import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { appApi, appRequest, db, json, makeUser, root } from "./fixtures";
import { refreshTokens } from "../src/db/schema";

/**
 * Обмен refresh-токена наперегонки с отзывом сессий (#138).
 *
 * Отзыв гасил живые токены одним UPDATE, обмен притязал на свой токен
 * другим, и ни один не ждал другого целиком. Отзыв первым: обмен ждал
 * строку, перечитывал её после фиксации отзыва, видел «не погашен» (условие
 * притязания смотрело только на rotated_at) — и выпускал в отозванной семье
 * новый живой токен. Обмен первым: новый токен вставлялся, пока отзыв ждал
 * строку старого, и отзыв, перечитав только её, нового не видел вовсе.
 * Человек нажимал «завершить все сессии» или менял пароль — а держатель
 * украденного токена оставался в сессии.
 *
 * Приём — как в guardRaces.test.ts: строку токена держит замком отдельное
 * соединение владельца, запросы под ролью приложения запускаются по одному,
 * и каждый дожидается, пока встанет в очередь; порядок в очереди — порядок
 * прохода. Когда стоят оба, строка отпускается. Проверяется результат, а не
 * механизм: после обоих запросов у человека нет ни одного живого
 * refresh-токена, а пара, выданная обменом (если он успел), не проходит ни
 * /me, ни следующий обмен.
 */

const PASSWORD = "secret12345";

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(async () => {
  await holder.end();
});

/** Сколько запросов к этой базе стоят в очереди за замком — по факту, а не по таймеру */
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
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

interface Outcome {
  status: number;
  body: any;
}

/** Держать строку токена, пока оба запроса не встанут за ней в очередь, и отпустить */
async function whileHeld(tokenId: string, actions: (() => Promise<Outcome>)[]): Promise<Outcome[]> {
  const pending: Promise<Outcome>[] = [];
  await holder.begin(async (tx) => {
    await tx`select id from refresh_tokens where id = ${tokenId} for update`;
    for (const [i, start] of actions.entries()) {
      const p = start();
      p.catch(() => {});
      pending.push(p);
      await untilWaiting(i + 1);
    }
  });
  return Promise.all(pending);
}

async function post(path: string, body: unknown): Promise<Outcome> {
  const res = await appRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
}

const exchange = (refreshToken: string) => () => post("/api/auth/refresh", { refreshToken });

interface Victim {
  id: string;
  access: string;
  refreshToken: string;
  tokenId: string;
}

/** Человек с одной живой сессией, полученной настоящим входом */
async function victim(tag: string): Promise<Victim> {
  const email = `rr-${tag}-${crypto.randomUUID()}@test.dev`;
  const person = await makeUser("user", email);
  const session = await post("/api/auth/login", { email, password: PASSWORD });
  expect(session.status, `вход: ${JSON.stringify(session.body)}`).toBe(200);
  const [row] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, person.id), isNull(refreshTokens.revokedAt)));
  expect(row, "вход не выдал refresh-токен").toBeTruthy();
  return { id: person.id, access: session.body.token, refreshToken: session.body.refreshToken, tokenId: row!.id };
}

/** Живые refresh-токены человека: не отозваны и не погашены обменом */
async function liveTokens(userId: string): Promise<number> {
  const rows = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), isNull(refreshTokens.rotatedAt)));
  return rows.length;
}

/**
 * Итог гонки: отзыв прошёл, живых токенов нет, а пара, выданная обменом,
 * если он успел первым, мертва — не открывает /me и не обменивается дальше.
 */
async function expectSessionGone(person: Victim, revoke: Outcome, swap: Outcome, label: string) {
  expect(revoke.status, `${label}: отзыв ${JSON.stringify(revoke.body)}`).toBe(200);
  expect([200, 401], `${label}: обмен ${JSON.stringify(swap.body)}`).toContain(swap.status);
  expect(await liveTokens(person.id), `${label}: после отзыва у человека остался живой refresh-токен`).toBe(0);
  if (swap.status === 200) {
    const me = await appApi("/api/auth/me", swap.body.token);
    expect(me.status, `${label}: access-токен, выданный обменом, пережил отзыв`).toBe(401);
    const next = await exchange(swap.body.refreshToken)();
    expect(next.status, `${label}: refresh-токен, выданный обменом, пережил отзыв`).toBe(401);
  }
  // и прежний access, с которым человек вошёл, тоже мёртв
  expect((await appApi("/api/auth/me", person.access)).status, `${label}: прежний access пережил отзыв`).toBe(401);
}

type Revoker = (person: Victim) => () => Promise<Outcome>;

const revokers: [string, Revoker][] = [
  [
    "завершение всех сессий",
    (p) => () => appApi(`/api/ops/users/${p.id}/revoke-sessions`, root.token, { method: "POST" }),
  ],
  [
    "смена пароля",
    (p) => () =>
      appApi("/api/auth/password", p.access, {
        method: "POST",
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "anotherpass9876" }),
      }),
  ],
  ["сброс пароля", (p) => () => appApi(`/api/ops/users/${p.id}/reset-password`, root.token, { method: "POST" })],
  ["выход", (p) => () => post("/api/auth/logout", { refreshToken: p.refreshToken })],
];

describe("обмен refresh-токена во время отзыва сессий не оживляет сессию (#138)", () => {
  for (const [name, revoke] of revokers) {
    test(
      `${name} первым, обмен вторым`,
      async () => {
        const person = await victim("revoke-first");
        const [revoked, swapped] = await whileHeld(person.tokenId, [
          revoke(person),
          exchange(person.refreshToken),
        ]);
        await expectSessionGone(person, revoked!, swapped!, name);
        // отзыв зафиксирован раньше — обменивать уже нечего
        expect(swapped!.status, `${name}: обмен после отзыва выдал пару`).toBe(401);
      },
      60_000,
    );

    test(
      `обмен первым, ${name} вторым`,
      async () => {
        const person = await victim("swap-first");
        const [swapped, revoked] = await whileHeld(person.tokenId, [
          exchange(person.refreshToken),
          revoke(person),
        ]);
        await expectSessionGone(person, revoked!, swapped!, name);
      },
      60_000,
    );
  }

  test("положительный контроль: обмен без отзыва выдаёт рабочую пару", async () => {
    const person = await victim("control");
    const swapped = await exchange(person.refreshToken)();
    expect(swapped.status).toBe(200);
    expect((await appApi("/api/auth/me", swapped.body.token)).status).toBe(200);
    expect(await liveTokens(person.id)).toBe(1);
    const next = await exchange(swapped.body.refreshToken)();
    expect(next.status).toBe(200);
  }, 30_000);
});
