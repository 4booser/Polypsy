import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, ApiError, impersonationStore, tokenStore } from "../src/api";

/**
 * Срок входа «от имени» вышел (#167).
 *
 * Слот «от имени» живёт полчаса. По истечении он считался пустым, и вкладка
 * молча переходила на собственный токен суперадмина: полоса «тільки
 * перегляд» и профиль другого человека на экране, а запросы — уже своими
 * правами, и кнопки записи («Підписати» чужое заключение) срабатывали по-
 * настоящему. Возврат на «Користувачі» был только на 401 при живом слоте —
 * то есть никогда.
 *
 * Теперь истечение по часам — то же, что 401: слот чистится, вкладка уходит
 * на /ops/users, своим токеном не уходит ничего.
 */

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage; window?: unknown };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage, window: g.window };

/** Что ушло в сеть: адрес и токен */
let sent: { path: string; auth: string | null }[] = [];
let assigned: string[] = [];
/** Сервер отвечает не сразу — чтобы срок мог выйти, пока запрос летит */
let latencyMs = 0;

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 1));
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  sent = [];
  assigned = [];
  latencyMs = 0;
  g.window = { location: { assign: (to: string) => assigned.push(to) }, dispatchEvent: () => true };
  tokenStore.set("own-access");
  tokenStore.setRefresh("own-refresh");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const auth = new Headers(init?.headers).get("Authorization");
    sent.push({ path, auth });
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/refresh") return reply(200, { token: "own-access-2", refreshToken: "own-refresh-2" });
    if (auth === "Bearer own-access" || auth === "Bearer own-access-2") return reply(200, { as: "superadmin" });
    // токен «от имени» сервер принимает, только пока не вышел срок теста
    if (auth === "Bearer imp-live") return reply(200, { as: "doctor-x" });
    return reply(401, { error: "Перегляд від імені завершено" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
  g.window = saved.window;
});

const slot = (token: string, msFromNow: number) => ({
  token,
  sessionId: "imp-session",
  expiresAt: new Date(Date.now() + msFromNow).toISOString(),
});

async function settle<T>(p: Promise<T>) {
  return p.then(
    (body) => ({ ok: true as const, body }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

describe("вход «от имени» истёк по часам", () => {
  test("запрос не уходит своим токеном: 401, слот чищен, вкладка — на «Користувачі»", async () => {
    impersonationStore.set(slot("imp-old", -60_000));
    expect(tokenStore.get(), "истёкший слот открыл свой токен суперадмина").toBeNull();

    const outcome = await settle(api.patientCard("x-patient"));
    expect(sent, "после истечения запрос ушёл").toEqual([]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: ApiError }).error.status).toBe(401);
    expect(impersonationStore.slot(), "слот остался лежать").toBeNull();
    expect(assigned).toEqual(["/ops/users"]);
  });

  test("срок вышел, пока запрос летел: 401 не меняется на свой refresh и не повторяется своим токеном", async () => {
    impersonationStore.set(slot("imp-dying", 30));
    latencyMs = 60;
    const outcome = await settle(api.patientCard("x-patient"));
    expect(sent, "повтор ушёл своим токеном").toEqual([{ path: "/api/patients/x-patient/card", auth: "Bearer imp-dying" }]);
    expect(outcome.ok).toBe(false);
    expect(impersonationStore.slot()).toBeNull();
    expect(assigned).toEqual(["/ops/users"]);
    // своя пара цела: «вийти» возвращает к ней без нового входа
    expect(tokenStore.own()).toBe("own-access");
    expect(tokenStore.getRefresh()).toBe("own-refresh");
  });

  test("положительный контроль: живой слот — его токеном; без слота — своим", async () => {
    impersonationStore.set(slot("imp-live", 60_000));
    expect((await api.patientCard("x-patient")) as unknown).toEqual({ as: "doctor-x" });
    impersonationStore.clear();
    expect((await api.patientCard("x-patient")) as unknown).toEqual({ as: "superadmin" });
    expect(sent.map((s) => s.auth)).toEqual(["Bearer imp-live", "Bearer own-access"]);
    expect(assigned).toEqual([]);
  });

  test("при открытии вкладки истёкший слот убирается, живой остаётся", () => {
    expect(typeof impersonationStore.dropExpired).toBe("function");
    impersonationStore.set(slot("imp-old", -1));
    impersonationStore.dropExpired();
    expect(impersonationStore.slot()).toBeNull();
    expect(tokenStore.get()).toBe("own-access");

    impersonationStore.set(slot("imp-live", 60_000));
    impersonationStore.dropExpired();
    expect(tokenStore.get()).toBe("imp-live");

    const auth = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");
    expect(auth.includes("impersonationStore.dropExpired()"), "старт сессии не убирает истёкший слот").toBe(true);
  });
});
