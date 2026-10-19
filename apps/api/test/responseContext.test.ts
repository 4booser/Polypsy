import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResponseContext } from "@quizzy/shared";
import { adminA, adminB, api, db, eq, groupA, groupAdmins, makeUser, root, submitSurvey, surveyInA, surveyInB, type Person } from "./fixtures";

/**
 * Обстановка вокруг протокола (GET /api/response-context/:id): шапка
 * пациента, строка открытого и переключатель попыток экранов прохождения.
 *
 * Данные — свои: отдельный обследуемый с уникальной почтой, две сдачи одной
 * методики и два сигнала, вставленные явно. Открытый сигнал в конце
 * закрывается — очередь сигналов общая на процесс, и висящий «тестовый»
 * сигнал чужому тесту уведомлений посчитался бы как настоящий.
 */
const { riskAlerts, questions, auditLog, permissionExceptions } = await import("../src/db/schema");
const { and, sql } = await import("drizzle-orm");

let person: Person;
let first: string;
let second: string;
/* сотрудники группы А: у одного отнято право читать данные пациентов, у другого — разбирать сигналы */
let noRead: Person;
let noReview: Person;
const openAlert = crypto.randomUUID();
const reviewedAlert = crypto.randomUUID();
/* открытый сигнал того же человека по методике группы Б — читающему из группы А его не видно */
const foreignAlert = crypto.randomUUID();

beforeAll(async () => {
  person = await makeUser("user", `ctx-${crypto.randomUUID()}@test`, {
    sex: "female",
    birthDate: "1991-05-12",
    unit: "Рота Б",
  });
  const a = await submitSurvey(surveyInA, person.token);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  first = a.body.id;
  const b = await submitSurvey(surveyInA, person.token);
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  second = b.body.id;

  const elsewhere = await submitSurvey(surveyInB, person.token);
  expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);

  const items = await db.query.questions.findMany({ where: eq(questions.surveyId, surveyInA), limit: 2 });
  const foreignItem = await db.query.questions.findFirst({ where: eq(questions.surveyId, surveyInB) });
  await db.insert(riskAlerts).values([
    {
      id: openAlert,
      responseId: second,
      surveyId: surveyInA,
      questionId: items[0]!.id,
      userId: person.id,
      label: "Сигнал контексту: відкритий",
      severity: "severe",
      at: new Date(Date.now() - 90 * 60_000).toISOString(),
    },
    {
      id: reviewedAlert,
      responseId: first,
      surveyId: surveyInA,
      questionId: items[1]!.id,
      userId: person.id,
      label: "Сигнал контексту: розібраний",
      severity: "moderate",
      at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      acknowledgedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      acknowledgedBy: adminA.id,
      outcome: "not_confirmed",
    },
    {
      id: foreignAlert,
      responseId: elsewhere.body.id,
      surveyId: surveyInB,
      questionId: foreignItem!.id,
      userId: person.id,
      label: "Сигнал контексту: чужа зона",
      severity: "severe",
      at: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
  ]);

  noRead = await makeUser("admin", `ctx-noread-${crypto.randomUUID()}@test`);
  noReview = await makeUser("admin", `ctx-noreview-${crypto.randomUUID()}@test`);
  await db.insert(groupAdmins).values([
    { groupId: groupA, userId: noRead.id, addedBy: root.id },
    { groupId: groupA, userId: noReview.id, addedBy: root.id },
  ]);
  await db.insert(permissionExceptions).values([
    {
      id: crypto.randomUUID(),
      userId: noRead.id,
      permission: "patients.read",
      mode: "revoke",
      reason: "Проверка: обстановка без права читать данные пациентов",
      grantedBy: root.id,
    },
    {
      id: crypto.randomUUID(),
      userId: noReview.id,
      permission: "alerts.review",
      mode: "revoke",
      reason: "Проверка: обстановка без права разбирать сигналы",
      grantedBy: root.id,
    },
  ]);
}, 30_000);

afterAll(async () => {
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: adminA.id, outcome: "not_confirmed" })
    .where(sql`${riskAlerts.id} in (${openAlert}, ${foreignAlert})`);
});

/** Строки журнала «прочитана обстановка» по прохождению от этого читающего */
async function contextReads(responseId: string, actorId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "response.read"),
        eq(auditLog.resourceId, responseId),
        eq(auditLog.actorId, actorId),
        sql`${auditLog.details}->>'view' = 'context'`,
      ),
    );
}

