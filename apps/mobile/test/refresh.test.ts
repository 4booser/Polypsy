import { beforeEach, describe, expect, test } from "bun:test";
import { isTransientStatus } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { enqueue, flush, pendingCount, rejectedItems } from "../src/offline/queue";
import {
  createRefresher,
  failureStatusAfterRefresh,
  type RefreshDeps,
  type RefreshOutcome,
  type RefreshPair,
} from "../src/auth/refresh";

/**
 * Продление сессии (auth/refresh.ts) — два дефекта ревью.
 *
 * CR-020: общий promise обмена не сбрасывался на раннем выходе «refresh нет»,
 * и после повторного входа продление возвращало старый отказ, не трогая сеть.
 *
 * CR-021: обрыв сети на обмене и недействительный refresh сводились к одному
 * false; очередь несданных получала исходный 401 и помечала сдачу
 * «отклонённой сервером» — до ручного повтора.
 */

function harness(initialRefresh: string | null) {
  const box = {
    refresh: initialRefresh,
    saved: [] as RefreshPair[],
    calls: 0,
    exchange: null as null | ((raw: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>),
    readFails: false,
  };
  const ok = (pair: RefreshPair) => Promise.resolve({ ok: true, status: 200, json: async () => pair });
  const deps: RefreshDeps = {
    getRefresh: async () => {
      if (box.readFails) throw new Error("secure store unavailable");
      return box.refresh;
    },
    exchange: (raw) => {
      box.calls++;
      return (box.exchange ?? (() => ok({ token: `t-${raw}`, refreshToken: `r-${raw}` })))(raw);
    },
    save: async (pair) => {
      box.saved.push(pair);
      box.refresh = pair.refreshToken;
    },
  };
  return { box, refresh: createRefresher(deps) };
}

describe("CR-020: отсутствующий refresh не фиксирует отказ навсегда", () => {
  test("нет refresh → отказ; человек вошёл → продление снова идёт в сеть", async () => {
    const { box, refresh } = harness(null);

    // 401 от старого запроса после выхода: токенов нет, сети не трогаем
    expect(await refresh()).toEqual({ kind: "invalid" });
    expect(box.calls).toBe(0);

    // вошли снова — хранилище получило новый refresh
    box.refresh = "fresh-1";
    const again = await refresh();
    expect(again).toEqual({ kind: "refreshed" });
    expect(box.calls).toBe(1);
    expect(box.saved).toEqual([{ token: "t-fresh-1", refreshToken: "r-fresh-1" }]);
  });

  test("общий promise сбрасывается после сбоя чтения хранилища и после сбоя сети", async () => {
    const { box, refresh } = harness("r0");

    box.readFails = true;
    expect(await refresh()).toEqual({ kind: "unavailable", status: 0 });
    box.readFails = false;

    box.exchange = () => Promise.reject(new TypeError("connection reset"));
    expect(await refresh()).toEqual({ kind: "unavailable", status: 0 });
    expect(box.calls).toBe(1);

    box.exchange = null;
    expect(await refresh()).toEqual({ kind: "refreshed" });
    expect(box.calls).toBe(2);
  });

  test("одновременные 401 делят один обмен, следующий после него — новый", async () => {
    const { box, refresh } = harness("r0");
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a).toEqual({ kind: "refreshed" });
    expect(b).toEqual({ kind: "refreshed" });
    expect(box.calls).toBe(1);

    expect(await refresh()).toEqual({ kind: "refreshed" });
    expect(box.calls).toBe(2);
  });

  test("человек вышел, пока шёл обмен — новая пара не записывается", async () => {
    const { box, refresh } = harness("r0");
    box.exchange = async (raw) => {
      box.refresh = null; // выход посреди обмена
      return { ok: true, status: 200, json: async () => ({ token: `t-${raw}`, refreshToken: `r-${raw}` }) };
    };
    expect(await refresh()).toEqual({ kind: "invalid" });
    expect(box.saved).toEqual([]);
  });
});

describe("CR-021: сетевой сбой продления отличается от недействительной сессии", () => {
  const reject = (status: number) => () => Promise.resolve({ ok: false, status, json: async () => ({}) });

  test("сервер отверг refresh (4xx) — сессия недействительна, наружу идёт исходный 401", async () => {
    const h = harness("r0");
    h.box.exchange = reject(401);
    const outcome = (await h.refresh()) as Exclude<RefreshOutcome, { kind: "refreshed" }>;
    expect(outcome).toEqual({ kind: "invalid" });
    expect(failureStatusAfterRefresh(outcome, 401)).toBe(401);
    expect(isTransientStatus(failureStatusAfterRefresh(outcome, 401))).toBe(false);
  });

  test("обрыв сети на обмене — временный сбой со статусом 0", async () => {
    const h = harness("r0");
    h.box.exchange = () => Promise.reject(new TypeError("connection reset"));
    const outcome = (await h.refresh()) as Exclude<RefreshOutcome, { kind: "refreshed" }>;
    expect(outcome).toEqual({ kind: "unavailable", status: 0 });
    expect(isTransientStatus(failureStatusAfterRefresh(outcome, 401))).toBe(true);
  });

  test("сервер лежит (503) — временный сбой с его статусом; обрезанный ответ без пары — тоже", async () => {
    const h = harness("r0");
    h.box.exchange = reject(503);
    expect(await h.refresh()).toEqual({ kind: "unavailable", status: 503 });

    h.box.exchange = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    expect(await h.refresh()).toEqual({ kind: "unavailable", status: 0 });
    expect(h.box.saved).toEqual([]);
  });
});

describe("CR-021: очередь несданных при сбое продления", () => {
  const A = "owner-a";
  beforeEach(() => resetStore());

  /*
   * Отправка из очереди: запрос получил 401, продление дало исход `outcome`,
   * наружу летит ошибка со статусом, который даёт failureStatusAfterRefresh
   * (ровно так поступает request() в api/client.ts).
   */
  function submitAfter(outcome: Exclude<RefreshOutcome, { kind: "refreshed" }>) {
    return async () => {
      throw Object.assign(new Error("401"), { status: failureStatusAfterRefresh(outcome, 401) });
    };
  }

  test("обрыв сети при продлении — сдача остаётся в автоматическом повторе", async () => {
    enqueue(A, "s1", {});
    const res = await flush(A, submitAfter({ kind: "unavailable", status: 0 }));
    expect(res).toEqual({ sent: 0, left: 1, rejected: 0 });
    expect(rejectedItems(A)).toHaveLength(0);

    // связь вернулась, сессия продлилась — уходит сама, без ручного повтора
    expect(await flush(A, async () => {})).toEqual({ sent: 1, left: 0, rejected: 0 });
  });

  test("сервер продления лежит (503) — тоже ждём, а не помечаем", async () => {
    enqueue(A, "s1", {});
    const res = await flush(A, submitAfter({ kind: "unavailable", status: 503 }));
    expect(res).toEqual({ sent: 0, left: 1, rejected: 0 });
  });

  test("сессия недействительна — отказ по существу, сдача ждёт разбора человеком", async () => {
    enqueue(A, "s1", {});
    const res = await flush(A, submitAfter({ kind: "invalid" }));
    expect(res).toEqual({ sent: 0, left: 0, rejected: 1 });
    expect(pendingCount(A)).toBe(0);
    expect(rejectedItems(A)).toHaveLength(1);
  });
});
