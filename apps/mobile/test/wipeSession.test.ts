import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, session, signIn, tokenOf, useFakeServer } from "./client.harness";
import { cache, drafts, type LocalDraft } from "../src/offline/cache";
import { leftAfterWipe } from "../src/offline/device";
import { enqueue, pending, rejectedItems } from "../src/offline/queue";
import { isStoreWriteError } from "../src/offline/writeError";
import { finishSubmission } from "../src/runner/finish";

/**
 * Удалённое стирание закрывает сессию и в интерфейсе, и для запоздавших записей (#125).
 *
 * Было: отметка устройства получала команду, carryOutWipe чистил хранилище и
 * подтверждал серверу, но интерфейс об этом не знал — пользователь оставался
 * в состоянии React, экраны с данными — до перезапуска. Ответ /api/worklist,
 * запрошенный до стирания, ложился в кэш после него (проба ревьюера:
 * `left after late response: ["u:staff-a:rounds:list"]`), открытое
 * прохождение продолжало писать черновик. Следующий запуск команды уже не
 * получал — записанное оставалось навсегда при «стёрто» в консоли.
 */

useFakeServer();

const STAFF = "staff-a";

/** Ответ, который сервер отдаст, когда тест разрешит: запрос «в пути» */
function held<T>() {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  return { release, later: (body: T) => gate.then(() => json(200, body)) };
}

/** Сервер с командой стирания; чтения отвечают, когда их отпустят */
function wipingServer(wipe: boolean) {
  const reads = held<unknown>();
  const asked: string[] = [];
  serve((path, init) => {
    asked.push(path);
    if (!(init.headers as Record<string, string>).Authorization) return json(401, { error: "unauthorized" });
    if (path === "/api/devices/checkin") return json(200, { wipe });
    if (path === "/api/devices/wiped") return json(200, { ok: true });
    if (path === "/api/worklist") return reads.later({ items: [{ userId: "p1" }] });
    if (path === "/api/dynamics/respondents/p1") return reads.later({ fullName: "Петренко", surveys: [] });
    if (path === "/api/auth/me") return reads.later({ id: STAFF, role: "admin" });
    return json(404, { error: "not found" });
  });
  return { release: reads.release, asked };
}

/** Интерфейс: пользователь в состоянии и текущий экран — как их меняют AuthContext и корень стека */
function screen(api: Awaited<ReturnType<typeof loadClient>>) {
  const ui = { user: { id: STAFF } as { id: string } | null, route: "/survey/s1" };
  const off = api.onWiped(() => {
    ui.user = null;
    ui.route = "/login";
  });
  return { ui, off };
}

const draftOf = (revision: number): LocalDraft => ({
  surveyId: "s1",
  answers: [{ questionId: "q1", text: "ВІДПОВІДЬ" }],
  startedAt: "2026-10-11T07:00:00.000Z",
  durationMs: 1000,
  events: [],
  savedAt: "2026-10-11T07:00:01.000Z",
  synced: false,
  revision,
});

/** Ждём, пока запросы дойдут до сервера (ответ он придержит); не дольше ~50 мс */
async function untilAsked(asked: string[], paths: string[]) {
  for (let i = 0; i < 50 && !paths.every((p) => asked.includes(p)); i++) await Bun.sleep(1);
  expect(asked).toEqual(expect.arrayContaining(paths));
}

beforeEach(() => {
  resetStore();
});

describe("стирание исполнено", () => {
  test("интерфейс без пользователя и на входе; ответы, запрошенные до команды, на устройство не ложатся", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const { ui, off } = screen(api);
    const srv = wipingServer(true);

    // обход, карта и профиль запрошены до команды и ещё в пути
    const late = Promise.all([api.rounds(), api.roundsCard("p1"), api.me()]);
    await untilAsked(srv.asked, ["/api/worklist", "/api/dynamics/respondents/p1", "/api/auth/me"]);

    expect(await api.deviceCheckin(null)).toBe(true);
    expect(ui.user).toBeNull();
    expect(ui.route).toBe("/login");
    expect(session.token, "сессия снята").toBeNull();
    expect(leftAfterWipe([])).toEqual([]);

    // ответы пришли уже после «стёрто»
    srv.release();
    await late;
    expect(leftAfterWipe([]), "запоздавшие ответы легли на стёртый планшет").toEqual([]);
    off();
  });

  test("автосохранение открытого прохождения без живого токена ничего не пишет", async () => {
    const api = await loadClient();
    signIn(STAFF);
    drafts.saveIfNewer(STAFF, draftOf(1));
    wipingServer(true);

    await api.deviceCheckin(null);
    expect(leftAfterWipe([])).toEqual([]);

    // экран прохождения ещё жив и сохраняет следующую правку — как autosave в app/survey/[id].tsx
    let refused: unknown = null;
    try {
      drafts.saveIfNewer(STAFF, draftOf(2));
    } catch (error) {
      refused = error;
    }
    expect(isStoreWriteError(refused), "экран узнаёт, что копия не легла").toBe(true);
    await expect(api.saveDraft("s1", { answers: [], startedAt: "x", durationMs: 0, events: [] })).rejects.toMatchObject({
      status: 401,
    });
    expect(() => drafts.save(STAFF, draftOf(3))).toThrow();
    expect(leftAfterWipe([])).toEqual([]);
  });

  test("после нового входа пишется только за вошедшего: запоздавший ответ прежнего не возвращает его данные", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const srv = wipingServer(true);
    const late = api.rounds();
    await untilAsked(srv.asked, ["/api/worklist"]);
    await api.deviceCheckin(null);

    // на планшет вошёл другой сотрудник (src/storage.ts, set → offline/owner.ts, signedIn)
    const { tokenStorage } = await import("../src/storage");
    await tokenStorage.set(tokenOf("staff-b"));
    cache.saveRounds("staff-b", { items: [] });
    expect(cache.rounds("staff-b"), "за вошедшего кэш снова пишется").not.toBeNull();

    srv.release();
    await late;
    expect(cache.rounds(STAFF)).toBeNull();
    expect(leftAfterWipe([])).toEqual(["u:staff-b:rounds:list"]);
  });
});

