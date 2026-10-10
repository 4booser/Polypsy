import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db, makeUser, sql, type Person } from "./fixtures";
import { taggedAppRolePool } from "./appRole";
// само приложение, без обёртки fixtures: под QUIZZY_TEST_APP_ROLE она пустила бы запрос общим пулом
import { app } from "../src/app";
import { db as appDb, runOnPool, type PoolOverride } from "../src/db";
import { responses } from "../src/db/schema";
import { requireAuth, type AppEnv } from "../src/middleware/auth";

/**
 * Отказ одного запроса в Promise.all внутри транзакции запроса не держит
 * соединение (#183).
 *
 * Как это было. Аналитика методики пускала три выборки через Promise.all,
 * и у каждой список id прохождений шёл параметром на элемент. Выше 65 533
 * параметров postgres.js отказывает, но отказ этот — на соединении, при
 * сборке сообщения, — и если на соединении уже идёт другой запрос (в
 * транзакции так всегда, когда запросы пущены разом), драйвер отклоняет НЕ
 * ТОТ запрос, а несобранный оставляет ждать ответа, которого не будет:
 * сервер его не получал. Каждый следующий ответ достаётся предыдущему
 * запросу, последнему — ROLLBACK транзакции — не достаётся никакой.
 * Транзакция не кончается, соединение в пул не возвращается, на сервере оно
 * «idle | rollback» навсегда; десять повторных нажатий — пул пуст, API молчит.
 *
 * Проверяется общее место — транзакция запроса и шов drizzle (db/sendGuard),
 * а не аналитика: маршрут здесь свой, проба из трёх запросов, второй из
 * которых драйвер не отправит. Пул — свой, с именем приложения: по нему
 * pg_stat_activity отбирает ровно соединения этих запросов, и сломанное
 * соединение не достанется соседним файлам.
 */

const TAG = `w20-pipeline-${crypto.randomUUID().slice(0, 8)}`;
let pool: PoolOverride & { close: () => Promise<void> };
let staff: Person;

/** Список, которого драйвер не примет: параметр на элемент, больше потолка */
const tooMany = Array.from({ length: 70_000 }, (_, i) => `${TAG}-${i}`);

const probe = new Hono<AppEnv>();
probe.use("*", requireAuth);
probe.get("/three", async (c) => {
  const [slow, , last] = await Promise.all([
    appDb.execute(sql`select pg_sleep(0.05), 1 as n`),
    appDb.select({ id: responses.id }).from(responses).where(inArray(responses.id, tooMany)),
    appDb.execute(sql`select 2 as n`),
  ]);
  return c.json({ slow: slow.length, last: last.length });
});

const within = <T>(ms: number, work: Promise<T>): Promise<T | "timeout"> =>
  Promise.race([work, Bun.sleep(ms).then(() => "timeout" as const)]);

const onPool = <T>(fn: () => Promise<T>): Promise<T> => runOnPool(pool, fn);
const auth = () => ({ headers: { Authorization: `Bearer ${staff.token}` } });

/** Соединения этого пула на сервере: состояние и последний запрос */
async function connections(): Promise<{ state: string; query: string }[]> {
  return (await db.execute(sql`
    select state, query from pg_stat_activity where application_name = ${TAG}
  `)) as unknown as { state: string; query: string }[];
}

beforeAll(async () => {
  staff = await makeUser("admin", `${TAG}@pipeline.test`);
  pool = await taggedAppRolePool(TAG);
});

afterAll(async () => {
  await pool?.close();
});

describe("транзакция запроса: отказ одного запроса в Promise.all", () => {
  test("положительный контроль: та же проба со списком под потолком — 200", async () => {
    const ok = new Hono<AppEnv>();
    ok.use("*", requireAuth);
    ok.get("/three", async (c) => {
      const [slow, few, last] = await Promise.all([
        appDb.execute(sql`select pg_sleep(0.05), 1 as n`),
        appDb.select({ id: responses.id }).from(responses).where(inArray(responses.id, tooMany.slice(0, 100))),
        appDb.execute(sql`select 2 as n`),
      ]);
      return c.json({ slow: slow.length, few: few.length, last: last.length });
    });
    const res = await within(5_000, onPool(async () => ok.request("/three", auth())));
    expect(res === "timeout" ? "timeout" : res.status).toBe(200);
    if (res !== "timeout") expect(await res.json()).toEqual({ slow: 1, few: 0, last: 1 });
  }, 15_000);

  test("десять таких запросов — 500 сразу, пул цел, idle | rollback не остаётся", async () => {
    const started = performance.now();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => within(5_000, onPool(async () => probe.request("/three", auth())))),
    );
    // ответ — отказ, и сразу, а не «нет ответа»
    expect(answers.map((r) => (r === "timeout" ? "timeout" : r.status))).toEqual(Array(10).fill(500));
    expect(performance.now() - started).toBeLessThan(5_000);

    // лёгкий запрос — тем же пулом, что пережил десять отказов
    const t0 = performance.now();
    const me = await within(2_000, onPool(async () => app.request("/api/auth/me", auth())));
    expect(me === "timeout" ? "timeout" : me.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(200);

    /*
     * Соединения пула возвращаются в него по кругу: десять лёгких запросов
     * подряд проходят по каждому открытому. Откатившаяся транзакция
     * оставляет на соединении последним запросом rollback, и это норма —
     * пока соединение в пуле; после круга его там быть не может. Осталось
     * — значит, драйвер считает соединение занятым и не отдаёт.
     */
    for (let i = 0; i < 10; i++) {
      const light = await within(1_000, onPool(() => appDb.execute(sql`select 'круг' as n`)));
      expect(light).not.toBe("timeout");
    }
    const left = await connections();
    expect(left.length).toBeGreaterThan(0);
    expect(left.filter((c) => c.state === "idle" && /^rollback/i.test(c.query.trim()))).toEqual([]);
  }, 30_000);
});
