import { describe, expect, test } from "bun:test";
import {
  answerScore,
  computeProfile,
  isAnswered,
  isQuestionVisible,
  questionScoreRange,
  scaleMaxScore,
} from "../src/scoring";
import type { Answer } from "../src/types";
import {
  answerNumber,
  answerYesNo,
  band,
  makeScale,
  makeSurvey,
  rule,
  scaleQuestion,
  yesNoQuestion,
} from "./fixtures";

/* ── Ключевой подсчёт ─────────────────────────────────────────────────────── */

describe("ключ по совпадению (matchKey)", () => {
  test("балл идёт только за совпадение с ключом", () => {
    const q1 = yesNoQuestion(0);
    const q2 = yesNoQuestion(1);
    const scale = makeScale({
      code: "S",
      items: [
        { questionId: q1.id, matchKey: "yes", weight: 1 },
        { questionId: q2.id, matchKey: "no", weight: 1 },
      ],
    });
    const survey = makeSurvey([q1, q2], [scale]);

    // q1 = Да (совпало), q2 = Да (не совпало: ключ ждёт «Нет»)
    const { scores } = computeProfile(survey, [answerYesNo(q1, true), answerYesNo(q2, true)]);
    expect(scores[0]!.rawScore).toBe(1);

    // оба по ключу
    const both = computeProfile(survey, [answerYesNo(q1, true), answerYesNo(q2, false)]);
    expect(both.scores[0]!.rawScore).toBe(2);
  });

  test("вес пункта умножает вклад", () => {
    const q = yesNoQuestion(0);
    const scale = makeScale({ code: "S", items: [{ questionId: q.id, matchKey: "yes", weight: 3 }] });
    const { scores } = computeProfile(makeSurvey([q], [scale]), [answerYesNo(q, true)]);
    expect(scores[0]!.rawScore).toBe(3);
  });

  test("пропущенный пункт не даёт ни балла, ни нуля в среднее", () => {
    const q1 = yesNoQuestion(0);
    const q2 = yesNoQuestion(1);
    const scale = makeScale({
      code: "S",
      aggregation: "average",
      items: [
        { questionId: q1.id, matchKey: "yes", weight: 1 },
        { questionId: q2.id, matchKey: "yes", weight: 1 },
      ],
    });
    // отвечен только q1 «Да»: среднее по одному отвеченному = 1, а не 0.5
    const { scores } = computeProfile(makeSurvey([q1, q2], [scale]), [answerYesNo(q1, true)]);
    expect(scores[0]!.rawScore).toBe(1);
  });
});

/* ── Обратный ключ ────────────────────────────────────────────────────────── */

describe("обратный ключ (reverseScored)", () => {
  test("инвертирует внутри диапазона вопроса", () => {
    const q = scaleQuestion(0, 4, { reverseScored: true });
    expect(answerScore(q, answerNumber(q, 0))).toBe(4);
    expect(answerScore(q, answerNumber(q, 4))).toBe(0);
    expect(answerScore(q, answerNumber(q, 1))).toBe(3);
  });

  test("края диапазона: прямой вопрос не меняется", () => {
    const q = scaleQuestion(0, 4);
    expect(answerScore(q, answerNumber(q, 0))).toBe(0);
    expect(answerScore(q, answerNumber(q, 4))).toBe(4);
  });
});

/* ── Кросс-шкальные поправки ──────────────────────────────────────────────── */

