import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, makeUser, surveys, users } from "./fixtures";
import { responses } from "../src/db/schema";

/**
 * Черновик заключения: «було» — только сравнимое (#137).
 *
 * Шкала T-баллов с нормой только для мужчин. Сдача без пола — сырой 3
 * (нормировать не по чему); пол исправлен, вторая сдача — T 70. Черновик
 * писал «70 — високий (було 3)», хотя динамика для той же пары говорит
 * «несравнимо». Так же шло значение недостоверного прошлого протокола.
 * Правило сравнимости — общее (shared/rci.ts, comparability).
 *
 * Сдаёт пациент, черновик читает специалист — ролью приложения.
 */

const surveyId = crypto.randomUUID();
const label = (uk: string) => ({ uk, ru: uk, en: uk });

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };
type Draft = {
  previousAt: string | null;
  scales: { value: number; normalization: string; previousValue: number | null; previousIncomparable: string | null }[];
};

beforeAll(async () => {
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: label(`T-бали ${surveyId.slice(0, 8)}`),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(
    surveyId,
    createSurveySchema.parse({
      title: label("T-бали"),
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "single",
          title: label("Пункт"),
          required: true,
          scaleCode: "T",
          options: [0, 1, 2, 3].map((score) => ({ text: label(String(score)), score })),
        },
      ],
      scales: [
        {
          code: "T",
          title: label("Шкала T"),
          kind: "clinical",
          normalization: "tscore",
          // норма только для мужчин: 3 → T 70, 1 → T 50
          norms: [{ sex: "male", mean: 1, sd: 1 }],
          bands: [
            { minScore: 0, maxScore: 64.9, label: label("Норма") },
            { minScore: 65, maxScore: 200, label: label("Високий"), severity: "moderate" },
          ],
        },
      ],
    }),
    adminA.id,
    "v1",
  );
}, 30_000);

async function personWith(sex: "male" | null) {
  return makeUser("user", `cn-cmp-${crypto.randomUUID().slice(0, 8)}@test.dev`, { sex, birthDate: "1990-05-05" });
}

async function submit(token: string, option: number): Promise<string> {
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, token)).body;
  const q = shown.questions[0]!;
  const res = await appApi(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      versionId: shown.versionId,
      answers: [{ questionId: q.id, optionIds: [q.options[option]!.id], durationMs: 1000, changeCount: 0, visitCount: 1 }],
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function draftOf(responseId: string) {
  const res = await appApi<Draft>(`/api/conclusions/responses/${responseId}/conclusion/draft`, adminA.token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.previousAt, "прошлое прохождение не найдено").not.toBeNull();
  return res.body.scales[0]!;
}

describe("черновик заключения: прошлое значение только сравнимое (#137)", () => {
  test("сырой 3 без пола, затем T 70 с полом — «було 3» не пишется, причина — единицы", async () => {
    const p = await personWith(null);
    await submit(p.token, 3);
    await db.update(users).set({ sex: "male" }).where(eq(users.id, p.id));
    const second = await submit(p.token, 3);
    const scale = await draftOf(second);
    expect(scale.value).toBe(70);
    expect(scale.previousValue, "T-бал рядом с сырым «було»").toBeNull();
    expect(scale.previousIncomparable).toBe("units");
  }, 30_000);

  test("прошлый протокол недостоверен — «було» не пишется, причина — недостоверность", async () => {
    const p = await personWith("male");
    const first = await submit(p.token, 3);
    await db.update(responses).set({ reliable: false }).where(eq(responses.id, first));
    const second = await submit(p.token, 1);
    const scale = await draftOf(second);
    expect(scale.previousValue).toBeNull();
    expect(scale.previousIncomparable).toBe("unreliable");
  }, 30_000);

  test("контроль: оба замера в T-баллах и достоверны — «було» — прошлое число", async () => {
    const p = await personWith("male");
    await submit(p.token, 3);
    const second = await submit(p.token, 1);
    const scale = await draftOf(second);
    expect(scale.value).toBe(50);
    expect(scale.previousValue).toBe(70);
    expect(scale.previousIncomparable ?? null).toBeNull();
  }, 30_000);

  test("контроль: оба замера сырые (пола нет) — сравнимы между собой", async () => {
    const p = await personWith(null);
    await submit(p.token, 3);
    const second = await submit(p.token, 1);
    const scale = await draftOf(second);
    expect(scale.value).toBe(1);
    expect(scale.previousValue).toBe(3);
    expect(scale.previousIncomparable ?? null).toBeNull();
  }, 30_000);
});
