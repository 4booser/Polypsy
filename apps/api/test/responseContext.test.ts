import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResponseContext } from "@quizzy/shared";
import { adminA, adminB, api, db, eq, makeUser, submitSurvey, surveyInA, type Person } from "./fixtures";

/**
 * Обстановка вокруг протокола (GET /api/response-context/:id): шапка
 * пациента, строка открытого и переключатель попыток экранов прохождения.
 *
 * Данные — свои: отдельный обследуемый с уникальной почтой, две сдачи одной
 * методики и два сигнала, вставленные явно. Открытый сигнал в конце
 * закрывается — очередь сигналов общая на процесс, и висящий «тестовый»
 * сигнал чужому тесту уведомлений посчитался бы как настоящий.
 */
const { riskAlerts, questions } = await import("../src/db/schema");

let person: Person;
let first: string;
let second: string;
const openAlert = crypto.randomUUID();
const reviewedAlert = crypto.randomUUID();

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

  const items = await db.query.questions.findMany({ where: eq(questions.surveyId, surveyInA), limit: 2 });
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
  ]);
}, 30_000);

afterAll(async () => {
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: adminA.id, outcome: "not_confirmed" })
    .where(eq(riskAlerts.id, openAlert));
});

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
  });

  test("сотруднику чужой зоны прохождения не существует", async () => {
    const res = await api(`/api/response-context/${second}`, adminB.token);
    expect(res.status).toBe(404);
  });

  test("неизвестный id — 404, а не пустая обстановка", async () => {
    const res = await api(`/api/response-context/${crypto.randomUUID()}`, adminA.token);
    expect(res.status).toBe(404);
  });
});
