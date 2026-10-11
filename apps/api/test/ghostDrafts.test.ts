import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, inArray, isNull } from "drizzle-orm";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, makeUser, sql, surveys, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { alertCases, answers, auditLog, responses, riskAlerts } from "../src/db/schema";
import { ghostDrafts } from "../src/lib/ghostDrafts";

/**
 * Чистка черновиков-призраков (#197).
 *
 * До #147 автосохранение, дошедшее после сдачи, заводило новый черновик той
 * же попытки (тот же startedAt) с тревогой — в том же случае, а если случай
 * успели разобрать, в новом. Сейчас такой черновик не завести (PUT /draft
 * отказывает сданной попытке), поэтому состояние «до #147» собирается так:
 * черновик и сдача — настоящими запросами пациента под ролью приложения,
 * призрак — строками в базе, ровно какими их писало прежнее автосохранение.
 *
 * Действие обслуживания — тоже ролью приложения: в бою оно идёт в контейнере
 * api (maintenance.yml), а не владельцем базы. Проход — по всей базе: явные
 * таймауты, проверки — по своим строкам.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const STARTED = new Date(Date.now() - 10 * 60_000).toISOString();
const people: string[] = [];

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };
interface Attempt {
  person: Person;
  surveyId: string;
  submittedId: string;
  /** сигнал сданного прохождения — тот, что переехал с черновика при сдаче */
  signal: typeof riskAlerts.$inferSelect;
}

