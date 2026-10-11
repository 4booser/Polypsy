import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { db, eq, makeUser, sql, type Person } from "./fixtures";
import { taggedAppRolePool } from "./appRole";
// само приложение, без обёртки fixtures: запросы этого файла идут своим пулом роли приложения
import { app } from "../src/app";
import { db as appDb, runOnPool, type PoolOverride } from "../src/db";
import { responses } from "../src/db/schema";
import { requireAuth, type AppEnv } from "../src/middleware/auth";

/**
 * Ошибка сборки сообщения на клиенте достаётся своему запросу (#193).
 *
 * postgres.js 3.4.9 собирает сообщение запроса уже на соединении. Если сборка
 * падает (потолок параметров, undefined, значение, которое сериализатор не
 * превращает в строку), а на соединении в этот момент идёт другой запрос — в
 * транзакции так всякий раз, когда запросы пущены через Promise.all, — драйвер
 * отклонял запрос В РАБОТЕ, а несобранный оставлял в очереди ждущих ответа,
 * хотя на сервер тот не ушёл. Каждый следующий ответ доставался предыдущему
 * запросу, ROLLBACK не получал никакого: транзакция и соединение висли
 * навсегда. Волна 20 закрыла сторожем (db/sendGuard.ts) только потолок
 * параметров; правка в самом драйвере — patches/postgres@3.4.9.patch.
 *
 * Первая проверка — сам драйвер, без приложения: пул из одного соединения,
 * и следующий запрос после транзакции проходит, только если оно вернулось в
 * пул. Вторая — то же через построитель drizzle и транзакцию запроса под
 * ролью приложения: eq(колонка, undefined) drizzle передаёт драйверу как
 * параметр undefined, и сборка сообщения падает на клиенте (UNDEFINED_VALUE)
 * — ошибка программиста, которой довольно, чтобы до правки повесить
 * транзакцию запроса и унести соединение пула.
 */

const TAG = `w22-build-${crypto.randomUUID().slice(0, 8)}`;
const within = <T>(ms: number, work: Promise<T>): Promise<T | "timeout"> =>
  Promise.race([work, Bun.sleep(ms).then(() => "timeout" as const)]);

/** Состояния соединений с этим именем приложения на сервере */
async function connections(name: string): Promise<{ state: string; query: string }[]> {
  return (await db.execute(sql`
    select state, query from pg_stat_activity where application_name = ${name}
  `)) as unknown as { state: string; query: string }[];
}

describe("драйвер: три запроса в транзакции, второй не собирается на клиенте", () => {
  const name = `${TAG}-drv`;
  let pg: postgres.Sql;

  beforeAll(() => {
    pg = postgres(process.env.DATABASE_URL as string, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: name },
    });
  });

  afterAll(async () => {
    await pg?.end({ timeout: 0 });
  }, 10_000);

  /** Транзакция из трёх запросов разом; второй параметром получает second */
  async function three(second: unknown) {
    const seen: { settled?: PromiseSettledResult<postgres.Row[]>[] } = {};
    const outcome = await within(
      5_000,
      pg
        .begin(async (tx) => {
          seen.settled = await Promise.allSettled([
            tx`select 1 as n, txid_current()::text as xid from pg_sleep(0.05)`,
            tx`select ${second as never}::text as x`,
            tx`select 3 as n`,
          ]);
          return "commit";
        })
        .then(
          (v) => v,
          (e: { code?: string }) => e.code ?? "error",
        ),
    );
    return { outcome, settled: seen.settled };
  }

  const rowsOf = (s: PromiseSettledResult<postgres.Row[]> | undefined) =>
    s?.status === "fulfilled" ? s.value.map((r) => ({ ...r })) : (s?.reason as { code?: string } | undefined)?.code;

  test("положительный контроль: все три собираются — у каждого свой ответ, транзакция фиксируется", async () => {
    const { outcome, settled } = await three("два");
    expect(outcome).toBe("commit");
    expect(rowsOf(settled?.[1])).toEqual([{ x: "два" }]);
    expect(rowsOf(settled?.[2])).toEqual([{ n: 3 }]);
  }, 15_000);

  test("отказ — второму, первый и третий получают свои ответы, транзакция откатывается, соединение в пуле", async () => {
    const { outcome, settled } = await three(undefined);
    // транзакция кончилась отказом второго запроса, а не повисла
    expect(outcome).toBe("UNDEFINED_VALUE");
    const first = rowsOf(settled?.[0]) as { n: number; xid: string }[];
    expect(first.map((r) => r.n)).toEqual([1]);
    expect(rowsOf(settled?.[1])).toBe("UNDEFINED_VALUE");
    expect(rowsOf(settled?.[2])).toEqual([{ n: 3 }]);

    // транзакция откатилась на сервере
    const [status] = (await db.execute(
      sql`select txid_status(${first[0]?.xid}::bigint) as status`,
    )) as unknown as { status: string }[];
    expect(status?.status).toBe("aborted");

    // соединение одно — следующий запрос проходит, только если оно вернулось в пул
    const again = await within(1_000, pg`select 'снова' as x`);
    expect(again === "timeout" ? "timeout" : again.map((r) => ({ ...r }))).toEqual([{ x: "снова" }]);
    expect((await connections(name)).map((c) => c.state)).toEqual(["idle"]);
  }, 15_000);
});

describe("транзакция запроса: eq(колонка, undefined) среди запросов Promise.all", () => {
  let pool: PoolOverride & { close: () => Promise<void> };
  let staff: Person;
  const answers: unknown[][] = [];

  const probe = new Hono<AppEnv>();
  probe.use("*", requireAuth);
  probe.get("/three", async (c) => {
    const settled = await Promise.allSettled([
      appDb.execute(sql`select 1 as n from pg_sleep(0.05)`),
      appDb.select({ id: responses.id }).from(responses).where(eq(responses.id, undefined as unknown as string)),
      appDb.execute(sql`select 3 as n`),
    ]);
    answers.push(settled.map((s) => (s.status === "fulfilled" ? { ...s.value[0] } : "отказ")));
    for (const s of settled) if (s.status === "rejected") throw s.reason;
    return c.json({ ok: true });
  });

  const onPool = <T>(fn: () => Promise<T>): Promise<T> => runOnPool(pool, fn);
  const auth = () => ({ headers: { Authorization: `Bearer ${staff.token}` } });

  beforeAll(async () => {
    staff = await makeUser("admin", `${TAG}@build.test`);
    pool = await taggedAppRolePool(`${TAG}-app`);
  });

  afterAll(async () => {
    await pool?.close();
  }, 10_000);

  test("отказ — второму запросу: 500 сразу, у первого и третьего свои ответы, пул цел", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await within(5_000, onPool(async () => probe.request("/three", auth())));
      expect(res === "timeout" ? "timeout" : res.status).toBe(500);
    }
    expect(answers).toEqual(Array(2).fill([{ n: 1 }, "отказ", { n: 3 }]));

    const me = await within(2_000, onPool(async () => app.request("/api/auth/me", auth())));
    expect(me === "timeout" ? "timeout" : me.status).toBe(200);
    expect((await connections(`${TAG}-app`)).filter((c) => c.state !== "idle")).toEqual([]);
  }, 30_000);
});