describe("поправки шкал (K-коррекция)", () => {
  test("поправка добавляет долю сырого балла источника", () => {
    // Hs = Hs_raw + 0.5 · K_raw — схема Мини-мульта
    const kq = [yesNoQuestion(0), yesNoQuestion(1)];
    const hq = [yesNoQuestion(2)];
    const K = makeScale({ code: "K", items: kq.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })) });
    const Hs = makeScale({
      code: "Hs",
      items: hq.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
      corrections: [{ sourceScaleCode: "K", coefficient: 0.5 }],
    });
    const survey = makeSurvey([...kq, ...hq], [K, Hs]);
    const answers = [...kq, ...hq].map((q) => answerYesNo(q, true)); // K=2, Hs_raw=1

    const { scores } = computeProfile(survey, answers);
    const hs = scores.find((s) => s.scaleCode === "Hs")!;
    expect(hs.rawScore).toBe(1);
    expect(hs.correctedScore).toBe(2); // 1 + 0.5·2
  });

  test("поправка берёт СЫРОЙ балл источника, даже если источник сам корректируется", () => {
    // A корректируется на B, B корректируется на C. Порядок объявления шкал
    // не должен влиять: все поправки считаются от сырых значений.
    const qa = yesNoQuestion(0);
    const qb = yesNoQuestion(1);
    const qc = yesNoQuestion(2);
    const A = makeScale({
      code: "A",
      items: [{ questionId: qa.id, matchKey: "yes", weight: 1 }],
      corrections: [{ sourceScaleCode: "B", coefficient: 1 }],
    });
    const B = makeScale({
      code: "B",
      items: [{ questionId: qb.id, matchKey: "yes", weight: 1 }],
      corrections: [{ sourceScaleCode: "C", coefficient: 1 }],
    });
    const C = makeScale({ code: "C", items: [{ questionId: qc.id, matchKey: "yes", weight: 1 }] });

    const answers = [answerYesNo(qa, true), answerYesNo(qb, true), answerYesNo(qc, true)];
    const forward = computeProfile(makeSurvey([qa, qb, qc], [A, B, C]), answers);
    const backward = computeProfile(makeSurvey([qa, qb, qc], [C, B, A]), answers);

    const a1 = forward.scores.find((s) => s.scaleCode === "A")!;
    const a2 = backward.scores.find((s) => s.scaleCode === "A")!;
    // A = A_raw + B_raw = 1 + 1 = 2 (НЕ 1 + (1+1) = 3)
    expect(a1.correctedScore).toBe(2);
    expect(a2.correctedScore).toBe(2);
  });
});

/* ── Нормирование ─────────────────────────────────────────────────────────── */

describe("нормирование", () => {
  test("ratio: доля от знаменателя, а не от максимума", () => {
    const qs = [yesNoQuestion(0), yesNoQuestion(1)];
    const scale = makeScale({
      code: "Sr",
      normalization: "ratio",
      ratioDenominator: 10, // как L в СР-45: знаменатель фиксирован методикой
      items: qs.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
    });
    const { scores } = computeProfile(makeSurvey(qs, [scale]), qs.map((q) => answerYesNo(q, true)));
    expect(scores[0]!.value).toBe(0.2); // 2/10, не 2/2
  });

  test("tscore: 50 + 10(x-M)/SD по норме своего пола", () => {
    const q = yesNoQuestion(0);
    const scale = makeScale({
      code: "D",
      normalization: "tscore",
      items: [{ questionId: q.id, matchKey: "yes", weight: 1 }],
      norms: [
        { id: "n1", scaleId: "x", sex: "male", ageMin: null, ageMax: null, mean: 0.5, sd: 0.25 },
        { id: "n2", scaleId: "x", sex: "female", ageMin: null, ageMax: null, mean: 0.8, sd: 0.1 },
      ],
    });
    const survey = makeSurvey([q], [scale]);
    const male = computeProfile(survey, [answerYesNo(q, true)], { sex: "male", age: 30 });
    expect(male.scores[0]!.value).toBe(70); // 50 + 10(1-0.5)/0.25

    const female = computeProfile(survey, [answerYesNo(q, true)], { sex: "female", age: 30 });
    expect(female.scores[0]!.value).toBe(70); // 50 + 10(1-0.8)/0.1
  });

  test("tscore без нормы: сырой балл + предупреждение, без выдумки", () => {
    const q = yesNoQuestion(0);
    const scale = makeScale({
      code: "D",
      normalization: "tscore",
      items: [{ questionId: q.id, matchKey: "yes", weight: 1 }],
      norms: [{ id: "n", scaleId: "x", sex: "male", ageMin: null, ageMax: null, mean: 1, sd: 1 }],
    });
    // пол не указан — мужская норма не подходит
    const { scores, warnings } = computeProfile(makeSurvey([q], [scale]), [answerYesNo(q, true)]);
    expect(scores[0]!.value).toBe(1);
    expect(warnings.some((w) => w.includes("нет нормы"))).toBe(true);
  });

  test("общая норма (sex=null) подхватывается, конкретная — приоритетнее", () => {
    const q = yesNoQuestion(0);
    const scale = makeScale({
      code: "D",
      normalization: "tscore",
      items: [{ questionId: q.id, matchKey: "yes", weight: 1 }],
      norms: [
        { id: "n0", scaleId: "x", sex: null, ageMin: null, ageMax: null, mean: 0, sd: 1 },
        { id: "n1", scaleId: "x", sex: "male", ageMin: null, ageMax: null, mean: 1, sd: 1 },
      ],
    });
    const survey = makeSurvey([q], [scale]);
    // мужчине — мужская норма: T = 50 + 10(1-1)/1 = 50
    expect(computeProfile(survey, [answerYesNo(q, true)], { sex: "male", age: null }).scores[0]!.value).toBe(50);
    // женщине — общая: T = 50 + 10(1-0)/1 = 60
    expect(computeProfile(survey, [answerYesNo(q, true)], { sex: "female", age: null }).scores[0]!.value).toBe(60);
  });

  test("sten: инвертированная таблица (высокий сырой → низкий стен) и выход за таблицу", () => {
    const qs = [yesNoQuestion(0), yesNoQuestion(1), yesNoQuestion(2)];
    const scale = makeScale({
      code: "MLO",
      normalization: "sten",
      items: qs.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
      stenTable: [
        { id: "s1", scaleId: "x", sex: null, ageMin: null, ageMax: null, rawMin: 0, rawMax: 0, sten: 10 },
        { id: "s2", scaleId: "x", sex: null, ageMin: null, ageMax: null, rawMin: 1, rawMax: 2, sten: 5 },
        // сырой 3 намеренно не покрыт
      ],
    });
    const survey = makeSurvey(qs, [scale]);

    const none = computeProfile(survey, qs.map((q) => answerYesNo(q, false)));
    expect(none.scores[0]!.value).toBe(10);

    const two = computeProfile(survey, [answerYesNo(qs[0]!, true), answerYesNo(qs[1]!, true), answerYesNo(qs[2]!, false)]);
    expect(two.scores[0]!.value).toBe(5);

    const out = computeProfile(survey, qs.map((q) => answerYesNo(q, true)));
    expect(out.warnings.some((w) => w.includes("вне таблицы стенов"))).toBe(true);
  });
});

