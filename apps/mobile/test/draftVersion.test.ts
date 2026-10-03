import { beforeEach, describe, expect, test } from "bun:test";
import type { SurveyFull } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { cache, draftRequestBody, drafts, pickDraft, type LocalDraft, type ResumableDraft } from "../src/offline/cache";
import { restoreDraft } from "../src/runner/resume";

/**
 * Черновик продолжается в своей версии методики (волна 16, внешний разбор, P1).
 *
 * Дефект: экран открывал методику в действующей версии, а ответы брал из
 * черновика, начатого на прежней. Версию черновика не помнил ни локальный
 * черновик, ни выбор между локальным и серверным, ни тип ответа сервера.
 * Автосохранение слало версию с экрана (v2) и ответы на пункты v1 — сервер
 * отвечал 200 и молча их выбрасывал, следующее открытие показывало пустой
 * черновик. У каждой версии свои пункты, поэтому перенести ответы нечем:
 * либо продолжить в той версии, где они даны, либо честно сказать человеку,
 * что это не получилось.
 */

const A = "patient-a";

/** Методика одной версии: пункты с идентификаторами, уникальными для версии */
function version(n: number, ids: string[]): SurveyFull {
  return {
    id: "s1",
    title: `v${n}`,
    versionId: `s1-v${n}`,
    versionNumber: n,
    questions: ids.map((id) => ({ id, type: "text", title: id, required: false })),
    sections: [],
  } as unknown as SurveyFull;
}

const v1 = version(1, ["v1-q1"]);
const v2 = version(2, ["v2-q1", "v2-q2"]);

const remoteOn = (survey: SurveyFull, questionIds: string[]): ResumableDraft => ({
  versionId: survey.versionId,
  versionNumber: survey.versionNumber,
  answers: questionIds.map((questionId) => ({ questionId, text: "ВІДПОВІДЬ" })),
  startedAt: "2026-09-28T07:00:00.000Z",
  durationMs: 7000,
  lastSavedAt: "2026-09-28T07:01:00.000Z",
});

const localOn = (survey: SurveyFull | null, questionIds: string[], extra: Partial<LocalDraft> = {}): LocalDraft => ({
  surveyId: "s1",
  ...(survey ? { versionId: survey.versionId, versionNumber: survey.versionNumber } : {}),
  answers: questionIds.map((questionId) => ({ questionId, text: "ЛОКАЛЬНО" })),
  startedAt: "2026-09-28T07:00:00.000Z",
  durationMs: 9000,
  events: [],
  savedAt: "2026-09-28T07:05:00.000Z",
  synced: false,
  revision: 3,
  ...extra,
});

/** Сервер методик: отдаёт версию по номеру — или ничего, если сети нет */
function versions(available: SurveyFull[]) {
  const asked: { versionId: string; versionNumber: number | null }[] = [];
  const open = async (versionId: string, versionNumber: number | null) => {
    asked.push({ versionId, versionNumber });
    const found = available.find((s) => s.versionId === versionId);
    if (!found) throw Object.assign(new Error("offline"), { status: 0 });
    return found;
  };
  return { open, asked };
}

beforeEach(() => {
  resetStore();
});

describe("версия черновика не теряется по дороге", () => {
  test("выбор между локальным и серверным черновиком несёт версию", () => {
    const fromRemote = pickDraft(null, remoteOn(v1, ["v1-q1"]));
    expect(fromRemote?.versionId).toBe("s1-v1");
    expect(fromRemote?.versionNumber).toBe(1);

    const fromLocal = pickDraft(localOn(v1, ["v1-q1"]), null);
    expect(fromLocal?.versionId, "локальный черновик потерял версию").toBe("s1-v1");
    expect(fromLocal?.versionNumber).toBe(1);
  });

  test("начатое заново и не дошедшее до сервера продолжается вместе с заменой", () => {
    // перезапуск до первой удачной отправки: без замены сервер отказывал бы черновику до самой сдачи
    const pending = pickDraft(localOn(v2, ["v2-q1"], { replacesVersionId: "s1-v1" }), remoteOn(v1, ["v1-q1"]));
    expect(pending?.versionId).toBe("s1-v2");
    expect(pending?.replacesVersionId).toBe("s1-v1");
    // принятая сервером замена дальше не едет
    const synced = pickDraft(localOn(v2, ["v2-q1"], { replacesVersionId: "s1-v1", synced: true }), null);
    expect(synced?.replacesVersionId).toBeNull();
  });

  test("тело автосохранения — версия черновика и явная замена, если она есть", () => {
    const local = localOn(v2, ["v2-q1"], { replacesVersionId: "s1-v1" });
    const body = draftRequestBody(local);
    expect(body.versionId).toBe("s1-v2");
    expect(body.replacesVersionId).toBe("s1-v1");
    expect(body.answers).toEqual(local.answers);

    // черновик до этой правки версии не знает — сервер выведет её по пунктам, как и раньше
    const legacy = draftRequestBody(localOn(null, ["v1-q1"]));
    expect("versionId" in legacy && legacy.versionId !== undefined).toBe(false);
  });
});

