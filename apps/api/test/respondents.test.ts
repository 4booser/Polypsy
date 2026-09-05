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

  test("испорченный курсор отдаёт первую страницу, а не отказ", async () => {
    // курсор приходит из адресной строки, и опечатка в нём не должна ронять экран
    const res = await api("/api/dynamics/respondents?limit=3&cursor=%%%мусор%%%", adminA.token);
    expect(res.status).toBe(200);
  });
});
