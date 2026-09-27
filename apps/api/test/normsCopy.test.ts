import { describe, expect, test } from "bun:test";
import { adminA, api, batteries, createSurveySchema, createVersion, db, encryptPersonFields, eq, groupA, surveys, users } from "./fixtures";
import {
  options,
  questionLogic,
  questions,
  responseScores,
  responses,
  scaleBands,
  scaleCorrections,
  scaleItems,
  scaleNorms,
  scales,
  sections,
  stenRows,
} from "../src/db/schema";
import { inArray } from "drizzle-orm";
import { renderNote } from "@quizzy/shared";
import { copyVersion } from "../src/lib/surveys";

/**
 * Применение локальных норм меняет ТОЛЬКО нормы своей шкалы (волна 12).
 *
 * До правки новая версия собиралась через экспорт (surveyToDraft) и теряла
 * секции, условия показа, обратный ключ, лимиты и порядок вариантов,
 * привязку пунктов к шкалам, каскады полос и локальные нормы других шкал.
 * Проверка — сравнением новой версии со старой целиком, с точностью до
 * собственных идентификаторов: ссылки переводятся в позиции и коды, и всё,
 * кроме норм применённой шкалы, обязано совпасть.
 */

const tag = crypto.randomUUID().slice(0, 8);
const L = (uk: string) => ({ uk, ru: uk });

const battery = crypto.randomUUID();
await db.insert(batteries).values({ id: battery, title: `Поглиблена ${tag}`, groupId: groupA, strictOrder: false, createdBy: adminA.id });

const surveyId = crypto.randomUUID();
await db.insert(surveys).values({
  id: surveyId,
  groupId: groupA,
  title: L(`Нормы-копия ${tag}`),
  administration: "self",
  status: "published",
  publishedAt: new Date().toISOString(),
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  createdBy: adminA.id,
} as never);

const yesNo = [
  { text: L("Так"), score: 1, keyCode: "yes" },
  { text: L("Ні"), score: 0, keyCode: "no" },
];
const content = createSurveySchema.parse({
  title: L("Нормы-копия"),
  administration: "self",
  scoringEnabled: true,
  sections: [
    { key: "a", title: L("Розділ А"), description: L("Про настрій") },
    { key: "b", title: L("Розділ Б") },
  ],
  questions: [
    { type: "single", title: L("Пункт 1"), required: true, sectionKey: "a", scaleCode: "T", randomizeOptions: true, timeLimitSec: 30, options: yesNo },
    {
      type: "single",
      title: L("Пункт 2"),
      required: false,
      sectionKey: "b",
      scaleCode: "T",
      reverseScored: true,
      options: yesNo,
      // значение подменяется ниже на идентификатор варианта пункта 1
      logic: [{ sourceIndex: 0, operator: "eq", value: "placeholder", action: "show" }],
    },
    {
      type: "number",
      title: L("Пункт 3"),
      required: false,
      sectionKey: "b",
      minValue: 0,
      maxValue: 10,
      riskThreshold: 9,
      riskLabel: L("Високий бал"),
      riskSeverity: "moderate",
      logic: [{ sourceIndex: 0, operator: "answered", action: "hide" }],
    },
  ],
  scales: [
    {
      code: "T",
      title: L("Тривога"),
      kind: "clinical",
      normalization: "tscore",
      key: [{ item: 1, matchKey: "yes" }, { item: 2, matchKey: "no", weight: 2 }],
      corrections: [{ from: "K", coefficient: 0.5 }],
      norms: [
        { sex: "male", mean: 1, sd: 0.5, source: "Посібник, 2016" },
        { sex: "female", mean: 1.2, sd: 0.6, source: "Посібник, 2016" },
      ],
      bands: [
        { minScore: 0, maxScore: 60, label: L("Норма"), severity: "none", grade: 1 },
        { minScore: 60, maxScore: 200, label: L("Висока"), severity: "severe", grade: 2, recommendation: L("Консультація") },
      ],
    },
    { code: "K", title: L("Корекція"), kind: "validity", normalization: "raw", key: [{ item: 1 }], validityThreshold: 5, validityDirection: "above", validityMessage: L("Сумнівно") },
    {
      code: "LL",
      title: L("Інша шкала"),
      kind: "clinical",
      normalization: "tscore",
      key: [{ item: 2 }],
      norms: [{ sex: "male", mean: 3, sd: 1, source: "локальная выборка, N=41, 2026-08-01" }],
    },
    {
      code: "ST",
      title: L("Стени"),
      kind: "clinical",
      normalization: "sten",
      key: [{ item: 1 }],
      stenTable: [
        { rawMin: 0, rawMax: 0, sten: 3 },
        { sex: "female", ageMin: 18, ageMax: 60, rawMin: 1, rawMax: 1, sten: 7 },
      ],
    },
  ],
});
const v1 = await createVersion(surveyId, content, adminA.id, "v1");

