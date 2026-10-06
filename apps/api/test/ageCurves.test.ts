import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  and,
  api,
  createSurveySchema,
  createVersion,
  db,
  encryptPersonFields,
  eq,
  groupA,
  surveys,
  users,
} from "./fixtures";
import { responseScores, responses, scales } from "../src/db/schema";

/**
 * Возрастные кривые норм — по совместимой референтной выборке (CR-102).
 *
 * Было: завершённые достоверные прохождения отбирались по методике, баллы
 * складывались по коду шкалы без оглядки на версию и единицы. У ревьюера
 * методика с v1 (шкала X, сырые 0–100) и v2 (та же X, сырые 0–10): тридцать
 * прохождений v2 с баллом 5 давали медиану 5, а девяносто прохождений v1 с
 * баллом 100 поднимали медиану «шкалы 0–10» до 100 — числа вне её размаха
 * под подписью действующей шкалы.
 *
 * Стало: та же политика, что у перцентиля листа и динамики
 * (lib/referenceSample.ts, мера «value»): совместимы версии с тем же
 * отпечатком приведённого значения, тем же размахом и теми же единицами;
 * только достоверные, только обследуемые, человек — одно наблюдение (его
 * последнее совместимое); порог окна считается после отбора.
 */

let surveyId = "";
const versionOf: Record<"wide" | "current" | "sameKey", string> = { wide: "", current: "", sameKey: "" };
const madePeople: string[] = [];
let seqAt = 0;

/** Один пункт-шкала 0..max и сырая шкала X по нему */
function content(max: number, title = "Шкала X") {
  return createSurveySchema.parse({
    title: { uk: "Вікові криві", ru: "Возрастные кривые" },
    administration: "self",
    scoringEnabled: true,
    questions: [
      {
        type: "scale",
        title: { uk: `Оцініть від 0 до ${max}`, ru: `Оцените от 0 до ${max}` },
        required: true,
        scaleCode: "X",
        minValue: 0,
        maxValue: max,
        options: [],
      },
    ],
    scales: [{ code: "X", title: { uk: title, ru: title }, kind: "clinical", normalization: "raw", bands: [] }],
  });
}

/** Обследуемый: пол и дата рождения — ровесники сорока лет на момент сдачи */
async function person(role: "user" | "admin" = "user", birthDate = "1984-03-15"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `curves-${id}@test`,
    ...encryptPersonFields({ firstName: "Крива", lastName: id.slice(0, 8), birthDate }),
    passwordHash: "x",
    role,
    sex: "male",
  } as never);
  madePeople.push(id);
  return id;
}

async function scaleOf(versionId: string): Promise<string> {
  const [row] = await db
    .select({ id: scales.id })
    .from(scales)
    .where(and(eq(scales.versionId, versionId), eq(scales.code, "X")));
  return row!.id;
}

/** Завершённое прохождение с одним баллом X — как его оставляет сдача */
async function observe(o: {
  userId: string | null;
  version: keyof typeof versionOf;
  value: number;
  maxScore: number;
  reliable?: boolean;
  at?: string;
}) {
  const id = crypto.randomUUID();
  // два года назад: сводки по последним неделям соседних файлов считают все прохождения базы
  const at = o.at ?? new Date(Date.UTC(2024, 5, 1, 0, 0, ++seqAt)).toISOString();
  await db.insert(responses).values({
    id,
    surveyId,
    versionId: versionOf[o.version],
    userId: o.userId,
    respondentSex: "male",
    status: "completed",
    startedAt: at,
    submittedAt: at,
    reliable: o.reliable ?? true,
  } as never);
  await db.insert(responseScores).values({
    id: crypto.randomUUID(),
    responseId: id,
    scaleId: await scaleOf(versionOf[o.version]),
    rawScore: o.value,
    value: o.value,
    normalization: "raw",
    maxScore: o.maxScore,
    percent: Math.round((o.value / o.maxScore) * 1000) / 10,
  } as never);
}

interface Curves {
  scales: {
    code: string;
    title: string;
    normalization: string;
    bySex: { sex: string; enough: boolean; points: { age: number; n: number; percentiles: { q: number; value: number }[] }[] }[];
  }[];
}

