import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app, appApi, db, root, sql } from "./fixtures";
import { asAppRole } from "./appRole";

/**
 * Поиск по тексту в журнале на миллионе строк (#190).
 *
 * Свободный текст — шесть ILIKE '%…%', среди них по подробностям целиком, и
 * счёт по тому же отбору на каждой странице: на 2 млн строк страница с
 * текстом шла 9 с — полный перебор дважды. Триграммный индекс здесь не
 * помогает: журнал читает роль приложения под политикой строк, а условие,
 * чей оператор не LEAKPROOF (ILIKE таков), PostgreSQL до проверки
 * политики не пускает — ни в индекс, ни раньше фильтра. Поэтому текст
 * ищется в пределах 31 дня: период человека, если он короче, иначе
 * последние 31 день его периода (без периода — до сегодня), — и ответ
 * говорит, за какие дни искали. Счёт — только на первой странице.
 *
 * Строки посева — вне цепочки (seq пуст, как у записей до её внедрения):
 * проверку целостности они не трогают, и уходят в afterAll.
 */

const TAG = `w21aud-${crypto.randomUUID().slice(0, 8)}`;
const ROWS = 1_000_000;
const NEEDLE = `${TAG}-needle`;
const kyivDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(Date.now() + offsetDays * 86_400_000));
/** Сегодня по Киеву минус n календарных дней — счётом дней, а не часов (переход на летнее время) */
const daysBefore = (n: number) =>
  new Date(Date.parse(`${kyivDay()}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  /*
   * Миллион строк за два года (шаг 63 с), четыре частых действия. Иголка —
   * в подробностях трёх свежих строк и одной двухлетней давности.
   */
  await db.execute(sql`
    insert into audit_log (id, at, actor_email, actor_role, action, resource_type, resource_id, outcome, details)
    select ${TAG} || '-' || g, now() - g * interval '63 seconds',
           'bulk' || (g % 50) || '@audit-scale.test', 'admin',
           (array['auth.login', 'response.read', 'report.render', 'patient.card_read'])[1 + g % 4],
           'response', md5(g::text), 'success',
           jsonb_build_object('n', g, 'note', case when g in (10, 20, 30, 900000) then ${NEEDLE} else 'звичайний запис' end)
    from generate_series(1, ${ROWS}::int) g`);
  await db.execute(sql`analyze audit_log`);
}, 300_000);

afterAll(async () => {
  // журнал неизменяем и для владельца; посев снимается так же, как в integrity.test.ts
  await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
  try {
    await db.execute(sql`delete from audit_log where id like ${`${TAG}-%`}`);
  } finally {
    await db.execute(sql`alter table audit_log enable trigger audit_log_immutable`);
  }
  // миллион мёртвых строк не должен доставаться соседям полным просмотром
  await db.execute(sql`vacuum analyze audit_log`);
}, 300_000);

type Page = {
  entries: { id: string; details: { note?: string } | null }[];
  total?: number;
  nextCursor: string | null;
  searchPeriod?: { from: string; to: string };
};

async function timed(path: string) {
  const t0 = performance.now();
  const res = await appApi<Page>(path, root.token);
  return { ...res, ms: performance.now() - t0 };
}

describe("поиск по тексту в журнале на миллионе строк (#190)", () => {
  test("редкий текст — меньше секунды; ищется за последние 31 день, и ответ это говорит", async () => {
    const res = await timed(`/api/audit?q=${encodeURIComponent(NEEDLE)}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(1000);
    expect(res.body.entries.map((e) => e.id).sort()).toEqual([`${TAG}-10`, `${TAG}-20`, `${TAG}-30`]);
    expect(res.body.total).toBe(3);
    expect(res.body.searchPeriod).toEqual({ from: daysBefore(30), to: kyivDay() });
  }, 30_000);

  test("частый текст: первая страница со счётом, следующая — без пересчёта; обе меньше секунды", async () => {
    const first = await timed("/api/audit?q=auth.login&limit=50");
    expect(first.status).toBe(200);
    expect(first.ms).toBeLessThan(1000);
    expect(first.body.entries).toHaveLength(50);
    expect(first.body.total).toBeGreaterThan(50);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await timed(`/api/audit?q=auth.login&limit=50&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(second.status).toBe(200);
    expect(second.ms).toBeLessThan(1000);
    expect(second.body.entries).toHaveLength(50);
    // счёт стоит на первой странице; на следующих его нет, а не «0»
    expect(second.body.total).toBeUndefined();
    expect(second.body.entries[0]!.id).not.toBe(first.body.entries[0]!.id);
  }, 30_000);

  test("старое находится, если указать период; период длиннее 31 дня сужается до его последних 31 дня", async () => {
    // иголка двухлетней давности: 900 000 × 63 с ≈ 656 дней назад
    const old = -Math.round((900_000 * 63) / 86_400);
    const around = await timed(`/api/audit?q=${encodeURIComponent(NEEDLE)}&from=${kyivDay(old - 5)}&to=${kyivDay(old + 5)}`);
    expect(around.status).toBe(200);
    expect(around.body.entries.map((e) => e.id)).toEqual([`${TAG}-900000`]);
    expect(around.body.searchPeriod).toEqual({ from: kyivDay(old - 5), to: kyivDay(old + 5) });

    const wide = await timed(`/api/audit?q=${encodeURIComponent(NEEDLE)}&from=${kyivDay(-800)}`);
    expect(wide.status).toBe(200);
    expect(wide.ms).toBeLessThan(1000);
    expect(wide.body.searchPeriod).toEqual({ from: daysBefore(30), to: kyivDay() });
    expect(wide.body.entries.map((e) => e.id).sort()).toEqual([`${TAG}-10`, `${TAG}-20`, `${TAG}-30`]);
  }, 30_000);

  test("выгрузка и график по дням ищут текст в том же окне, что таблица", async () => {
    const csv = await asAppRole(async () =>
      app.request(`/api/audit/export.csv?q=${encodeURIComponent(NEEDLE)}`, { headers: { Authorization: `Bearer ${root.token}` } }),
    );
    expect(csv.status).toBe(200);
    const lines = (await csv.text()).split("\n").filter((l) => l.includes(NEEDLE));
    expect(lines).toHaveLength(3);

    const daily = await timed(`/api/audit/daily?q=${encodeURIComponent(NEEDLE)}`);
    expect(daily.status).toBe(200);
    expect(daily.body).toMatchObject({ from: daysBefore(30), to: kyivDay(), step: "day" });
  }, 30_000);

  test("без текста период не навязывается: отбор по действию видит весь журнал", async () => {
    const res = await timed("/api/audit?action=patient.card_read&limit=5");
    expect(res.status).toBe(200);
    expect(res.body.searchPeriod).toBeUndefined();
    expect(res.body.total).toBeGreaterThanOrEqual(ROWS / 4);
  }, 30_000);
});