/** Один пункт: «Ні» — без тревоги, «Іноді» — умеренная, «Часто» — тяжёлая */
async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  const label = (uk: string) => ({ uk, ru: uk });
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Призрак ${tag()}`, ru: "Призрак" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(
    id,
    createSurveySchema.parse({
      title: label("Призрак"),
      administration: "self",
      questions: [
        {
          type: "single",
          title: label("Чи бувають думки про небажання жити?"),
          required: true,
          options: [
            { text: label("Ні") },
            { text: label("Іноді"), riskFlag: true, riskLabel: label("Іноді"), riskSeverity: "moderate" },
            { text: label("Часто"), riskFlag: true, riskLabel: label("Часто"), riskSeverity: "severe" },
          ],
        },
      ],
    }),
    adminA.id,
    "v1",
  );
  return id;
}

/** Черновик «Часто» → сдача «Часто» той же попытки: настоящими запросами пациента */
async function submittedAttempt(): Promise<Attempt> {
  const surveyId = await makeSurvey();
  const person = await makeUser("user", `ghost-${tag()}@test.dev`, { sex: "female", birthDate: "1990-03-03" });
  people.push(person.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
  const q = shown.questions[0]!;
  const body = { startedAt: STARTED, versionId: shown.versionId, answers: [{ questionId: q.id, optionIds: [q.options[2]!.id] }] };
  const draft = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
    method: "PUT",
    body: JSON.stringify({ ...body, durationMs: 20_000 }),
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const done = await appApi(`/api/surveys/${surveyId}/responses`, person.token, {
    method: "POST",
    body: JSON.stringify({ ...body, durationMs: 60_000, events: [] }),
  });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  const signals = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, done.body.id));
  expect(signals.length).toBe(1);
  return { person, surveyId, submittedId: done.body.id, signal: signals[0]! };
}

/**
 * Призрак — как его писало автосохранение до #147: тот же startedAt, ответы
 * последней правки (по умолчанию — те же, что сданы), тревога на том же пункте.
 */
async function ghostOf(
  a: Attempt,
  o: { caseId: string | null; option?: 1 | 2; severity?: "moderate" | "severe" },
): Promise<{ id: string; alertId: string }> {
  const id = crypto.randomUUID();
  const [submitted] = await db.select().from(responses).where(eq(responses.id, a.submittedId));
  await db.insert(responses).values({
    id,
    surveyId: a.surveyId,
    userId: a.person.id,
    versionId: submitted!.versionId,
    status: "in_progress",
    startedAt: STARTED,
    lastSavedAt: new Date().toISOString(),
    durationMs: 61_000,
  });
  const sent = await db.select().from(answers).where(eq(answers.responseId, a.submittedId));
  for (const ans of sent) {
    let optionIds = ans.optionIds;
    if (o.option) {
      const [row] = (await db.execute(sql`
        select array_agg(id order by position) as ids from options where question_id = ${ans.questionId}`)) as unknown as {
        ids: string[];
      }[];
      optionIds = [row!.ids[o.option]!];
    }
    await db.insert(answers).values({ ...ans, id: crypto.randomUUID(), responseId: id, optionIds, score: null });
  }
  const alertId = crypto.randomUUID();
  await db.insert(riskAlerts).values({
    id: alertId,
    responseId: id,
    surveyId: a.surveyId,
    questionId: a.signal.questionId,
    userId: a.person.id,
    caseId: o.caseId,
    label: a.signal.label,
    severity: o.severity ?? "severe",
    at: new Date().toISOString(),
  });
  return { id, alertId };
}

async function journalOf(alertIds: string[]) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "alert.duplicate_closed"), inArray(sql`${auditLog.details}->>'alertId'`, alertIds)));
}

const run = (apply: boolean) => asAppRole(() => ghostDrafts({ apply }));

let same: Attempt;
let reviewed: Attempt;
let diverged: Attempt;
let ghost: { id: string; alertId: string };
let ghostNewCase: { id: string; alertId: string };
let ghostDiverged: { id: string; alertId: string };
let newCaseId: string;
let before: (typeof riskAlerts.$inferSelect)[];

beforeAll(async () => {
  // призрак в том же случае: случай сданной попытки ещё открыт
  same = await submittedAttempt();
  ghost = await ghostOf(same, { caseId: same.signal.caseId });

  // случай сданной попытки разобран — позднее автосохранение открыло под призрак новый
  reviewed = await submittedAttempt();
  const decided = await appApi(`/api/alert-cases/${reviewed.signal.caseId}`, adminA.token, {
    method: "PATCH",
    body: JSON.stringify({ outcome: "not_confirmed" }),
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  newCaseId = crypto.randomUUID();
  await db.insert(alertCases).values({ id: newCaseId, userId: reviewed.person.id, surveyId: reviewed.surveyId, severity: "severe" });
  ghostNewCase = await ghostOf(reviewed, { caseId: newCaseId });

  // контроль: в призрак писала другая попытка — ответ «Іноді», а сдано «Часто»
  diverged = await submittedAttempt();
  ghostDiverged = await ghostOf(diverged, { caseId: diverged.signal.caseId, option: 1, severity: "moderate" });

  before = await db
    .select()
    .from(riskAlerts)
    .where(inArray(riskAlerts.responseId, [same.submittedId, reviewed.submittedId, diverged.submittedId]));
}, 60_000);

afterAll(async () => {
  // своё — в конечном состоянии: контрольный призрак убран, случаи разобраны (открытый случай — строка очереди)
  if (ghostDiverged) {
    await db.delete(riskAlerts).where(eq(riskAlerts.id, ghostDiverged.alertId));
    await db.delete(responses).where(eq(responses.id, ghostDiverged.id));
  }
  if (people.length) {
    const at = new Date().toISOString();
    await db.update(riskAlerts).set({ acknowledgedAt: at, acknowledgedBy: adminA.id }).where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
    await db
      .update(alertCases)
      .set({ acknowledgedAt: at, acknowledgedBy: adminA.id, outcome: "not_confirmed" })
      .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
  }
}, 30_000);

/** Призраки этих людей по запросу из #197 */
async function ghostsLeft(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select d.id from responses d
    join responses r on r.survey_id = d.survey_id and r.user_id = d.user_id
      and r.status <> 'in_progress' and r.started_at = d.started_at
    where d.status = 'in_progress' and d.user_id in ${people}`)) as unknown as { id: string }[];
  return rows.map((r) => r.id).sort();
}

