import { expect } from "bun:test";
import type {
  Option,
  Question,
  RespondentDynamics,
  ResponseDetail,
  ResponseDetailAnswer,
  ResponseDetailScore,
  Scale,
  ScaleDynamics,
  SurveyFull,
} from "@quizzy/shared";

/**
 * Общие заготовки для проверок графиков прохождения: модели
 * (responseCharts.test.ts) и рендера (responseChartsRender.test.tsx).
 * Одни объекты на обе проверки — чтобы «рисуется без NaN» проверялось на тех
 * же данных, на которых доказано, что счёт верен.
 */

export const LABELS = {
  of: "з",
  norm: { raw: "сирий бал", ratio: "частка", tscore: "T-бал", sten: "стен" },
} as const;

export const band = (id: string, minScore: number, maxScore: number, label: string, severity: "none" | "mild" | "moderate" | "severe", hit = false) => ({
  id,
  minScore,
  maxScore,
  label,
  severity,
  description: `${label}: опис`,
  grade: null,
  recommendation: hit ? "Повторний замір за місяць" : null,
  hit,
});

export function score(over: Partial<ResponseDetailScore> = {}): ResponseDetailScore {
  return {
    scaleId: "sc1",
    scaleCode: "D",
    scaleTitle: "Депресія",
    kind: "clinical",
    rawScore: 12,
    correctedScore: 12,
    value: 12,
    normalized: true,
    normalization: "raw",
    maxScore: 27,
    percent: 44,
    band: { label: "Помірна", severity: "moderate", description: null, grade: null, recommendation: null },
    bands: [
      band("b3", 10, 14, "Помірна", "moderate", true),
      band("b1", 0, 4, "Мінімальна", "none"),
      band("b2", 5, 9, "Легка", "mild"),
      band("b4", 15, 27, "Тяжка", "severe"),
    ],
    ...over,
  };
}

export function answer(over: Partial<ResponseDetailAnswer> & { questionId: string; position: number }): ResponseDetailAnswer {
  return {
    title: `Пункт ${over.position}`,
    type: "single",
    answered: true,
    optionIds: null,
    options: [],
    text: null,
    number: null,
    date: null,
    matrix: null,
    ranking: null,
    score: null,
    durationMs: 0,
    changeCount: 0,
    visitCount: 1,
    events: [],
    ...over,
  };
}

export function detail(over: Partial<ResponseDetail> = {}): ResponseDetail {
  return {
    id: "r3",
    userId: "u1",
    survey: { id: "s1", title: "PHQ-9", scoringEnabled: true, versionNumber: 2 },
    status: "completed",
    startedAt: "2026-09-20T10:00:00Z",
    submittedAt: "2026-09-20T10:05:00Z",
    durationMs: 300_000,
    scores: [score()],
    answers: [],
    ...over,
  };
}

/**
 * Ни одного NaN и бесконечности в глубине объекта. JSON.stringify для этого
 * не годится: NaN он молча печатает как null, и проверка по строке прошла
 * бы на том самом, что должна ловить.
 */
export function noNaN(v: unknown, path = "view"): void {
  if (typeof v === "number") {
    expect(Number.isFinite(v), `${path} = ${v}`).toBe(true);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => noNaN(x, `${path}[${i}]`));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) noNaN(x, `${path}.${k}`);
  }
}

export function series(points: Partial<ScaleDynamics["points"][number]>[], over: Partial<ScaleDynamics> = {}): ScaleDynamics {
  return {
    scaleId: "sc1",
    code: "D",
    title: "Депресія",
    points: points.map((p, i) => ({
      responseId: `r${i + 1}`,
      submittedAt: `2026-0${i + 6}-01T10:00:00Z`,
      rawScore: 0,
      maxScore: 27,
      percent: 0,
      bandLabel: null,
      severity: null,
      percentile: null,
      versionNo: 2,
      ...p,
    })),
    delta: null,
    direction: null,
    reliableChange: null,
    sem: 2,
    ...over,
  };
}

export function dynamics(scales: ScaleDynamics[], responseCount = scales[0]?.points.length ?? 0): RespondentDynamics {
  return {
    userId: "u1",
    fullName: "—",
    email: "—",
    sex: null,
    age: null,
    surveys: [{ surveyId: "s1", title: "PHQ-9", responseCount, firstAt: null, lastAt: null, scales }],
  };
}

