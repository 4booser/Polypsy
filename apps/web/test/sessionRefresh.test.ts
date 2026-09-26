import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, refreshesOn401, tokenStore } from "../src/api";

/**
 * Тихое продление сессии: какой 401 чинится обменом refresh.
 *
 * Внешний разбор 2026-09-26: консоль исключала из продления весь
 * /api/auth/*, включая защищённый GET /api/auth/me — тот самый, которым
 * она восстанавливает сессию при открытии. Access живёт полчаса, refresh —
 * тридцать дней; открыл консоль утром — /me отвечает 401, обмена нет, и
 * старт чистит сессию, хотя refresh жив. Человек входил заново каждое
 * утро без всякой причины.
 *
 * Исключены только маршруты, чей 401 — ответ о предъявленных учётных
 * данных (пароль, код, сам refresh), а не об истёкшем access: обмен там
 * ничего не чинит, а повтор посчитал бы неверный пароль дважды.
 */

/* ── хранилища и сеть — подмена на время теста ── */

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

const saved = {
  fetch: globalThis.fetch,
  localStorage: (globalThis as { localStorage?: Storage }).localStorage,
  sessionStorage: (globalThis as { sessionStorage?: Storage }).sessionStorage,
};

let calls: string[] = [];

/**
 * Сервер-макет: access «old» истёк, refresh «r1» жив и меняется на
 * «new»/«r2» — один раз. Повтор погашенного refresh — кража: семья
 * гасится вместе с access-токенами, как на настоящем сервере.
 */
const server = {
  used: new Set<string>(),
  familyRevoked: false,
  /** запрос /me «в полёте» — сюда тест вставляет то, что успела другая вкладка */
  beforeMe: null as null | (() => void),
  exchange(raw: string | undefined): { token: string; refreshToken: string } | null {
    if (this.familyRevoked || !raw) return null;
    if (this.used.has(raw)) {
      this.familyRevoked = true;
      return null;
    }
    if (raw !== "r1") return null;
    this.used.add(raw);
    return { token: "new", refreshToken: "r2" };
  },
};

function installServer() {
  calls = [];
  server.used = new Set();
  server.familyRevoked = false;
  server.beforeMe = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    const auth = new Headers(init?.headers).get("Authorization");
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/refresh") {
      const { refreshToken } = JSON.parse(String(init?.body ?? "{}")) as { refreshToken?: string };
      const pair = server.exchange(refreshToken);
      return pair ? reply(200, pair) : reply(401, { error: "expired" });
    }
    if (path === "/api/auth/login") return reply(401, { error: "wrong password" });
    if (path === "/api/auth/password") return reply(401, { error: "wrong current password" });
    if (path === "/api/auth/me" && server.beforeMe) {
      const hook = server.beforeMe;
      server.beforeMe = null;
      hook();
    }
    return auth === "Bearer new" && !server.familyRevoked
      ? reply(200, { id: "u1", email: "u1@test" })
      : reply(401, { error: "expired" });
  }) as typeof fetch;
}

/* ── замок между вкладками: одна очередь на всё, как navigator.locks для одного имени ── */

function installLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  const locks = {
    request: (_name: string, callback: () => Promise<unknown>) => {
      const run = tail.then(() => callback());
      tail = run.catch(() => {});
      return run;
    },
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  return locks;
}

function removeLocks() {
  delete (globalThis.navigator as { locks?: unknown }).locks;
}

