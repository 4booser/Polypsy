import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  and,
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  encryptPersonFields,
  eq,
  groupA,
  makeUser,
  sr45,
  submitSurvey,
  surveys,
  users,
  type Person,
} from "./fixtures";
import { responseScores, responses, scales } from "../src/db/schema";
import { MIN_NORM_SAMPLE } from "../src/lib/norms";
import { referencePercentile, referenceSample, type Observation } from "../src/lib/referenceSample";

/**
 * Перцентиль печатного листа — по единой референтной выборке (волна 15,
 * внешний разбор, п. 19).
 *
 * Было: выборка — все сырые баллы методики с тем же кодом шкалы. В неё шли
 * версии с другим ключом и другим размахом (0–100 рядом с 0–10), протоколы,
 * проваленные шкалой лжи, сотрудники, пробовавшие методику на себе, и каждый
 * повтор одного человека отдельным наблюдением: у ревьюера перцентиль того
 * же балла уезжал с 50-го на 5-й от одной примеси старой версии, а замена
 * примеси недостоверными протоколами ничего не меняла.
 *
 * Стало (lib/referenceSample.ts): совместимые версии (та же или доказанно
 * тот же ключ — отпечаток сырого балла — и тот же размах), только
 * достоверные, только обследуемые, единица — человек (его последнее такое
 * прохождение), от MIN_NORM_SAMPLE людей.
 */

describe("политика референтной выборки — функцией", () => {
  const V = new Set(["v-now", "v-same-key"]);
  let seq = 0;
  const obs = (o: Partial<Observation>): Observation => ({
    responseId: `r-${String(++seq).padStart(4, "0")}`,
    userId: "u-1",
    versionId: "v-now",
    reliable: true,
    submittedAt: "2026-09-01T10:00:00.000Z",
    value: 5,
    maxScore: 10,
    ...o,
  });

  test("человек — одно наблюдение: его последнее достоверное прохождение совместимой версии", () => {
    const sample = referenceSample(
      [
        obs({ userId: "u-1", value: 1, submittedAt: "2026-01-01T00:00:00.000Z" }),
        obs({ userId: "u-1", value: 2, submittedAt: "2026-03-01T00:00:00.000Z" }),
        /* позже, но недостоверно — в выборку не идёт, человек остаётся со своим прежним */
        obs({ userId: "u-1", value: 9, submittedAt: "2026-04-01T00:00:00.000Z", reliable: false }),
        /* позже, но другой ключ — не идёт */
        obs({ userId: "u-1", value: 8, submittedAt: "2026-05-01T00:00:00.000Z", versionId: "v-old-key" }),
        obs({ userId: "u-2", value: 7, versionId: "v-same-key" }),
      ],
      { versions: V, maxScore: 10 },
    );
    expect(sample.sort()).toEqual([2, 7]);
  });

  test("не идут: другой ключ, другой размах, без версии, анонимные, недостоверные", () => {
    const sample = referenceSample(
      [
        obs({ userId: "a", versionId: "v-old-key" }),
        obs({ userId: "b", maxScore: 100 }),
        obs({ userId: "c", versionId: null }),
        obs({ userId: null }),
        obs({ userId: "d", reliable: false }),
        obs({ userId: "e" }),
      ],
      { versions: V, maxScore: 10 },
    );
    expect(sample).toEqual([5]);
  });

  test("одновременные прохождения человека разводятся по id, а не порядком строк", () => {
    const at = "2026-09-01T10:00:00.000Z";
    const a = obs({ responseId: "r-a", userId: "u", value: 1, submittedAt: at });
    const b = obs({ responseId: "r-b", userId: "u", value: 2, submittedAt: at });
    expect(referenceSample([a, b], { versions: V, maxScore: 10 })).toEqual([2]);
    expect(referenceSample([b, a], { versions: V, maxScore: 10 })).toEqual([2]);
  });

  test("перцентиль — от MIN_NORM_SAMPLE людей; меньше — прочерк, а не видимость точности", () => {
    const people = (n: number) =>
      referenceSample(
        Array.from({ length: n }, (_, i) => obs({ userId: `p-${i}`, value: i })),
        { versions: V, maxScore: 10 },
      );
    expect(referencePercentile(3, people(MIN_NORM_SAMPLE - 1))).toBeNull();
    expect(referencePercentile(3, people(MIN_NORM_SAMPLE))).not.toBeNull();
    /* повторы одного человека людей не добавляют */
    const one = referenceSample(
      Array.from({ length: 50 }, (_, i) => obs({ userId: "same", value: i % 10, submittedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() })),
      { versions: V, maxScore: 10 },
    );
    expect(one.length).toBe(1);
    expect(referencePercentile(3, one)).toBeNull();
  });
});

/* ───────────────────────── печатный лист целиком ───────────────────────── */

let surveyId = "";
let patient: Person;
let responseId = "";
let raw = 0;
let max = 0;
/** Балл примеси: заметно другой, чтобы любая утечка сдвинула перцентиль */
let other = 0;
const versionOf: Record<"oldKey" | "sameKey" | "current", string> = { oldKey: "", sameKey: "", current: "" };
const madePeople: string[] = [];