/* ── Интерпретация и достоверность ────────────────────────────────────────── */

describe("полосы и гейт достоверности", () => {
  test("полоса подбирается по итоговому значению, не по сырому", () => {
    const qs = Array.from({ length: 4 }, (_, i) => yesNoQuestion(i));
    const scale = makeScale({
      code: "Sr",
      normalization: "ratio",
      ratioDenominator: 4,
      items: qs.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
    });
    scale.bands = [band(scale.id, 0, 0.5, "Низкий"), band(scale.id, 0.51, 1, "Высокий", { severity: "severe", grade: 1 })];
    const survey = makeSurvey(qs, [scale]);

    const three = computeProfile(survey, qs.slice(0, 3).map((q) => answerYesNo(q, true)));
    // сырой 3 попал бы в «Высокий» по сырому; доля 0.75 → «Высокий» — совпадает,
    // а вот 2 из 4 (0.5) должен попасть в «Низкий», хотя сырой 2 > 1
    expect(three.scores[0]!.band?.label).toBe("Высокий");
    const two = computeProfile(survey, qs.slice(0, 2).map((q) => answerYesNo(q, true)));
    expect(two.scores[0]!.band?.label).toBe("Низкий");
    expect(two.scores[0]!.band?.grade ?? null).toBe(null);
  });

  test("шкала достоверности «выше порога» валит весь профиль", () => {
    const lq = [yesNoQuestion(0), yesNoQuestion(1)];
    const L = makeScale({
      code: "L",
      kind: "validity",
      normalization: "ratio",
      ratioDenominator: 2,
      validityThreshold: 0.6,
      validityDirection: "above",
      validityMessage: "Обследуемый приукрашивает себя",
      items: lq.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
    });
    const survey = makeSurvey(lq, [L]);

    const honest = computeProfile(survey, [answerYesNo(lq[0]!, true), answerYesNo(lq[1]!, false)]);
    expect(honest.reliable).toBe(true); // 0.5 ≤ 0.6

    const fake = computeProfile(survey, lq.map((q) => answerYesNo(q, true)));
    expect(fake.reliable).toBe(false); // 1 > 0.6
    expect(fake.warnings).toContain("Обследуемый приукрашивает себя");
    expect(fake.scores[0]!.validityFailed).toBe(true);
  });

  test("направление below: слишком низкий балл — тоже недостоверно", () => {
    const q = yesNoQuestion(0);
    const F = makeScale({
      code: "F",
      kind: "validity",
      validityThreshold: 1,
      validityDirection: "below",
      items: [{ questionId: q.id, matchKey: "yes", weight: 1 }],
    });
    const { reliable } = computeProfile(makeSurvey([q], [F]), [answerYesNo(q, false)]);
    expect(reliable).toBe(false); // 0 < 1
  });
});

