import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, signIn, useFakeServer } from "./client.harness";
import { drafts, type LocalDraft } from "../src/offline/cache";
import { draftLaneKey, draftLanes, ownerLanePrefix } from "../src/offline/draftLane";
import { dropOwnDraft } from "../src/runner/ownDraft";

/**
 * Второе прохождение той же методики в том же запуске (#129).
 *
 * Было: дорожка черновика (offline/draftLane.ts) жила до перезапуска и
 * помнила подтверждённую правку прошлого прохождения, а экран нового
 * прохождения считает правки с нуля (app/survey/[id].tsx). Первое
 * прохождение — правки 1..12 ушли; второе — все правки «superseded», до
 * сервера ни одной: ранние тревоги автосохранения не поднимаются,
 * продолжить на другом устройстве нечего.
 *
 * Стало: конец попытки (сдача — dropOwnDraft) сбрасывает дорожку; внутри
 * одной попытки запоздалая правка по-прежнему не уходит.
 */

/** Дорожка — одна на приложение, поэтому владелец у каждого теста свой */
const ownerOf = () => `patient-${crypto.randomUUID().slice(0, 8)}`;
const SURVEY = "s-retake";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Автосохранения одного прохождения: правки from..to, каждая дожидается ответа — как переходы между вопросами */
async function pass(owner: string, from: number, to: number, sent: number[]) {
  const results: string[] = [];
  for (let rev = from; rev <= to; rev++) {
    const r = await draftLanes.submit(draftLaneKey(owner, SURVEY), rev, async () => {
      sent.push(rev);
      return { lastSavedAt: `t${rev}` };
    });
    results.push(r.status);
  }
  return results;
}

const local = (revision: number): LocalDraft => ({
  surveyId: SURVEY,
  answers: [{ questionId: "q1" }],
  startedAt: "2026-10-11T08:00:00.000Z",
  durationMs: 1000,
  events: [],
  savedAt: "2026-10-11T08:00:01.000Z",
  synced: true,
  revision,
});

useFakeServer();

beforeEach(() => {
  resetStore();
});

describe("после сдачи следующее прохождение сохраняется на сервер", () => {
  test("первая правка второго прохождения — sent, а не superseded", async () => {
    const owner = ownerOf();
    const sent: number[] = [];
    expect(await pass(owner, 1, 12, sent)).toEqual(Array(12).fill("sent"));
    drafts.save(owner, local(12));

    // сдано: экран стирает свой черновик (runner/finish.ts → dropOwnDraft)
    dropOwnDraft(SURVEY, { owner });
    expect(drafts.get(owner, SURVEY)).toBeNull();

    // второе прохождение без перезапуска: экран снова считает с нуля
    sent.length = 0;
    expect(await pass(owner, 1, 3, sent)).toEqual(["sent", "sent", "sent"]);
    expect(sent).toEqual([1, 2, 3]);
  });

  test("внутри одного прохождения запоздалая правка по-прежнему superseded", async () => {
    const owner = ownerOf();
    const sent: number[] = [];
    await pass(owner, 1, 12, sent);
    dropOwnDraft(SURVEY, { owner });

    await pass(owner, 1, 5, sent);
    sent.length = 0;
    expect(await pass(owner, 4, 4, sent)).toEqual(["superseded"]);
    expect(await pass(owner, 5, 5, sent)).toEqual(["superseded"]);
    expect(sent).toEqual([]);
  });

  test("сохранение прошлого прохождения, ещё бывшее в пути, новое не обгоняет и счёт ему не портит", async () => {
    const owner = ownerOf();
    const key = draftLaneKey(owner, SURVEY);
    const order: string[] = [];
    const slow = deferred<string>();
    const old = draftLanes.submit(key, 12, () => {
      order.push("old-12");
      return slow.promise;
    });
    dropOwnDraft(SURVEY, { owner });

    const first = draftLanes.submit(key, 1, async () => {
      order.push("new-1");
      return "n1";
    });
    // новая правка ждёт, пока прежняя дойдёт: иначе та могла бы прийти на сервер позже неё
    await Bun.sleep(0);
    expect(order).toEqual(["old-12"]);

    slow.resolve("o12");
    expect(await old).toEqual({ status: "sent", value: "o12" });
    expect(await first).toEqual({ status: "sent", value: "n1" });
    // подтверждение двенадцатой правки прошлой попытки не делает вторую правку новой «устаревшей»
    expect((await draftLanes.submit(key, 2, async () => "n2")).status).toBe("sent");
    expect(order).toEqual(["old-12", "new-1"]);
  });

  test("сдача за пациента дорожку специалиста не трогает", async () => {
    const owner = ownerOf();
    await pass(owner, 1, 12, []);
    dropOwnDraft(SURVEY, { owner, onBehalfOf: "patient-x" });
    // свой черновик специалиста — та же попытка, и старая правка остаётся старой
    expect((await draftLanes.submit(draftLaneKey(owner, SURVEY), 3, async () => "x")).status).toBe("superseded");
  });
});

describe("сброс всех дорожек владельца", () => {
  test("resetAll по владельцу снимает счёт только его дорожек", async () => {
    const a = ownerOf();
    const b = ownerOf();
    await pass(a, 1, 5, []);
    await pass(b, 1, 5, []);
    draftLanes.resetAll(ownerLanePrefix(a));
    expect((await draftLanes.submit(draftLaneKey(a, SURVEY), 1, async () => "a")).status).toBe("sent");
    expect((await draftLanes.submit(draftLaneKey(b, SURVEY), 1, async () => "b")).status).toBe("superseded");
  });
});

describe("стирание устройства — тоже конец попытки", () => {
  test("после стирания и нового входа того же человека правки снова уходят", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    await pass(owner, 1, 7, []);

    serve((path) => {
      if (path === "/api/devices/checkin") return json(200, { wipe: true });
      if (path === "/api/devices/wiped") return json(200, { ok: true });
      return json(404, { error: "not found" });
    });
    expect(await api.deviceCheckin(null)).toBe(true);

    // вошёл снова тот же человек: черновик на сервере остался, локального нет — экран считает с нуля
    signIn(owner);
    expect((await draftLanes.submit(draftLaneKey(owner, SURVEY), 1, async () => "w")).status).toBe("sent");
  });
});
