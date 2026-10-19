import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, session, signIn, tokenOf, useFakeServer } from "./client.harness";
import { isAborted, RequestAborted } from "../src/api/abort";
import { cache } from "../src/offline/cache";

/**
 * Отмена чтений (волна 27, api/abort.ts).
 *
 * Было: у request() не было сигнала. Специалист открывал карту пациента
 * (динамика — секунды, на холодной базе — до двадцати), не дожидался и
 * уходил — запрос шёл дальше, держал соединение и ложился в состояние
 * экрана, с которого ушли.
 *
 * Здесь — договор отмены: отменённое чтение кончается только RequestAborted.
 * Не «нет сети» — иначе чтение с кэшем отдало бы копию с прошлого раза; не
 * отказ сервера — иначе отказ доступа стёр бы кэш карты (#126); не данными —
 * даже если ответ пришёл после отмены.
 */

useFakeServer();

const STAFF = "staff-abort";
const CARD = { userId: "p1", fullName: "Петренко Іван", email: "p1@x", sex: "male" as const, age: 34, surveys: [] };
const CARD_V2 = { ...CARD, fullName: "Петренко Іван Іванович" };

/** Сервер, который держит ответ, пока его не отпустят, и честно рвёт его по сигналу — как настоящий fetch */
function held(path: string, body: unknown) {
  let release: () => void = () => {};
  const calls: string[] = [];
  serve((p, init) => {
    calls.push(p);
    if (p !== path) return json(404, { error: "not found" });
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (init.signal?.aborted) return aborted();
      init.signal?.addEventListener("abort", aborted);
      release = () => resolve(json(200, body));
    });
  });
  return { calls, release: () => release() };
}

/*
 * Срок каждой проверки — явный и короткий: сломанная отмена не падает, а
 * висит (запрос, которого никто не отпустит), и без срока прогон ждал бы её
 * вечно вместо того, чтобы назвать виновника.
 */
const SHORT = 2_000;

beforeEach(() => {
  resetStore();
});

describe("отмена чтения", () => {
  test("отменённый до отправки — fetch не зовётся вовсе", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const server = held("/api/dynamics/respondents/p1", CARD);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(api.respondentDynamics("p1", { signal: ctrl.signal })).rejects.toBeInstanceOf(RequestAborted);
    expect(server.calls).toEqual([]);
  }, SHORT);

  test("отмена посреди запроса — RequestAborted, а не «нет сети» (status 0)", async () => {
    const api = await loadClient();
    signIn(STAFF);
    held("/api/dynamics/respondents/p1", CARD);
    const ctrl = new AbortController();

    const read = api.respondentDynamics("p1", { signal: ctrl.signal });
    await Bun.sleep(0);
    ctrl.abort();

    const error = await read.catch((e) => e);
    expect(isAborted(error)).toBe(true);
    expect((error as { status?: number }).status, "отмена — не сбой сети").toBeUndefined();
  }, SHORT);

  test("карта у койки: отмена не отдаёт копию с прошлого раза и не трогает её", async () => {
    const api = await loadClient();
    signIn(STAFF);
    serve(() => json(200, CARD));
    await api.roundsCard("p1");
    expect(cache.patientCard(STAFF, "p1")?.card).toEqual(CARD);

    held("/api/dynamics/respondents/p1", CARD_V2);
    const ctrl = new AbortController();
    const read = api.roundsCard("p1", { signal: ctrl.signal });
    await Bun.sleep(0);
    ctrl.abort();

    await expect(read, "отмена отдала кэш, как будто сети нет").rejects.toBeInstanceOf(RequestAborted);
    expect(cache.patientCard(STAFF, "p1")?.card, "отмена стёрла или переписала карту").toEqual(CARD);
  }, SHORT);

  test("ответ, пришедший после отмены, не отдаётся и в кэш не ложится", async () => {
    const api = await loadClient();
    signIn(STAFF);
    serve(() => json(200, CARD));
    await api.roundsCard("p1");

    // сервер не слышит отмены (прокси, медленное тело) и отвечает всё равно
    let release: () => void = () => {};
    serve(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(200, CARD_V2));
        }),
    );
    const ctrl = new AbortController();
    const read = api.roundsCard("p1", { signal: ctrl.signal });
    await Bun.sleep(0);
    ctrl.abort();
    release();

    await expect(read).rejects.toBeInstanceOf(RequestAborted);
    expect(cache.patientCard(STAFF, "p1")?.card).toEqual(CARD);
  }, SHORT);

  test("тело, оборванное отменой, не становится данными (null)", async () => {
    const api = await loadClient();
    signIn(STAFF);
    let push: (text: string) => void = () => {};
    serve(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (text) => {
                controller.enqueue(new TextEncoder().encode(text));
                controller.close();
              };
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const ctrl = new AbortController();
    const read = api.respondentDynamics("p1", { signal: ctrl.signal });
    await Bun.sleep(0);
    ctrl.abort();
    // тело дописано обрывком: без проверки отмены разбор вернул бы null как карту
    push('{"userId":"p1"');

    await expect(read).rejects.toBeInstanceOf(RequestAborted);
  }, SHORT);

  test("истёкший токен: продление доделывается для всех, а отменённый запрос не повторяется", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const fresh = tokenOf(STAFF);
    let releaseRefresh: () => void = () => {};
    const dynamicsCalls: string[] = [];
    serve((path) => {
      if (path === "/api/auth/refresh") {
        return new Promise<Response>((resolve) => {
          releaseRefresh = () => resolve(json(200, { token: fresh, refreshToken: "refresh-next" }));
        });
      }
      dynamicsCalls.push(path);
      return json(401, { error: "expired" });
    });
    const ctrl = new AbortController();
    const read = api.respondentDynamics("p1", { signal: ctrl.signal });
    await Bun.sleep(5);
    ctrl.abort();
    releaseRefresh();

    await expect(read).rejects.toBeInstanceOf(RequestAborted);
    expect(dynamicsCalls, "отменённое чтение ушло повтором после продления").toEqual(["/api/dynamics/respondents/p1"]);
    expect(session.refresh, "продление — общее, отмена одного запроса его не обрывает").toBe("refresh-next");
  }, SHORT);

  test("без сигнала всё как было: без сети карта у койки — из кэша", async () => {
    const api = await loadClient();
    signIn(STAFF);
    serve(() => json(200, CARD));
    await api.roundsCard("p1");
    serve(noNetwork);

    const offline = await api.roundsCard("p1");
    expect(offline.card).toEqual(CARD);
    expect(offline.cachedAt).not.toBeNull();
  }, SHORT);

  test("isAborted узнаёт и свою отмену, и отмену самого fetch — и только их", () => {
    expect(isAborted(new RequestAborted())).toBe(true);
    expect(isAborted(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAborted({ status: 0, message: "offline" })).toBe(false);
    expect(isAborted(null)).toBe(false);
  });
});

describe("динамика одной методики", () => {
  test("survey сужает чтение (?survey=), без него — вся карта", async () => {
    const api = await loadClient();
    signIn(STAFF);
    serve(() => json(200, CARD));
    const urls: string[] = [];
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return fetchBefore(input, init);
    }) as typeof fetch;

    await api.respondentDynamics("p1", { survey: "s 1" });
    await api.respondentDynamics("p1");

    expect(urls).toEqual(["http://api.test/api/dynamics/respondents/p1?survey=s%201", "http://api.test/api/dynamics/respondents/p1"]);
  }, SHORT);
});
