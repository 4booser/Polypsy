import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as client from "../src/api";
import { api, ApiError, tokenStore } from "../src/api";
import { createOutbox, outbox, type OutboxStorage } from "../src/patient/outbox";

/**
 * Смена человека в соседней вкладке (#166).
 *
 * Токены лежат в localStorage — общем для всех вкладок, — а профиль на
 * экране, кэш и очередь кабинета выбирает каждая вкладка сама. Общий
 * компьютер: вкладка 1 — кабинет A с неотправленной сдачей, во вкладке 2
 * входит B. Таймер вкладки 1 слал ответы A с токеном B — они ложились в
 * карту B, а у A стирались как отправленные; вкладка врача A после 401
 * подхватывала токен B и работала дальше от его имени.
 *
 * Здесь три рубежа: у записи очереди есть владелец, сверяемый с `sub`
 * токена; продление не принимает токен другого владельца; событие `storage`
 * со сменой владельца сбрасывает вкладку.
 */

/** JWT без подписи: клиенту важен только `sub` (api.ts, ownerOfToken) */
function jwt(sub: string, n = 1): string {
  const body = btoa(JSON.stringify({ sub, n })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

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

const TOKEN_KEY = "quizzy.web.token";
const REFRESH_KEY = "quizzy.web.refresh";
/* новые имена — через пространство модуля: на коде до правки файл грузится и падает по существу, а не на импорте */
const SESSION_TAKEN_EVENT = "quizzy:session-taken";
const ownerOfToken = (token: string | null) => client.ownerOfToken(token);
const watchSession: typeof client.watchSession = (target, onForeign) => client.watchSession(target, onForeign);

const g = globalThis as {
  localStorage?: Storage;
  sessionStorage?: Storage;
  window?: unknown;
};
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage, window: g.window };

/** Что ушло в сеть: адрес и токен из заголовка */
let sent: { path: string; auth: string | null }[] = [];
let windowEvents: string[] = [];

beforeEach(async () => {
  // общий на вкладку обмен отпускается таймером (api.ts, tryRefresh): не брать итог прошлого теста
  await new Promise((r) => setTimeout(r, 1));
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  sent = [];
  windowEvents = [];
  const win = new EventTarget();
  win.addEventListener(SESSION_TAKEN_EVENT, () => windowEvents.push(SESSION_TAKEN_EVENT));
  g.window = Object.assign(win, { location: { assign: () => {} } });
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
  g.window = saved.window;
});

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("владелец токена", () => {
  test("sub из полезной нагрузки; не JWT — никто", () => {
    expect(client.SESSION_TAKEN_EVENT).toBe(SESSION_TAKEN_EVENT);
    expect(ownerOfToken(jwt("user-a"))).toBe("user-a");
    expect(ownerOfToken(null)).toBeNull();
    expect(ownerOfToken("old")).toBeNull();
    expect(ownerOfToken("a.!!!.c")).toBeNull();
  });
});

describe("очередь кабинета сверяет владельца записи с токеном", () => {
  const memory = (): OutboxStorage => {
    const map = new Map<string, string>();
    return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
  };

  test("очередь A при токене B ничего не шлёт, не стирает и не помечает отказом", async () => {
    let owner = "A";
    const box = createOutbox(memory(), () => owner);
    const item = box.enqueue("A", "s1", { answers: [] });
    expect(item.ownerId).toBe("A");

    owner = "B";
    const submitted: string[] = [];
    const res = await box.flush("A", async (i) => {
      submitted.push(i.id);
    });
    expect(submitted, "сдача A ушла под токеном B").toEqual([]);
    expect(res).toEqual({ sent: 0, left: 1, rejected: 0 });
    expect(box.waiting("A")).toHaveLength(1);

    // положительный контроль: A вернулся — уходит
    owner = "A";
    const back = await box.flush("A", async (i) => {
      submitted.push(i.id);
    });
    expect(back.sent).toBe(1);
    expect(submitted).toEqual([item.id]);
    expect(box.waiting("A")).toHaveLength(0);
  });

  test("очередь вкладки — с токеном из хранилища: у B запрос не уходит, у A уходит с токеном A", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ path: String(input), auth: new Headers(init?.headers).get("Authorization") });
      return reply(200, { id: "r1", scores: [] });
    }) as typeof fetch;
    const user = `patient-${crypto.randomUUID()}`;
    const submit = (i: { surveyId: string; payload: unknown }) => api.submitResponse(i.surveyId, i.payload as never);
    outbox.enqueue(user, "s1", { startedAt: "2026-10-11T10:00:00+03:00", durationMs: 1, answers: [], events: [] });

    // в соседней вкладке вошёл другой человек
    tokenStore.set(jwt("someone-else"));
    await outbox.flush(user, submit);
    expect(sent, "ответы пациента ушли с чужим токеном").toEqual([]);
    expect(outbox.waiting(user)).toHaveLength(1);

    // вернулся владелец — сдача уходит его токеном и из очереди убирается
    tokenStore.set(jwt(user));
    await outbox.flush(user, submit);
    expect(sent).toEqual([{ path: "/api/surveys/s1/responses", auth: `Bearer ${jwt(user)}` }]);
    expect(outbox.waiting(user)).toHaveLength(0);
  });
});

