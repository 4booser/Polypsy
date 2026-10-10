import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SurveyFull } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { drafts, pickDraft, type LocalDraft, type ResumableDraft } from "../src/offline/cache";
import { draftLaneKey, draftLanes } from "../src/offline/draftLane";
import { finishSubmission } from "../src/runner/finish";
import { draftsToResume, dropOwnDraft } from "../src/runner/ownDraft";
import { restoreDraft } from "../src/runner/resume";

/**
 * Сдача за пациента и черновик специалиста (#127).
 *
 * Было: специалист начал методику сам (черновик на сервере и на планшете),
 * потом из обхода открыл её для пациента P. Экран прохождения читал черновик
 * без оглядки на onBehalfOf — предлагал «Продовжити» с ответами специалиста,
 * «Завершити» отправлял их на P, а после сдачи стирал локальную копию
 * специалиста. Серверная копия переживала сдачу и подставлялась следующему
 * пациенту.
 */

const STAFF = "staff-127";
const PATIENT = "patient-127";
const SURVEY = "s127";

const shown = {
  id: SURVEY,
  title: "PHQ-9",
  versionId: `${SURVEY}-v1`,
  versionNumber: 1,
  questions: [{ id: "q1", type: "text", title: "q1", required: false }],
  sections: [],
} as unknown as SurveyFull;

/** Своё незавершённое прохождение специалиста — так оно лежит и на сервере, и на планшете */
const STAFF_STARTED = "2026-10-01T06:00:00.000Z";
const staffLocal: LocalDraft = {
  surveyId: SURVEY,
  versionId: shown.versionId,
  versionNumber: 1,
  answers: [{ questionId: "q1", text: "ВІДПОВІДЬ СПЕЦІАЛІСТА" }],
  startedAt: STAFF_STARTED,
  durationMs: 4000,
  events: [],
  savedAt: "2026-10-01T06:05:00.000Z",
  synced: true,
  revision: 2,
};
const staffRemote: ResumableDraft = {
  versionId: shown.versionId,
  versionNumber: 1,
  answers: staffLocal.answers,
  startedAt: STAFF_STARTED,
  durationMs: 4000,
  lastSavedAt: "2026-10-01T06:05:00.000Z",
};

/** Сервер черновиков: отдаёт черновик того, чей токен, — то есть специалиста */
function server() {
  const asked: string[] = [];
  return {
    asked,
    getDraft: async (surveyId: string) => {
      asked.push(surveyId);
      return staffRemote;
    },
  };
}

const noVersion = async () => null;

beforeEach(() => {
  resetStore();
  drafts.save(STAFF, staffLocal);
});

describe("открытие за пациента", () => {
  test("черновик не читается ни с сервера, ни с устройства — прохождение начинается заново", async () => {
    const srv = server();

    const found = await draftsToResume(SURVEY, { owner: STAFF, onBehalfOf: PATIENT }, srv.getDraft);
    expect(srv.asked, "серверный черновик специалиста не запрашивается").toEqual([]);
    expect(found).toEqual({ local: null, remote: null });

    const restored = await restoreDraft(shown, pickDraft(found.local, found.remote), noVersion);
    // fresh — экран оставляет свой startedAt (момент открытия), а не время начала специалиста
    expect(restored.kind).toBe("fresh");
    expect(restored).not.toHaveProperty("draft");
  });

  test("положительный контроль: своё прохождение черновик продолжает", async () => {
    const srv = server();

    const found = await draftsToResume(SURVEY, { owner: STAFF, onBehalfOf: null }, srv.getDraft);
    expect(srv.asked).toEqual([SURVEY]);
    expect(found.local?.startedAt).toBe(STAFF_STARTED);

    const restored = await restoreDraft(shown, pickDraft(found.local, found.remote), noVersion);
    expect(restored.kind).toBe("resumed");
    if (restored.kind !== "resumed") throw new Error("unreachable");
    expect(restored.draft.startedAt).toBe(STAFF_STARTED);
  });

  test("сервер молчит — своё продолжается с устройства, как раньше", async () => {
    const found = await draftsToResume(SURVEY, { owner: STAFF }, async () => {
      throw Object.assign(new Error("offline"), { status: 0 });
    });
    expect(found.remote).toBeNull();
    expect(found.local?.revision).toBe(2);
  });
});

describe("сдача за пациента", () => {
  test("не стирает черновик специалиста и не снимает его ждущее сохранение", async () => {
    // своё сохранение специалиста в пути и ещё одно ждёт (тот же ключ у досылки очереди)
    const lane = draftLaneKey(STAFF, SURVEY);
    let release!: () => void;
    const inFlight = draftLanes.submit(lane, 10, () => new Promise<void>((done) => (release = done)));
    const waiting = draftLanes.submit(lane, 11, async () => "sent");

    const outcome = await finishSubmission({
      submit: async () => ({ id: "r1", scores: [] }),
      dropDraft: () => dropOwnDraft(SURVEY, { owner: STAFF, onBehalfOf: PATIENT }),
    });
    expect(outcome.ok).toBe(true);
    expect(drafts.get(STAFF, SURVEY)?.startedAt, "черновик специалиста цел").toBe(STAFF_STARTED);

    release();
    await inFlight;
    expect(await waiting, "его сохранение ушло, а не снято чужой сдачей").toEqual({ status: "sent", value: "sent" });
  });

  test("положительный контроль: своя сдача свой черновик стирает и ждущее снимает", async () => {
    const lane = draftLaneKey(STAFF, `${SURVEY}-own`);
    drafts.save(STAFF, { ...staffLocal, surveyId: `${SURVEY}-own` });
    let release!: () => void;
    const inFlight = draftLanes.submit(lane, 10, () => new Promise<void>((done) => (release = done)));
    const waiting = draftLanes.submit(lane, 11, async () => "sent");

    await finishSubmission({
      submit: async () => ({ id: "r2", scores: [] }),
      dropDraft: () => dropOwnDraft(`${SURVEY}-own`, { owner: STAFF, onBehalfOf: null }),
    });
    expect(drafts.get(STAFF, `${SURVEY}-own`)).toBeNull();

    release();
    await inFlight;
    expect(await waiting).toEqual({ status: "superseded" });
  });
});

/**
 * Экран прохождения сам в тестовом процессе не грузится (react-native), а
 * дефект жил именно в нём: черновик читался и стирался прямо в экране, мимо
 * onBehalfOf. Проверяем, что экран ходит к черновику только через решения
 * выше и не держит обходного пути.
 */
describe("экран прохождения", () => {
  const screen = readFileSync(resolve(import.meta.dir, "../app/survey/[id].tsx"), "utf8");

  test("черновик читает и стирает только через runner/ownDraft", () => {
    expect(screen).toContain("draftsToResume(");
    expect(screen).toContain("dropOwnDraft(");
    for (const bypass of ["api.getDraft(", "drafts.get(", "drafts.drop("]) {
      expect(screen.includes(bypass), `${bypass} — в обход onBehalfOf`).toBe(false);
    }
  });
});
