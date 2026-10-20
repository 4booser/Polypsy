import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { ces } from "../ces";
import { cesdr } from "../cesdr";
import { dass42 } from "../dass42";
import { gad7 } from "../gad7";
import { gds15 } from "../gds15";
import { pcl5 } from "../pcl5";
import { pcptsd5 } from "../pcptsd5";
import { phq4 } from "../phq4";
import { phq8 } from "../phq8";
import { phq9 } from "../phq9";
import { pq16 } from "../pq16";
import { pss10 } from "../pss10";
import { sbqr } from "../sbqr";
import { srq20 } from "../srq20";
import { who5 } from "../who5";

/**
 * Рецензия каталога 2.1 (участок review-mood): золотые протоколы методик, у
 * которых их не было (PCL-5, PQ-16), и сторож текста для пятнадцати методик
 * участка.
 *
 * Расчёты — по карточкам досье, добавленным рецензией (trauma.json — pcl5,
 * psychosis.json — pq16), и стоят в комментарии рядом с ожиданием.
 *
 * Конвертер — копия из golden-mood.test.ts по той же причине, что и там:
 * импорт из файла тестов зарегистрировал бы его тесты второй раз.
 */
function toSurveyFull(draft: unknown): SurveyFull {
  const input = createSurveySchema.parse(draft);
  const ru = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string }).ru ?? ""));
  const questions = input.questions.map((q, qi) => ({
    id: `q${qi + 1}`,
    surveyId: "s",
    sectionId: null,
    type: q.type,
    title: ru(q.title),
    help: null,
    required: q.required ?? true,
    position: qi,
    scaleId: null,
    reverseScored: q.reverseScored ?? false,
    minValue: q.minValue ?? null,
    maxValue: q.maxValue ?? null,
    step: q.step ?? null,
    minLabel: null,
    maxLabel: null,
    randomizeOptions: false,
    timeLimitSec: null,
    riskThreshold: null,
    riskLabel: null,
    riskSeverity: null,
    logic: [],
    options: (q.options ?? []).map((o, oi) => ({
      id: `q${qi + 1}o${oi}`,
      questionId: `q${qi + 1}`,
      text: ru(o.text),
      keyCode: o.keyCode ?? null,
      score: o.score ?? 0,
      position: oi,
      kind: o.kind ?? "option",
      riskFlag: o.riskFlag ?? false,
      riskLabel: null,
      riskSeverity: o.riskSeverity ?? null,
    })),
  }));
  const scales = (input.scales ?? []).map((s, si) => ({
    id: `sc${si}`,
    surveyId: "s",
    code: s.code,
    title: ru(s.title),
    description: null,
    aggregation: s.aggregation ?? "sum",
    position: si,
    kind: s.kind ?? "clinical",
    normalization: s.normalization ?? "raw",
    ratioDenominator: s.ratioDenominator ?? null,
    validityThreshold: s.validityThreshold ?? null,
    validityDirection: s.validityDirection ?? null,
    validityMessage: null,
    bands: (s.bands ?? []).map((b, bi) => ({
      id: `b${si}-${bi}`,
      scaleId: `sc${si}`,
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: ru(b.label),
      severity: b.severity,
      description: null,
      grade: b.grade ?? null,
      recommendation: null,
    })),
    items: (s.key ?? []).map((k) => ({ questionId: `q${k.item}`, matchKey: k.matchKey ?? null, weight: k.weight ?? 1 })),
    corrections: [],
    norms: [],
    stenTable: [],
  }));
  return { id: "s", title: "golden-review", questions, scales, sections: [], versionId: "v", versionNumber: 1 } as unknown as SurveyFull;
}

/** Ответ на каждый пункт — вариант с таким баллом (у методик ниже баллы вариантов различны) */
function byScore(survey: SurveyFull, scores: number[]): Answer[] {
  expect(scores.length, "ответов не столько, сколько пунктов").toBe(survey.questions.length);
  return survey.questions.map((q, i) => {
    const option = q.options.find((o) => o.score === scores[i]);
    if (!option) throw new Error(`пункт ${i + 1}: нет варианта с баллом ${scores[i]}`);
    return { questionId: q.id, optionIds: [option.id] };
  });
}