beforeEach(async () => {
  /*
   * Общий на вкладку обмен отпускается таймером после завершения (api.ts,
   * tryRefresh): следующий тест не должен получить итог обмена предыдущего.
   */
  await new Promise((r) => setTimeout(r, 1));
  (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
  tokenStore.set("old");
  tokenStore.setRefresh("r1");
  installServer();
});

afterEach(() => {
  removeLocks();
  globalThis.fetch = saved.fetch;
  (globalThis as { localStorage?: Storage }).localStorage = saved.localStorage;
  (globalThis as { sessionStorage?: Storage }).sessionStorage = saved.sessionStorage;
});

describe("какой 401 чинится обменом refresh", () => {
  test("защищённые маршруты /api/auth — да", () => {
    expect(refreshesOn401("/api/auth/me")).toBe(true);
    expect(refreshesOn401("/api/auth/me/workspace")).toBe(true);
    expect(refreshesOn401("/api/auth/mfa")).toBe(true);
    expect(refreshesOn401("/api/auth/google/link")).toBe(true);
    expect(refreshesOn401("/api/patients?page=2")).toBe(true);
  });

  test("вход, обмен, выход и проверки пароля/кода — нет", () => {
    for (const path of [
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/refresh",
      "/api/auth/logout",
      "/api/auth/mfa/login",
      "/api/auth/google/exchange",
      "/api/auth/password",
      "/api/auth/google/unlink",
      "/api/auth/mfa/disable",
    ]) {
      expect(refreshesOn401(path), path).toBe(false);
    }
  });
});

describe("восстановление сессии при открытии", () => {
  test("истёкший access и живой refresh — /me проходит после обмена", async () => {
    const me = await api.me();
    expect(me.id).toBe("u1");
    expect(calls).toEqual(["/api/auth/me", "/api/auth/refresh", "/api/auth/me"]);
    expect(tokenStore.get()).toBe("new");
    expect(tokenStore.getRefresh()).toBe("r2");
  });

  test("неверный пароль на входе обмена не запускает", async () => {
    await expect(api.login("u1@test", "nope")).rejects.toThrow();
    expect(calls).toEqual(["/api/auth/login"]);
    // и сессия, которая была, не стёрта чужим отказом
    expect(tokenStore.getRefresh()).toBe("r1");
  });

  test("неверный текущий пароль не повторяется и не жжёт refresh", async () => {
    await expect(api.changePassword("wrong", "whatever-long")).rejects.toThrow();
    expect(calls).toEqual(["/api/auth/password"]);
    expect(tokenStore.getRefresh()).toBe("r1");
  });
});

describe("обмен refresh между вкладками", () => {
  /*
   * Внешний разбор 2026-09-26: refresh — общий, в localStorage, а замок
   * «обмен уже идёт» — свой в каждой вкладке. Две вкладки с истёкшим access
   * меняли один и тот же refresh; второй обмен сервер читал как повтор
   * украденного токена и гасил всю семью — человек вылетал из всех вкладок
   * разом, просто открыв вторую.
   */
  test("вкладка ждёт чужой обмен и берёт его результат, а не меняет тот же refresh второй раз", async () => {
    const locks = installLocks();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // другая вкладка уже меняет r1: ответ сервера получен, в хранилище ещё не записан
    const other = locks.request("any", async () => {
      const pair = server.exchange("r1");
      await gate;
      tokenStore.set(pair!.token);
      tokenStore.setRefresh(pair!.refreshToken);
    });

    const me = api.me();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await other;

    expect((await me).id).toBe("u1");
    expect(calls, "вкладка обменяла refresh сама, не дождавшись чужого обмена").toEqual([
      "/api/auth/me",
      "/api/auth/me",
    ]);
    expect(server.familyRevoked, "сервер прочёл второй обмен как кражу и погасил семью").toBe(false);
    expect(tokenStore.getRefresh()).toBe("r2");
  });

  test("без navigator.locks: токен сменился, пока летел запрос, — берём его, не меняем снова", async () => {
    removeLocks();
    // пока наш /me летел, другая вкладка успела обменять r1 и записать пару
    server.beforeMe = () => {
      const pair = server.exchange("r1");
      tokenStore.set(pair!.token);
      tokenStore.setRefresh(pair!.refreshToken);
    };

    expect((await api.me()).id).toBe("u1");
    expect(calls).toEqual(["/api/auth/me", "/api/auth/me"]);
    expect(server.familyRevoked).toBe(false);
  });

  test("свой обмен — под замком, и пара записывается до того, как замок отпущен", async () => {
    installLocks();
    expect((await api.me()).id).toBe("u1");
    expect(calls).toEqual(["/api/auth/me", "/api/auth/refresh", "/api/auth/me"]);
    expect(tokenStore.get()).toBe("new");
  });
});