describe("черновики-призраки (#197)", () => {
  test("сухой прогон: находит призраков, дубли отличает от расходящихся — и ничего не меняет", async () => {
    const report = await run(false);
    const mine = new Map(report.ghosts.map((g) => [g.id, g]));

    const g = mine.get(ghost.id);
    expect(g?.verdict).toBe("duplicate");
    expect(g?.submittedId).toBe(same.submittedId);
    expect(g?.alerts.map((a) => [a.id, a.pair?.id])).toEqual([[ghost.alertId, same.signal.id]]);
    expect(mine.get(ghostNewCase.id)?.verdict).toBe("duplicate");
    expect(mine.get(ghostDiverged.id)).toMatchObject({ verdict: "review", reason: "answers" });

    expect(report.removed).toBe(0);
    expect(await ghostsLeft()).toEqual([ghost.id, ghostNewCase.id, ghostDiverged.id].sort());
    const alerts = await db
      .select({ id: riskAlerts.id })
      .from(riskAlerts)
      .where(inArray(riskAlerts.id, [ghost.alertId, ghostNewCase.alertId, ghostDiverged.alertId]));
    expect(alerts.length).toBe(3);
    expect(await journalOf([ghost.alertId, ghostNewCase.alertId])).toEqual([]);
    const [open] = await db.select().from(alertCases).where(eq(alertCases.id, newCaseId));
    expect(open!.acknowledgedAt).toBeNull();
  }, 60_000);

  test("с --apply: призрака нет, его тревога закрыта как дубль строкой журнала, сданное прохождение не тронуто", async () => {
    const report = await run(true);
    expect(report.removed).toBeGreaterThanOrEqual(2);

    // призраков-дублей нет; расходящийся — на месте, вместе с тревогой
    expect(await ghostsLeft()).toEqual([ghostDiverged.id]);
    const left = await db
      .select({ id: riskAlerts.id })
      .from(riskAlerts)
      .where(inArray(riskAlerts.id, [ghost.alertId, ghostNewCase.alertId, ghostDiverged.alertId]));
    expect(left.map((a) => a.id)).toEqual([ghostDiverged.alertId]);
    expect(await db.select().from(answers).where(inArray(answers.responseId, [ghost.id, ghostNewCase.id]))).toEqual([]);

    // тревога не пропала без следа: строка журнала в её случае — с исходом и тем, что было в строке
    const journal = await journalOf([ghost.alertId, ghostNewCase.alertId]);
    expect(journal.length).toBe(2);
    const of = (id: string) => journal.find((j) => (j.details as { alertId: string }).alertId === id)!;
    expect(of(ghost.alertId)).toMatchObject({
      resourceType: "alert_case",
      resourceId: same.signal.caseId,
      subjectUserId: same.person.id,
      details: {
        outcome: "duplicate",
        duplicateOf: same.signal.id,
        ghostResponseId: ghost.id,
        responseId: same.submittedId,
        questionId: same.signal.questionId,
        severity: "severe",
        caseClosed: false,
      },
    });
    expect(of(ghostNewCase.alertId)).toMatchObject({
      resourceId: newCaseId,
      details: { outcome: "duplicate", duplicateOf: reviewed.signal.id, caseClosed: true },
    });
    const removed = await db
      .select({ resourceId: auditLog.resourceId })
      .from(auditLog)
      .where(and(eq(auditLog.action, "response.ghost_removed"), inArray(auditLog.resourceId, [ghost.id, ghostNewCase.id])));
    expect(removed.length).toBe(2);

    // видно в разборе случая — тем же маршрутом, что у дежурного
    const history = await appApi<{ items: { action: string; details: { alertId?: string } }[] }>(
      `/api/alert-cases/${same.signal.caseId}/history`,
      adminA.token,
    );
    expect(history.status).toBe(200);
    expect(history.body.items.find((i) => i.action === "alert.duplicate_closed")?.details.alertId).toBe(ghost.alertId);

    // случай, открытый под призрак, без сигналов из очереди ушёл; разобранный случай сдачи — как был
    const [emptied] = await db.select().from(alertCases).where(eq(alertCases.id, newCaseId));
    expect(emptied!.acknowledgedAt).not.toBeNull();
    const [kept] = await db.select().from(alertCases).where(eq(alertCases.id, reviewed.signal.caseId!));
    expect(kept!.outcome).toBe("not_confirmed");

    // сданные прохождения и их тревоги — те же строки, что до чистки
    const after = await db
      .select()
      .from(riskAlerts)
      .where(inArray(riskAlerts.responseId, [same.submittedId, reviewed.submittedId, diverged.submittedId]));
    expect(after.sort((x, y) => x.id.localeCompare(y.id))).toEqual(before.sort((x, y) => x.id.localeCompare(y.id)));
    const kept3 = await db
      .select({ id: responses.id, status: responses.status })
      .from(responses)
      .where(inArray(responses.id, [same.submittedId, reviewed.submittedId, diverged.submittedId]));
    expect(kept3.every((r) => r.status === "completed")).toBe(true);
    expect(kept3.length).toBe(3);
  }, 60_000);

  test("повторный прогон с --apply ничего не делает", async () => {
    const report = await run(true);
    expect(report.removed).toBe(0);
    expect(report.closedAlerts).toBe(0);
    expect(report.ghosts.map((g) => g.verdict)).not.toContain("duplicate");
    expect(await ghostsLeft()).toEqual([ghostDiverged.id]);
    expect((await journalOf([ghost.alertId, ghostNewCase.alertId])).length).toBe(2);
  }, 60_000);
});
