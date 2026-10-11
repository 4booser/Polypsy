import { describe, expect, test } from "bun:test";
import { answerScore, computeProfile, scaleMaxScore } from "../src/scoring";
import { evaluateSubmission } from "../src/risk";
import type { Answer, Option, Question } from "../src/types";
import { answerYesNo, band, makeScale, makeSurvey, yesNoQuestion } from "./fixtures";

/*
 * Подсчёт, общий для сервера, веба и мобилки (волна 21, участок clinical):
 * границы балла частично заполненной обратной матрицы (#136) и максимум с
 * процентом шкал с поправками (#133).
 */

/* ── #136: частично заполненная матрица с обратным ключом ─────────────────── */

/** Матрица: строки r1…rN, варианты 0–3 */
function matrixQuestion(rows: number, over: Partial<Question> = {}): Question {
  const base = yesNoQuestion(0);
  const qid = base.id;
  const opt = (i: number): Option => ({
    ...base.options[0]!,
    id: `${qid}-o${i}`,
    keyCode: null,
    score: i,
    kind: "option",
    position: rows + i,
  });
  const row = (i: number): Option => ({
    ...base.options[0]!,
    id: `${qid}-r${i}`,
    keyCode: null,
    score: 0,
    kind: "row",
    position: i,
  });
  return {
    ...base,
    type: "matrix",
    required: false,
    options: [...Array.from({ length: rows }, (_, i) => row(i)), ...[0, 1, 2, 3].map(opt)],
    ...over,
  };
}

const pick = (q: Question, picks: Record<number, number>): Answer => ({
  questionId: q.id,
  matrix: Object.fromEntries(Object.entries(picks).map(([r, o]) => [`${q.id}-r${r}`, `${q.id}-o${o}`])),
});