export function option(id: string, questionId: string, score: number, extra: Partial<Option> = {}): Option {
  return {
    id,
    questionId,
    text: id,
    keyCode: null,
    score,
    position: 0,
    kind: "option",
    riskFlag: false,
    riskLabel: null,
    riskSeverity: null,
    ...extra,
  };
}

export function question(id: string, position: number, type: Question["type"], options: Option[], extra: Partial<Question> = {}): Question {
  return {
    id,
    surveyId: "s1",
    sectionId: null,
    type,
    title: `Пункт ${position}`,
    help: null,
    required: true,
    position,
    scaleId: null,
    reverseScored: false,
    minValue: null,
    maxValue: null,
    step: null,
    minLabel: null,
    maxLabel: null,
    randomizeOptions: false,
    timeLimitSec: null,
    riskThreshold: null,
    riskLabel: null,
    riskSeverity: null,
    options,
    logic: [],
    ...extra,
  };
}

/**
 * Методика на все виды пунктов, которые движок считает по-разному:
 * вариант с весом, обратный ключ, «совпал с ключом», матрица, порядок и
 * текст (эти двое балла не дают), пропущенный пункт.
 */
export const Q = [
  question("q1", 1, "single", [option("q1a", "q1", 0), option("q1b", "q1", 2), option("q1c", "q1", 3, { riskFlag: true })]),
  question("q2", 2, "single", [option("q2a", "q2", 0), option("q2b", "q2", 3)], { reverseScored: true }),
  question("q3", 3, "yesno", [option("q3n", "q3", 0, { keyCode: "no" }), option("q3y", "q3", 1, { keyCode: "yes" })]),
  question("q4", 4, "matrix", [
    option("r1", "q4", 0, { kind: "row" }),
    option("r2", "q4", 0, { kind: "row" }),
    option("m0", "q4", 0),
    option("m1", "q4", 1),
    option("m2", "q4", 2),
  ]),
  question("q5", 5, "ranking", [option("k1", "q5", 1), option("k2", "q5", 2)]),
  question("q6", 6, "text", []),
  question("q7", 7, "single", [option("q7a", "q7", 0), option("q7b", "q7", 3)]),
];

export const SCALE: Scale = {
  id: "sc1",
  surveyId: "s1",
  code: "D",
  title: "Депресія",
  description: null,
  aggregation: "sum",
  position: 0,
  kind: "clinical",
  normalization: "raw",
  ratioDenominator: null,
  validityThreshold: null,
  validityDirection: null,
  validityMessage: null,
  bands: [],
  items: [
    { questionId: "q1", matchKey: null, weight: 1 },
    { questionId: "q2", matchKey: null, weight: 1 },
    { questionId: "q3", matchKey: "yes", weight: 2 },
    { questionId: "q4", matchKey: null, weight: 1 },
    { questionId: "q5", matchKey: null, weight: 1 },
    { questionId: "q6", matchKey: null, weight: 1 },
    { questionId: "q7", matchKey: null, weight: 1 },
  ],
  corrections: [],
  norms: [],
  stenTable: [],
};

export function surveyFull(over: Partial<SurveyFull> = {}): SurveyFull {
  return { id: "s1", versionNumber: 2, questions: Q, scales: [SCALE], ...over } as unknown as SurveyFull;
}

export const ANSWERS: ResponseDetailAnswer[] = [
  answer({
    questionId: "q1",
    position: 1,
    optionIds: ["q1c"],
    options: [
      { id: "q1a", text: "a", riskFlag: false, riskSeverity: null, score: 0 },
      { id: "q1c", text: "c", riskFlag: true, riskSeverity: "severe", score: 3 },
    ],
  }),
  // обратный ключ: выбран «3» → вклад 0 + 3 − 3 = 0, в перечень не попадает
  answer({ questionId: "q2", position: 2, optionIds: ["q2b"] }),
  answer({ questionId: "q3", position: 3, type: "yesno", optionIds: ["q3y"] }),
  answer({ questionId: "q4", position: 4, type: "matrix", matrix: { r1: "m1", r2: "m2" } }),
  answer({ questionId: "q5", position: 5, type: "ranking", ranking: ["k2", "k1"] }),
  answer({ questionId: "q6", position: 6, type: "text", text: "вільна відповідь" }),
  answer({ questionId: "q7", position: 7, answered: false }),
];
