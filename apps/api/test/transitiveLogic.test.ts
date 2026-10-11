import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray } from "drizzle-orm";
import { isQuestionVisible, type Answer, type SurveyFull } from "@quizzy/shared";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, isNull, makeUser, surveys } from "./fixtures";
import { alertCases, answers as answersTable, auditLog, riskAlerts } from "../src/db/schema";

/**
 * Условие показа транзитивно (#135) — через сервер.
 *
 * Q1 «думки?», Q2 показ при «так» в Q1, Q3 «є план?» (тяжёлый) показ при
 * ответе на Q2. Человек ответил всё и сменил Q1 на «ні». Прежде экран
 * показывал Q3 (его держал старый ответ Q2) и слал тело без скрытого Q2, а
 * сервер считал Q3 скрытым: ответ отброшен (hidden_answers_dropped),
 * тревоги нет, кризисной карточки нет — при показанном пункте. Теперь Q3
 * скрыт и на экране: тело по клиентскому правилу сервер читает без потерь.
 *
 * Тело собирается ТЕМ ЖЕ правилом, что у клиентов (только видимые по
 * isQuestionVisible ответы, как Runner, мобилка и administerPayload). Сдаёт
 * пациент ролью приложения.
 */

const surveyId = crypto.randomUUID();
const people: string[] = [];
const label = (uk: string) => ({ uk, ru: uk, en: uk });

beforeAll(async () => {
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: label(`Ланцюжок умов ${surveyId.slice(0, 8)}`),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  const yesNo = (title: string, extra: Record<string, unknown> = {}, risky = false) => ({
    type: "yesno",
    title: label(title),
    required: false,
    options: [
      {
        text: label("Так"),
        keyCode: "yes",
        ...(risky ? { riskFlag: true, riskSeverity: "severe", riskLabel: label("Є план") } : {}),
      },
      { text: label("Ні"), keyCode: "no" },
    ],
    ...extra,
  });
  await createVersion(
    surveyId,
    createSurveySchema.parse({
      title: label("Ланцюжок умов"),
      administration: "self",
      questions: [
        yesNo("Чи бувають думки про смерть?"),
        // «так» в Q1 — ссылка на вариант местом: createVersion переведёт в id варианта
        yesNo("Як часто?", { logic: [{ sourceIndex: 0, operator: "contains", value: { $option: { question: 0, position: 0 } } }] }),
        yesNo("Чи є план?", { logic: [{ sourceIndex: 1, operator: "answered" }] }, true),
      ],
    }),
    adminA.id,
    "v1",
  );
}, 30_000);

afterAll(async () => {
  if (!people.length) return;
  const now = new Date().toISOString();
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: now, acknowledgedBy: adminA.id })
    .where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
  await db
    .update(alertCases)
    .set({ acknowledgedAt: now, acknowledgedBy: adminA.id, outcome: "not_confirmed" })
    .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
});

/** Ответы «так»/«ні» по пунктам, тело — по клиентскому правилу; сдача пациентом */
async function submitAsClient(choices: ("yes" | "no")[]) {
  const p = await makeUser("user", `chain-${crypto.randomUUID().slice(0, 8)}@test.dev`, { sex: "female", birthDate: "1994-04-04" });
  people.push(p.id);
  const shown = (await appApi<SurveyFull>(`/api/surveys/${surveyId}`, p.token)).body;
  const all: Answer[] = shown.questions.map((q, i) => ({
    questionId: q.id,
    optionIds: [q.options.find((o) => o.keyCode === choices[i])!.id],
  }));
  const memory = new Map(all.map((a) => [a.questionId, a]));
  const visible = shown.questions.filter((q) => isQuestionVisible(q, shown.questions, memory));
  const body = all.filter((a) => visible.some((q) => q.id === a.questionId));
  const res = await appApi(`/api/surveys/${surveyId}/responses`, p.token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      versionId: shown.versionId,
      answers: body.map((a) => ({ ...a, durationMs: 1000, changeCount: 0, visitCount: 1 })),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const [logged] = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "response.submit"), eq(auditLog.resourceId, res.body.id)));
  const stored = await db.select({ questionId: answersTable.questionId }).from(answersTable).where(eq(answersTable.responseId, res.body.id));
  const alerts = await db.select({ severity: riskAlerts.severity }).from(riskAlerts).where(eq(riskAlerts.userId, p.id));
  return {
    screen: visible.map((q) => shown.questions.indexOf(q) + 1),
    sent: body.length,
    stored: stored.length,
    hiddenDropped: (logged!.details as { hiddenDropped: number }).hiddenDropped,
    alerts: alerts.map((a) => a.severity),
  };
}

describe("транзитивное условие показа через сервер (#135)", () => {
  test("Q1 сменён на «ні» при старых ответах Q2 и Q3: Q3 не показан, тело принято без потерь", async () => {
    expect(await submitAsClient(["no", "yes", "yes"])).toEqual({
      screen: [1],
      sent: 1,
      stored: 1,
      hiddenDropped: 0,
      alerts: [],
    });
  }, 30_000);

  test("контроль: Q1 «так» — все три пункта показаны и приняты, тяжёлый ответ поднимает тревогу", async () => {
    expect(await submitAsClient(["yes", "yes", "yes"])).toEqual({
      screen: [1, 2, 3],
      sent: 3,
      stored: 3,
      hiddenDropped: 0,
      alerts: ["severe"],
    });
  }, 30_000);
});
