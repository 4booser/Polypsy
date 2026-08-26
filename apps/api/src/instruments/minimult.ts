import type { CreateSurveyDraft, ScaleDraft } from "@quizzy/shared";
import { MINIMULT_ITEMS } from "./minimult_items";

/**
 * Опросник Мини-мульт (сокращённый вариант MMPI).
 * Источник: Збірник методик для діагностики негативних психічних станів
 * військовослужбовців. — К.: НДЦ ГП ЗСУ, 2016. — С. 53–88.
 *
 * Проверяет два механизма, которых нет больше нигде:
 *   • K-коррекция — значение шкалы коррекции прибавляется к пяти базисным
 *     шкалам с разными коэффициентами;
 *   • T-баллы по нормам, различающимся для мужчин и женщин.
 *
 * Тексты пунктов приведены по пособию и подлежат согласованию с
 * правообладателем перед клиническим использованием.
 */

/** Ключ: В — ответ «верно», Н — «неверно» */
const KEY: Record<string, { yes?: number[]; no?: number[] }> = {
  L: { no: [5, 11, 24, 47, 53] },
  F: { no: [22, 24, 61], yes: [9, 12, 15, 19, 30, 38, 48, 49, 58, 59, 64, 71] },
  K: { no: [11, 23, 31, 33, 34, 36, 40, 41, 43, 51, 56, 61, 65, 67, 69, 70] },
  Hs: { no: [1, 2, 6, 37, 45], yes: [9, 18, 26, 32, 44, 46, 55, 62, 63] },
  D: { no: [1, 3, 6, 11, 28, 37, 40, 42, 60, 61, 65], yes: [9, 13, 17, 18, 22, 25, 36, 44] },
  Hy: {
    no: [1, 2, 3, 11, 23, 28, 29, 31, 33, 35, 37, 40, 41, 43, 45, 50, 56],
    yes: [9, 13, 18, 26, 44, 46, 55, 57, 62],
  },
  Pd: { no: [3, 28, 34, 35, 41, 43, 50, 65], yes: [7, 10, 13, 14, 15, 16, 22, 27, 52, 58, 71] },
  Pa: { no: [28, 29, 31, 67], yes: [5, 8, 10, 15, 30, 39, 63, 64, 66, 68] },
  Pt: { no: [2, 3, 42], yes: [5, 8, 13, 17, 22, 25, 27, 36, 44, 51, 57, 66, 68] },
  Se: {
    no: [3, 42],
    yes: [5, 7, 8, 10, 13, 14, 15, 16, 17, 26, 30, 38, 39, 46, 57, 63, 64, 66],
  },
  Ma: { no: [43], yes: [4, 7, 8, 21, 29, 34, 38, 39, 54, 57, 60] },
};

/**
 * Коэффициенты K-коррекции. Значение шкалы K прибавляется к базисным шкалам:
 * Hs + 0,5K, Pd + 0,4K, Pt + 1,0K, Se + 1,0K, Ma + 0,2K.
 */
const K_CORRECTION: Record<string, number> = { Hs: 0.5, Pd: 0.4, Pt: 1, Se: 1, Ma: 0.2 };

/** Нормы для перевода в T-баллы: среднее и стандартное отклонение по полу */
const NORMS: Record<string, { male: [number, number]; female: [number, number] }> = {
  L: { male: [1.48, 1.23], female: [1.51, 1.19] },
  F: { male: [3.1, 2.3], female: [2.64, 1.71] },
  K: { male: [7.68, 3.42], female: [7.72, 2.64] },
  Hs: { male: [7.24, 3], female: [8.47, 2.92] },
  D: { male: [7.02, 2.68], female: [7.96, 3] },
  Hy: { male: [9.73, 2.91], female: [11.53, 3.38] },
  Pd: { male: [10.39, 2.13], female: [9.76, 1.9] },
  Pa: { male: [4.03, 1.74], female: [4.77, 2] },
  Pt: { male: [13.57, 2.51], female: [14.48, 2.27] },
  Se: { male: [13.68, 2.83], female: [13.52, 2.8] },
};

const TITLES: Record<string, [string, string]> = {
  L: ["Шкала брехні (L)", "Шкала лжи (L)"],
  F: ["Шкала достовірності (F)", "Шкала достоверности (F)"],
  K: ["Шкала корекції (K)", "Шкала коррекции (K)"],
  Hs: ["1. Іпохондрія (Hs)", "1. Ипохондрия (Hs)"],
  D: ["2. Депресія (D)", "2. Депрессия (D)"],
  Hy: ["3. Істерія (Hy)", "3. Истерия (Hy)"],
  Pd: ["4. Психопатія (Pd)", "4. Психопатия (Pd)"],
  Pa: ["6. Параноя (Pa)", "6. Паранойяльность (Pa)"],
  Pt: ["7. Психастенія (Pt)", "7. Психастения (Pt)"],
  Se: ["8. Шизоїдність (Se)", "8. Шизоидность (Se)"],
  Ma: ["9. Гіпоманія (Ma)", "9. Гипомания (Ma)"],
};

/**
 * Интерпретация T-баллов. Границы общие для всех базисных шкал:
 * профиль читается по пикам, а не по каждой шкале в отрыве.
 */
