import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, api, db, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { responses } from "../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * Список обследованных постранично.
 *
 * Проверяется одно: пролистав список до конца, человек видит КАЖДОГО ровно
 * один раз. Курсор шёл по одному времени последнего замера, а оно
 * повторяется — приём идёт потоком, замеры сдают подряд, — и на границе
 * страницы условие «строго раньше курсора» выбрасывало всех, кто попал в ту
 * же секунду: один показывался, второй не попадал ни на одну страницу.
 *
 * Потеря молчаливая: список выглядит целым, и заметить её можно только по
 * несовпадению с общим числом.
 */

const PEOPLE = 7;
const sameMoment = new Date(Date.now() - 3 * 3600_000).toISOString();

beforeAll(async () => {
  /*
   * Всем ставится ОДНО И ТО ЖЕ время замера. Так и выглядит настоящая
   * граница страницы, только здесь она гарантирована, а не вероятна: со
   * случайными временами эта проверка проходила бы через раз и никого бы ни
   * в чём не убедила.
   */
  for (let i = 0; i < PEOPLE; i++) {
    const person = await makeUser("user", `page-${i}-${crypto.randomUUID()}@test`);
    const res = await submitSurvey(surveyInA, person.token);
    if (res.status === 201) {
      await db
        .update(responses)
        .set({ submittedAt: sameMoment })
        .where(eq(responses.id, res.body.id));
    }
  }
});

describe("страницы списка обследованных", () => {
  test("пролистав до конца, каждого видно ровно один раз", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    /*
     * Список обходится ДО КОНЦА, а не заданное число страниц.
     *
     * Стоял потолок в сорок страниц по три — сто двадцать человек. Локально
     * их столько и не набиралось, а в общей базе, где следы оставляют все
     * остальные файлы, обход обрывался на середине, и семеро с общим
     * временем замера просто не успевали показаться. Проверка краснела на
     * последнем условии — «человек не попал ни на одну страницу», — и
     * называла виновником постраничность, которая была цела.
     *
     * Потолок остаётся, но как защита от бесконечного цикла, а не как
     * длина списка: упёршись в него, проверка говорит именно это.
     */
    let pages = 0;
    const LIMIT = 3;
    const MAX_PAGES = 2000;
    do {
      const url: string = `/api/dynamics/respondents?limit=${LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await api<{ items: { userId: string }[]; nextCursor: string | null; total?: number }>(
        url,
        adminA.token,
      );
      expect(res.status).toBe(200);
      for (const item of res.body.items) seen.push(item.userId);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);

    expect(cursor, `список не кончился за ${MAX_PAGES} страниц — курсор не двигается`).toBeNull();

    const unique = new Set(seen);
    expect(unique.size, "один и тот же человек показан на двух страницах").toBe(seen.length);

    /*
     * Люди с одинаковым временем замера должны оказаться в списке ВСЕ. Это
     * и есть проверка: без второго поля в курсоре часть из них не попадала
     * ни на одну страницу.
     */
    const withSameMoment = await db
      .select({ userId: responses.userId })
      .from(responses)
      .where(eq(responses.submittedAt, sameMoment));
    const expected = new Set(withSameMoment.map((r) => r.userId).filter(Boolean) as string[]);
    for (const id of expected) {
      expect(unique.has(id), `человек ${id} не попал ни на одну страницу списка`).toBe(true);
    }
  });

  /*
   * Страница — по человеку, а не по замеру.
   *
   * Внешний разбор: «пагинация повторных замеров фильтровала строки вместо
   * агрегатов, поэтому пациенты повторялись на следующих страницах». Это
   * было исправлено ещё при переносе свёртки в базу (условие курсора ушло в
   * HAVING), но проверка выше этого не ловит: у её людей по одному замеру, а
   * при одном замере фильтр по строкам и фильтр по агрегату совпадают.
   *
   * Здесь у каждого по три замера, и времена переплетены: самый свежий замер
   * одного старше самого свежего замера следующего, но моложе его прежних.
   * Условие курсора в WHERE отрезало бы у человека свежий замер и оставило
   * прежние — он вернулся бы на следующей странице с меньшим максимумом.
   * Поиском список сужается до своих людей, поэтому страницы — ровно наши.
   */
  test("у кого замеров много — тот всё равно на одной странице: две страницы не пересекаются", async () => {
    const tag = `интерлив${crypto.randomUUID().slice(0, 8)}`;
    const PEOPLE_MANY = 4;
    const MEASURES = 3;
    const t0 = Date.now() - 5 * 3600_000;
    const mine: string[] = [];
    for (let i = 0; i < PEOPLE_MANY; i++) {
      const person = await makeUser("user", `${tag}-${i}-${crypto.randomUUID().slice(0, 6)}@test`);
      mine.push(person.id);
      for (let k = 0; k < MEASURES; k++) {
        const res = await submitSurvey(surveyInA, person.token);
        expect(res.status).toBe(201);
        // человек i: замеры в t0 − i, t0 − (i + 4), t0 − (i + 8) минут — через одного с соседями
        const at = new Date(t0 - (i + k * PEOPLE_MANY) * 60_000).toISOString();
        await db.update(responses).set({ submittedAt: at }).where(eq(responses.id, res.body.id));
      }
    }

    const page = async (cursor: string | null) => {
      const url = `/api/dynamics/respondents?limit=2&search=${encodeURIComponent(tag)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await api<{ items: { userId: string; count: number }[]; nextCursor: string | null }>(url, adminA.token);
      expect(res.status).toBe(200);
      return res.body;
    };

    const first = await page(null);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(first.nextCursor);

    const firstIds = first.items.map((r) => r.userId);
    const secondIds = second.items.map((r) => r.userId);
    expect(firstIds.filter((id) => secondIds.includes(id)), "человек повторился на второй странице").toEqual([]);
    // порядок — по самому свежему замеру: 0, 1 | 2, 3
    expect(firstIds).toEqual([mine[0]!, mine[1]!]);
    expect(secondIds).toEqual([mine[2]!, mine[3]!]);
    // и каждый показан со всеми своими замерами, а не с тем, что осталось после курсора
    for (const r of [...first.items, ...second.items]) expect(r.count).toBe(MEASURES);

    /*
     * Дальше страниц быть не должно. При курсоре по строкам они были бы:
     * прежние замеры первых двоих остались «после курсора», и оба
     * вернулись бы третьей страницей. Обход до конца — чтобы повтор был
     * виден, а не только «лишний курсор».
     */
    const seen = [...firstIds, ...secondIds];
    let cursor = second.nextCursor;
    for (let guard = 0; cursor && guard < 10; guard++) {
      const next = await page(cursor);
      seen.push(...next.items.map((r) => r.userId));
      cursor = next.nextCursor;
    }
    expect(seen, "человек показан на двух страницах").toEqual(mine);
  }, 60_000);

  test("испорченный курсор отдаёт первую страницу, а не отказ", async () => {
    // курсор приходит из адресной строки, и опечатка в нём не должна ронять экран
    const res = await api("/api/dynamics/respondents?limit=3&cursor=%%%мусор%%%", adminA.token);
    expect(res.status).toBe(200);
  });
});