/*
 * Что экспорт терял, но что настоящая методика несёт: условие по
 * идентификатору варианта и каскад полосы. Конструктор их пишет своими
 * путями, здесь — прямо в строки версии.
 */
const v1Questions = await db.select().from(questions).where(eq(questions.versionId, v1));
const q1 = v1Questions.find((q) => q.position === 0)!;
const [q1Yes] = await db.select().from(options).where(eq(options.questionId, q1.id)).orderBy(options.position);
await db.update(questionLogic).set({ value: q1Yes!.id }).where(eq(questionLogic.sourceQuestionId, q1.id));
await db.execute(
  // только оператор eq: «answered» значения не несёт
  (await import("drizzle-orm")).sql`update question_logic set value = null where source_question_id = ${q1.id} and operator = 'answered'`,
);
const v1Scales = await db.select().from(scales).where(eq(scales.versionId, v1));
const scaleT = v1Scales.find((s) => s.code === "T")!;
const scaleK = v1Scales.find((s) => s.code === "K")!;
await db
  .update(scaleBands)
  .set({ cascadeBatteryId: battery, cascadeDueDays: 14, followUpDays: "7,30" })
  .where(eq(scaleBands.scaleId, scaleT.id));

/* выборка: 32 мужчины с разбросом по T — ровно столько, чтобы норма публиковалась */
for (let i = 0; i < 32; i++) {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `norm-copy-${tag}-${i}@test.dev`,
    ...encryptPersonFields({ firstName: "Н", lastName: `Вибірка${i}`, birthDate: null }),
    passwordHash: "x",
    role: "user",
    sex: "male",
  } as never);
  const responseId = crypto.randomUUID();
  const at = new Date(Date.now() - (i + 1) * 60_000).toISOString();
  await db.insert(responses).values({
    id: responseId,
    surveyId,
    userId,
    status: "completed",
    versionId: v1,
    startedAt: at,
    submittedAt: at,
    durationMs: 1000,
    // пол на момент сдачи: кандидаты норм считаются по нему, а не по карточке (участок stats)
    respondentSex: "male",
  });
  const common = { value: 0, normalization: "raw" as const, maxScore: 10, percent: 0, normalized: false };
  await db.insert(responseScores).values([
    { id: crypto.randomUUID(), responseId, scaleId: scaleT.id, rawScore: i % 4, ...common },
    { id: crypto.randomUUID(), responseId, scaleId: scaleK.id, rawScore: i % 2, ...common },
  ]);
}

/**
 * Версия как структура без собственных идентификаторов.
 *
 * Ссылки переводятся в то, что от идентификаторов не зависит: секция и пункт —
 * позицией, шкала — кодом, вариант в условии — «пункт:вариант». Всё прочее
 * — все колонки строк как есть.
 */
