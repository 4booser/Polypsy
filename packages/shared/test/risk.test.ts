import { describe, expect, test } from "bun:test";
import { assessRisk, countedAnswers, evaluateSubmission } from "../src/risk";
import { computeProfile } from "../src/scoring";
import type { Scale } from "../src/types";
import { band, makeScale, makeSurvey, rule, yesNoQuestion } from "./fixtures";
import { riskCases } from "./riskCases";

/**
 * Оценка сдачи: какие ответы считаются и какой риск (волна 12, engine).
 *
 * Одна функция на сервер и оба клиента без сети. Набор случаев общий с
 * тестом офлайн-памятки веб-кабинета (riskCases.ts).
 */

describe("итоговый риск сдачи — набор случаев", () => {
  for (const c of riskCases()) {
    test(c.name, () => {
      expect(evaluateSubmission(c.survey, c.answers).risk.severity).toBe(c.expected);
    });
  }

  test("полоса — сигнал со шкалой, критический ответ — с пунктом", () => {
    const c = riskCases().find((x) => x.name === "умеренный флаг и тяжёлая полоса")!;
    const { risk } = evaluateSubmission(c.survey, c.answers);
    expect(risk.answers.map((r) => r.severity)).toEqual(["moderate"]);
    expect(risk.bands.map((r) => [r.scaleId, r.severity])).toEqual([[c.survey.scales[0]!.id, "severe"]]);
    expect(risk.bands[0]!.label).toBe("D: Тяжкий");
  });
});

describe("скрытые условием ответы", () => {
  test("не считаются в баллы и перечислены отдельно", () => {
    const gate = yesNoQuestion(0);
    const hidden = yesNoQuestion(1, { logic: [rule(gate, { operator: "gte", value: 1 })] });
    const plain = yesNoQuestion(2);
    const scale = makeScale({
      code: "S",
      items: [
        { questionId: hidden.id, matchKey: "yes", weight: 5 },
        { questionId: plain.id, matchKey: "yes", weight: 1 },
      ],
    });
    const survey = makeSurvey([gate, hidden, plain], [scale]);
    const yesOf = (q: typeof gate) => q.options.find((o) => o.keyCode === "yes")!.id;
    const noOf = (q: typeof gate) => q.options.find((o) => o.keyCode === "no")!.id;
    const answers = [
      { questionId: gate.id, optionIds: [noOf(gate)] },
      { questionId: hidden.id, optionIds: [yesOf(hidden)] },
      { questionId: plain.id, optionIds: [yesOf(plain)] },
    ];

    const evaluation = evaluateSubmission(survey, answers);
    expect(evaluation.hidden).toEqual([hidden.id]);
    expect(evaluation.answers.map((a) => a.questionId)).toEqual([gate.id, plain.id]);
    expect(evaluation.profile.scores[0]!.rawScore).toBe(1);
    // и сам движок скрытый пункт не считает, откуда бы его ни позвали (предпросмотр, посев)
    expect(computeProfile(survey, answers).scores[0]!.rawScore).toBe(1);
  });

  test("assessRisk отбирает видимые сам — откуда бы его ни позвали", () => {
    const c = riskCases().find((x) => x.name === "скрытый пункт")!;
    expect(assessRisk(c.survey, c.answers, []).severity).toBeNull();
  });

  test("ответ на неизвестный вопрос выпадает, но скрытым не считается", () => {
    const q = yesNoQuestion(0);
    const survey = makeSurvey([q], []);
    const result = countedAnswers(survey, [
      { questionId: "чужой", optionIds: ["x"] },
      { questionId: q.id, optionIds: [q.options[0]!.id] },
    ]);
    expect(result.answers.map((a) => a.questionId)).toEqual([q.id]);
    expect(result.hidden).toEqual([]);
  });
});

