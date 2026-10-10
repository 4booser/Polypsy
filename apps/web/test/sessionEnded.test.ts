import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { api, tokenStore } from "../src/api";
import * as client from "../src/api";
import * as auth from "../src/auth";

/**
 * Сессию погасил сервер (#173).
 *
 * Учётку выключили, её сессии завершили, refresh истёк — 401, который обмен
 * refresh уже не чинит. Токены стирались молча, а профиль и экран с данными
 * оставались: консоль стояла на карточке пациента с его именем, и каждое
 * действие кончалось тостом «Сесія закінчилась». Теперь окончательный 401
 * сбрасывает пользователя и кэш, и вкладка показывает вход.
 *
 * Цепочка та же, что в браузере: request → событие окна → watchSession →
 * сброс вкладки (dropTabSession, его зовёт AuthProvider).
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

/* имя события — контракт между api.ts и AuthProvider; на коде до правки файл грузится и падает по существу */
const SESSION_ENDED_EVENT = "quizzy:session-ended";

/** Состояние вкладки, как его держит AuthProvider */
interface Tab {
  user: unknown;
  perms: ReadonlySet<string>;
  mfa: unknown;
  cache: QueryClient;
  ended: number;
}

let tab: Tab;
let calls: string[] = [];
/** Принимает ли сервер refresh */
let refreshAlive = true;
/** Обмен не доходит (сеть) или сервер сбоит (503) — связь, а не сессия */
let refreshBroken: null | "network" | 503 = null;

beforeEach(async () => {
  // общий на вкладку обмен отпускается таймером (api.ts, tryRefresh): не брать итог прошлого теста
  await new Promise((r) => setTimeout(r, 1));
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  calls = [];
  refreshAlive = true;
  refreshBroken = null;

  const cache = new QueryClient();
  cache.setQueryData(["patientCard", "p1"], { fullName: "Коваль Ірина" });
  tab = { user: { id: "doctor-a" }, perms: new Set(["patients.read"]), mfa: null, cache, ended: 0 };

  const win = new EventTarget();
  win.addEventListener(SESSION_ENDED_EVENT, () => tab.ended++);
  g.window = Object.assign(win, { location: { assign: () => {} } });
  client.watchSession?.(win, () =>
    auth.dropTabSession(
      {
        user: (u) => void (tab.user = u),
        perms: (p) => void (tab.perms = p),
        mfa: (m) => void (tab.mfa = m),
      },
      cache,
    ),
  );

  tokenStore.set("access-old");
  tokenStore.setRefresh("refresh-1");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    const authz = new Headers(init?.headers).get("Authorization");
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/refresh") {
      if (refreshBroken === "network") throw new TypeError("Failed to fetch");
      if (refreshBroken === 503) return reply(503, { error: "Повторіть запит", code: "err.retryRequest" });
      return refreshAlive ? reply(200, { token: "access-new", refreshToken: "refresh-2" }) : reply(401, { error: "Сесія закінчилась" });
    }
    if (path === "/api/auth/login") return reply(401, { error: "Невірний пароль" });
    return authz === "Bearer access-new" ? reply(200, { fullName: "Коваль Ірина" }) : reply(401, { error: "Сесія закінчилась" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
  g.window = saved.window;
});

/** Дать сработать отложенной очистке кэша */
const afterScreensGone = () => new Promise((r) => setTimeout(r, 5));

describe("окончательный 401", () => {
  test("refresh не принят — пользователь сброшен, кэш пуст, токены стёрты", async () => {
    refreshAlive = false;
    await expect(api.patientCard("p1")).rejects.toThrow();
    await afterScreensGone();

    expect(calls).toEqual(["/api/patients/p1/card", "/api/auth/refresh"]);
    expect(tab.ended, "вкладке не сказали, что сессии нет").toBe(1);
    expect(tab.user, "профиль остался на экране").toBeNull();
    expect(tab.perms.size).toBe(0);
    expect(tab.cache.getQueryCache().getAll(), "в кэше остались данные пациента").toHaveLength(0);
    expect(tokenStore.own()).toBeNull();
    expect(tokenStore.getRefresh()).toBeNull();
  });

  test("положительный контроль: продление удалось — ничего не сброшено", async () => {
    expect(await api.patientCard("p1")).toEqual({ fullName: "Коваль Ірина" } as never);
    await afterScreensGone();

    expect(calls).toEqual(["/api/patients/p1/card", "/api/auth/refresh", "/api/patients/p1/card"]);
    expect(tab.ended).toBe(0);
    expect(tab.user).toEqual({ id: "doctor-a" });
    expect(tab.perms.size).toBe(1);
    expect(tab.cache.getQueryData<{ fullName: string }>(["patientCard", "p1"])).toEqual({ fullName: "Коваль Ірина" });
  });

  test("неверный пароль — не конец сессии: вкладку не сбрасывает", async () => {
    await expect(api.login("doctor-a@test", "nope")).rejects.toThrow();
    await afterScreensGone();
    expect(tab.ended).toBe(0);
    expect(tab.user).toEqual({ id: "doctor-a" });
    expect(tokenStore.getRefresh()).toBe("refresh-1");
  });

  for (const broken of ["network", 503] as const) {
    test(`обмен refresh не дошёл (${broken}) — сессия цела: токены на месте, вкладка остаётся, ошибка «нет связи»`, async () => {
      // ревью PR #196: секундный обрыв связи при продлении выкидывал врача из консоли
      refreshBroken = broken;
      await expect(api.patientCard("p1")).rejects.toMatchObject({ status: 0 });
      await afterScreensGone();

      expect(tab.ended, "вкладку вывели на вход из-за связи").toBe(0);
      expect(tab.user).toEqual({ id: "doctor-a" });
      expect(tab.cache.getQueryData<{ fullName: string }>(["patientCard", "p1"])).toEqual({ fullName: "Коваль Ірина" });
      expect(tokenStore.own()).toBe("access-old");
      expect(tokenStore.getRefresh()).toBe("refresh-1");
    });
  }

  test("AuthProvider сбрасывает вкладку по событию", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");
    expect(src.includes("dropTabSession({ user: setUser"), "auth.tsx не сбрасывает вкладку при конце сессии").toBe(true);
  });
});
