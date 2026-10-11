import { expect, test } from "bun:test";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, makeUser, responsesTable, surveys } from "./fixtures";
import { riskAlerts } from "../src/db/schema";

/*
 * Сдача забирает только черновик своей попытки (#147, ревью PR #198).
 * Возвратная методика: черновик СЛЕДУЮЩЕЙ попытки (свой startedAt) с
 * тревогой уже на сервере, а сдача прошлой попытки приходит позже (очередь
 * мобилки). Прежде сдача забирала чужой черновик и его тревогу себе.
 */
const tag = () => crypto.randomUUID().slice(0, 8);
const l = (uk: string) => ({ uk, ru: uk });

async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id, groupId: groupA, title: { uk: `rv21 ${tag()}`, ru: "rv21" }, administration: "self", status: "published",
    publishedAt: new Date().toISOString(), visibility: "public", scoringEnabled: true, showResultsToPatient: true,
    allowRetake: true, createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse({
    title: l("rv21"), administration: "self", scoringEnabled: true,
    questions: [{ type: "single", title: l("Думки?"), required: true, scaleCode: "S", options: [
      { text: l("Ні"), score: 0 },
      { text: l("Так"), score: 1, riskFlag: true, riskLabel: l("Так"), riskSeverity: "severe" },
    ] }],
    scales: [{ code: "S", title: l("Сума"), kind: "clinical", normalization: "raw", bands: [{ minScore: 0, maxScore: 1, label: l("x") }] }],
  }), adminA.id, "v1");
  return id;
}

test("сдача попытки A не трогает черновик и тревогу попытки B", async () => {
  const surveyId = await makeSurvey();
  const person = await makeUser("user", `rv21-retake-${tag()}@test.dev`, { sex: "female", birthDate: "1990-03-03" });
  const shown = (await appApi(`/api/surveys/${surveyId}`, person.token)).body;
  const q = shown.questions[0];
  const answers = (o: number) => [{ questionId: q.id, optionIds: [q.options[o].id], durationMs: 1500, changeCount: 0, visitCount: 1 }];
  const startedA = new Date(Date.now() - 300_000).toISOString();
  const startedB = new Date(Date.now() - 60_000).toISOString();

  // попытка B (новая) — автосохранение с «Так»: тревога на черновике B
  const draftB = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
    method: "PUT", body: JSON.stringify({ startedAt: startedB, durationMs: 30_000, versionId: shown.versionId, answers: answers(1) }),
  });
  expect(draftB.status, JSON.stringify(draftB.body)).toBe(200);
  // попытка A (прошлая, из очереди) — «Ні»
  const subA = await appApi(`/api/surveys/${surveyId}/responses`, person.token, {
    method: "POST", body: JSON.stringify({ startedAt: startedA, durationMs: 100_000, events: [], versionId: shown.versionId, answers: answers(0) }),
  });
  expect(subA.status, JSON.stringify(subA.body)).toBe(201);
  const onA = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, subA.body.id));
  const rows = await db.select({ id: responsesTable.id, status: responsesTable.status, startedAt: responsesTable.startedAt }).from(responsesTable).where(eq(responsesTable.surveyId, surveyId));

  // B продолжает автосохранение — черновика B больше нет, заводится новый, тревога — снова
  const draftB2 = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
    method: "PUT", body: JSON.stringify({ startedAt: startedB, durationMs: 40_000, versionId: shown.versionId, answers: answers(1) }),
  });
  const all = await db.select({ id: riskAlerts.id, responseId: riskAlerts.responseId }).from(riskAlerts).where(eq(riskAlerts.surveyId, surveyId));
  expect(onA.length, "тревога B легла на A, где риска нет").toBe(0);
  expect(rows.filter((r) => r.status === "in_progress").length, "черновик B удалён сдачей A").toBe(1);
  expect(draftB2.status).toBe(200);
  expect(all.length, "одна рискованная попытка — один сигнал").toBe(1);
}, 30_000);