describe("обстановка вокруг протокола", () => {
  /**
   * Мутация: сортировать попытки по убыванию — переключатель «19 → 16 → 14»
   * читался бы задом наперёд, проверка порядка падает. Мутация: брать
   * сигналы только по responseId — открытый сигнал виден, а разобранный
   * сигнал первой сдачи пропадает правильно; брать все сигналы человека без
   * условия «открыт или этот» — в список второй сдачи попадает разобранный
   * сигнал первой, проверка называет его.
   */
  test("персоналу — человек, попытки по порядку, открытый сигнал этого прохождения", async () => {
    const res = await api<ResponseContext>(`/api/response-context/${second}`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ctx = res.body;
    expect(ctx.patient?.id).toBe(person.id);
    expect(ctx.patient?.sex).toBe("female");
    expect(ctx.patient?.unit).toBe("Рота Б");
    expect(ctx.patient?.age).toBeGreaterThanOrEqual(34);
    expect(ctx.attempts.map((a) => a.id)).toEqual([first, second]);
    expect(ctx.attempts.every((a) => a.versionNumber === ctx.attempts[0]!.versionNumber)).toBe(true);
    expect(ctx.attempts[1]!.scores.length).toBeGreaterThan(0);

    const ids = (ctx.signals ?? []).map((s) => s.id);
    expect(ids).toContain(openAlert);
    expect(ids, "разобранный сигнал другой сдачи не висит над этим протоколом").not.toContain(reviewedAlert);
    const open = ctx.signals!.find((s) => s.id === openAlert)!;
    expect(open.here).toBe(true);
    expect(open.reviewedAt).toBeNull();
    expect(open.minutesOpen).toBeGreaterThanOrEqual(89);
    expect(Array.isArray(ctx.hits)).toBe(true);
    expect(ids, "сигнал по методике чужой зоны читающему не показывается").not.toContain(foreignAlert);
  });

  /**
   * Мутация: убрать audit из маршрута — строки нет, проверка падает. Чтение
   * клинических данных (баллы всех попыток, сигналы человека) не бывает
   * тихим: так пишут соседние чтения — прохождение по id, динамика.
   */
  test("каждое чтение — строка журнала response.read с видом context и пациентом", async () => {
    const before = (await contextReads(second, adminA.id)).length;
    const res = await api<ResponseContext>(`/api/response-context/${second}`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await contextReads(second, adminA.id);
    expect(rows.length, "строки журнала нет").toBe(before + 1);
    const row = rows.find((x) => (x.details as { attempts?: number }).attempts === 2)!;
    expect(row, "в строке нет числа попыток").toBeDefined();
    expect(row.subjectUserId).toBe(person.id);
    expect(row.resourceType).toBe("response");
    expect((row.details as { signals?: number | null }).signals).toBe(res.body.signals!.length);
  });

  /** Мутация: снять requirePermission(CLINICAL_READ) — обстановка уходит тому, кому заключение закрыто */
  test("без права читать данные пациентов — отказ, как у заключения, и строки чтения нет", async () => {
    const res = await api(`/api/response-context/${second}`, noRead.token);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("patients.read");
    expect(JSON.stringify(res.body)).not.toContain(person.id);
    expect((await contextReads(second, noRead.id)).length).toBe(0);
  });

  /** Мутация: отдавать сигналы без alerts.review — у noReview появится список, проверка падает */
  test("без права разбирать сигналы — человек и попытки есть, сигналов и правил нет (null, а не пусто)", async () => {
    const res = await api<ResponseContext>(`/api/response-context/${second}`, noReview.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.patient?.id).toBe(person.id);
    expect(res.body.attempts.length).toBe(2);
    expect(res.body.signals).toBeNull();
    expect(res.body.hits).toBeNull();
    const rows = await contextReads(second, noReview.id);
    expect(rows.length).toBe(1);
    expect((rows[0]!.details as { signals?: number | null }).signals).toBeNull();
  });

  test("у первой сдачи — её разобранный сигнал со словом исхода и открытый сигнал человека", async () => {
    const res = await api<ResponseContext>(`/api/response-context/${first}`, adminA.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byId = new Map((res.body.signals ?? []).map((s) => [s.id, s]));
    expect(byId.get(reviewedAlert)?.here).toBe(true);
    expect(byId.get(reviewedAlert)?.outcome).toBe("not_confirmed");
    expect(byId.get(reviewedAlert)?.reviewedAt).not.toBeNull();
    expect(byId.get(openAlert)?.here).toBe(false);
    // открытые — первыми: строка открытого начинается с того, что ждёт разбора
    expect(res.body.signals![0]!.reviewedAt).toBeNull();
  });

  test("обследуемому своё — нет: это экран персонала", async () => {
    const res = await api(`/api/response-context/${second}`, person.token);
    expect(res.status).toBe(403);
    expect((await contextReads(second, person.id)).length, "отказ записан как чтение").toBe(0);
  });

  test("сотруднику чужой зоны прохождения не существует", async () => {
    const res = await api(`/api/response-context/${second}`, adminB.token);
    expect(res.status).toBe(404);
    expect((await contextReads(second, adminB.id)).length, "отказ записан как чтение").toBe(0);
  });

  test("неизвестный id — 404, а не пустая обстановка", async () => {
    const res = await api(`/api/response-context/${crypto.randomUUID()}`, adminA.token);
    expect(res.status).toBe(404);
  });
});