const T_BANDS = [
  { minScore: 0, maxScore: 44.9, label: ["Низький", "Низкий"], severity: "none" as const },
  { minScore: 45, maxScore: 55.9, label: ["У межах норми", "В пределах нормы"], severity: "none" as const },
  { minScore: 56, maxScore: 69.9, label: ["Підвищений", "Повышенный"], severity: "mild" as const },
  {
    minScore: 70,
    maxScore: 79.9,
    label: ["Виражений пік", "Выраженный пик"],
    severity: "moderate" as const,
    recommendation: [
      "Пік профілю: потрібна клінічна інтерпретація фахівцем",
      "Пик профиля: требуется клиническая интерпретация специалистом",
    ],
  },
  {
    minScore: 80,
    maxScore: 200,
    label: ["Різко виражений пік", "Резко выраженный пик"],
    severity: "severe" as const,
    recommendation: [
      "Різкий пік: потрібне поглиблене обстеження",
      "Резкий пик: требуется углублённое обследование",
    ],
  },
];

const loc = (pair: [string, string]) => ({ uk: pair[0], ru: pair[1] });

function keyOf(code: string) {
  const k = KEY[code]!;
  return [
    ...(k.yes ?? []).map((item) => ({ item, matchKey: "yes" })),
    ...(k.no ?? []).map((item) => ({ item, matchKey: "no" })),
  ];
}

function normsOf(code: string) {
  const n = NORMS[code];
  if (!n) return [];
  const source = "Пособие НДЦ ГП ЗСУ, 2016";
  return [
    { sex: "male" as const, mean: n.male[0], sd: n.male[1], source },
    { sex: "female" as const, mean: n.female[0], sd: n.female[1], source },
  ];
}

const validityScale = (code: "L" | "F" | "K", threshold: number | null): ScaleDraft => ({
  code,
  title: loc(TITLES[code]!),
  kind: "validity",
  normalization: "tscore",
  key: keyOf(code),
  norms: normsOf(code),
  ...(threshold !== null
    ? {
        validityThreshold: threshold,
        validityDirection: "above" as const,
        validityMessage: {
          uk: `${TITLES[code]![0]} перевищила ${threshold} T — профіль інтерпретувати не можна`,
          ru: `${TITLES[code]![1]} превысила ${threshold} T — профиль интерпретировать нельзя`,
        },
      }
    : {}),
  bands: T_BANDS.map((b) => ({
    minScore: b.minScore,
    maxScore: b.maxScore,
    label: loc(b.label as [string, string]),
    severity: b.severity,
  })),
});

const clinicalScale = (code: string): ScaleDraft => {
  const norms = normsOf(code);
  /*
   * У шкалы 9 (Ma) в пособии нет строки в таблице норм, поэтому перевести её
   * в T-баллы не по чему. Оставляем сырой балл и говорим об этом прямо, вместо
   * того чтобы показывать T-балл, посчитанный неизвестно по какой норме.
   */
  const hasNorms = norms.length > 0;
  return {
  code,
  title: loc(TITLES[code]!),
  kind: "clinical",
  normalization: hasNorms ? "tscore" : "raw",
  ...(hasNorms
    ? {}
    : {
        description: {
          uk: "Норми для цієї шкали у посібнику відсутні — показано «сирий» бал, інтерпретувати його як T-бал не можна",
          ru: "Нормы для этой шкалы в пособии отсутствуют — показан «сырой» балл, интерпретировать его как T-балл нельзя",
        },
      }),
  key: keyOf(code),
  norms,
  // поправка на шкалу коррекции применяется до перевода в T-баллы
  corrections: K_CORRECTION[code] ? [{ from: "K", coefficient: K_CORRECTION[code]! }] : [],
  // нормы полос заданы в T-баллах, поэтому к шкале без норм они неприменимы
  bands: hasNorms
    ? T_BANDS.map((b) => ({
        minScore: b.minScore,
        maxScore: b.maxScore,
        label: loc(b.label as [string, string]),
        severity: b.severity,
        ...(b.recommendation ? { recommendation: loc(b.recommendation as [string, string]) } : {}),
      }))
    : [],
  };
};

export const minimult: CreateSurveyDraft = {
  title: { uk: "Опитувальник Міні-мульт", ru: "Опросник Мини-мульт" },
  description: {
    uk: "Скорочений варіант MMPI: три оцінні та вісім базисних шкал",
    ru: "Сокращённый вариант MMPI: три оценочные и восемь базисных шкал",
  },
  instructions: {
    uk: "Відповідайте «Вірно», якщо твердження стосується Вас, і «Невірно», якщо ні. Довго не замислюйтеся.",
    ru: "Отвечайте «Верно», если утверждение относится к Вам, и «Неверно», если нет. Долго не задумывайтесь.",
  },
  administration: "self",
  scoringEnabled: true,
  allowRetake: true,
  showProgress: true,
  // 71 короткое утверждение «верно/неверно» — порог небрежности ниже общего
  tooFastMs: 900,
  alertEscalateMinutes: 240,
  sections: [],

  questions: MINIMULT_ITEMS.map(([uk, ru]) => ({
    type: "yesno" as const,
    title: { uk, ru },
    required: true,
    options: [
      { text: { uk: "Вірно", ru: "Верно" }, keyCode: "yes" },
      { text: { uk: "Невірно", ru: "Неверно" }, keyCode: "no" },
    ],
  })),

  scales: [
    validityScale("L", 70),
    validityScale("F", 80),
    validityScale("K", null),
    ...["Hs", "D", "Hy", "Pd", "Pa", "Pt", "Se", "Ma"].map(clinicalScale),
  ],
};
