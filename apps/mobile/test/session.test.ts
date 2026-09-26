import { describe, expect, test } from "bun:test";
import { flushRevocations, queueRevocation, REVOKE_CAP, refreshOnUnauthorized, type RevokeStore } from "../src/auth/session";

/**
 * Сессия на устройстве.
 *
 * Два дефекта из ревью: запуск стирал сессию, хотя refresh был жив (клиент
 * не продлевал токен на всём `/api/auth/*`, включая `/api/auth/me`), и выход
 * не отзывал сессию на сервере.
 */

describe("когда 401 значит «продлить токен»", () => {
  test("защищённые маршруты под /api/auth продлеваются — с /api/auth/me начинается запуск", () => {
    expect(refreshOnUnauthorized("/api/auth/me")).toBe(true);
    expect(refreshOnUnauthorized("/api/auth/me/reveal")).toBe(true);
    expect(refreshOnUnauthorized("/api/auth/password")).toBe(true);
    expect(refreshOnUnauthorized("/api/auth/google/link")).toBe(true);
  });

  test("там, где токен выдают или гасят, 401 — ответ по существу", () => {
    for (const path of [
      "/api/auth/login",
      "/api/auth/mfa/login",
      "/api/auth/register",
      "/api/auth/refresh",
      "/api/auth/logout",
      "/api/auth/google/exchange",
      "/api/auth/login?next=1",
    ]) {
      expect(refreshOnUnauthorized(path)).toBe(false);
    }
  });

  test("прочее API продлевается, как и было", () => {
    expect(refreshOnUnauthorized("/api/surveys")).toBe(true);
    // похожее начало — не повод отказываться: /api/auth/loginHistory не вход
    expect(refreshOnUnauthorized("/api/auth/loginHistory")).toBe(true);
  });
});

function memoryRevokeStore(initial: string[] = []): RevokeStore & { list: string[] } {
  const box = {
    list: [...initial],
    get: async () => [...box.list],
    set: async (tokens: string[]) => {
      box.list = [...tokens];
    },
  };
  return box;
}

const fail = (status: number) => Promise.reject(Object.assign(new Error("fail"), { status }));

describe("отзыв сессии при выходе", () => {
  test("связь есть — отзыв уходит сразу, список пуст", async () => {
    const store = memoryRevokeStore();
    const revoked: string[] = [];
    await queueRevocation(store, "r1");
    expect(await flushRevocations(store, async (t) => void revoked.push(t))).toBe(1);
    expect(revoked).toEqual(["r1"]);
    expect(store.list).toEqual([]);
  });

  test("без сети выход не ждёт, а отзыв ждёт первой связи", async () => {
    const store = memoryRevokeStore();
    await queueRevocation(store, "r1");
    expect(await flushRevocations(store, () => fail(0))).toBe(0);
    expect(store.list).toEqual(["r1"]);

    // связь появилась — при старте или возвращении приложения
    const revoked: string[] = [];
    await flushRevocations(store, async (t) => void revoked.push(t));
    expect(revoked).toEqual(["r1"]);
    expect(store.list).toEqual([]);
  });

  test("сервер лежит (5xx) — ждём; сервер токен не знает (4xx) — снимаем", async () => {
    const store = memoryRevokeStore(["r1", "r2"]);
    await flushRevocations(store, () => fail(503));
    expect(store.list).toEqual(["r1", "r2"]);

    await flushRevocations(store, () => fail(400));
    expect(store.list).toEqual([]);
  });

  test("токен, поставленный в очередь во время прогона, не теряется", async () => {
    const store = memoryRevokeStore(["r1"]);
    await flushRevocations(store, async () => {
      // пока уходил r1, на устройстве вышел ещё кто-то
      await queueRevocation(store, "r2");
    });
    expect(store.list).toEqual(["r2"]);
  });

  test("список не растёт без предела и не хранит дублей", async () => {
    const store = memoryRevokeStore();
    for (let i = 0; i < REVOKE_CAP + 3; i++) await queueRevocation(store, `r${i}`);
    await queueRevocation(store, `r${REVOKE_CAP + 2}`);
    expect(store.list).toHaveLength(REVOKE_CAP);
    expect(new Set(store.list).size).toBe(REVOKE_CAP);
    expect(store.list.at(-1)).toBe(`r${REVOKE_CAP + 2}`);
  });
});