/** Человек выборки — строкой, без хэша пароля: входить ему не нужно */
async function person(role: "user" | "admin" = "user"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `percentile-${id}@test`,
    ...encryptPersonFields({ firstName: "Вибірка", lastName: id.slice(0, 8), birthDate: null }),
    passwordHash: "x",
    role,
  } as never);
  madePeople.push(id);
  return id;
}

async function srScaleOf(versionId: string): Promise<string> {
  const [row] = await db
    .select({ id: scales.id })
    .from(scales)
    .where(and(eq(scales.versionId, versionId), eq(scales.code, "Sr")));
  return row!.id;
}

let seqAt = 0;
/** Завершённое прохождение с одним баллом Sr — как его оставляет сдача */
async function observe(o: { userId: string | null; version: keyof typeof versionOf; value: number; reliable?: boolean; at?: string }) {
  const id = crypto.randomUUID();
  const at = o.at ?? new Date(Date.UTC(2026, 5, 1, 0, 0, ++seqAt)).toISOString();
  await db.insert(responses).values({
    id,
    surveyId,
    versionId: versionOf[o.version],
    userId: o.userId,
    status: "completed",
    startedAt: at,
    submittedAt: at,
    reliable: o.reliable ?? true,
  } as never);
  await db.insert(responseScores).values({
    id: crypto.randomUUID(),
    responseId: id,
    scaleId: await srScaleOf(versionOf[o.version]),
    rawScore: o.value,
    value: o.value / max,
    normalization: "ratio",
    maxScore: max,
    percent: Math.round((o.value / max) * 1000) / 10,
  } as never);
}

/** Перцентиль строки Sr в печатном листе */
function percentileCell(html: string): string | null {
  const row = html.match(/<tr>\s*<td>Схильність до суїцидальних реакцій<\/td>([\s\S]*?)<\/tr>/)?.[1];
  const cells = [...(row ?? "").matchAll(/<td class="num">([^<]*)<\/td>/g)].map((m) => m[1]!);
  return cells.at(-1) ?? null;
}

beforeAll(async () => {
  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: "Перцентиль листа", ru: "Перцентиль листа", en: "Report percentile" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showResultsToPatient: true,
    createdBy: adminA.id,
  } as never);

  /*
   * Три версии. Первая — с другим ключом Sr (у первого пункта ожидается
   * «Ні» вместо «Так»): размах тот же, 35, а сырой балл — другая величина.
   * Вторая и третья — одинаковые: сырой балл в них считается одинаково, и
   * вторая в выборку идти обязана, хотя версия и не та.
   */
  const changed = structuredClone(createSurveySchema.parse(sr45));
  const srKey = changed.scales!.find((s) => s.code === "Sr")!.key!;
  srKey[0] = { ...srKey[0]!, matchKey: srKey[0]!.matchKey === "yes" ? "no" : "yes" };
  versionOf.oldKey = await createVersion(surveyId, changed, adminA.id, "percentile: другой ключ");
  versionOf.sameKey = await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "percentile: тот же ключ");
  versionOf.current = await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "percentile: действующая");

  patient = await makeUser("user", `percentile-p-${crypto.randomUUID()}@test`);
  madePeople.push(patient.id);
  const done = await submitSurvey(surveyId, patient.token);
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  responseId = done.body.id;
  const [score] = await db
    .select({ raw: responseScores.rawScore, max: responseScores.maxScore })
    .from(responseScores)
    .where(and(eq(responseScores.responseId, responseId), eq(responseScores.scaleId, await srScaleOf(versionOf.current))));
  raw = score!.raw;
  max = score!.max;
  other = raw + 3 <= max ? raw + 3 : raw - 3;

  /* выборка: одиннадцать человек с тем же баллом — на совместимой версии, не на той же */
  for (let i = 0; i < 11; i++) await observe({ userId: await person(), version: "sameKey", value: raw });

  /* примесь, которой в выборке быть не должно */
  for (let i = 0; i < 30; i++) await observe({ userId: await person(), version: "oldKey", value: other });
  for (let i = 0; i < 30; i++) await observe({ userId: await person(), version: "current", value: other, reliable: false });
  for (let i = 0; i < 5; i++) await observe({ userId: await person("admin"), version: "current", value: other });
  for (let i = 0; i < 5; i++) await observe({ userId: null, version: "current", value: other });
  /* один человек, сорок раз: сначала «другим» баллом, последним — тем же */
  const repeater = await person();
  for (let i = 0; i < 39; i++) await observe({ userId: repeater, version: "current", value: other });
  await observe({ userId: repeater, version: "current", value: raw, at: new Date(Date.UTC(2026, 8, 1)).toISOString() });
}, 120_000);

afterAll(async () => {
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
});

describe("печатный лист", () => {
  test("перцентиль не сдвигают другой ключ, недостоверные, сотрудники, анонимные и повторы", async () => {
    /*
     * В выборке — двенадцать-тринадцать человек (пациент — если его
     * протокол достоверен), и у всех тот же балл: перцентиль ровно 50-й.
     * Любая утечка примеси (балл other) его сдвигает.
     */
    const res = await appRequest(`/api/reports/responses/${responseId}`, {
      headers: { Authorization: `Bearer ${patient.token}`, "Accept-Language": "uk" },
    });
    const html = await res.text();
    expect(res.status, html.slice(0, 300)).toBe(200);
    expect(percentileCell(html)).toBe("50-й");
  });
});
