import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type RespondentDynamics, type SurveyAnalytics } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { PatientView } from "../src/pages/analytics/tests/patient";
import { OverviewView, QualityView, QuestionsView, ScalesView, TimeView } from "../src/pages/analytics/tests/views";

/**
 * Вкладка «Тести» рисуется на краях: шкала без полос, неделя под порогом,
 * корзина длительности, скрытая порогом, пункт без ответов, пустой ряд
 * прохождений. Проверяется, как в clinicalCharts.test.tsx, что разметка
 * получилась и в ней нет NaN и «undefined»: деление на ноль в координатах
 * молча стирает SVG, а undefined в подписи — это строка, которую человек
 * прочтёт как данные.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const either = (key: keyof typeof UI) => [UI[key].uk, UI[key].ru];
const clean = (html: string) => {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain("Infinity");
};

const bands = [
  { label: "Мінімальна", severity: "none" as const, count: 6, percent: 50, min: 0, max: 4 },
  { label: "Помірна", severity: "moderate" as const, count: 4, percent: 33.3, min: 5, max: 14 },
  { label: "Тяжка", severity: "severe" as const, count: 2, percent: 16.7, min: 15, max: 27 },
];

const shape = (n: number) => ({ n, mean: null, median: null, sd: null, skewness: null, kurtosis: null, percentiles: null });

const data: SurveyAnalytics = {
  surveyId: "s1",
  title: "PHQ-9",
  versionId: "v2",
  versionNumber: 2,
  versions: [
    { id: "v2", version: 2, responseCount: 12, note: null },
    { id: "v1", version: 1, responseCount: 3, note: null },
  ],
  inProgressNow: [{ userName: "Іваненко", startedAt: "2026-09-26T09:00:00Z", lastSavedAt: "2026-09-26T09:05:00Z", answered: 4 }],
  started: 14,
  completed: 12,
  abandoned: 2,
  completionRate: 85.7,
  avgDurationMs: 190_000,
  medianDurationMs: 170_000,
  dropOff: [
    { questionId: "q1", title: "Перший", position: 0, reached: 14, lost: 0, endedHere: 0, endedHerePercent: 0, avgDurationMs: 4000 },
    { questionId: "q2", title: "Другий", position: 1, reached: 12, lost: 2, endedHere: null, endedHerePercent: null, avgDurationMs: 9000 },
  ],
  questions: [
    {
      questionId: "q1",
      title: "Настрій",
      type: "single",
      position: 0,
      shown: 14,
      answered: 13,
      skipped: 1,
      skipRate: 7.1,
      avgDurationMs: 4000,
      medianDurationMs: 3500,
      minDurationMs: 900,
      maxDurationMs: 12000,
      p25DurationMs: 2500,
      p75DurationMs: 5200,
      avgChangeCount: 0.2,
      avgTimeToFirstAnswerMs: 2000,
      changedShare: 15.4,
      tooFastShare: 7.7,
      options: [
        { optionId: "o0", text: "Ніколи", count: 5, percent: 38.5, score: 0 },
        { optionId: "o1", text: "Кілька днів", count: 4, percent: 30.8, score: 1 },
        { optionId: "o3", text: "Майже щодня", count: 4, percent: 30.8, score: 3 },
      ],
    },
    {
      questionId: "q2",
      title: "Що турбує",
      type: "longtext",
      position: 1,
      shown: 12,
      answered: 3,
      skipped: 9,
      skipRate: 75,
      avgDurationMs: 30000,
      medianDurationMs: 28000,
      minDurationMs: 10000,
      maxDurationMs: 60000,
      p25DurationMs: 20000,
      p75DurationMs: 40000,
      avgChangeCount: 0,
      avgTimeToFirstAnswerMs: 0,
      changedShare: 0,
      tooFastShare: 0,
      texts: ["Сон", "Тривога"],
    },
    {
      questionId: "q3",
      title: "Години сну",
      type: "number",
      position: 2,
      shown: 12,
      answered: 0,
      skipped: 12,
      skipRate: 100,
      avgDurationMs: 0,
      medianDurationMs: 0,
      minDurationMs: 0,
      maxDurationMs: 0,
      p25DurationMs: 0,
      p75DurationMs: 0,
      avgChangeCount: 0,
      avgTimeToFirstAnswerMs: 0,
      changedShare: 0,
      tooFastShare: 0,
      numeric: { average: 0, median: 0, min: 0, max: 0, distribution: [] },
    },
  ],
  scales: [
    {
      scaleId: "sc1",
      code: "D",
      title: "Депресія",
      kind: "clinical",
      average: 8.4,
      median: 7,
      min: 0,
      max: 22,
      p25: 3,
      p75: 13,
      maxPossible: 27,
      bands,
      reliability: {
        alpha: 0.64,
        itemCount: 9,
        sampleN: 12,
        omega: null,
        weakItems: null,
        items: [
          { questionId: "q1", title: "Настрій", itemTotalCorrelation: 0.41, alphaIfDeleted: 0.7, variance: 1.1, endorsement: null, discriminating: null },
        ],
      },
      shape: shape(12),
      floorCeiling: { n: 12, floorPercent: null, ceilingPercent: null, floorProblem: null, ceilingProblem: null },
      measurement: { sem: 1.9, sdiff: 2.7, mdc95: 5.3, basis: { sd: 5, alpha: 0.64, sampleN: 12 } },
    },
    {
      scaleId: "sc2",
      code: "L",
      title: "Щирість",
      kind: "validity",
      average: 2,
      median: 2,
      min: 1,
      max: 3,
      p25: 1,
      p75: 3,
      maxPossible: 10,
      bands: [],
      reliability: null,
      shape: shape(3),
      floorCeiling: null,
      measurement: null,
    },
  ],
  quality: [
    {
      responseId: "r9",
      respondent: null,
      submittedAt: "2026-09-20T10:00:00Z",
      durationMs: 20_000,
      tooFastShare: 88,
      longestStraightLine: 9,
      personFit: null,
      flagged: true,
      reasons: ["швидко"],
    },
  ],
  tooFastThresholdMs: 1500,
  timeline: [
    { date: "2026-09-01", count: 3 },
    { date: "2026-09-04", count: 9 },
  ],
  respondentCount: 10,
  scaleTimeline: [
    {
      scaleId: "sc1",
      weeks: [
        { week: "2026-08-31", n: 4, mean: null },
        { week: "2026-09-07", n: 8, mean: 9.1 },
        { week: "2026-09-14", n: 6, mean: 7.4 },
      ],
    },
    { scaleId: "sc2", weeks: [{ week: "2026-09-07", n: 3, mean: null }] },
  ],
  durationBins: [
    { fromMs: 0, toMs: 60_000, count: 0 },
    { fromMs: 60_000, toMs: 120_000, count: 9 },
    { fromMs: 120_000, toMs: null, count: null },
  ],
  answerMatrix: null,
};

describe("вкладка «Тести»: все пациенты", () => {
  test("огляд: плитки, столбцы с достроенным днём, потери", () => {
    const html = draw(<OverviewView data={data} />);
    clean(html);
    expect(html).toContain("Іваненко");
    // четыре дня (1…4 сентября), а не два: пустые достроены нулями
    expect(html.match(/<rect /g)?.length).toBe(4);
    expect(html).toContain("2. Другий");
  });

  test("шкали: профиль медиан, «замало даних» у шкалы под порогом, низкая альфа — словами", () => {
    const html = draw(<ScalesView data={data} />);
    clean(html);
    expect(either("ant.tooFew").some((t) => html.includes(t))).toBe(true);
    expect(either("ant.alphaLow").some((t) => html.includes(t))).toBe(true);
    expect(either("ant.validity").some((t) => html.includes(t))).toBe(true);
    // у содержательной шкалы две недели выше порога — есть ход, а не «замало даних»
    expect(html).toContain('role="img"');
  });

  test("питання: доли вариантов, свободные ответы раскрытием, пункт без ответов — словами", () => {
    const html = draw(<QuestionsView data={data} sort="number" onSort={() => {}} />);
    clean(html);
    expect(html).toContain("Майже щодня");
    expect(html).toContain("<details");
    expect(either("ant.noAnswers").some((t) => html.includes(t))).toBe(true);
  });

  test("час: медиана по пунктам, скрытая корзина — прочерк, а не ноль", () => {
    const html = draw(<TimeView data={data} />);
    clean(html);
    expect(either("kit.hidden").some((t) => html.includes(t))).toBe(true);
  });

  test("якість: помеченный протокол ведёт на графики прохождения", () => {
    const html = draw(<QualityView data={data} />);
    clean(html);
    expect(html).toContain("/surveys/s1/responses/r9/charts");
  });
});

describe("вкладка «Тести»: один пациент", () => {
  const dynamics: RespondentDynamics = {
    userId: "u1",
    fullName: "Петренко Іван",
    email: "p@x",
    sex: "male",
    age: 30,
    surveys: [
      {
        surveyId: "s1",
        title: "PHQ-9",
        responseCount: 2,
        firstAt: "2026-09-01T10:00:00Z",
        lastAt: "2026-09-20T10:00:00Z",
        scales: [
          {
            scaleId: "sc1",
            code: "D",
            title: "Депресія",
            delta: -6,
            direction: "down",
            reliableChange: null,
            points: [
              { responseId: "r1", submittedAt: "2026-09-01T10:00:00Z", rawScore: 16, maxScore: 27, percent: 59, bandLabel: "Тяжка", severity: "severe", percentile: null },
              { responseId: "r2", submittedAt: "2026-09-20T10:00:00Z", rawScore: 10, maxScore: 27, percent: 37, bandLabel: "Помірна", severity: "moderate", percentile: null },
            ],
          },
        ],
      },
    ],
  };

  const withMatrix: SurveyAnalytics = {
    ...data,
    answerMatrix: {
      responses: [
        { id: "r1", submittedAt: "2026-09-01T10:00:00Z", durationMs: 200_000 },
        { id: "r2", submittedAt: "2026-09-20T10:00:00Z", durationMs: 150_000 },
      ],
      rows: [
        {
          questionId: "q1",
          position: 0,
          title: "Настрій",
          type: "single",
          maxScore: 3,
          cells: [
            { label: "Майже щодня", score: 3, skipped: false, changed: true, durationMs: 4000 },
            { label: "Ніколи", score: 0, skipped: false, changed: false, durationMs: 2000 },
          ],
        },
        {
          questionId: "q2",
          position: 1,
          title: "Що турбує",
          type: "longtext",
          maxScore: null,
          cells: [null, { label: null, score: null, skipped: false, changed: false, durationMs: 9000 }],
        },
      ],
    },
  };

  test("динамика по лестнице, матрица ответов с тоном и свободный текст не в клетке", () => {
    const html = draw(<PatientView data={withMatrix} dynamics={dynamics} slice={{ userId: "u1" }} />);
    clean(html);
    expect(html).toContain("Петренко Іван");
    expect(html).toContain("/patients/u1");
    // тон верхней ступени у максимального балла и нижней — у нулевого
    expect(html).toContain("var(--primary)_46%");
    expect(html).toContain("var(--primary)_6%");
    // свободный текст в клетку не попадает — только отметка, что ответ есть
    expect(either("ant.cellHidden").some((t) => html.includes(t))).toBe(true);
    expect(either("ant.cellChanged").some((t) => html.includes(t))).toBe(true);
  });
});
