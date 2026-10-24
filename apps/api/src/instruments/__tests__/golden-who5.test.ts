import { describe, expect, test } from "bun:test";
import { createSurveySchema, evaluateSubmission, type Answer, type SurveyFull } from "@quizzy/shared";
import { who5 } from "../who5";

/**
 * Золотой протокол WHO-5 (волна 12, клиническое ревью).
 *
 * Пороги источника (WHO, 1998; Topp et al., 2015): сырой балл ниже 13 —
 * плохое благополучие, показание к скринингу депрессии; 7 и ниже — вероятная
 * депрессия. До правки 13 из 25 (52 %) попадало в «Знижене благополуччя» —
 * умеренную полосу с тревогой и случаем в очереди дежурного.
 *
 * Свой маленький конвертер, как у соседних золотых файлов (там он не
 * экспортирован): у WHO-5 пять пунктов одного вида и одна шкала-сумма.
 */
function toSurveyFull(): SurveyFull {
  const input = createSurveySchema.parse(who5);
  const ru = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string }).ru ?? ""));
  const questions = input.questions.map((q, qi) => ({
    id: `q${qi + 1}`,
    type: q.type,
    title: ru(q.title),
    required: q.required,
    reverseScored: q.reverseScored,
    minValue: null,
    maxValue: null,
    riskThreshold: null,
    riskLabel: null,
    riskSeverity: null,
    logic: [],
    options: q.options.map((o, oi) => ({
      id: `q${qi + 1}o${oi}`,
      text: ru(o.text),
      keyCode: o.keyCode ?? null,
      score: o.score,
      kind: o.kind,
      riskFlag: o.riskFlag,
      riskLabel: null,
      riskSeverity: o.riskSeverity ?? null,
    })),
  }));
  const scales = input.scales.map((s, si) => ({
    id: `sc${si}`,
    code: s.code,
    title: ru(s.title),
    aggregation: s.aggregation,
    kind: s.kind,
    normalization: s.normalization,
    ratioDenominator: null,
    validityThreshold: null,
    validityDirection: null,
    validityMessage: null,
    bands: s.bands.map((b, bi) => ({
      id: `b${bi}`,
      minScore: b.minScore,
      maxScore: b.maxScore,
      // подпись — украинская: с ней и сверяется эталон ниже
      label: typeof b.label === "string" ? b.label : (b.label.uk ?? ""),
      severity: b.severity,
      description: null,
      grade: b.grade ?? null,
      recommendation: null,
    })),
    items: s.key.map((k) => ({ questionId: `q${k.item}`, matchKey: k.matchKey ?? null, weight: k.weight })),
    corrections: [],
    norms: [],
    stenTable: [],
  }));
  return { id: "who5", scoringEnabled: true, questions, scales, sections: [] } as unknown as SurveyFull;
}

const survey = toSurveyFull();

/** Сырой балл 0–25 раскладывается по пяти пунктам 0–5 */
function answersFor(total: number): Answer[] {
  let left = total;
  return survey.questions.map((q) => {
    const want = Math.min(5, left);
    left -= want;
    const option = q.options.find((o) => o.score === want)!;
    return { questionId: q.id, optionIds: [option.id] };
  });
}

describe("бланк WHO-5: порядок вариантов и официальный русский текст", () => {
  test("варианты идут как на бланке ВОЗ — от 5 к 0, баллы в вариантах", () => {
    for (const q of who5.questions ?? []) expect((q.options ?? []).map((o) => o.score)).toEqual([5, 4, 3, 2, 1, 0]);
    expect((who5.questions ?? [])[0]!.options!.map((o) => (o.text as { ru: string }).ru)).toEqual([
      "Все время",
      "Большую часть времени",
      "Более половины времени",
      "Менее половины времени",
      "Некоторое время",
      "Никогда",
    ]);
  });

  test("русские пункты — дословно с бланка 1999 г., украинские — рабочий перевод с оговоркой ВОЗ", () => {
    // бланк ВОЗ (who-5_russian.pdf): «Я чувствую себя бодрой(-ым) и в хорошем настроении»
    expect(((who5.questions ?? [])[0]!.title as { ru: string }).ru).toBe("Я чувствую себя бодрой(-ым) и в хорошем настроении");
    expect(((who5.questions ?? [])[4]!.title as { ru: string }).ru).toBe(
      "Каждый день со мной происходят вещи, представляющие для меня интерес",
    );
    const d = who5.description as { uk: string; ru: string };
    // лицензия ВОЗ требует оговорку к собственному переводу
    expect(d.uk).toContain("створений не ВООЗ");
    expect(d.ru).toContain("вариант 1999 г.");
  });
});

describe("золотой протокол: WHO-5", () => {
  const cases: [number, string, "none" | "moderate" | "severe", "moderate" | "severe" | null][] = [
    [0, "Дуже низьке благополуччя", "severe", "severe"],
    [7, "Дуже низьке благополуччя", "severe", "severe"],
    [8, "Знижене благополуччя", "moderate", "moderate"],
    [12, "Знижене благополуччя", "moderate", "moderate"],
    // 13 из 25 = 52 %: по руководству благополучие не снижено — ни полосы риска, ни тревоги
    [13, "Без ознак зниженого благополуччя", "none", null],
    [25, "Без ознак зниженого благополуччя", "none", null],
  ];
  for (const [raw, label, severity, risk] of cases) {
    test(`${raw} из 25 — ${severity}`, () => {
      const { profile, risk: assessed } = evaluateSubmission(survey, answersFor(raw));
      const score = profile.scores[0]!;
      expect(score.rawScore).toBe(raw);
      expect(score.band?.severity).toBe(severity);
      expect(score.band?.label).toBe(label);
      expect(assessed.severity).toBe(risk);
    });
  }
});
