import { describe, expect, test } from "bun:test";
import { answerScore, computeProfile } from "../src/scoring";
import { evaluateSubmission } from "../src/risk";
import type { Answer, Option, Question } from "../src/types";
import { band, makeScale, makeSurvey, yesNoQuestion } from "./fixtures";

/*
 * Подсчёт, общий для сервера, веба и мобилки (волна 21, участок clinical):
 * границы балла частично заполненной обратной матрицы (#136).
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
