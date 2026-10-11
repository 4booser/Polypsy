import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import {
  and,
  appApi,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupAdmins,
  makeUser,
  root,
  surveyGroups,
  surveys,
} from "./fixtures";
import { auditLog, scaleBands, scales, surveyFollowups, surveyVersions } from "../src/db/schema";

/**
 * Протокол наблюдения: окна одной полосы не стирают окна другой (#132).
 *
 * Сдача попадает в полосу шкалы A («через 7») и в полосу шкалы B («через
 * 30»). Прежде каждая полоса ставила окна сама, а постановка заменяет все
 * неоткрытые окна пары «методика + человек»: в базе оставалось одно окно —
 * той полосы, чей id шкалы случайно шёл последним, — а в ответе стояло
 * «scheduledFollowUps: 2». Теперь окна ставятся один раз — по объединению
 * сроков всех попавших полос.
 *
 * Порядок шкал задают их случайные id, поэтому каждая проверка идёт в обе
 * стороны: сроки A и B меняются местами, итог обязан совпасть.
 */

const tag = crypto.randomUUID().slice(0, 8);
const groupId = crypto.randomUUID();
const surveyId = crypto.randomUUID();
const people: string[] = [];
const l = (uk: string) => ({ uk, ru: uk, en: uk });

let bandA = "";
let bandB = "";

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: groupId, title: `Повтори полос ${tag}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: root.id, addedBy: root.id });
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: l(`Дві шкали ${tag}`),
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  const question = (code: string) => ({
    type: "single" as const,
    title: l(`Пункт ${code}`),
    required: true,
    scaleCode: code,
    options: [
      { text: l("Так"), score: 1 },
      { text: l("Ні"), score: 0 },
    ],
  });
  // любой ответ попадает в полосу каждой шкалы
  const scale = (code: string) => ({
    code,
    title: l(`Шкала ${code}`),
    kind: "clinical" as const,
    normalization: "raw" as const,
    bands: [{ minScore: 0, maxScore: 1, label: l("Будь-який") }],
  });
  await createVersion(
    surveyId,
    createSurveySchema.parse({
      title: l(`Дві шкали ${tag}`),
      administration: "self",
      scoringEnabled: true,
      questions: [question("A"), question("B")],
      scales: [scale("A"), scale("B")],
    }),
    root.id,
    "v1",
  );
  const [version] = await db.select({ id: surveyVersions.id }).from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
  const bandOf = async (code: string) => {
    const [row] = await db
      .select({ id: scaleBands.id })
      .from(scaleBands)
      .innerJoin(scales, eq(scales.id, scaleBands.scaleId))
      .where(and(eq(scales.versionId, version!.id), eq(scales.code, code)));
    return row!.id;
  };
  bandA = await bandOf("A");
  bandB = await bandOf("B");
}, 30_000);

afterAll(async () => {
  // очередь повторов общая: окна проверочных людей убираются
  if (people.length) await db.delete(surveyFollowups).where(inArray(surveyFollowups.userId, people));
});

async function setSpecs(a: string | null, b: string | null) {
  await db.update(scaleBands).set({ followUpDays: a }).where(eq(scaleBands.id, bandA));
  await db.update(scaleBands).set({ followUpDays: b }).where(eq(scaleBands.id, bandB));
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Сдача человеком под ролью приложения: окна повторов его, ответ — scheduledFollowUps */
async function submitAs() {
  const p = await makeUser("user", `followup-bands-${crypto.randomUUID().slice(0, 8)}@test.dev`, {
    sex: "female",
    birthDate: "1991-03-03",
  });
  people.push(p.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, p.token)).body;
  const res = await appApi(`/api/surveys/${surveyId}/responses`, p.token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      versionId: shown.versionId,
      answers: shown.questions.map((q) => ({
        questionId: q.id,
        optionIds: [q.options[0]!.id],
        durationMs: 1000,
        changeCount: 0,
        visitCount: 1,
      })),
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const windows = await db
    .select({ afterDays: surveyFollowups.afterDays })
    .from(surveyFollowups)
    .where(and(eq(surveyFollowups.surveyId, surveyId), eq(surveyFollowups.userId, p.id)))
    .orderBy(surveyFollowups.afterDays);
  const logged = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.subjectUserId, p.id), eq(auditLog.action, "cascade.followup")));
  return {
    scheduled: res.body.cascade.scheduledFollowUps as number,
    windows: windows.map((w) => w.afterDays),
    logged: logged.map((r) => (r.details as { days: number[] }).days),
  };
}

describe("окна повторов двух полос одной сдачи (#132)", () => {
  test("«через 7» на A и «через 30» на B — в базе оба окна, в ответе их число; в обе стороны", async () => {
    await setSpecs("7", "30");
    expect(await submitAs()).toEqual({ scheduled: 2, windows: [7, 30], logged: [[7, 30]] });
    await setSpecs("30", "7");
    expect(await submitAs()).toEqual({ scheduled: 2, windows: [7, 30], logged: [[7, 30]] });
  }, 30_000);

  test("пересекающиеся сроки — объединение без повторов", async () => {
    await setSpecs("7,30", "7,90");
    expect(await submitAs()).toEqual({ scheduled: 3, windows: [7, 30, 90], logged: [[7, 30, 90]] });
    await setSpecs("7,90", "7,30");
    expect(await submitAs()).toEqual({ scheduled: 3, windows: [7, 30, 90], logged: [[7, 30, 90]] });
  }, 30_000);

  test("контроль: сроки только на одной полосе — её окна, как и прежде", async () => {
    await setSpecs("7,30", null);
    expect(await submitAs()).toEqual({ scheduled: 2, windows: [7, 30], logged: [[7, 30]] });
    await setSpecs(null, null);
    expect(await submitAs()).toEqual({ scheduled: 0, windows: [], logged: [] });
  }, 30_000);
});
