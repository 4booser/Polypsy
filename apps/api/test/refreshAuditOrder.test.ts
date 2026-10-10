import { afterAll, expect, test } from "bun:test";
import postgres from "postgres";
import { and, appRequest, db, eq, isNull, json, makeUser, sql } from "./fixtures";
import { refreshTokens, users } from "../src/db/schema";

/*
 * Строка журнала об отказе обмена refresh переживает вход того же человека.
 *
 * Обмен держит строку владельца в users (lockOwner, lib/refresh.ts) до своей
 * фиксации; вход берёт замок цепочки журнала, потом users (touchLastSeen).
 * Пока строка отказа писалась в транзакции обмена, повтор погашенного
 * токена (кража) одновременно со входом давал цикл, и база снимала запись
 * журнала: строка «reused» пропадала (ревью PR #196). Теперь она пишется
 * после фиксации обмена (routes/auth.ts, /refresh).
 */

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(async () => {
  await holder.end();
});

async function untilWaiting(n: number, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
    `);
    if (Number(row?.n ?? 0) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`waiting < ${n}`);
}

async function post(path: string, body: unknown) {
  const res = await appRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res), retryAfter: res.headers.get("retry-after") };
}

test("повтор refresh (кража) одновременно со входом того же человека: строка reused на месте, вход проходит", async () => {
  const email = `rv20-dl-${crypto.randomUUID()}@test.dev`;
  const person = await makeUser("user", email);
  const s0 = await post("/api/auth/login", { email, password: "secret12345" });
  expect(s0.status).toBe(200);
  const s1 = await post("/api/auth/refresh", { refreshToken: s0.body.refreshToken });
  expect(s1.status).toBe(200);
  const [live] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, person.id), isNull(refreshTokens.revokedAt), isNull(refreshTokens.rotatedAt)));
  // вход давно не был — touchLastSeen будет писать
  await db.update(users).set({ lastSeenAt: null }).where(eq(users.id, person.id));

  const started = Date.now();
  const pending: Promise<{ status: number; body: any; retryAfter: string | null }>[] = [];
  await holder.begin(async (tx) => {
    // держим живой токен семьи: обмен краденым (s0) возьмёт lockOwner и встанет на гашении семьи
    await tx`select id from refresh_tokens where id = ${live!.id} for update`;
    const reuse = post("/api/auth/refresh", { refreshToken: s0.body.refreshToken });
    reuse.catch(() => {});
    pending.push(reuse);
    await untilWaiting(1);
    // вход того же человека: журнал (замок цепочки) → touchLastSeen (строка users под lockOwner)
    const login = post("/api/auth/login", { email, password: "secret12345" });
    login.catch(() => {});
    pending.push(login);
    await untilWaiting(2);
  });
  const [reuse, login] = await Promise.all(pending);
  const rows = (await db.execute(sql`
    select action, outcome, details->>'reason' as reason from audit_log
    where action = 'auth.refresh_failed' and (resource_id = ${person.id} or subject_user_id = ${person.id})`)) as unknown as { reason: string }[];
  const liveLeft = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, person.id), isNull(refreshTokens.revokedAt)));
  expect(reuse.status).toBe(401);
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  expect(Date.now() - started, "вход не ждал разрешения взаимоблокировки").toBeLessThan(20_000);
  expect(rows.filter((r) => r.reason === "reused"), "строка «подозрение на кражу» потеряна").toHaveLength(1);
  // семья погашена; живой — только токен нового входа
  expect(liveLeft).toHaveLength(1);
}, 60_000);

test("контроль: тот же повтор без параллельного входа пишет строку reused", async () => {
  const email = `rv20-ctl-${crypto.randomUUID()}@test.dev`;
  const person = await makeUser("user", email);
  const s0 = await post("/api/auth/login", { email, password: "secret12345" });
  const s1 = await post("/api/auth/refresh", { refreshToken: s0.body.refreshToken });
  expect(s1.status).toBe(200);
  const reuse = await post("/api/auth/refresh", { refreshToken: s0.body.refreshToken });
  expect(reuse.status).toBe(401);
  const rows = (await db.execute(sql`
    select details->>'reason' as reason from audit_log
    where action = 'auth.refresh_failed' and (resource_id = ${person.id} or subject_user_id = ${person.id})`)) as unknown as { reason: string }[];
  expect(rows.filter((r) => r.reason === "reused")).toHaveLength(1);
}, 30_000);
