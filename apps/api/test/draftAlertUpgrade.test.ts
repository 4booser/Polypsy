import { afterAll, describe, expect, test } from "bun:test";
import { and, inArray, notInArray } from "drizzle-orm";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, isNull, makeUser, surveys } from "./fixtures";
import { alertNotifications, riskAlerts } from "../src/db/schema";
import { runNotifierOnce, setTransportForTests } from "../src/lib/notify";

/**
 * Сдача повышает разобранную тревогу черновика до тяжёлой (#131).
 *
 * Автосохранение подняло умеренную тревогу, дежурный разобрал случай
 * («не подтвердилось»), а человек сменил ответ на тяжёлый и сдал без
 * промежуточного автосохранения. Сдача сливала свежий тяжёлый сигнал в
 * строку черновика (adoptDraftAlerts) вместе с прежней отметкой разбора:
 * тяжёлый сигнал числился разобранным — его не было в /api/alerts, эскалация
 * не шла, а решение по новому случаю его не касалось. Тот же переход на
 * автосохранении (PUT /draft) снимает отметку — это образец.
 *
 * Всё, что делают пациент и дежурный, — ролью приложения (appApi), как в бою.
 * Проверки читают базу владельцем.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const mine: string[] = [];

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Один пункт: «Ні» — без тревоги, «Іноді» — умеренная, «Часто» — тяжёлая; эскалация через 30 минут */
async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Підвищення ${tag()}`, ru: "Повышение" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    allowRetake: true,
    alertEscalateMinutes: 30,
    createdBy: adminA.id,
  } as never);
  const label = (uk: string) => ({ uk, ru: uk });
  await createVersion(
    id,
    createSurveySchema.parse({
      title: label("Підвищення"),
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

function answer(survey: Loaded, option: 1 | 2) {
  const q = survey.questions[0]!;
  return [{ questionId: q.id, optionIds: [q.options[option]!.id], durationMs: 1500, changeCount: 0, visitCount: 1 }];
}

const startedAt = () => new Date(Date.now() - 60_000).toISOString();

async function signalOf(responseId: string) {
  const rows = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, responseId));
  expect(rows.length).toBe(1);
  mine.push(rows[0]!.id);
  return rows[0]!;
}

/**
 * Сигнал итоговой сдачи — как у свежей тяжёлой тревоги: не разобран, в
 * очереди, просроченный эскалируется, решение по случаю ложится на него.
 */
async function expectLiveSevere(responseId: string) {
  const signal = await signalOf(responseId);
  expect(signal.severity).toBe("severe");
  expect(signal.acknowledgedAt, "тяжёлый сигнал унаследовал отметку разбора умеренного").toBeNull();
  expect(signal.outcome).toBeNull();

  const queue = await appApi<{ items: { id: string }[] }>("/api/alerts?limit=500", adminA.token);
  expect(queue.status).toBe(200);
  expect(queue.body.items.map((a) => a.id), "тяжёлого сигнала нет в очереди дежурного").toContain(signal.id);

  /*
   * Просрочен: эскалация через 30 минут, сигналу — 40. Хвост соседних
   * тревог помечается разосланным, как в alerts.test.ts: проход рассыльщика
   * — о наших сигналах, а не о случайном остатке базы.
   */
  await db
    .update(riskAlerts)
    .set({ at: new Date(Date.now() - 40 * 60_000).toISOString() })
    .where(eq(riskAlerts.id, signal.id));
  const others = await db.select({ id: riskAlerts.id }).from(riskAlerts).where(notInArray(riskAlerts.id, mine));
  if (others.length) {
    await db
      .insert(alertNotifications)
      .values(
        others.flatMap((a) =>
          (["initial", "escalation"] as const).map((kind) => ({
            id: crypto.randomUUID(),
            alertId: a.id,
            kind,
            recipients: "",
            channel: "none" as const,
          })),
        ),
      )
      .onConflictDoNothing();
  }
  setTransportForTests({ sendMail: async () => ({ messageId: crypto.randomUUID() }) } as never);
  await runNotifierOnce();
  const kinds = await db
    .select({ kind: alertNotifications.kind })
    .from(alertNotifications)
    .where(eq(alertNotifications.alertId, signal.id));
  expect(kinds.map((k) => k.kind).sort(), "просроченный тяжёлый сигнал не эскалирован").toEqual([
    "escalation",
    "initial",
  ]);

  // решение по случаю, в котором сигнал лежит, — его решение
  const decided = await appApi(`/api/alert-cases/${signal.caseId}`, adminA.token, {
    method: "PATCH",
    body: JSON.stringify({ outcome: "confirmed" }),
  });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const [after] = await db.select().from(riskAlerts).where(eq(riskAlerts.id, signal.id));
  expect(after!.outcome).toBe("confirmed");
  expect(after!.acknowledgedAt).not.toBeNull();
}

afterAll(async () => {
  setTransportForTests(null);
  // всё своё — в конечном состоянии: разобрано (тесты сами разбирают, это страховка на падение)
  if (mine.length) {
    await db
      .update(riskAlerts)
      .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: adminA.id })
      .where(and(inArray(riskAlerts.id, mine), isNull(riskAlerts.acknowledgedAt)));
  }
});

describe("сдача повышает тревогу черновика (#131)", () => {
  test("черновик «умеренно» → разбор «не подтвердилось» → сдача «тяжело»: сигнал снова в работе", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `upgrade-${tag()}@test.dev`, { sex: "female", birthDate: "1990-03-03" });
    const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;

    const draft = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
      method: "PUT",
      body: JSON.stringify({ startedAt: startedAt(), durationMs: 20_000, versionId: shown.versionId, answers: answer(shown, 1) }),
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const early = await signalOf(draft.body.id);
    expect(early.severity).toBe("moderate");

    const dismissed = await appApi(`/api/alert-cases/${early.caseId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "not_confirmed" }),
    });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);

    // ответ сменён на тяжёлый и сдан сразу — без автосохранения между
    const done = await appApi(`/api/surveys/${surveyId}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: startedAt(),
        durationMs: 60_000,
        events: [],
        versionId: shown.versionId,
        answers: answer(shown, 2),
      }),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);

    const signal = await signalOf(done.body.id);
    expect(signal.id, "сигнал черновика не переехал на сдачу").toBe(early.id);
    expect(signal.caseId, "тяжёлый сигнал остался в разобранном случае").not.toBe(early.caseId);
    await expectLiveSevere(done.body.id);
  }, 30_000);

  test("контроль: сдача «тяжело» без черновика — то же самое", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `upgrade-ctl-${tag()}@test.dev`, { sex: "male", birthDate: "1988-04-04" });
    const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const done = await appApi(`/api/surveys/${surveyId}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: startedAt(),
        durationMs: 60_000,
        events: [],
        versionId: shown.versionId,
        answers: answer(shown, 2),
      }),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    await expectLiveSevere(done.body.id);
  }, 30_000);
});