describe("положительный контроль: без стирания", () => {
  test("rounds() кладёт кэш, сессия и пользователь на месте", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const { ui, off } = screen(api);
    const srv = wipingServer(false);

    const pending = api.rounds();
    await untilAsked(srv.asked, ["/api/worklist"]);
    expect(await api.deviceCheckin(null)).toBe(false);
    srv.release();
    expect((await pending).cachedAt).toBeNull();

    expect(cache.rounds(STAFF)).not.toBeNull();
    expect(ui.user).toEqual({ id: STAFF });
    expect(ui.route).toBe("/survey/s1");
    expect(session.token).toBe(tokenOf(STAFF));

    drafts.saveIfNewer(STAFF, draftOf(1));
    expect(drafts.get(STAFF, "s1")?.revision).toBe(1);
    off();
  });
});

/**
 * Очередь сдач — тот же запрет (#125, доработка). Сдача, ушедшая до команды и
 * упавшая по сети после неё, ложилась в очередь стёртого планшета; прогон
 * очереди, получивший отказ сервера уже после стирания, записывал помеченную
 * сдачу обратно.
 */
describe("очередь сдач после стирания", () => {
  /** Сервер стирания; сдача отвечает `answer`, когда её отпустят */
  function submissionServer(wipe: boolean, answer: () => Response) {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const asked: string[] = [];
    serve((path, init) => {
      asked.push(path);
      if (!(init.headers as Record<string, string>).Authorization) return json(401, { error: "unauthorized" });
      if (path === "/api/devices/checkin") return json(200, { wipe });
      if (path === "/api/devices/wiped") return json(200, { ok: true });
      if (path === "/api/surveys/s1/responses") return gate.then(answer);
      return json(404, { error: "not found" });
    });
    return { release, asked };
  }

  const submission = { answers: [], startedAt: "2026-10-11T07:00:00.000Z", durationMs: 1000, events: [] };

  test("сдача, упавшая по сети уже после стирания, в очередь не ложится — экран узнаёт, что не сохранено", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const srv = submissionServer(true, noNetwork);

    const sending = finishSubmission({ submit: () => api.submitResponse("s1", submission), dropDraft: () => {} });
    await untilAsked(srv.asked, ["/api/surveys/s1/responses"]);
    await api.deviceCheckin(null);
    srv.release();

    const outcome = await sending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.notSaved).toBe(true);
    expect(leftAfterWipe([])).toEqual([]);
  });

  test("прогон очереди, получивший отказ уже после стирания, помеченную сдачу обратно не пишет", async () => {
    const api = await loadClient();
    signIn(STAFF);
    enqueue(STAFF, "s1", submission);
    const srv = submissionServer(true, () => json(422, { error: "invalid answers" }));

    const flushing = api.flushQueue();
    await untilAsked(srv.asked, ["/api/surveys/s1/responses"]);
    await api.deviceCheckin(null);
    srv.release();
    await flushing;

    expect(leftAfterWipe([])).toEqual([]);
  });

  test("положительный контроль: без стирания сдача без сети ложится в очередь, отказ сервера — помечается", async () => {
    const api = await loadClient();
    signIn(STAFF);
    const offline = submissionServer(false, noNetwork);
    offline.release();
    expect((await api.submitResponse("s1", submission)).queued).toBe(true);
    expect(pending(STAFF)).toHaveLength(1);

    const refusing = submissionServer(false, () => json(422, { error: "invalid answers" }));
    refusing.release();
    await api.flushQueue();
    expect(rejectedItems(STAFF).map((i) => i.rejectedReason)).toEqual(["invalid answers"]);
  });
});
