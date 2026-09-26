import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { drafts, pickDraft, type LocalDraft } from "../src/offline/cache";
import { createLanes } from "../src/offline/draftLane";

/**
 * Автосохранение не затирает свежий черновик старым.
 *
 * Дефект: сохранения шли параллельно, и запрос с правкой 5, ответивший
 * позже запроса с правкой 6, записывал на устройство свою копию и помечал
 * её синхронизированной. Сервер при этом тоже оставался с пятой — она
 * пришла последней. После перезапуска последние ответы пропадали.
 *
 * Правило: последний выигрывает по номеру правки, а не по времени ответа.
 */

const A = "patient-a";

const draft = (revision: number, answers: number, extra: Partial<LocalDraft> = {}): LocalDraft => ({
  surveyId: "s1",
  answers: Array.from({ length: answers }, (_, i) => ({ questionId: `q${i}` })),
  startedAt: "2026-01-01T10:00:00.000Z",
  durationMs: answers * 1000,
  events: [],
  savedAt: `2026-01-01T10:${String(revision).padStart(2, "0")}:00.000Z`,
  synced: false,
  revision,
  ...extra,
});

/** Отложенный ответ сервера: тест сам решает, когда и в каком порядке запросы «отвечают» */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetStore();
});

describe("на сервер — по одному и по порядку правок", () => {
  test("пока правка в пути, ждёт только самая свежая; сервер получает их по возрастанию", async () => {
    const lanes = createLanes();
    const received: number[] = [];
    const replies = new Map<number, ReturnType<typeof deferred<string>>>();
    const send = (rev: number) => () => {
      received.push(rev);
      const d = deferred<string>();
      replies.set(rev, d);
      return d.promise;
    };

    const r5 = lanes.submit("k", 5, send(5));
    const r6 = lanes.submit("k", 6, send(6));
    const r7 = lanes.submit("k", 7, send(7));

    // в пути одна пятая; шестая вытеснена седьмой, не успев уйти
    expect(received).toEqual([5]);
    expect(await r6).toEqual({ status: "superseded" });

    replies.get(5)!.resolve("t5");
    expect(await r5).toEqual({ status: "sent", value: "t5" });
    await Bun.sleep(0);
    expect(received).toEqual([5, 7]);

    replies.get(7)!.resolve("t7");
    expect(await r7).toEqual({ status: "sent", value: "t7" });
  });

  test("старая правка после подтверждённой новой не уходит вовсе", async () => {
    const lanes = createLanes();
    const received: number[] = [];
    await lanes.submit("k", 8, async () => received.push(8));
    expect(await lanes.submit("k", 7, async () => received.push(7))).toEqual({ status: "superseded" });
    expect(await lanes.submit("k", 8, async () => received.push(8))).toEqual({ status: "superseded" });
    expect(received).toEqual([8]);
  });

  test("отказ сети правку не съедает: та же правка уходит следующей попыткой", async () => {
    const lanes = createLanes();
    await expect(lanes.submit("k", 3, () => Promise.reject(Object.assign(new Error("offline"), { status: 0 })))).rejects.toThrow(
      "offline",
    );
    expect(await lanes.submit("k", 3, async () => "ok")).toEqual({ status: "sent", value: "ok" });
  });

  test("после сдачи ждущее сохранение снимается и до сервера не доходит", async () => {
    const lanes = createLanes();
    const received: number[] = [];
    const inFlight = deferred<string>();
    const r1 = lanes.submit("k", 1, () => {
      received.push(1);
      return inFlight.promise;
    });
    const r2 = lanes.submit("k", 2, async () => {
      received.push(2);
      return "t2";
    });
    lanes.cancelPending("k");
    expect(await r2).toEqual({ status: "superseded" });
    inFlight.resolve("t1");
    await r1;
    await Bun.sleep(0);
    expect(received).toEqual([1]);
  });

  test("разные черновики друг друга не ждут", async () => {
    const lanes = createLanes();
    const slow = deferred<string>();
    const a = lanes.submit("a", 1, () => slow.promise);
    expect(await lanes.submit("b", 1, async () => "b")).toEqual({ status: "sent", value: "b" });
    slow.resolve("a");
    expect(await a).toEqual({ status: "sent", value: "a" });
  });
});