describe("продление не принимает токен другого человека", () => {
  /**
   * Запрос вкладки A уходит со старым токеном A и получает 401; пока он
   * летел, соседняя вкладка записала в хранилище пару `next`.
   */
  async function expiredWhileOtherTabWrote(next: { token: string; refresh: string }) {
    tokenStore.set(jwt("doctor-a", 1));
    tokenStore.setRefresh("ra1");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const auth = new Headers(init?.headers).get("Authorization");
      sent.push({ path, auth });
      if (auth === `Bearer ${jwt("doctor-a", 1)}`) {
        tokenStore.set(next.token);
        tokenStore.setRefresh(next.refresh);
        return reply(401, { error: "expired" });
      }
      if (path === "/api/auth/refresh") return reply(401, { error: "unexpected" });
      return reply(200, { whoami: auth });
    }) as typeof fetch;
    return api.patientCard("p1").then(
      (body) => ({ ok: true as const, body }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  test("в соседней вкладке вошёл B — вкладка A не берёт его токен, не стирает его и выходит", async () => {
    const outcome = await expiredWhileOtherTabWrote({ token: jwt("doctor-b"), refresh: "rb1" });
    expect(
      sent.map((s) => s.auth),
      "после 401 запрос повторён с токеном B",
    ).toEqual([`Bearer ${jwt("doctor-a", 1)}`]);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: ApiError }).error.status).toBe(401);
    // сессия B — его: вкладка A её не трогает
    expect(g.localStorage!.getItem(TOKEN_KEY)).toBe(jwt("doctor-b"));
    expect(g.localStorage!.getItem(REFRESH_KEY)).toBe("rb1");
    // и выходит: событие ловит AuthProvider
    expect(windowEvents).toEqual([SESSION_TAKEN_EVENT]);
  });

  test("положительный контроль: соседняя вкладка продлила сессию того же A — повтор с новым токеном", async () => {
    const outcome = await expiredWhileOtherTabWrote({ token: jwt("doctor-a", 2), refresh: "ra2" });
    expect(sent.map((s) => s.auth)).toEqual([`Bearer ${jwt("doctor-a", 1)}`, `Bearer ${jwt("doctor-a", 2)}`]);
    expect(outcome.ok).toBe(true);
    expect(windowEvents).toEqual([]);
  });
});

describe("событие storage из другой вкладки", () => {
  function storageEvent(key: string | null, oldValue: string | null, newValue: string | null): Event {
    return Object.assign(new Event("storage"), { key, oldValue, newValue });
  }

  test("токен сменил владельца или исчез — вкладка сбрасывается; продление и чужие ключи — нет", () => {
    const target = new EventTarget();
    let resets = 0;
    const off = watchSession(target, () => resets++);

    target.dispatchEvent(storageEvent(TOKEN_KEY, jwt("a", 1), jwt("a", 2)));
    target.dispatchEvent(storageEvent(REFRESH_KEY, "r1", "r2"));
    target.dispatchEvent(storageEvent("quizzy.theme.v2", "dark", "light"));
    expect(resets, "продление той же сессии или чужой ключ сбросили вкладку").toBe(0);

    target.dispatchEvent(storageEvent(TOKEN_KEY, jwt("a"), jwt("b")));
    expect(resets, "вошёл другой человек — вкладка не сброшена").toBe(1);
    target.dispatchEvent(storageEvent(TOKEN_KEY, jwt("b"), null));
    expect(resets, "выход в соседней вкладке — эта осталась внутри").toBe(2);
    target.dispatchEvent(storageEvent(null, null, null));
    expect(resets, "хранилище очищено целиком").toBe(3);
    target.dispatchEvent(new Event(SESSION_TAKEN_EVENT));
    expect(resets, "продление нашло чужую сессию — вкладка не вышла").toBe(4);

    off();
    target.dispatchEvent(storageEvent(TOKEN_KEY, jwt("a"), jwt("c")));
    expect(resets).toBe(4);
  });

  test("вкладку сбрасывает AuthProvider: слушатель стоит на window", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");
    expect(src.includes("watchSession(window"), "auth.tsx не подписан на смену человека").toBe(true);
  });
});