async function snapshot(versionId: string) {
  const sec = await db.select().from(sections).where(eq(sections.versionId, versionId)).orderBy(sections.position);
  const qs = await db.select().from(questions).where(eq(questions.versionId, versionId)).orderBy(questions.position);
  const sc = await db.select().from(scales).where(eq(scales.versionId, versionId)).orderBy(scales.position);
  const qIds = qs.map((q) => q.id);
  const sIds = sc.map((s) => s.id);
  const [opts, logic, bands, items, corr, norms, sten] = await Promise.all([
    db.select().from(options).where(inArray(options.questionId, qIds)).orderBy(options.position),
    db.select().from(questionLogic).where(inArray(questionLogic.questionId, qIds)),
    db.select().from(scaleBands).where(inArray(scaleBands.scaleId, sIds)).orderBy(scaleBands.position),
    db.select().from(scaleItems).where(inArray(scaleItems.scaleId, sIds)),
    db.select().from(scaleCorrections).where(inArray(scaleCorrections.targetScaleId, sIds)),
    db.select().from(scaleNorms).where(inArray(scaleNorms.scaleId, sIds)),
    db.select().from(stenRows).where(inArray(stenRows.scaleId, sIds)),
  ]);
  const secPos = new Map(sec.map((s) => [s.id, s.position]));
  const qPos = new Map(qs.map((q) => [q.id, q.position]));
  const code = new Map(sc.map((s) => [s.id, s.code]));
  const optRef = new Map(opts.map((o) => [o.id, `${qPos.get(o.questionId)}:${o.position}`]));
  const sortBy = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();

  return {
    sections: sec.map(({ id: _i, versionId: _v, ...rest }) => rest),
    questions: qs.map(({ id, versionId: _v, sectionId, scaleId, ...rest }) => ({
      ...rest,
      section: sectionId ? secPos.get(sectionId) : null,
      scale: scaleId ? code.get(scaleId) : null,
      options: opts.filter((o) => o.questionId === id).map(({ id: _i, questionId: _q, ...o }) => o),
      logic: sortBy(
        logic
          .filter((l) => l.questionId === id)
          .map(({ id: _i, questionId: _q, sourceQuestionId, value, ...l }) => ({
            ...l,
            source: qPos.get(sourceQuestionId),
            value: typeof value === "string" ? (optRef.get(value) ?? value) : value,
          })),
      ),
    })),
    scales: sc.map(({ id, versionId: _v, ...rest }) => ({
      ...rest,
      bands: bands.filter((b) => b.scaleId === id).map(({ id: _i, scaleId: _s, ...b }) => b),
      items: sortBy(items.filter((i) => i.scaleId === id).map(({ scaleId: _s, questionId, ...i }) => ({ ...i, item: qPos.get(questionId) }))),
      corrections: sortBy(
        corr.filter((c) => c.targetScaleId === id).map(({ targetScaleId: _t, sourceScaleId, ...c }) => ({ ...c, from: code.get(sourceScaleId) })),
      ),
      norms: sortBy(norms.filter((n) => n.scaleId === id).map(({ id: _i, scaleId: _s, ...n }) => n)),
      stenTable: sortBy(sten.filter((r) => r.scaleId === id).map(({ id: _i, scaleId: _s, ...r }) => r)),
    })),
  };
}

describe("применение локальных норм", () => {
  test("новая версия отличается от старой только нормами применённой шкалы", async () => {
    const before = await snapshot(v1);
    // исходная версия действительно несёт всё, что терял экспорт
    expect(before.sections.length).toBe(2);
    expect(before.questions[1]!.reverseScored).toBe(true);
    expect(before.questions[1]!.logic[0]).toContain('"value":"0:0"');
    expect(before.questions[0]!.randomizeOptions).toBe(true);
    expect(before.scales[0]!.bands[0]!.cascadeBatteryId).toBe(battery);

    const res = await api(`/api/norms/surveys/${surveyId}/apply`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["T"] }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v2 = res.body.versionId as string;
    expect(v2).not.toBe(v1);
    const [row] = await db.select({ current: surveys.currentVersionId }).from(surveys).where(eq(surveys.id, surveyId));
    expect(row!.current).toBe(v2);

    const after = await snapshot(v2);
    const normsOf = (s: typeof before, c: string) => s.scales.find((x) => x.code === c)!.norms;
    const beforeT = normsOf(before, "T");
    const afterT = normsOf(after, "T");

    // нормы T: мужская — своя выборка, женская — из пособия (выборки нет)
    // источник локальной нормы хранится кодом (волна 14); по-русски — прежними словами
    const localSource = (n: string) => renderNote((JSON.parse(n) as { source: string | null }).source, "ru") ?? "";
    expect(afterT.some((n) => n.includes('"sex":"male"') && localSource(n).startsWith("локальная выборка, N=32"))).toBe(true);
    expect(afterT.some((n) => n.includes('"sex":"female"') && n.includes("Посібник"))).toBe(true);
    expect(afterT.some((n) => n.includes('"sex":"male"') && n.includes("Посібник"))).toBe(false);
    expect(afterT).not.toEqual(beforeT);

    // всё остальное — байт в байт
    const strip = (s: typeof before) => ({
      ...s,
      scales: s.scales.map((x) => (x.code === "T" ? { ...x, norms: [] } : x)),
    });
    expect(strip(after)).toEqual(strip(before));
  });

  test("экспорт несёт долю ответов шкалы (участок engine: minAnsweredShare)", async () => {
    const res = await api(`/api/surveys/${surveyId}/export`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.scales.length).toBeGreaterThan(0);
    for (const scale of res.body.scales) expect(scale).toHaveProperty("minAnsweredShare");
  });

  test("копия без правок совпадает с исходной целиком", async () => {
    const [row] = await db.select({ current: surveys.currentVersionId }).from(surveys).where(eq(surveys.id, surveyId));
    const from = row!.current!;
    const copy = await copyVersion(surveyId, adminA.id, "проверка копии");
    expect(await snapshot(copy)).toEqual(await snapshot(from));
  });
});