describe("на устройстве — свежая копия не затирается старой", () => {
  test("запоздавшая запись старой правки не ложится поверх новой", () => {
    expect(drafts.saveIfNewer(A, draft(6, 60))).toBe(true);
    expect(drafts.saveIfNewer(A, draft(5, 50))).toBe(false);
    expect(drafts.get(A, "s1")?.answers).toHaveLength(60);
  });

  test("подтверждение старой правки не помечает новую синхронизированной", () => {
    /*
     * Ровно дефект: ответ на правку 5 пришёл, когда на устройстве уже лежит
     * шестая. Шестая обязана остаться неотправленной — иначе её никто не
     * дошлёт.
     */
    drafts.saveIfNewer(A, draft(6, 60));
    drafts.confirm(A, "s1", 5, "2026-01-01T11:05:00.000Z");

    const stored = drafts.get(A, "s1")!;
    expect(stored.revision).toBe(6);
    expect(stored.answers).toHaveLength(60);
    expect(stored.synced).toBe(false);
    expect(drafts.unsynced(A)).toHaveLength(1);
    // время сервера при этом запомнено — по нему pickDraft поймёт, что сервер с тех пор не менялся
    expect(stored.serverSavedAt).toBe("2026-01-01T11:05:00.000Z");

    drafts.confirm(A, "s1", 6, "2026-01-01T11:06:00.000Z");
    expect(drafts.get(A, "s1")!.synced).toBe(true);
    expect(drafts.unsynced(A)).toEqual([]);
  });

  test("копия старше подтверждённой стирается: иначе её дошлют и откатят сервер", () => {
    // свежая правка на устройство не легла (место), а на сервер ушла
    drafts.saveIfNewer(A, draft(4, 40));
    drafts.confirm(A, "s1", 5, "2026-01-01T11:05:00.000Z");
    expect(drafts.get(A, "s1")).toBeNull();
    expect(drafts.unsynced(A)).toEqual([]);
  });

  test("черновик без номера (до правки) — правка 0, любая новая его заменяет", () => {
    drafts.save(A, { ...draft(0, 10), revision: undefined });
    expect(drafts.saveIfNewer(A, draft(1, 11))).toBe(true);
    expect(drafts.get(A, "s1")?.answers).toHaveLength(11);
  });
});

describe("при возобновлении — по правке, а не по часам сервера", () => {
  const remote = (answers: number, lastSavedAt: string) => ({
    answers: Array.from({ length: answers }, (_, i) => ({ questionId: `r${i}` })),
    startedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 1000,
    lastSavedAt,
  });

  test("сервер не менялся с последнего подтверждения — неотправленная локальная правка новее", () => {
    /*
     * Правка 6 дошла до сервера медленно (11:07), а человек за это время
     * ответил ещё на вопрос — правка 7 на устройстве в 11:06, не ушла.
     * По часам сервер «новее», по правке — нет.
     */
    const local = draft(7, 70, { savedAt: "2026-01-01T11:06:00.000Z", serverSavedAt: "2026-01-01T11:07:00.000Z" });
    const chosen = pickDraft(local, remote(60, "2026-01-01T11:07:00.000Z"));
    expect(chosen?.answers).toHaveLength(70);
  });

  test("сервер изменился после нашего подтверждения (другое устройство) — как и было, по времени", () => {
    const local = draft(7, 70, { savedAt: "2026-01-01T11:06:00.000Z", serverSavedAt: "2026-01-01T11:05:00.000Z" });
    const chosen = pickDraft(local, remote(90, "2026-01-01T12:00:00.000Z"));
    expect(chosen?.answers).toHaveLength(90);
  });
});
