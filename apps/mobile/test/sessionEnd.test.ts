import { beforeEach, describe, expect, test } from "bun:test";
import { memoryStore, resetStore } from "./store.mock";
import { json, loadClient, noNetwork, serve, session, signIn, useFakeServer } from "./client.harness";
import { cache, drafts, type LocalDraft } from "../src/offline/cache";
import { enqueue, pending } from "../src/offline/queue";
import { reviewDrafts } from "../src/staff/reviewDrafts";

/**
 * Сессия кончилась по слову сервера — тот же путь, что выход (волна 26).
 *
 * Было: refresh отозван или истёк, запросы падали с 401, а приложение
 * оставалось «вошедшим»: обход, карты у койки, план безопасности, отметки
 * обхода и черновики разбора лежали на общем планшете, пока кто-нибудь не
 * нажмёт «вийти».
 *
 * Стало: 401 на обмене refresh (или продлевать нечем) уносит копии
 * вышедшего, снимает токены и уводит на вход с объяснением; очередь сдач и
 * неотправленные черновики ждут его входа. Без сети и при лежащем сервере —
 * ничего не стирается: медсестра в подвале читает обход по копии.
 */

useFakeServer();

const ownerOf = () => `staff-${crypto.randomUUID().slice(0, 8)}`;
const keysOf = (owner: string) => memoryStore.keys(`u:${owner}:`).sort();

const draftOf = (surveyId: string, synced: boolean): LocalDraft => ({
  surveyId,
  answers: [{ questionId: "q1", text: "ВІДПОВІДЬ" }],
  startedAt: "2026-10-11T09:00:00.000Z",
  durationMs: 1000,
  events: [],
  savedAt: "2026-10-11T09:00:01.000Z",
  synced,
  revision: 3,
});

/** Клиника отвечает, пока сессия жива: обход, карта, профиль, план */
function liveClinic(owner: string) {
  serve((path) => {
    if (path === "/api/worklist") return json(200, { items: [{ userId: "p1", userName: "Петренко Олена" }] });
    if (path === "/api/dynamics/respondents/p1") return json(200, { fullName: "Петренко Олена", surveys: [] });
    if (path === "/api/auth/me") return json(200, { id: owner, role: "admin" });
    if (path === "/api/safety/me") return json(200, { plan: { content: { people: [{ name: "Дружина", contact: "+380671234567" }] } } });
    return json(404, { error: "not found" });
  });
}

/** Access истёк; обмен refresh отвечает так, как скажет тест */
function expired(refresh: () => Response | Promise<Response>) {
  const asked: string[] = [];
  serve((path) => {
    asked.push(path);
    if (path === "/api/auth/refresh") return refresh();
    return json(401, { error: "Сесія закінчилася", code: "err.sessionExpired" });
  });
  return asked;
}

/** Всё, что выход обязан унести, — на устройстве */
async function filled(api: Awaited<ReturnType<typeof loadClient>>, owner: string) {
  liveClinic(owner);
  await api.rounds();
  await api.roundsCard("p1");
  await api.me();
  await api.mySafetyPlan();
  cache.saveRoundsVisited(owner, { day: "2026-10-19", ids: ["p1"] });
  drafts.save(owner, draftOf("s-synced", true));
  drafts.save(owner, draftOf("s-unsent", false));
  reviewDrafts.set(owner, "case-1", { outcome: "needs_followup", note: "Зателефонував" });
  return enqueue(owner, "s-queued", { answers: [] });
}

beforeEach(async () => {
  resetStore();
  reviewDrafts.forgetAll();
  // уведомление прошлых тестов не переносится
  (await loadClient()).sessionEndedNotice();
});

