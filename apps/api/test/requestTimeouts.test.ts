import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { app, db, makeUser, root, sql, type Person } from "./fixtures";
import { appRolePool } from "./appRole";
import { baseDb, db as appDb, runOnPool, type PoolOverride } from "../src/db";
import * as schema from "../src/db/schema";
import { REQUEST_STATEMENT_TIMEOUT_MS, systemContext } from "../src/db/context";
import { requireAuth, type AppEnv } from "../src/middleware/auth";
import { IDLE_TIMEOUT_S, serveOptions } from "../src/serve";

/**
 * Долгий запрос и ушедший клиент (#186).
 *
 * Как было. Сервер отдавался Bun объектом { port, fetch } — без
 * idleTimeout, а у Bun по умолчанию 10 с: обработчик на 15 с получал обрыв
 * соединения, сервер писал «timed out a request after 10 seconds», а
 * обработчик работал дальше и держал соединение пула до конца. Человек
 * жал ещё раз — второе соединение; выгрузка писала analytics.export, хотя
 * файл никто не получил. Предела оператора у транзакции запроса не было
 * вовсе: брошенный тяжёлый запрос шёл в базе, сколько ему нужно.
 *
 * Проверяется общее место — настройки сервера (serve.ts) и транзакция
 * запроса с отменой по обрыву (db/context.ts, db/cancelOnAbort.ts), — а не
 * какой-то тяжёлый маршрут: проба своя, pg_sleep в транзакции запроса.
 * Сервер — настоящий Bun.serve с теми же настройками, что у index.ts, на
 * свободном порту. Пул — роли приложения и в одно соединение, с меткой:
 * «соединение свободно» здесь значит буквально «следующий запрос через
 * этот пул проходит сразу», а по метке pg_stat_activity видит ровно его.
 */

const TAG = `w21-timeouts-${crypto.randomUUID().slice(0, 8)}`;
let staff: Person;
let client: ReturnType<typeof postgres>;
let pool: PoolOverride;

const probe = new Hono<AppEnv>();
probe.use("*", requireAuth);
// отменённый запрос падает ошибкой базы; разбор ошибок приложения здесь не проверяется — без вывода в консоль
probe.onError((error, c) => c.json({ error: String(error) }, 500));
probe.get("/sleep/:s", async (c) => {
  const seconds = Number(c.req.param("s"));
  await appDb.execute(sql`select pg_sleep(${seconds})`);
  return c.json({ slept: seconds });
});
probe.get("/timeout", async (c) => {
  const [row] = (await appDb.execute(
    sql`select setting from pg_settings where name = 'statement_timeout'`,
  )) as unknown as { setting: string }[];
  return c.json({ setting: row?.setting ?? null });
});

/** Сервер с настройками приложения; каждый запрос — пулом роли приложения в одно соединение */
function serve() {
  return Bun.serve({
    ...serveOptions((req: Request) => runOnPool(pool, () => probe.fetch(req))),
    port: 0,
  });
}

const auth = () => ({ Authorization: `Bearer ${staff.token}` });

/** Соединение пула на сервере: состояние и последний запрос */
async function connection(): Promise<{ state: string; query: string } | undefined> {
  const rows = (await db.execute(sql`
    select state, query from pg_stat_activity where application_name = ${TAG}
  `)) as unknown as { state: string; query: string }[];
  return rows[0];
}

beforeAll(async () => {
  staff = await makeUser("admin", `${TAG}@timeouts.test`);
  const { url } = await appRolePool();
  client = postgres(url, {
    max: 1,
    idle_timeout: 20,
    transform: undefined,
    onnotice: () => {},
    connection: { application_name: TAG },
  });
  pool = { db: drizzle(client, { schema }), url };
});

afterAll(async () => {
  await client?.end({ timeout: 1 });
});

describe("долгий запрос: предел простоя соединения", () => {
  test("предел простоя — больше предела оператора и в пределах Bun (255 с)", () => {
    expect(IDLE_TIMEOUT_S * 1000).toBeGreaterThan(REQUEST_STATEMENT_TIMEOUT_MS);
    expect(IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });

  test("обработчик на 15 с отдаёт тело, а не обрыв", async () => {
    const server = serve();
    try {
      const t0 = performance.now();
      const res = await fetch(`http://localhost:${server.port}/sleep/15`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slept: 15 });
      expect(performance.now() - t0).toBeGreaterThan(14_000);
    } finally {
      server.stop(true);
    }
  }, 40_000);
});

describe("ушедший клиент: соединение пула возвращается сразу", () => {
  test("клиент ушёл через секунду — запрос в базе отменён, следующий проходит через то же соединение", async () => {
    const server = serve();
    try {
      const gone = new AbortController();
      const abandoned = fetch(`http://localhost:${server.port}/sleep/30`, {
        headers: auth(),
        signal: gone.signal,
      }).catch(() => "aborted" as const);
      // запрос дошёл до базы и спит в ней
      for (let i = 0; i < 50 && !(await connection())?.query.includes("pg_sleep"); i++) await Bun.sleep(50);
      expect((await connection())?.state).toBe("active");
      await Bun.sleep(1_000);
      gone.abort();
      const abortedAt = performance.now();
      expect(await abandoned).toBe("aborted");

      /*
       * Пул — в одно соединение: пока брошенный запрос его держит, этот
       * ждёт. Порог — по порядку величины: без отмены ждать пришлось бы
       * ещё 29 секунд сна.
       */
      const next = await fetch(`http://localhost:${server.port}/sleep/0`, { headers: auth() });
      const freedMs = performance.now() - abortedAt;
      expect(next.status).toBe(200);
      expect(freedMs).toBeLessThan(2_000);
      const after = await connection();
      expect(after?.state).toBe("idle");
      expect(after?.query).not.toContain("pg_sleep(");
    } finally {
      server.stop(true);
    }
  }, 40_000);

  test("приложение: ответ ушедшему клиенту — 499 без ошибки сервера, транзакция откатана", async () => {
    const gone = new AbortController();
    gone.abort();
    const res = await app.request("/api/analytics/overview", {
      headers: { Authorization: `Bearer ${root.token}` },
      signal: gone.signal,
    });
    expect(res.status).toBe(499);
    // тот же запрос с живым клиентом — обычный ответ
    const ok = await app.request("/api/analytics/overview", { headers: { Authorization: `Bearer ${root.token}` } });
    expect(ok.status).toBe(200);
  }, 15_000);

  test("положительный контроль: клиент дождался — запрос не отменён", async () => {
    const server = serve();
    try {
      const res = await fetch(`http://localhost:${server.port}/sleep/1`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slept: 1 });
    } finally {
      server.stop(true);
    }
  }, 15_000);
});

describe("предел оператора", () => {
  test("в транзакции запроса — REQUEST_STATEMENT_TIMEOUT_MS", async () => {
    const res = await runOnPool(pool, async () => probe.request("/timeout", { headers: auth() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ setting: String(REQUEST_STATEMENT_TIMEOUT_MS) });
  }, 15_000);

  test("у фоновых задач (systemContext) предела нет: им законно нужно дольше", async () => {
    const [row] = (await runOnPool(pool, () =>
      systemContext(baseDb, () => appDb.execute(sql`select setting from pg_settings where name = 'statement_timeout'`)),
    )) as unknown as { setting: string }[];
    expect(row?.setting).toBe("0");
  }, 15_000);
});