async function curves(): Promise<Curves> {
  const res = await api<Curves>(`/api/norms/surveys/${surveyId}/age-curves`, adminA.token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function male(c: Curves) {
  const x = c.scales.find((s) => s.code === "X");
  return { scale: x, curve: x?.bySex.find((b) => b.sex === "male") };
}

const median = (p: { percentiles: { q: number; value: number }[] }) => p.percentiles.find((x) => x.q === 0.5)!.value;

beforeAll(async () => {
  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: "Вікові криві", ru: "Возрастные кривые" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  /* v1 — X в сырых 0–100; v2 — X в сырых 0–10, действующая; v3 — тот же ключ, что v2, иначе названа */
  versionOf.wide = await createVersion(surveyId, content(100, "Стара 0-100"), adminA.id, "curves: 0–100");
  versionOf.sameKey = await createVersion(surveyId, content(10, "Та сама 0-10"), adminA.id, "curves: тот же ключ");
  versionOf.current = await createVersion(surveyId, content(10, "Нова 0-10"), adminA.id, "curves: действующая");

  /* тридцать разных мужчин сорока лет, действующая версия, балл 5 из 10 */
  for (let i = 0; i < 30; i++) await observe({ userId: await person(), version: "current", value: 5, maxScore: 10 });
}, 120_000);

afterAll(async () => {
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
});

describe("возрастные кривые", () => {
  test("несовместимая старая шкала не меняет кривую действующей", async () => {
    const before = male(await curves());
    expect(before.scale?.title).toBe("Нова 0-10");
    expect(before.scale?.normalization).toBe("raw");
    expect(before.curve?.enough).toBe(true);
    expect(before.curve?.points.map((p) => [p.age, p.n, median(p)])).toEqual([[40, 30, 5]]);

    /* девяносто других мужчин того же возраста — старая версия, 100 из 100 */
    for (let i = 0; i < 90; i++) await observe({ userId: await person(), version: "wide", value: 100, maxScore: 100 });

    const after = male(await curves());
    expect(after.curve?.points.map((p) => [p.age, p.n, median(p)]), "старая мера 0–100 попала в кривую шкалы 0–10").toEqual([
      [40, 30, 5],
    ]);
    for (const p of after.curve!.points) for (const q of p.percentiles) expect(q.value).toBeLessThanOrEqual(10);
  }, 60_000);

  test("совместимая версия (тот же ключ и размах) входит; повторы человека, недостоверные и сотрудники — нет", async () => {
    const base = male(await curves()).curve!.points[0]!;
    /* десять человек на версии с тем же ключом — входят */
    for (let i = 0; i < 10; i++) await observe({ userId: await person(), version: "sameKey", value: 9, maxScore: 10 });
    /* один человек сорок раз — одно наблюдение, его последнее */
    const repeater = await person();
    for (let i = 0; i < 39; i++) await observe({ userId: repeater, version: "current", value: 10, maxScore: 10 });
    await observe({ userId: repeater, version: "current", value: 9, maxScore: 10, at: new Date(Date.UTC(2024, 8, 1)).toISOString() });
    /* недостоверные и сотрудники на действующей — нет */
    for (let i = 0; i < 20; i++) await observe({ userId: await person(), version: "current", value: 10, maxScore: 10, reliable: false });
    for (let i = 0; i < 5; i++) await observe({ userId: await person("admin"), version: "current", value: 10, maxScore: 10 });

    const now = male(await curves()).curve!.points[0]!;
    expect(now.n).toBe(base.n + 10 + 1);
    // 30 × 5 и 11 × 9: медиана остаётся 5, девяностый перцентиль — 9, а не 10
    expect(median(now)).toBe(5);
    expect(now.percentiles.find((x) => x.q === 0.9)!.value).toBe(9);
  }, 60_000);

  test("порог окна считается после отбора: одна несовместимая версия сама по себе кривой не даёт", async () => {
    const other = crypto.randomUUID();
    await db.insert(surveys).values({
      id: other,
      groupId: groupA,
      title: { uk: "Криві: лише стара", ru: "Кривые: только старая" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    const wide = await createVersion(other, content(100), adminA.id, "only: 0–100");
    await createVersion(other, content(10), adminA.id, "only: действующая 0–10");
    const wideScale = (await db.select({ id: scales.id }).from(scales).where(and(eq(scales.versionId, wide), eq(scales.code, "X"))))[0]!.id;
    for (let i = 0; i < 40; i++) {
      const id = crypto.randomUUID();
      const at = new Date(Date.UTC(2024, 5, 2, 0, 0, i)).toISOString();
      await db.insert(responses).values({
        id,
        surveyId: other,
        versionId: wide,
        userId: await person(),
        respondentSex: "male",
        status: "completed",
        startedAt: at,
        submittedAt: at,
        reliable: true,
      } as never);
      await db.insert(responseScores).values({
        id: crypto.randomUUID(),
        responseId: id,
        scaleId: wideScale,
        rawScore: 50,
        value: 50,
        normalization: "raw",
        maxScore: 100,
        percent: 50,
      } as never);
    }
    const res = await api<Curves>(`/api/norms/surveys/${other}/age-curves`, adminA.token);
    expect(res.status).toBe(200);
    // сорок наблюдений есть, но все — другой меры: кривой у действующей шкалы нет, а не кривая из чужих чисел
    expect(res.body.scales).toEqual([]);
    await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, other));
  }, 60_000);
});