describe("повтор варианта в множественном выборе", () => {
  test("вариант считается один раз: 3, а не 9", () => {
    const q = { ...yesNoQuestion(0), type: "multiple" as const };
    q.options = q.options.map((o, i) => ({ ...o, score: i === 0 ? 3 : 0 }));
    const scale = makeScale({ code: "M", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    const survey = makeSurvey([q], [scale]);
    const id = q.options[0]!.id;
    const { scores } = computeProfile(survey, [{ questionId: q.id, optionIds: [id, id, id] }]);
    expect(scores[0]!.rawScore).toBe(3);
    expect(scores[0]!.maxScore).toBe(3);
  });
});

describe("шкала, на которую почти не ответили, не вычисляется", () => {
  /*
   * Шкала без ответов давала 0 и полосу: три необязательных пропуска
   * читались как «Норма». Невычислимое — null (ARCHITECTURE.md): такой
   * шкалы нет в профиле, а в предупреждениях сказано почему.
   */
  function optionalScale(over: Partial<Scale> = {}) {
    const qs = [0, 1, 2].map((i) => yesNoQuestion(i, { required: false }));
    const scale = makeScale({
      code: "S",
      items: qs.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
      ...over,
    });
    scale.bands = [band(scale.id, 0, 1, "Норма"), band(scale.id, 2, 3, "Виражено", { severity: "severe" })];
    return { qs, survey: makeSurvey(qs, [scale]) };
  }
  const yes = (q: ReturnType<typeof yesNoQuestion>) => ({ questionId: q.id, optionIds: [q.options[0]!.id] });

  test("три необязательных пропуска — не «Норма», а не вычислено", () => {
    const { survey } = optionalScale();
    const profile = computeProfile(survey, []);
    expect(profile.scores).toEqual([]);
    expect(profile.warnings.some((w) => w.includes("0 из 3"))).toBe(true);
  });

  test("явный пропуск (skipped) — тоже не ответ", () => {
    const { qs, survey } = optionalScale();
    expect(computeProfile(survey, qs.map((q) => ({ questionId: q.id, skipped: true }))).scores).toEqual([]);
  });

  test("умолчание — четыре пятых: два из трёх мало, три из трёх считаются", () => {
    const { qs, survey } = optionalScale();
    expect(computeProfile(survey, [yes(qs[0]!), yes(qs[1]!)]).scores).toEqual([]);
    expect(computeProfile(survey, qs.map(yes)).scores[0]!.rawScore).toBe(3);
  });

  test("своё правило методики: 0 — считать при любом числе ответов, 0,5 — половины хватает", () => {
    const any = optionalScale({ minAnsweredShare: 0 });
    expect(computeProfile(any.survey, []).scores[0]!.rawScore).toBe(0);
    const half = optionalScale({ minAnsweredShare: 0.5 });
    expect(computeProfile(half.survey, [yes(half.qs[0]!), yes(half.qs[1]!)]).scores[0]!.rawScore).toBe(2);
  });

  test("скрытый условием пункт в знаменатель не идёт: все скрыты — честный ноль", () => {
    // так устроен ASSIST: не употреблял — уточнения закрыты, балл вещества 0
    const gate = yesNoQuestion(0);
    const followUps = [1, 2].map((i) => yesNoQuestion(i, { logic: [rule(gate, { operator: "gte", value: 1 })] }));
    const scale = makeScale({ code: "A", items: followUps.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })) });
    const survey = makeSurvey([gate, ...followUps], [scale]);
    const no = gate.options.find((o) => o.keyCode === "no")!.id;
    const profile = computeProfile(survey, [{ questionId: gate.id, optionIds: [no] }]);
    expect(profile.scores.map((s) => [s.scaleCode, s.rawScore])).toEqual([["A", 0]]);
  });

  test("поправка от невычисленной шкалы — тоже не вычислено, а не поправка нулём", () => {
    const { qs, survey } = optionalScale();
    const composite = makeScale({ code: "C", corrections: [{ sourceScaleCode: "S", coefficient: 1 }] });
    const withComposite = { ...survey, scales: [...survey.scales, composite] };
    expect(computeProfile(withComposite, []).scores).toEqual([]);
    expect(computeProfile(withComposite, qs.map(yes)).scores.map((s) => s.scaleCode)).toEqual(["S", "C"]);
  });

  test("невычисленная шкала достоверности — протокол не проверен", () => {
    const { survey } = optionalScale({ kind: "validity", validityThreshold: 1, validityDirection: "above" });
    expect(computeProfile(survey, []).reliable).toBe(false);
  });
});
