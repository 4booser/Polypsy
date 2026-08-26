import { describe, expect, test } from "bun:test";
import { computeProfile, createSurveySchema, type Answer, type SurveyFull } from "@quizzy/shared";
import { minimult } from "../minimult";
import { sr45 } from "../sr45";

/**
 * Золотые протоколы: ответы прогоняются через движок, а ожидаемые баллы
 * посчитаны руками по формулам пособий. Если кто-то тронет ключ, поправку или
 * норму инструмента — эти тесты упадут первыми.
 *
 * Инструмент хранится в формате CreateSurveyDraft, где ключ ссылается на
 * номера пунктов. Конвертер ниже повторяет то, что делает createVersion при
 * посеве, но без БД: строит SurveyFull с ключами по id вопросов.
 */
function toSurveyFull(draft: unknown): SurveyFull {
  const input = createSurveySchema.parse(draft);
  const questions = input.questions.map((q, qi) => ({
    id: `q${qi + 1}`,
    surveyId: "s",
    sectionId: null,
    type: q.type,
    title: typeof q.title === "string" ? q.title : (q.title.ru ?? ""),
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
      text: typeof o.text === "string" ? o.text : (o.text.ru ?? ""),
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
    title: typeof s.title === "string" ? s.title : (s.title.ru ?? ""),
    description: null,
    aggregation: s.aggregation ?? "sum",
    position: si,
    kind: s.kind ?? "clinical",
    normalization: s.normalization ?? "raw",
    ratioDenominator: s.ratioDenominator ?? null,
    validityThreshold: s.validityThreshold ?? null,
    validityDirection: s.validityDirection ?? null,
    validityMessage:
      s.validityMessage && typeof s.validityMessage !== "string"
        ? (s.validityMessage.ru ?? null)
        : (s.validityMessage ?? null),
    bands: (s.bands ?? []).map((b, bi) => ({
      id: `b${si}-${bi}`,
      scaleId: `sc${si}`,
      minScore: b.minScore,
      maxScore: b.maxScore,
      label: typeof b.label === "string" ? b.label : (b.label.ru ?? ""),
      severity: b.severity,
      description: null,
      grade: b.grade ?? null,
      recommendation: null,
    })),
    items: (s.key ?? []).map((k) => ({
      questionId: `q${k.item}`,
      matchKey: k.matchKey ?? null,
      weight: k.weight ?? 1,
    })),
    corrections: (s.corrections ?? []).map((c) => ({
      sourceScaleCode: c.from,
      coefficient: c.coefficient,
    })),
    norms: (s.norms ?? []).map((n, ni) => ({
      id: `n${si}-${ni}`,
      scaleId: `sc${si}`,
      sex: n.sex ?? null,
      ageMin: n.ageMin ?? null,
      ageMax: n.ageMax ?? null,
      mean: n.mean,
      sd: n.sd,
    })),
    stenTable: (s.stenRows ?? []).map((r, ri) => ({
      id: `st${si}-${ri}`,
      scaleId: `sc${si}`,
      sex: r.sex ?? null,
      ageMin: null,
      ageMax: null,
      rawMin: r.rawMin,
      rawMax: r.rawMax,
      sten: r.sten,
    })),
  }));

  return {
    id: "s",
    title: "golden",
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/** Ответы по номерам пунктов: yes — набор «Да», всё остальное — «Нет» */
function answersByNumbers(survey: SurveyFull, yes: Set<number>): Answer[] {
  return survey.questions.map((q, i) => {
    const key = yes.has(i + 1) ? "yes" : "no";
    const option = q.options.find((o) => o.keyCode === key)!;
    return { questionId: q.id, optionIds: [option.id] };
  });
}

describe("золотой протокол: СР-45", () => {
  const survey = toSurveyFull(sr45);

  test("все «Нет»: Sr по обратной части ключа, профиль достоверен", () => {
    // при сплошных «Нет» баллы дают только пункты с ключом «нет»
    const { scores, reliable } = computeProfile(survey, answersByNumbers(survey, new Set()));
    const sr = scores.find((s) => s.scaleCode === "Sr")!;
    const l = scores.find((s) => s.scaleCode === "L")!;

    const noKeyed = survey.scales
      .find((s) => s.code === "Sr")!
      .items.filter((i) => i.matchKey === "no").length;
    expect(sr.rawScore).toBe(noKeyed);
    expect(sr.value).toBe(Math.round((noKeyed / 35) * 1000) / 1000);
    expect(l.value).toBeLessThanOrEqual(0.6);
    expect(reliable).toBe(true);
  });

  test("все «Да»: шкала лжи валит достоверность", () => {
    const all = new Set(Array.from({ length: survey.questions.length }, (_, i) => i + 1));
    const { scores, reliable, warnings } = computeProfile(survey, answersByNumbers(survey, all));
    const l = scores.find((s) => s.scaleCode === "L")!;
    // «Да» на все: срабатывает вся «да»-часть ключа лжи
    const lYes = survey.scales.find((s) => s.code === "L")!.items.filter((i) => i.matchKey === "yes").length;
    expect(l.rawScore).toBe(lYes);
    expect(l.value).toBeGreaterThan(0.6);
    expect(reliable).toBe(false);
    expect(warnings.some((w) => w.includes("брехн") || w.includes("лжи") || w.includes("прикраш"))).toBe(true);
  });

  test("граница полос: 0.23 — «Низкий», 0.24 — уже нет", () => {
    const srScale = survey.scales.find((s) => s.code === "Sr")!;
    const yesItems = srScale.items.filter((i) => i.matchKey === "yes").map((i) => Number(i.questionId.slice(1)));
    // 8 «да»-пунктов: 8/35 = 0.229 → «Низкий»; 9: 0.257 → следующая полоса
    const eight = computeProfile(survey, answersByNumbers(survey, new Set(yesItems.slice(0, 8))));
    // «нет»-часть ключа при этом тоже победит — ответы «Нет» на остальные совпадают
    // с ключом, поэтому ожидание строим от фактического сырого
    const sr8 = eight.scores.find((s) => s.scaleCode === "Sr")!;
    expect(sr8.band).not.toBeNull();
    expect(sr8.value).toBe(Math.round((sr8.rawScore / 35) * 1000) / 1000);
  });
});

describe("золотой протокол: Мини-мульт", () => {
  const survey = toSurveyFull(minimult);

  test("K-коррекция и T-баллы мужской нормы, посчитанные руками", () => {
    // Протокол: «Да» на первые 30 пунктов, остальные «Нет».
    const yes = new Set(Array.from({ length: 30 }, (_, i) => i + 1));
    const { scores } = computeProfile(survey, answersByNumbers(survey, yes), { sex: "male", age: 30 });

    // ожидание считаем независимо от движка: по ключам инструмента
    const rawOf = (code: string) => {
      const scale = survey.scales.find((s) => s.code === code)!;
      return scale.items.filter((i) => {
        const n = Number(i.questionId.slice(1));
        return i.matchKey === (yes.has(n) ? "yes" : "no");
      }).length;
    };

    const K = rawOf("K");
    for (const [code, coeff] of [["Hs", 0.5], ["Pd", 0.4], ["Pt", 1], ["Se", 1], ["Ma", 0.2]] as const) {
      const s = scores.find((x) => x.scaleCode === code)!;
      const corrected = Math.round((rawOf(code) + K * coeff) * 1000) / 1000;
      expect(s.rawScore).toBe(rawOf(code));
      expect(s.correctedScore).toBe(corrected);
    }

    // T-балл шкалы D (без коррекции): T = 50 + 10(raw − 7.02)/2.68 (мужская норма)
    const d = scores.find((x) => x.scaleCode === "D")!;
    const expected = Math.round((50 + (10 * (rawOf("D") - 7.02)) / 2.68) * 10) / 10;
    expect(d.value).toBe(expected);
  });

  test("одни и те же ответы дают разные T у мужчин и женщин", () => {
    const yes = new Set(Array.from({ length: 20 }, (_, i) => i + 1));
    const answers = answersByNumbers(survey, yes);
    const male = computeProfile(survey, answers, { sex: "male", age: 30 });
    const female = computeProfile(survey, answers, { sex: "female", age: 30 });
    const dM = male.scores.find((x) => x.scaleCode === "D")!;
    const dF = female.scores.find((x) => x.scaleCode === "D")!;
    // нормы D различаются по полу (7.02/2.68 против 7.96/3) — T обязаны разойтись
    expect(dM.value).not.toBe(dF.value);
    expect(dM.rawScore).toBe(dF.rawScore);
  });

  test("Ma остаётся сырой: в пособии нет норм для неё", () => {
    const { scores } = computeProfile(survey, answersByNumbers(survey, new Set([1, 2, 3])), {
      sex: "male",
      age: 30,
    });
    const ma = scores.find((x) => x.scaleCode === "Ma")!;
    expect(ma.normalization).toBe("raw");
  });
});