/* ── Диапазоны и максимумы ────────────────────────────────────────────────── */

describe("questionScoreRange / scaleMaxScore", () => {
  test("multiple: максимум — сумма положительных, минимум — сумма отрицательных", () => {
    const q = yesNoQuestion(0, { type: "multiple" });
    q.options = [
      { ...q.options[0]!, score: 2 },
      { ...q.options[1]!, score: -1 },
    ];
    expect(questionScoreRange(q)).toEqual({ min: -1, max: 2 });
  });

  test("максимум шкалы с ключом — сумма весов", () => {
    const qs = [yesNoQuestion(0), yesNoQuestion(1)];
    const scale = makeScale({
      code: "S",
      items: [
        { questionId: qs[0]!.id, matchKey: "yes", weight: 1 },
        { questionId: qs[1]!.id, matchKey: "no", weight: 2 },
      ],
    });
    expect(scaleMaxScore(scale, qs)).toBe(3);
  });
});

/* ── Отвеченность и логика ────────────────────────────────────────────────── */

describe("isAnswered / isQuestionVisible", () => {
  test("матрица отвечена, только когда заполнены все строки", () => {
    const q = yesNoQuestion(0, { type: "matrix" });
    const r1 = { ...q.options[0]!, id: "row1", kind: "row" as const };
    const r2 = { ...q.options[0]!, id: "row2", kind: "row" as const };
    const opt = { ...q.options[0]!, id: "opt1" };
    q.options = [r1, r2, opt];
    expect(isAnswered(q, { questionId: q.id, matrix: { row1: "opt1" } })).toBe(false);
    expect(isAnswered(q, { questionId: q.id, matrix: { row1: "opt1", row2: "opt1" } })).toBe(true);
  });

  test("show-правило открывает вопрос после нужного ответа", () => {
    const source = yesNoQuestion(0);
    const target = yesNoQuestion(1, {
      logic: [rule(source, { operator: "contains", value: source.options[0]!.id })],
    });
    const questions = [source, target];
    const empty = new Map<string, Answer>();
    expect(isQuestionVisible(target, questions, empty)).toBe(false);

    const yes = new Map([[source.id, answerYesNo(source, true)]]);
    expect(isQuestionVisible(target, questions, yes)).toBe(true);

    const no = new Map([[source.id, answerYesNo(source, false)]]);
    expect(isQuestionVisible(target, questions, no)).toBe(false);
  });

  test("hide-правило работает зеркально", () => {
    const source = yesNoQuestion(0);
    const target = yesNoQuestion(1, {
      logic: [rule(source, { operator: "answered", action: "hide" })],
    });
    const questions = [source, target];
    expect(isQuestionVisible(target, questions, new Map())).toBe(true);
    expect(isQuestionVisible(target, questions, new Map([[source.id, answerYesNo(source, true)]]))).toBe(false);
  });

  test("числовые операторы gt/lte", () => {
    const source = scaleQuestion(0, 10);
    const target = yesNoQuestion(1, { logic: [rule(source, { operator: "gt", value: 5 })] });
    const questions = [source, target];
    expect(isQuestionVisible(target, questions, new Map([[source.id, answerNumber(source, 6)]]))).toBe(true);
    expect(isQuestionVisible(target, questions, new Map([[source.id, answerNumber(source, 5)]]))).toBe(false);
  });
});