describe("обратная матрица, заполненная частично (#136)", () => {
  test("одна строка из трёх с ответом 3 — обращённый вклад 0, а не 6", () => {
    const q = matrixQuestion(3, { reverseScored: true });
    expect(answerScore(q, pick(q, { 0: 3 }))).toBe(0);
    expect(answerScore(q, pick(q, { 0: 0 }))).toBe(3);
  });

  test("k отвеченных строк — вклад в [min·k; max·k] при любых ответах", () => {
    const q = matrixQuestion(4, { reverseScored: true });
    for (let k = 1; k <= 4; k++) {
      for (const v of [0, 1, 2, 3]) {
        const picks = Object.fromEntries(Array.from({ length: k }, (_, r) => [r, v]));
        const score = answerScore(q, pick(q, picks))!;
        expect(score, `k=${k}, ответ ${v}`).toBeGreaterThanOrEqual(0);
        expect(score, `k=${k}, ответ ${v}`).toBeLessThanOrEqual(3 * k);
        expect(score).toBe((3 - v) * k);
      }
    }
  });

  test("частичная матрица — не «отвечена целиком»: одна строка из трёх ниже минимальной доли, полосы и тревоги нет", () => {
    const q = matrixQuestion(3, { reverseScored: true });
    const scale = makeScale({ code: "M", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    scale.bands = [band(scale.id, 0, 4, "Норма"), band(scale.id, 5, 9, "Тяжело", { severity: "severe" })];
    const survey = makeSurvey([q], [scale]);

    const partial = evaluateSubmission(survey, [pick(q, { 0: 3 })]);
    expect(partial.profile.scores.map((s) => s.scaleCode), "шкала посчитана по трети матрицы").toEqual([]);
    expect(partial.risk.severity).toBeNull();

    // при своей доле 0 шкала считается — и по настоящему баллу, без тяжёлой полосы
    const lenient = makeSurvey([q], [{ ...scale, minAnsweredShare: 0 }]);
    const [score] = computeProfile(lenient, [pick(q, { 0: 3 })]).scores;
    expect(score!.rawScore).toBe(0);
    expect(score!.band?.label).toBe("Норма");
  });

  test("контроль: полностью заполненная обратная матрица — как прежде, min·rows + max·rows − сумма", () => {
    const q = matrixQuestion(3, { reverseScored: true });
    expect(answerScore(q, pick(q, { 0: 3, 1: 3, 2: 3 }))).toBe(0);
    expect(answerScore(q, pick(q, { 0: 0, 1: 1, 2: 3 }))).toBe(9 - 4);
    const scale = makeScale({ code: "M", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    scale.bands = [band(scale.id, 0, 4, "Норма"), band(scale.id, 5, 9, "Тяжело", { severity: "severe" })];
    const full = evaluateSubmission(makeSurvey([q], [scale]), [pick(q, { 0: 0, 1: 0, 2: 0 })]);
    expect(full.profile.scores[0]!.rawScore).toBe(9);
    expect(full.risk.severity).toBe("severe");
  });

  test("контроль: прямая матрица не меняется — сумма отвеченных строк", () => {
    const q = matrixQuestion(3);
    expect(answerScore(q, pick(q, { 0: 3 }))).toBe(3);
    expect(answerScore(q, pick(q, { 0: 1, 1: 2, 2: 3 }))).toBe(6);
  });
});

/* ── #133: максимум и процент — от балла после поправок ───────────────────── */

describe("максимум шкалы с поправками (#133)", () => {
  /** Три шкалы по два пункта «так»: A, B и композит C = A + B без своих пунктов (как ЛАП МЛО) */
  function composite() {
    const qs = Array.from({ length: 4 }, (_, i) => yesNoQuestion(i));
    const item = (q: Question) => ({ questionId: q.id, matchKey: "yes", weight: 1 });
    const A = makeScale({ code: "A", items: [item(qs[0]!), item(qs[1]!)] });
    const B = makeScale({ code: "B", items: [item(qs[2]!), item(qs[3]!)] });
    const C = makeScale({
      code: "C",
      corrections: [
        { sourceScaleCode: "A", coefficient: 1 },
        { sourceScaleCode: "B", coefficient: 1 },
      ],
    });
    return { qs, A, B, C, survey: makeSurvey(qs, [A, B, C]) };
  }

  test("композит без своих пунктов: максимум — сумма максимумов источников, процент — от него", () => {
    const { qs, A, B, C, survey } = composite();
    expect(scaleMaxScore(C, qs, survey.scales)).toBe(4);
    // без шкал методики поправки не видны — прежний максимум по пунктам
    expect(scaleMaxScore(C, qs)).toBe(0);
    expect(scaleMaxScore(A, qs, survey.scales)).toBe(2);
    expect(scaleMaxScore(B, qs, survey.scales)).toBe(2);
    const answers = [answerYesNo(qs[0]!, true), answerYesNo(qs[1]!, false), answerYesNo(qs[2]!, true), answerYesNo(qs[3]!, true)];
    const c = computeProfile(survey, answers).scores.find((s) => s.scaleCode === "C")!;
    expect(c).toMatchObject({ rawScore: 0, correctedScore: 3, maxScore: 4, percent: 75 });
  });

  test("K-поправка с дробным коэффициентом: процент не выше ста при «так» на всё", () => {
    const qs = Array.from({ length: 6 }, (_, i) => yesNoQuestion(i));
    const item = (q: Question) => ({ questionId: q.id, matchKey: "yes", weight: 1 });
    const K = makeScale({ code: "K", items: qs.slice(0, 4).map(item) });
    const Pd = makeScale({ code: "Pd", items: qs.slice(4).map(item), corrections: [{ sourceScaleCode: "K", coefficient: 0.4 }] });
    const survey = makeSurvey(qs, [K, Pd]);
    const all = qs.map((q) => answerYesNo(q, true));
    const pd = computeProfile(survey, all).scores.find((s) => s.scaleCode === "Pd")!;
    expect(pd).toMatchObject({ rawScore: 2, correctedScore: 3.6, maxScore: 3.6, percent: 100 });
  });

  test("отрицательный коэффициент: к максимуму прибавляется наибольшее — от минимума источника", () => {
    const qs = Array.from({ length: 3 }, (_, i) => yesNoQuestion(i));
    const item = (q: Question) => ({ questionId: q.id, matchKey: "yes", weight: 1 });
    const S = makeScale({ code: "S", items: qs.slice(0, 2).map(item) });
    const T = makeScale({ code: "T", items: [item(qs[2]!)], corrections: [{ sourceScaleCode: "S", coefficient: -1 }] });
    // минимум S — 0: вычет не прибавляет ничего, максимум T — его пункт
    expect(scaleMaxScore(T, qs, [S, T])).toBe(1);
  });

  test("контроль: шкала без поправок — максимум по пунктам, как прежде", () => {
    const { qs, A, survey } = composite();
    const a = computeProfile(survey, qs.map((q) => answerYesNo(q, true))).scores.find((s) => s.scaleCode === "A")!;
    expect(scaleMaxScore(A, qs)).toBe(2);
    expect(a).toMatchObject({ rawScore: 2, correctedScore: 2, maxScore: 2, percent: 100 });
  });
});