describe("сессия кончилась по слову сервера", () => {
  test("refresh отвергнут 401 — копии вышедшего уходят, токены сняты, вход с объяснением; сдачи и неотправленное ждут его", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    const queued = await filled(api, staff);
    expect(keysOf(staff)).toEqual(
      expect.arrayContaining([
        `u:${staff}:rounds:list`,
        `u:${staff}:rounds:card:p1`,
        `u:${staff}:rounds:visited`,
        `u:${staff}:me`,
        `u:${staff}:safety:plan`,
        `u:${staff}:draft:s-synced`,
      ]),
    );

    let ended = 0;
    const off = api.onSessionEnded(() => ended++);
    expired(() => json(401, { error: "Сесія закінчилася", code: "err.sessionExpired" }));

    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(session.token, "сессия снята").toBeNull();
    expect(session.refresh).toBeNull();
    expect(keysOf(staff), "на планшете осталось только неотправленное").toEqual([`u:${staff}:draft:s-unsent`]);
    expect(pending(staff).map((i) => i.id)).toEqual([queued.id]);
    expect(reviewDrafts.get(staff, "case-1"), "черновик разбора пережил конец сессии").toBeNull();
    expect(ended, "интерфейс уведомлён один раз").toBe(1);
    // экран входа скажет, почему человек на нём, — один раз
    expect(api.sessionEndedNotice()).toBe(true);
    expect(api.sessionEndedNotice()).toBe(false);
    off();
  });

  test("несколько отвергнутых запросов разом — сессия кончается один раз", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    await filled(api, staff);
    let ended = 0;
    const off = api.onSessionEnded(() => ended++);
    expired(() => json(401, { error: "Сесія закінчилася" }));

    await Promise.allSettled([api.rounds(), api.roundsCard("p1"), api.me(), api.mySafetyPlan()]);

    expect(ended).toBe(1);
    expect(keysOf(staff)).toEqual([`u:${staff}:draft:s-unsent`]);
    off();
  });

  test("продлевать нечем — refresh на устройстве нет, а access сервер не принял: сессия тоже кончилась", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    await filled(api, staff);
    session.refresh = null;
    const asked = expired(() => json(200, {}));

    await expect(api.rounds()).rejects.toMatchObject({ status: 401 });

    expect(asked, "обмен без refresh не идёт в сеть").not.toContain("/api/auth/refresh");
    expect(session.token).toBeNull();
    expect(keysOf(staff)).toEqual([`u:${staff}:draft:s-unsent`]);
  });
});

describe("без слова сервера сессия жива", () => {
  test("сети нет на обмене — ничего не стирается, план безопасности читается из копии", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    await filled(api, staff);
    const before = keysOf(staff);
    let ended = 0;
    const off = api.onSessionEnded(() => ended++);

    // access истёк, а продлить нечем — сеть пропала посреди обмена
    expired(noNetwork);
    await expect(api.me()).rejects.toMatchObject({ status: 0 });
    // и совсем без сети — копии на месте и отдаются
    serve(noNetwork);
    const plan = await api.mySafetyPlan();
    const rounds = await api.rounds();

    expect(plan.plan).not.toBeNull();
    expect(rounds.cachedAt).not.toBeNull();
    expect(session.token, "сессия на месте").not.toBeNull();
    expect(keysOf(staff)).toEqual(before);
    expect(reviewDrafts.get(staff, "case-1")).not.toBeNull();
    expect(ended).toBe(0);
    expect(api.sessionEndedNotice()).toBe(false);
    off();
  });

  test("сервер лежит (503) или ответил лимитом (429) — сессия жива, копии на месте", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    await filled(api, staff);
    const before = keysOf(staff);
    let ended = 0;
    const off = api.onSessionEnded(() => ended++);

    expired(() => json(503, { error: "maintenance" }));
    await expect(api.me()).rejects.toMatchObject({ status: 503 });
    expired(() => json(429, { error: "too many" }));
    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(session.token).not.toBeNull();
    expect(keysOf(staff)).toEqual(before);
    expect(ended).toBe(0);
    off();
  });

  test("тот же человек вошёл заново, пока шёл обмен старой сессии (смена пароля), — новую сессию это не трогает", async () => {
    const api = await loadClient();
    const staff = ownerOf();
    signIn(staff);
    await filled(api, staff);
    const before = keysOf(staff);
    let ended = 0;
    const off = api.onSessionEnded(() => ended++);

    // смена пароля гасит все сессии, и экран тут же входит новым паролем: тот же владелец, другой токен
    const fresh = `${session.token}.fresh`;
    expired(() => {
      session.token = fresh;
      session.refresh = "refresh-after-password";
      return json(401, { error: "Сесія закінчилася" });
    });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(ended).toBe(0);
    expect(session.token).toBe(fresh);
    expect(keysOf(staff)).toEqual(before);
    off();
  });

  test("вышли и вошёл другой, пока шёл обмен прежнего, — сессию нового это не трогает", async () => {
    const api = await loadClient();
    const first = ownerOf();
    const second = ownerOf();
    signIn(first);
    let ended = 0;
    const off = api.onSessionEnded(() => ended++);

    expired(() => {
      // на планшет вошёл следующий, а отказ пришёл на обмен прежнего
      signIn(second);
      cache.saveMe({ id: second, role: "admin" } as never);
      return json(401, { error: "Сесія закінчилася" });
    });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(ended).toBe(0);
    expect(session.token, "сессия нового на месте").not.toBeNull();
    expect(keysOf(second)).toEqual([`u:${second}:me`]);
    off();
  });
});
