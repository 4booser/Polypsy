import { beforeEach, describe, expect, test } from "bun:test";
import { memoryStore, resetStore, storeFaults } from "./store.mock";
import { json, loadClient, serve, session, signIn, useFakeServer } from "./client.harness";
import { cache, drafts, type LocalDraft } from "../src/offline/cache";
import { enqueue, pending } from "../src/offline/queue";

/**
 * Выход уносит офлайн-кэш вышедшего (#130).
 *
 * Было: logout снимал только токены и push, а `u:A:rounds:card:*` (ФИО,
 * баллы, динамика), `u:A:me`, план безопасности оставались на общем
 * планшете бессрочно.
 *
 * Стало: после выхода ключей `u:<вышедший>:` нет, кроме неотправленных
 * черновиков; очередь сдач цела. Они уходят при следующем входе владельца.
 * Ответ, запрошенный до выхода, кэш обратно не наполняет.
 */

useFakeServer();

const ownerOf = (role: string) => `${role}-${crypto.randomUUID().slice(0, 8)}`;

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

/** Сервер: обход, карта, профиль, план; ответы на чтения придерживаются, пока их не отпустят */
function clinic(owner: string, opts: { hold?: boolean } = {}) {
  let release!: () => void;
  const gate = opts.hold ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  const later = (body: unknown) => gate.then(() => json(200, body));
  const asked: string[] = [];
  const sent: { path: string; body: unknown }[] = [];
  serve((path, init) => {
    asked.push(path);
    if (!(init.headers as Record<string, string>).Authorization) return json(401, { error: "unauthorized" });
    if (path === "/api/worklist") return later({ items: [{ userId: "p1", fullName: "Петренко Олена" }] });
    if (path === "/api/dynamics/respondents/p1") return later({ fullName: "Петренко Олена", surveys: [] });
    if (path === "/api/auth/me") return later({ id: owner, role: "admin" });
    if (path === "/api/safety/me") return later({ plan: { warningSigns: ["тривога"] } });
    if (path === "/api/auth/logout") return json(200, { ok: true });
    if (init.method === "POST" || init.method === "PUT") {
      sent.push({ path, body: JSON.parse(String(init.body)) });
      return json(200, { id: "r1", scores: [], lastSavedAt: "2026-10-11T10:00:00.000Z" });
    }
    return json(404, { error: "not found" });
  });
  return { release: () => release?.(), asked, sent };
}

async function untilAsked(asked: string[], paths: string[]) {
  for (let i = 0; i < 50 && !paths.every((p) => asked.includes(p)); i++) await Bun.sleep(1);
  expect(asked).toEqual(expect.arrayContaining(paths));
}

const keysOf = (owner: string) => memoryStore.keys(`u:${owner}:`).sort();

beforeEach(() => {
  resetStore();
});

describe("выход на общем планшете", () => {
  test("кэш вышедшего уходит; остаются очередь сдач и неотправленный черновик", async () => {
    const api = await loadClient();
    const staff = ownerOf("staff");
    const other = ownerOf("staff");
    signIn(staff);
    clinic(staff);

    await api.rounds();
    await api.roundsCard("p1");
    await api.me();
    await api.mySafetyPlan();
    drafts.save(staff, draftOf("s-synced", true));
    drafts.save(staff, draftOf("s-unsent", false));
    const queued = enqueue(staff, "s-queued", { answers: [] });
    // чужое на том же планшете — не его выход
    cache.saveMe({ id: other, role: "admin" } as never);

    expect(keysOf(staff)).toEqual(
      expect.arrayContaining([
        `u:${staff}:rounds:list`,
        `u:${staff}:rounds:card:p1`,
        `u:${staff}:me`,
        `u:${staff}:safety:plan`,
        `u:${staff}:draft:s-synced`,
      ]),
    );

    await api.signOut();

    expect(session.token, "сессия снята").toBeNull();
    expect(keysOf(staff)).toEqual([`u:${staff}:draft:s-unsent`]);
    expect(pending(staff).map((i) => i.id)).toEqual([queued.id]);
    expect(keysOf(other)).toEqual([`u:${other}:me`]);
  });

  test("ответ, запрошенный до выхода и пришедший после, кэш обратно не наполняет", async () => {
    const api = await loadClient();
    const staff = ownerOf("staff");
    signIn(staff);
    const srv = clinic(staff, { hold: true });

    const late = Promise.all([api.rounds(), api.roundsCard("p1"), api.me()]);
    await untilAsked(srv.asked, ["/api/worklist", "/api/dynamics/respondents/p1", "/api/auth/me"]);

    await api.signOut();
    srv.release();
    await late;

    expect(keysOf(staff), "запоздавший ответ вернул данные вышедшего").toEqual([]);
  });

  test("при следующем входе владельца оставленное уходит на сервер, и кэш снова пишется", async () => {
    const api = await loadClient();
    const staff = ownerOf("staff");
    signIn(staff);
    drafts.save(staff, draftOf("s-unsent", false));
    enqueue(staff, "s-queued", { answers: [] });
    clinic(staff);
    await api.signOut();

    signIn(staff);
    const srv = clinic(staff);
    const res = await api.flushQueue();
    expect(res).toMatchObject({ sent: 1, rejected: 0 });
    expect(srv.sent.map((s) => s.path)).toEqual(["/api/surveys/s-queued/responses", "/api/surveys/s-unsent/draft"]);
    expect(drafts.get(staff, "s-unsent")?.synced).toBe(true);

    await api.me();
    expect(keysOf(staff)).toContain(`u:${staff}:me`);
  });

  test("хранилище отказало удалить — выход всё равно выходит", async () => {
    const api = await loadClient();
    const staff = ownerOf("staff");
    signIn(staff);
    clinic(staff);
    await api.me();
    storeFaults.failRemove = (name) => name.endsWith(":me");

    await api.signOut();
    expect(session.token).toBeNull();
    storeFaults.failRemove = null;
  });
});
