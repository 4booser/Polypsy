import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { RespondentDynamics } from "@quizzy/shared";
import { adminA, appApi, db, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { conclusions, responseScores, riskAlerts, scales, surveyAccess } from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";

/**
 * Что график курса берёт у динамики и хронологии (charts/course.tsx).
 *
 *   — точка динамики говорит, кто заполнял (source): сам человек по
 *     назначению или специалист с его слов — подсказка замера называет это
 *     словом, а балл со слов читается иначе, чем самоотчёт;
 *   — строка сигнала в хронологии несёт прохождение, которое его подняло
 *     (и код шкалы, если его подняла полоса), а строка заключения —
 *     прохождение, по которому оно написано: сигнал ставится кольцом на свой
 *     замер своей шкалы, а не на ось дня (в один день человек проходит три
 *     методики, и сигнал PHQ-9 на оси GAD-7 читался бы как сигнал GAD-7).
 *
 * Запросы — под ролью приложения, как в бою: поле, которое политика строк
 * не пропускает, здесь пропало бы.
 */

interface TimelineRow {
  id: string;
  kind: string;
  responseId?: string | null;
  scaleCode?: string | null;
}

describe("курс: кто заполнял и к какому замеру относится событие", () => {
  test("точка динамики несёт источник: сам по назначению и специалист с его слов", async () => {
    const person = await makeUser("user", `ce-src-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });

    const own = await submitSurvey(surveyInA, person.token);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const byStaff = await submitSurvey(surveyInA, adminA.token, { onBehalfOf: person.id });
    expect(byStaff.status, JSON.stringify(byStaff.body)).toBe(201);

    const res = await appApi<RespondentDynamics>(`/api/dynamics/respondents/${person.id}`, adminA.token);
    expect(res.status).toBe(200);
    const points = res.body.surveys.flatMap((s) => s.scales.flatMap((sc) => sc.points));
    const sourceOf = (id: string) => points.find((p) => p.responseId === id)?.source;
    expect(sourceOf(own.body.responseId ?? own.body.id)).toBe("assigned");
    expect(sourceOf(byStaff.body.responseId ?? byStaff.body.id)).toBe("clinician");
  });

  test("сигнал и заключение в хронологии — со своим прохождением", async () => {
    const person = await makeUser("user", `ce-tl-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
    const sub = await submitSurvey(surveyInA, person.token);
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const responseId: string = sub.body.responseId ?? sub.body.id;

    const alertId = crypto.randomUUID();
    await db.insert(riskAlerts).values({ id: alertId, responseId, surveyId: surveyInA, userId: person.id, label: "тест", severity: "severe" });
    /* сигнал по полосе — со шкалой: на график он встаёт только своей шкалы */
    const [scored] = await db
      .select({ scaleId: responseScores.scaleId, code: scales.code })
      .from(responseScores)
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(eq(responseScores.responseId, responseId))
      .limit(1);
    expect(scored).toBeTruthy();
    const bandAlertId = crypto.randomUUID();
    await db
      .insert(riskAlerts)
      .values({ id: bandAlertId, responseId, surveyId: surveyInA, scaleId: scored!.scaleId, userId: person.id, label: "смуга", severity: "moderate" });
    const conclusionId = crypto.randomUUID();
    await db.insert(conclusions).values({
      id: conclusionId,
      responseId,
      version: 1,
      text: encryptField("Стан стабільний")!,
      status: "signed",
      createdBy: adminA.id,
      signedAt: new Date().toISOString(),
      signedBy: adminA.id,
    });

    const res = await appApi<{ items: TimelineRow[] }>(`/api/timeline/${person.id}`, adminA.token);
    expect(res.status).toBe(200);
    const alert = res.body.items.find((i) => i.id === `alert:${alertId}`);
    const conclusion = res.body.items.find((i) => i.id === `conclusion:${conclusionId}`);
    expect(alert?.responseId).toBe(responseId);
    expect(alert?.scaleCode).toBeNull();
    const band = res.body.items.find((i) => i.id === `alert:${bandAlertId}`);
    expect(band?.responseId).toBe(responseId);
    expect(band?.scaleCode).toBe(scored!.code);
    expect(conclusion?.responseId).toBe(responseId);
    // у прочих строк поля нет — ни приёму, ни прохождению оно не нужно
    expect(res.body.items.find((i) => i.kind === "response")?.responseId).toBeUndefined();

    /* разобранная тревога — в конечном состоянии, общие очереди не копят «висящих» тестовых строк */
    for (const id of [alertId, bandAlertId]) {
      await db.update(riskAlerts).set({ acknowledgedBy: adminA.id, acknowledgedAt: new Date().toISOString() }).where(eq(riskAlerts.id, id));
    }
  });
});