function scoreOf(draft: CreateSurveyDraft, scores: number[], code: string) {
  const survey = toSurveyFull(draft);
  const found = computeProfile(survey, byScore(survey, scores)).scores.find((s) => s.scaleCode === code);
  if (!found) throw new Error(`нет шкалы ${code}`);
  return found;
}

describe("золотой протокол: PCL-5", () => {
  test("пример досье: пп. 1–13 по 2, пп. 14–20 по 1 → 33, порог достигнут", () => {
    // 13 × 2 + 7 × 1 = 26 + 7 = 33 ≥ 33 → полоса 33–80, grade 2, moderate
    const s = scoreOf(pcl5, [...Array(13).fill(2), ...Array(7).fill(1)], "PCL");
    expect(s.rawScore).toBe(33);
    expect(s.maxScore).toBe(80);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("moderate");
  });

  test("32 — порог не достигнут; 80 — та же умеренная полоса: ступеней тяжести у источника нет", () => {
    // 12 × 2 + 8 × 1 = 32 < 33
    const below = scoreOf(pcl5, [...Array(12).fill(2), ...Array(8).fill(1)], "PCL");
    expect(below.rawScore).toBe(32);
    expect(below.band?.severity).toBe("none");
    // все «Дуже сильно»: 20 × 4 = 80 — раньше здесь была тяжёлая полоса 50–80 без источника
    const top = scoreOf(pcl5, Array(20).fill(4), "PCL");
    expect(top.rawScore).toBe(80);
    expect(top.band?.severity).toBe("moderate");
    expect(pcl5.scales?.[0]?.bands?.map((b) => [b.minScore, b.maxScore])).toEqual([
      [0, 32],
      [33, 80],
    ]);
  });

  test("пункты 9 и 11 — «сильні», а не «стійкі»: «strong negative beliefs / feelings» бланка", () => {
    const qs = pcl5.questions ?? [];
    expect(qs.length).toBe(20);
    expect((qs[8]!.title as { uk: string }).uk.startsWith("Сильні негативні переконання")).toBe(true);
    expect((qs[10]!.title as { uk: string }).uk.startsWith("Сильні негативні почуття")).toBe(true);
    expect((qs[4]!.title as { uk: string }).uk.startsWith("Сильні тілесні реакції")).toBe(true);
    for (const q of qs) expect((q.options ?? []).map((o) => o.score)).toEqual([0, 1, 2, 3, 4]);
  });
});

/* ─── сторож текста: буквы чужого языка в пунктах и ответах ─── */

const AREA: [string, CreateSurveyDraft][] = [
  ["phq9", phq9],
  ["gad7", gad7],
  ["phq4", phq4],
  ["phq8", phq8],
  ["cesdr", cesdr],
  ["srq20", srq20],
  ["gds15", gds15],
  ["pss10", pss10],
  ["dass42", dass42],
  ["who5", who5],
  ["pcl5", pcl5],
  ["pcptsd5", pcptsd5],
  ["ces", ces],
  ["sbqr", sbqr],
  ["pq16", pq16],
];

describe("рецензия 2.1: буквы языка в том, что читает обследуемый", () => {
  /*
   * Пункты, варианты ответа и инструкция — то, что видит человек. В украинском
   * тексте не должно быть русских букв (ы э ъ ё), в русском — украинских
   * (і ї є ґ). Описание методики не проверяется: оно законно цитирует текст
   * другого языка («відчуття безпорадності» в русском описании PHQ-9).
   */
  for (const [key, draft] of AREA) {
    test(`${key}: украинский без ы э ъ ё, русский без і ї є ґ`, () => {
      const texts: { uk?: string; ru?: string }[] = [
        draft.instructions as { uk?: string; ru?: string },
        ...(draft.questions ?? []).flatMap((q) => [q.title as { uk?: string; ru?: string }, ...(q.options ?? []).map((o) => o.text as { uk?: string; ru?: string })]),
      ].filter(Boolean);
      const badUk = texts.map((t) => t.uk ?? "").filter((t) => /[ыэъёЫЭЪЁ]/.test(t));
      const badRu = texts.map((t) => t.ru ?? "").filter((t) => /[іїєґІЇЄҐ]/.test(t));
      expect(badUk).toEqual([]);
      expect(badRu).toEqual([]);
    });

    test(`${key}: схема и проверка структуры без ошибок`, () => {
      const parsed = createSurveySchema.parse(draft);
      expect(validateSurvey(parsed).filter((i) => i.level === "error").map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });
  }
});