describe("продолжение после обновления методики", () => {
  test("ровно сценарий ревьюера: на экране v2, черновик v1 — продолжаем в v1 с его ответами", async () => {
    const server = versions([v1, v2]);
    const restored = await restoreDraft(v2, pickDraft(null, remoteOn(v1, ["v1-q1"])), server.open);

    expect(restored.kind).toBe("resumed");
    if (restored.kind !== "resumed") return;
    // то, что уйдёт автосохранением: версия экрана и ответы — из одной версии
    expect(restored.survey.versionId, "ответы v1 положены на экран v2").toBe("s1-v1");
    expect(restored.draft.answers).toHaveLength(1);
    const ids = new Set(restored.survey.questions.map((q) => q.id));
    for (const a of restored.draft.answers as { questionId: string }[]) expect(ids.has(a.questionId)).toBe(true);
    expect(restored.keptVersion, "человеку не сказали, что он продолжает прежнюю версию").toBe(true);
    // своя версия открывается по номеру из черновика
    expect(server.asked).toEqual([{ versionId: "s1-v1", versionNumber: 1 }]);
  });

  test("та же версия — продолжаем как раньше, без лишнего запроса", async () => {
    const server = versions([v1, v2]);
    const restored = await restoreDraft(v2, pickDraft(null, remoteOn(v2, ["v2-q2"])), server.open);
    expect(restored.kind).toBe("resumed");
    if (restored.kind === "resumed") {
      expect(restored.survey.versionId).toBe("s1-v2");
      expect(restored.keptVersion).toBe(false);
    }
    expect(server.asked).toEqual([]);
  });

  test("свою версию не открыть (нет сети) — ответы не ложатся на чужую, человеку говорят", async () => {
    const server = versions([v2]);
    const restored = await restoreDraft(v2, pickDraft(localOn(v1, ["v1-q1"]), null), server.open);

    expect(restored.kind).toBe("otherVersion");
    if (restored.kind !== "otherVersion") return;
    expect(restored.survey.versionId).toBe("s1-v2");
    // что заменит новый черновик, если человек начнёт заново, — названо явно
    expect(restored.replacesVersionId).toBe("s1-v1");
  });

  test("черновик до этой правки (без версии): свои пункты — продолжаем, чужие — не кладём", async () => {
    const server = versions([v1, v2]);
    const fits = await restoreDraft(v2, pickDraft(localOn(null, ["v2-q1"]), null), server.open);
    expect(fits.kind).toBe("resumed");

    const foreign = await restoreDraft(v2, pickDraft(localOn(null, ["v1-q1"]), null), server.open);
    expect(foreign.kind).toBe("otherVersion");
    if (foreign.kind === "otherVersion") expect(foreign.replacesVersionId).toBeNull();
  });

  test("открытая «своя» версия, где ответов нет, — тоже не продолжение", async () => {
    // сервер вернул не ту версию (или содержимое разошлось) — проверяются сами пункты
    const server = { open: async () => v2 };
    const restored = await restoreDraft(v2, pickDraft(null, remoteOn(v1, ["v1-q1"])), server.open);
    expect(restored.kind).toBe("otherVersion");
  });

  test("черновика нет — обычное начало", async () => {
    const restored = await restoreDraft(v2, pickDraft(null, null), versions([v2]).open);
    expect(restored.kind).toBe("fresh");
    expect(restored.survey).toBe(v2);
  });
});

describe("содержимое версии черновика — на устройстве", () => {
  test("обновление методики в кэше не стирает версию, на которой лежит черновик", () => {
    cache.saveSurvey(A, v1);
    drafts.save(A, localOn(v1, ["v1-q1"]));
    cache.saveSurvey(A, v2);

    expect(cache.survey(A, "s1")?.versionId).toBe("s1-v2");
    expect(cache.surveyVersion(A, "s1", "s1-v1")?.versionId, "без сети черновик v1 не открыть").toBe("s1-v1");
    expect(cache.surveyVersion(A, "s1", "s1-v2")?.versionId).toBe("s1-v2");
  });

  test("без черновика на прежней версии её копия не копится", () => {
    cache.saveSurvey(A, v1);
    cache.saveSurvey(A, v2);
    expect(cache.surveyVersion(A, "s1", "s1-v1")).toBeNull();
  });

  test("сданный черновик уносит и копию своей версии", () => {
    cache.saveSurveyVersion(A, v1);
    drafts.save(A, localOn(v1, ["v1-q1"]));
    expect(cache.surveyVersion(A, "s1", "s1-v1")).not.toBeNull();
    drafts.drop(A, "s1");
    expect(cache.surveyVersion(A, "s1", "s1-v1")).toBeNull();
  });

  test("чужой владелец копию не видит", () => {
    cache.saveSurveyVersion(A, v1);
    expect(cache.surveyVersion("patient-b", "s1", "s1-v1")).toBeNull();
    expect(cache.surveyVersion(null, "s1", "s1-v1")).toBeNull();
  });
});
