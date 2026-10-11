import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, signIn, useFakeServer } from "./client.harness";
import { drafts, type LocalDraft } from "../src/offline/cache";
import { draftLaneKey, draftLanes } from "../src/offline/draftLane";

/**
 * Досылка черновика сданной попытки (волна 21, хвост участка w21:submit).
 *
 * Сервер отвечает на PUT /api/surveys/:id/draft 409: невозвратная методика
 * уже сдана (err.alreadyTaken) или сдана эта попытка — тот же startedAt
 * (err.attemptAlreadySubmitted). Ключ едет в поле `code` (app.ts, onError).
 * Мобилка оставляла черновик и слала его при каждом прогоне flushQueue —
 * вечно, в тот же отказ.
 *
 * Стало: черновик этой попытки стирается, следующий прогон его не шлёт.
 * Сеть, 5xx и прочие отказы черновик не трогают.
 */

useFakeServer();

const ownerOf = () => `patient-${crypto.randomUUID().slice(0, 8)}`;
const SURVEY = "s-closed";
const STARTED = "2026-10-11T07:30:00.000Z";

const draftOf = (extra: Partial<LocalDraft> = {}): LocalDraft => ({
  surveyId: SURVEY,
  answers: [{ questionId: "q1", optionIds: ["o2"] }],
  startedAt: STARTED,
  durationMs: 40_000,
  events: [],
  savedAt: "2026-10-11T07:31:00.000Z",
  synced: false,
  revision: 4,
  ...extra,
});

/** Сервер черновиков: что отвечать на PUT и сколько раз его спросили */
function draftServer(reply: () => Response | Promise<Response>) {
  const puts: string[] = [];
  serve((path, init) => {
    if (init.method === "PUT" && path === `/api/surveys/${SURVEY}/draft`) {
      puts.push(JSON.parse(String(init.body)).startedAt);
      return reply();
    }
    return json(404, { error: "not found" });
  });
  return puts;
}

const closed = (code: string) => () =>
  json(409, { error: "Це проходження вже здано, тож чернетку не збережено", code, requestId: "r" });

beforeEach(() => {
  resetStore();
});

describe("сервер говорит, что попытка закрыта", () => {
  for (const code of ["err.attemptAlreadySubmitted", "err.alreadyTaken"]) {
    test(`${code}: черновик стёрт, следующий прогон его не шлёт`, async () => {
      const api = await loadClient();
      const owner = ownerOf();
      signIn(owner);
      drafts.save(owner, draftOf());
      const puts = draftServer(closed(code));

      await api.flushQueue();
      expect(puts).toEqual([STARTED]);
      expect(drafts.get(owner, SURVEY), "черновик сданной попытки остался").toBeNull();
      expect(drafts.unsynced(owner)).toEqual([]);

      await api.flushQueue();
      expect(puts, "черновик досылается снова").toEqual([STARTED]);
    });
  }

  test("дорожка черновика сброшена: следующее прохождение считает правки заново", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    // экран успел подтвердить четвёртую правку этой попытки
    await draftLanes.submit(draftLaneKey(owner, SURVEY), 3, async () => "t3");
    drafts.save(owner, draftOf());
    draftServer(closed("err.attemptAlreadySubmitted"));

    await api.flushQueue();
    expect((await draftLanes.submit(draftLaneKey(owner, SURVEY), 1, async () => "n1")).status).toBe("sent");
  });

  test("новая попытка, начатая, пока шёл запрос, не стирается", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    drafts.save(owner, draftOf());
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const puts = draftServer(() => gate.then(closed("err.attemptAlreadySubmitted")));

    const flushing = api.flushQueue();
    for (let i = 0; i < 50 && puts.length === 0; i++) await Bun.sleep(1);
    // человек начал заново: под тем же ключом — черновик с другим началом
    drafts.save(owner, draftOf({ startedAt: "2026-10-11T08:00:00.000Z", revision: 1 }));
    release();
    await flushing;

    expect(drafts.get(owner, SURVEY)?.startedAt).toBe("2026-10-11T08:00:00.000Z");
  });
});

describe("положительный контроль: черновик остаётся", () => {
  test("500 — черновик цел и уходит при следующем прогоне", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    drafts.save(owner, draftOf());
    const puts = draftServer(() => json(500, { error: "boom" }));

    await api.flushQueue();
    expect(drafts.get(owner, SURVEY)?.synced).toBe(false);
    await api.flushQueue();
    expect(puts).toEqual([STARTED, STARTED]);
  });

  test("нет сети — черновик цел", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    drafts.save(owner, draftOf());
    serve(noNetwork);

    await api.flushQueue();
    expect(drafts.get(owner, SURVEY)).not.toBeNull();
    expect(drafts.unsynced(owner)).toHaveLength(1);
  });

  test("другой 409 того же маршрута (черновик другой версии) — без кода, черновик цел", async () => {
    const api = await loadClient();
    const owner = ownerOf();
    signIn(owner);
    drafts.save(owner, draftOf());
    draftServer(() => json(409, { error: "Незавершене проходження іншої версії", requestId: "r" }));

    await api.flushQueue();
    expect(drafts.get(owner, SURVEY)).not.toBeNull();
  });
});
