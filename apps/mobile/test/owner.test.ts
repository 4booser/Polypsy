import { beforeEach, describe, expect, test } from "bun:test";
import { memoryStore, resetStore } from "./store.mock";
import { cache, dropLegacyCache, drafts, type LocalDraft } from "../src/offline/cache";
import { OwnerChanged, ownerOfToken } from "../src/offline/owner";
import {
  claim,
  deviceCounts,
  discard,
  enqueue,
  flush,
  ownerless,
  pending,
  pendingCount,
  rejectedItems,
  retryRejected,
  type QueuedSubmission,
} from "../src/offline/queue";

/**
 * Чьи офлайн-данные.
 *
 * Ошибка, ради которой это написано: очередь, черновики и кэш лежали под
 * общими ключами, а уходили с тем токеном, какой найдётся. Пациент А сдал
 * методику без сети и вышел, вошёл пациент Б — и ответы А ушли на сервер от
 * имени Б, а офлайн-кэш показал Б чужой план безопасности. Каждая проверка
 * здесь — про одно: чужое не уходит под твоим именем и не показывается тебе.
 */

const A = "patient-a";
const B = "patient-b";

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Токен с данным sub — в том виде, в каком его выдаёт сервер (header.payload.signature) */
function tokenFor(claims: Record<string, unknown>): string {
  const b64url = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.signature`;
}

const draft = (surveyId: string, answers: number): LocalDraft => ({
  surveyId,
  answers: Array.from({ length: answers }, (_, i) => ({ questionId: `q${i}` })),
  startedAt: "2026-01-01T10:00:00.000Z",
  durationMs: 1000,
  events: [],
  savedAt: "2026-01-01T10:01:00.000Z",
  synced: false,
});

beforeEach(() => {
  resetStore();
});

describe("владелец токена", () => {
  test("sub из полезной нагрузки", () => {
    expect(ownerOfToken(tokenFor({ sub: A, role: "user", iat: 1 }))).toBe(A);
  });

  test("base64url с «-» и «_» разбирается, а не роняет владельца в null", () => {
    // подобрано так, что в base64 полезной нагрузки встречаются и «+», и «/»
    const sub = "a>>?b~~~ c???";
    const token = tokenFor({ sub });
    expect(token.split(".")[1]).toMatch(/[-_]/);
    expect(ownerOfToken(token)).toBe(sub);
  });

  test("нет токена, мусор, нет sub — владельца нет", () => {
    expect(ownerOfToken(null)).toBeNull();
    expect(ownerOfToken("")).toBeNull();
    expect(ownerOfToken("not-a-jwt")).toBeNull();
    expect(ownerOfToken("a.!!!.c")).toBeNull();
    expect(ownerOfToken(tokenFor({ role: "user" }))).toBeNull();
    expect(ownerOfToken(tokenFor({ sub: 42 }))).toBeNull();
  });
});

describe("очередь: чужое не уходит под твоим токеном", () => {
  test("после смены учётной записи сдача А ждёт А, а не уходит от имени Б", async () => {
    /*
     * Ровно сценарий дефекта: А сдала без сети и вышла, вошёл Б, сеть
     * появилась. Прогон под токеном Б не должен даже увидеть запись А.
     */
    const item = enqueue(A, "s1", { answers: [{ q: 1 }] });

    const sentAsB: QueuedSubmission[] = [];
    const asB = await flush(B, async (i) => {
      sentAsB.push(i);
    });
    expect(sentAsB).toEqual([]);
    expect(asB).toEqual({ sent: 0, left: 0, rejected: 0 });
    expect(pendingCount(B)).toBe(0);
    expect(pending(B)).toEqual([]);

    // запись А цела и уходит, когда А входит снова
    expect(pending(A).map((i) => i.id)).toEqual([item.id]);
    const sentAsA: string[] = [];
    const asA = await flush(A, async (i) => {
      sentAsA.push(i.id);
    });
    expect(sentAsA).toEqual([item.id]);
    expect(asA.sent).toBe(1);
    expect(pending(A)).toEqual([]);
  });

  test("у каждой записи владелец — тот, от чьего имени её положили", () => {
    enqueue(A, "s1", {});
    enqueue(B, "s2", {});
    expect(pending(A).map((i) => [i.ownerId, i.surveyId])).toEqual([[A, "s1"]]);
    expect(pending(B).map((i) => [i.ownerId, i.surveyId])).toEqual([[B, "s2"]]);
  });

  test("без владельца (никто не вошёл) не отправляется и не показывается ничего", async () => {
    enqueue(A, "s1", {});
    let calls = 0;
    const res = await flush(null, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    expect(res.sent).toBe(0);
    expect(pending(null)).toEqual([]);
    expect(pendingCount(A)).toBe(1);
  });

  test("смена токена посреди прогона — остановка, а не отказ сервера", async () => {
    /*
     * Клиент бросает OwnerChanged, когда токен в хранилище уже не владельца
     * записи. Пометить её «отвергнутой» значило бы заставить А разбирать
     * руками сдачу, с которой всё в порядке.
     */
    enqueue(A, "s1", {});
    enqueue(A, "s2", {});
    let calls = 0;
    const res = await flush(A, async () => {
      calls++;
      throw new OwnerChanged("owner changed");
    });
    expect(calls).toBe(1);
    expect(res.sent).toBe(0);
    expect(rejectedItems(A)).toEqual([]);
    expect(pendingCount(A)).toBe(2);
  });

  test("отвергнутое у А не видно Б и не поддаётся его повтору и удалению", async () => {
    const item = enqueue(A, "bad", {});
    await flush(A, async () => {
      throw new HttpError("Відмова", 400);
    });
    expect(rejectedItems(A)).toHaveLength(1);
    expect(rejectedItems(B)).toEqual([]);

    retryRejected(B, item.id);
    discard(B, item.id);
    // ни снять пометку, ни удалить чужую сдачу нельзя
    expect(rejectedItems(A).map((i) => i.id)).toEqual([item.id]);
  });

  test("счёт устройства для техпанели — по всем владельцам", async () => {
    enqueue(A, "s1", {});
    enqueue(B, "s2", {});
    enqueue(B, "bad", {});
    await flush(B, async (i) => {
      if (i.surveyId === "bad") throw new HttpError("Відмова", 400);
    });
    expect(deviceCounts()).toEqual({ pending: 1, rejected: 1 });
  });
});

describe("сдачи без владельца — положенные до его появления", () => {
  /** Запись в прежнем виде: без ownerId, как её клало приложение до исправления */
  function legacyItem(id: string, surveyId: string): QueuedSubmission {
    const item = { id, surveyId, payload: { clientRequestId: `c-${id}` }, queuedAt: "2026-09-01T10:00:00.000Z", attempts: 0 };
    memoryStore.write(`queue:${id}`, item);
    return item;
  }

  test("сами не уходят ни под чьим токеном", async () => {
    legacyItem("old-1", "s1");
    let calls = 0;
    await flush(A, async () => {
      calls++;
    });
    await flush(B, async () => {
      calls++;
    });
    expect(calls).toBe(0);
    expect(ownerless().map((i) => i.id)).toEqual(["old-1"]);
    // и в своих счётчиках их нет — но на устройстве они учтены
    expect(pendingCount(A)).toBe(0);
    expect(deviceCounts().pending).toBe(1);
  });

  test("«це мої»: запись переходит к опознавшему и уходит от его имени", async () => {
    legacyItem("old-1", "s1");
    claim(A, "old-1");

    expect(ownerless()).toEqual([]);
    const sent: QueuedSubmission[] = [];
    await flush(A, async (i) => {
      sent.push(i);
    });
    expect(sent.map((i) => [i.id, i.ownerId])).toEqual([["old-1", A]]);
    // идентификатор первой попытки сохранён: дубль сервер узнает
    expect(sent[0]!.payload.clientRequestId).toBe("c-old-1");
  });

  test("присвоить чужую (уже с владельцем) сдачу нельзя", () => {
    const item = enqueue(A, "s1", {});
    claim(B, item.id);
    expect(pending(B)).toEqual([]);
    expect(pending(A).map((i) => i.ownerId)).toEqual([A]);
  });

  test("без вошедшего присвоить некому", () => {
    legacyItem("old-1", "s1");
    claim(null, "old-1");
    expect(ownerless()).toHaveLength(1);
  });
});

describe("кэш и черновики: чужое не показывается", () => {
  test("план безопасности, списки и профиль А не видны Б", () => {
    cache.saveSafetyPlan(A, { content: { steps: ["А"] } } as never);
    cache.saveSurveyList(A, [{ id: "s1", title: "Методика А" }] as never);
    cache.saveBatteries(A, [{ id: "b1" }] as never);
    cache.saveMe({ id: A, readOnly: false } as never);
    cache.saveRounds(A, { items: [{ id: "p1" }] });
    cache.savePatientCard(A, "p1", { fullName: "Петренко" });
    cache.saveSurvey(A, { id: "s1", title: "Методика А" } as never);

    expect(cache.safetyPlan(B)).toBeNull();
    expect(cache.surveyList(B)).toBeNull();
    expect(cache.batteries(B)).toBeNull();
    expect(cache.me(B)).toBeNull();
    expect(cache.rounds(B)).toBeNull();
    expect(cache.patientCard(B, "p1")).toBeNull();
    expect(cache.survey(B, "s1")).toBeNull();
    expect(cache.surveyTitle(B, "s1")).toBeNull();

    // своё при этом на месте
    expect(cache.safetyPlan(A)).not.toBeNull();
    expect(cache.me(A)?.id).toBe(A);
    expect(cache.surveyTitle(A, "s1")).toBe("Методика А");
  });

  test("без владельца кэш не отдаёт и не пишет ничего", () => {
    cache.saveSafetyPlan(A, { content: {} } as never);
    expect(cache.safetyPlan(null)).toBeNull();

    // ответ, пришедший после выхода, не ложится «ничьим»
    cache.saveSurveyList(null, [{ id: "s1" }] as never);
    expect(memoryStore.keys("")).toEqual([`u:${A}:safety:plan`]);
  });

  test("профиль кладётся под того, кого вернул сервер", () => {
    cache.saveMe({ id: B } as never);
    expect(cache.me(B)?.id).toBe(B);
    expect(cache.me(A)).toBeNull();
  });

  test("черновик А не предлагается Б «продолжить» и не досылается под Б", () => {
    drafts.save(A, draft("s1", 120));
    expect(drafts.get(B, "s1")).toBeNull();
    expect(drafts.unsynced(B)).toEqual([]);
    expect(drafts.get(A, "s1")?.answers).toHaveLength(120);
    expect(drafts.unsynced(A)).toHaveLength(1);

    // стереть чужой черновик Б тоже не может
    drafts.drop(B, "s1");
    expect(drafts.get(A, "s1")).not.toBeNull();
  });

  test("черновик без владельца не пишется молча — это отказ", () => {
    expect(() => drafts.save(null, draft("s1", 1))).toThrow();
    expect(drafts.get(null, "s1")).toBeNull();
    expect(drafts.unsynced(null)).toEqual([]);
  });
});

describe("кэш под общими ключами, оставшийся от прежней версии", () => {
  test("стирается при запуске; очередь, своё и идентификатор устройства остаются", () => {
    // так лежало до исправления: чьё — не узнать
    for (const name of ["list:surveys", "list:groups", "list:batteries", "safety:plan", "me", "rounds:list"]) {
      memoryStore.write(name, { legacy: true });
    }
    memoryStore.write("rounds:card:p1", { legacy: true });
    memoryStore.write("survey:s1", { legacy: true });
    memoryStore.write("draft:s1", { legacy: true });
    memoryStore.write("queue:old-1", { id: "old-1", surveyId: "s1", payload: {}, queuedAt: "2026-09-01T00:00:00.000Z", attempts: 0 });
    memoryStore.write("device:id", { id: "dev-1" });
    cache.saveSafetyPlan(A, { content: {} } as never);
    drafts.save(A, draft("s1", 3));

    expect(dropLegacyCache()).toBe(9);

    expect(memoryStore.keys("").sort()).toEqual(
      ["device:id", "queue:old-1", `u:${A}:draft:s1`, `u:${A}:safety:plan`].sort(),
    );
    // второй запуск — стирать уже нечего
    expect(dropLegacyCache()).toBe(0);
  });
});
