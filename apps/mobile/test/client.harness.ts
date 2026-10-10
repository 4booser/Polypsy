import { afterEach, beforeEach, mock } from "bun:test";
import { ownerOfToken, setActiveOwner, signedIn } from "../src/offline/owner";

/**
 * Клиент запросов (src/api/client.ts) в тестовом процессе.
 *
 * Сам клиент react-native не тянет — тянут соседи: хранилище токенов
 * (expo-secure-store) и адрес API (expo-constants). Они подменяются здесь до
 * первого импорта клиента; хранилище данных — память из store.mock.ts, сеть —
 * подменой fetch: что ответит сервер и когда, решает тест.
 *
 * Хранилище токенов ведёт себя как настоящее (src/storage.ts): каждое чтение,
 * запись и очистка называют владельца офлайн-данных, очистка — первым делом.
 */
export const session: { token: string | null; refresh: string | null } = { token: null, refresh: null };

mock.module("../src/storage", () => ({
  tokenStorage: {
    get: async () => {
      setActiveOwner(ownerOfToken(session.token));
      return session.token;
    },
    set: async (token: string) => {
      session.token = token;
      signedIn(ownerOfToken(token));
    },
    getRefresh: async () => session.refresh,
    setRefresh: async (token: string) => {
      session.refresh = token;
    },
    clear: async () => {
      setActiveOwner(null);
      session.token = null;
      session.refresh = null;
    },
  },
  revokeStorage: { get: async () => [], set: async () => {} },
  prefStorage: { get: async () => null, set: async () => {} },
}));
mock.module("../src/config", () => ({ API_URL: "http://api.test" }));
// платформа для отметки устройства (offline/device.ts, platformName) — без самого react-native
mock.module("react-native", () => ({ Platform: { OS: "android" } }));

/** Токен с нужным sub — владелец офлайн-данных определяется по нему (offline/owner.ts) */
export function tokenOf(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
}

export function signIn(sub: string): void {
  session.token = tokenOf(sub);
  session.refresh = `refresh-${sub}`;
  signedIn(sub);
}

/** Сервер: путь запроса → ответ. Бросить — значит «сети нет» (fetch так и падает) */
export type Server = (path: string, init: RequestInit) => Response | Promise<Response>;

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const noNetwork = (): never => {
  throw new TypeError("Network request failed");
};

let server: Server = noNetwork;
export function serve(next: Server): void {
  server = next;
}

/**
 * Перед каждым тестом файла — никто не вошёл, сети нет; после — настоящий
 * fetch на место. Зовётся из самого тестового файла: модуль подмен грузится
 * один раз на процесс, и хуки, заведённые при его загрузке, достались бы
 * только первому файлу.
 */
export function useFakeServer(): void {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    session.token = null;
    session.refresh = null;
    setActiveOwner(null);
    server = noNetwork;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      server(new URL(String(input)).pathname, init ?? {})) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
}

/** Клиент — после подмен: статический импорт поднялся бы выше mock.module */
export async function loadClient() {
  return (await import("../src/api/client")).api;
}
