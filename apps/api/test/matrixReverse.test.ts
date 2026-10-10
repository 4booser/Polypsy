import { afterAll, describe, expect, test } from "bun:test";
import { and, inArray } from "drizzle-orm";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, isNull, makeUser, surveys } from "./fixtures";
import { alertCases, responseScores, riskAlerts } from "../src/db/schema";

/**
 * Частично заполненная матрица с обратным ключом (#136) — через сервер.
 *
 * Матрица 3 строки, варианты 0–3, обратный ключ, пункт необязательный;
 * ответ — одна строка, вариант 3 (обращённый — 0). Прежде: балл 6, полоса
 * «тяжело», тревога. Пропущенные строки при обращении считались худшим
 * ответом, а для доли ответов частичная матрица считалась отвеченной
 * целиком. Подсчёт общий (packages/shared, scoring.ts); здесь — что сервер
 * записывает и поднимает. Сдаёт пациент ролью приложения.
 */

const people: string[] = [];
const label = (uk: string) => ({ uk, ru: uk, en: uk });

afterAll(async () => {
  // тревоги и случаи — в конечном состоянии (на прежнем коде тест их заводил)
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

async function makeSurvey(minAnsweredShare: number | null): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: label(`Обернена матриця ${id.slice(0, 8)}`),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(
    id,
    createSurveySchema.parse({
      title: label("Обернена матриця"),
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "matrix",
          title: label("Як часто за останній тиждень…"),
          required: false,
          reverseScored: true,
          scaleCode: "M",
          options: [
            ...["Спокій", "Сон", "Апетит"].map((text) => ({ text: label(text), kind: "row" })),
            ...[0, 1, 2, 3].map((score) => ({ text: label(String(score)), score })),
          ],
        },
      ],
      scales: [
        {
          code: "M",
          title: label("Матриця"),
          kind: "clinical",
          normalization: "raw",
          ...(minAnsweredShare !== null ? { minAnsweredShare } : {}),
          bands: [
            { minScore: 0, maxScore: 4, label: label("Норма") },
            { minScore: 5, maxScore: 9, label: label("Тяжко"), severity: "severe" },
          ],
        },
      ],
    }),
    adminA.id,
    "v1",
  );
  return id;
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string; kind: string; score: number }[] }[] };

/** Одна строка матрицы — вариант 3 */
async function submitOneRow(surveyId: string) {
  const p = await makeUser("user", `matrix-rev-${crypto.randomUUID().slice(0, 8)}@test.dev`, {
    sex: "male",
    birthDate: "1989-09-09",
  });
  people.push(p.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, p.token)).body;
  const q = shown.questions[0]!;
  const row = q.options.find((o) => o.kind === "row")!;
  const three = q.options.find((o) => o.kind === "option" && o.score === 3)!;
  const res = await appApi(`/api/surveys/${surveyId}/responses`, p.token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      versionId: shown.versionId,
      answers: [{ questionId: q.id, matrix: { [row.id]: three.id }, durationMs: 1000, changeCount: 0, visitCount: 1 }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const stored = await db.select().from(responseScores).where(eq(responseScores.responseId, res.body.id));
  const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.userId, p.id));
  return { stored, alerts };
}

describe("обратная матрица, одна строка из трёх (#136)", () => {
  test("доля по умолчанию: треть матрицы — шкала не вычислена, ни полосы, ни тревоги", async () => {
    const { stored, alerts } = await submitOneRow(await makeSurvey(null));
    expect(stored, "шкала посчитана по трети матрицы").toEqual([]);
    expect(alerts, "тревога по фиктивному баллу").toEqual([]);
  }, 30_000);

  test("своя доля 0: балл — обращённый ответ строки (0), полоса «Норма», тревоги нет", async () => {
    const { stored, alerts } = await submitOneRow(await makeSurvey(0));
    expect(stored.map((s) => ({ raw: s.rawScore, band: s.bandLabel, severity: s.severity }))).toEqual([
      { raw: 0, band: "Норма", severity: "none" },
    ]);
    expect(alerts).toEqual([]);
  }, 30_000);
});
