import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  isQuestionVisible,
  validateSurvey,
  type Answer,
  type SurveyFull,
} from "@quizzy/shared";
import { detectRisks } from "../../lib/risk";
import { CATALOG } from "../catalog";
import { ces } from "../ces";
import { WORKING_TRANSLATION } from "../common";
import { pcptsd5 } from "../pcptsd5";
import { sbqr } from "../sbqr";

/**
 * Золотые протоколы группы «травма и военный контекст»: PC-PTSD-5, CES, SBQ-R.
 *
 * Каждый пример взят из поля `example` досье docs/instruments/dossiers/trauma.json и
 * посчитан руками — расчёт стоит в комментарии рядом с ожиданием. У всех трёх методик
 * по одной шкале, поэтому «по примеру на подшкалу» здесь значит: пример досье плюс его
 * контрольные случаи — те, что ловят ловушку именно этого ключа.
 *
 * Файл отдельный от golden.test.ts, чтобы группы каталога собирались параллельно и не
 * правили один и тот же файл. По той же причине конвертер ниже — копия, а не импорт:
 * импорт из golden.test.ts зарегистрировал бы его тесты второй раз, а вынос в общий
 * модуль правил бы файл, который правят все группы. От оригинала копия отличается
 * двумя вещами, нужными именно здесь: переносит условную логику (без неё отсеивающий
 * вопрос PC-PTSD-5 не проверить) и подпись тревоги варианта (без неё не проверить,
 * что именно увидит дежурный по SBQ-R).
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
    logic: q.logic.map((rule, ri) => ({
      id: `q${qi + 1}l${ri}`,
      questionId: `q${qi + 1}`,
      sourceQuestionId: `q${rule.sourceIndex + 1}`,
      operator: rule.operator,
      value: rule.value,
      action: rule.action,
    })),
    options: (q.options ?? []).map((o, oi) => ({
      id: `q${qi + 1}o${oi}`,
      questionId: `q${qi + 1}`,
      text: typeof o.text === "string" ? o.text : (o.text.ru ?? ""),
      keyCode: o.keyCode ?? null,
      score: o.score ?? 0,
      position: oi,
      kind: o.kind ?? "option",
      riskFlag: o.riskFlag ?? false,
      riskLabel: o.riskLabel ? (typeof o.riskLabel === "string" ? o.riskLabel : (o.riskLabel.ru ?? null)) : null,
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
    validityMessage: null,
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
    corrections: [],
    norms: [],
    stenTable: [],
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

/**
 * Ответы по номеру варианта у каждого пункта (с нуля, в порядке бланка).
 * `null` — пункт не отвечен: так приходит скрытый логикой вопрос.
 */
function pick(survey: SurveyFull, picks: (number | null)[]): Answer[] {
  return picks.flatMap((oi, qi) => {
    if (oi === null) return [];
    const q = survey.questions[qi]!;
    return [{ questionId: q.id, optionIds: [q.options[oi]!.id] }];
  });
}

function only(survey: SurveyFull, answers: Answer[]) {
  const { scores } = computeProfile(survey, answers);
  expect(scores.length).toBe(1);
  return scores[0]!;
}

const GROUP = [
  ["pcptsd5", pcptsd5],
  ["ces", ces],
  ["sbqr", sbqr],
] as const;

describe("группа trauma: структура", () => {
  for (const [key, draft] of GROUP) {
    test(`${key}: схема и проверка структуры без ошибок`, () => {
      const parsed = createSurveySchema.parse(draft);
      const errors = validateSurvey(parsed).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: полосы покрывают весь диапазон суммы без дыр`, () => {
      /*
       * Дыра между полосами — балл без интерпретации и без тревоги: движок вернёт
       * band = null, и положительный скрининг тихо превратится в «ничего». Диапазон
       * считается от баллов самих вариантов, а не переписан из досье, чтобы ловить и
       * опечатку в балле варианта.
       */
      const parsed = createSurveySchema.parse(draft);
      for (const scale of parsed.scales ?? []) {
        let min = 0;
        let max = 0;
        for (const k of scale.key ?? []) {
          const scores = (parsed.questions[k.item - 1]!.options ?? []).map((o) => o.score ?? 0);
          min += Math.min(...scores);
          max += Math.max(...scores);
        }
        const bandsSorted = [...(scale.bands ?? [])].sort((a, b) => a.minScore - b.minScore);
        expect(bandsSorted[0]!.minScore).toBe(min);
        expect(bandsSorted.at(-1)!.maxScore).toBe(max);
        for (let i = 1; i < bandsSorted.length; i++) {
          expect(bandsSorted[i]!.minScore).toBe(bandsSorted[i - 1]!.maxScore + 1);
        }
      }
    });

    test(`${key}: в каталоге, рабочий перевод и чужая норма названы в описании`, () => {
      /*
       * Правила каталога: рабочий перевод назван (WORKING_TRANSLATION), страна
       * валидации порогов названа прямым текстом — там, где методику выбирают.
       */
      expect(CATALOG.find((e) => e.key === key)?.draft).toBe(draft);
      const description = draft.description as { uk: string; ru: string };
      expect(description.uk).toContain(WORKING_TRANSLATION.uk);
      expect(description.ru).toContain(WORKING_TRANSLATION.ru);
      expect(description.uk).toContain("США");
      expect(description.ru).toContain("США");
    });

    test(`${key}: результат человеку не показывается, план безопасности есть`, () => {
      expect(draft.showResultsToPatient).toBe(false);
      expect(draft.safetyPlan).toBeTruthy();
    });
  }
});

describe("золотой протокол: PC-PTSD-5", () => {
  const survey = toSurveyFull(pcptsd5);
  const NO = 0;
  const YES = 1;

  test("пример досье: gate «так», пункты 1–4 «так», 5 «ні» → 4, положительный скрининг", () => {
    // сумма — число «так» по пунктам 1–5, gate не считается: 1+1+1+1+0 = 4 ≥ 4
    const score = only(survey, pick(survey, [YES, YES, YES, YES, YES, NO]));
    expect(score.rawScore).toBe(4);
    expect(score.band?.grade).toBe(2);
    expect(score.band?.severity).toBe("moderate");
  });

  test("gate «ні»: пункты 1–5 скрыты, итог 0 («If no, screen total = 0»)", () => {
    const gateNo = pick(survey, [NO]);
    const byId = new Map(gateNo.map((a) => [a.questionId, a]));
    for (const q of survey.questions.slice(1)) {
      expect(isQuestionVisible(q, survey.questions, byId)).toBe(false);
    }
    const score = only(survey, gateNo);
    expect(score.rawScore).toBe(0);
    expect(score.band?.severity).toBe("none");
  });

  test("gate «так» открывает пункты 1–5", () => {
    const byId = new Map(pick(survey, [YES]).map((a) => [a.questionId, a]));
    for (const q of survey.questions.slice(1)) {
      expect(isQuestionVisible(q, survey.questions, byId)).toBe(true);
    }
  });

  test("gate не входит в сумму: «так» на событие и пять «ні» → 0, а не 1", () => {
    // ловушка ключа: gate в ключе дал бы 1 здесь и 5 вместо 4 в примере досье
    expect(only(survey, pick(survey, [YES, NO, NO, NO, NO, NO])).rawScore).toBe(0);
  });

  test("граница порога: 3 — отрицательный скрининг, 5 — положительный", () => {
    // 1+1+1+0+0 = 3 < 4
    const three = only(survey, pick(survey, [YES, YES, YES, YES, NO, NO]));
    expect(three.rawScore).toBe(3);
    expect(three.band?.severity).toBe("none");
    // 1+1+1+1+1 = 5 — потолок шкалы
    const five = only(survey, pick(survey, [YES, YES, YES, YES, YES, YES]));
    expect(five.rawScore).toBe(5);
    expect(five.band?.severity).toBe("moderate");
  });

  test("пунктов риска нет (досье: risk_items пуст)", () => {
    expect(survey.questions.flatMap((q) => q.options).some((o) => o.riskFlag)).toBe(false);
  });
});

describe("золотой протокол: CES", () => {
  const survey = toSurveyFull(ces);

  test("балл каждого варианта совпадает с формулой Scoring Sheet", () => {
    /*
     * Формулы переписаны с официального бланка независимо от файла методики: если
     * кто-то «выровняет» пункты 3 и 4 (два верхних варианта с одинаковым баллом), тест
     * упадёт здесь, а не у человека с чужой категорией опыта.
     */
    const convert: ((r: number) => number)[] = [
      (r) => (r - 1) * 2,
      (r) => r - 1,
      (r) => (r <= 4 ? (r - 1) * 2 : (r - 2) * 2),
      (r) => (r <= 4 ? r - 1 : r - 2),
      (r) => r - 1,
      (r) => (r - 1) * 2,
      (r) => (r - 1) * 2,
    ];
    expect(survey.questions.length).toBe(7);
    survey.questions.forEach((q, qi) => {
      // сырой ответ бланка 1..5 — это номер варианта, считая с единицы
      expect(q.options.map((o) => o.score)).toEqual([1, 2, 3, 4, 5].map(convert[qi]!));
    });
  });

  test("пример досье: все raw = 5 → 8+4+6+3+4+8+8 = 41, «heavy»", () => {
    const score = only(survey, pick(survey, [4, 4, 4, 4, 4, 4, 4]));
    expect(score.rawScore).toBe(41);
    expect(score.maxScore).toBe(41);
    expect(score.band?.grade).toBe(5);
  });

  test("все raw = 1 → 0, «light»", () => {
    const score = only(survey, pick(survey, [0, 0, 0, 0, 0, 0, 0]));
    expect(score.rawScore).toBe(0);
    expect(score.band?.grade).toBe(1);
  });

  test("raw [3,2,2,1,3,2,2] → [4,1,2,0,2,2,2] = 13, «light - moderate»", () => {
    const score = only(survey, pick(survey, [2, 1, 1, 0, 2, 1, 1]));
    expect(score.rawScore).toBe(13);
    expect(score.band?.grade).toBe(2);
  });

  test("шкала экспозиции не поднимает тревог: ни флагов, ни тяжести у полос", () => {
    /*
     * Тяжесть полосы клинической шкалы поднимает тревогу при сдаче (submission.ts).
     * «Тяжёлый боевой опыт» — биография, а не состояние, и звать по нему дежурного
     * нельзя; флагов риска в досье у CES тоже нет.
     */
    expect(survey.questions.flatMap((q) => q.options).some((o) => o.riskFlag)).toBe(false);
    expect(survey.scales[0]!.bands.every((b) => b.severity === "none")).toBe(true);
  });
});

describe("золотой протокол: SBQ-R", () => {
  const survey = toSurveyFull(sbqr);

  test("пример досье: п.1 «2», п.2 «3», п.3 «1», п.4 «2» → 2+3+1+2 = 8, выше обоих порогов", () => {
    const answers = pick(survey, [1, 2, 0, 2]);
    const score = only(survey, answers);
    expect(score.rawScore).toBe(8);
    expect(score.band?.grade).toBe(3);
    expect(score.band?.severity).toBe("severe");
    // тревога по пунктам: п.1 ≥ 2 (опубликованное правило), п.2 — мысли за год, п.4 — не исключает
    const risks = detectRisks(survey, answers);
    expect(risks.map((r) => r.questionId).sort()).toEqual(["q1", "q2", "q4"]);
  });

  test("минимум: «Ніколи», «Ніколи», «Ні», «Ніколи» → 1+1+1+0 = 3 (п.4 «Ніколи» = 0)", () => {
    // ловушка бланка: п.4 как 1..7 дал бы минимум 4 и сдвинул весь диапазон
    const answers = pick(survey, [0, 0, 0, 0]);
    const score = only(survey, answers);
    expect(score.rawScore).toBe(3);
    expect(score.band?.grade).toBe(1);
    expect(detectRisks(survey, answers)).toEqual([]);
  });

  test("максимум: 4b, «Дуже часто», 3b, «Дуже ймовірно» → 4+5+3+6 = 18", () => {
    const score = only(survey, pick(survey, [5, 4, 4, 6]));
    expect(score.rawScore).toBe(18);
    expect(score.maxScore).toBe(18);
    expect(score.band?.grade).toBe(3);
  });

  test("п.1 «коротка думка» при сумме ниже порога: 2+1+1+0 = 4, но тревога есть", () => {
    const answers = pick(survey, [1, 0, 0, 0]);
    const score = only(survey, answers);
    expect(score.rawScore).toBe(4);
    expect(score.band?.severity).toBe("none");
    const risks = detectRisks(survey, answers);
    expect(risks.length).toBe(1);
    expect(risks[0]!.questionId).toBe("q1");
    expect(risks[0]!.severity).toBe("moderate");
  });

  test("ровно 7: порог общей популяции достигнут, стационарный — нет", () => {
    // п.1 «коротка думка» 2 + 1 + 1 + п.4 «Малоймовірно» 3 = 7
    const answers = pick(survey, [1, 0, 0, 3]);
    const score = only(survey, answers);
    expect(score.rawScore).toBe(7);
    expect(score.band?.grade).toBe(2);
    expect(score.band?.severity).toBe("moderate");
    expect(detectRisks(survey, answers).every((r) => r.severity === "moderate")).toBe(true);
  });

  test("попытка в анамнезе — тяжёлая тревога при любой сумме", () => {
    // 4a: 4 + 1 + 1 + 0 = 6 — ниже обоих порогов, но это попытка самоубийства
    const answers = pick(survey, [4, 0, 0, 0]);
    expect(only(survey, answers).band?.grade).toBe(1);
    expect(detectRisks(survey, answers).map((r) => r.severity)).toEqual(["severe"]);
  });

  test("тревогу поднимает каждый вариант, кроме отрицающих", () => {
    /*
     * Досье: risk_items = [1, 2, 3, 4]. Отрицающие варианты — первый у пунктов 1–3
     * («Ніколи», «Ніколи», «Ні») и первые два у пункта 4 («Ніколи», «Жодного шансу»).
     */
    const denials = [1, 1, 1, 2];
    survey.questions.forEach((q, qi) => {
      const flags = q.options.map((o) => o.riskFlag);
      const expected = q.options.map((_, oi) => oi >= denials[qi]!);
      expect(flags).toEqual(expected);
    });
  });

  test("сумма 8+ недостижима без тяжёлого флага по пунктам", () => {
    // перебор всех 6·5·5·7 = 1050 комбинаций: полоса «severe» не может прийти одна
    const [a, b, c, d] = survey.questions.map((q) => q.options.length);
    for (let i = 0; i < a!; i++)
      for (let j = 0; j < b!; j++)
        for (let k = 0; k < c!; k++)
          for (let l = 0; l < d!; l++) {
            const answers = pick(survey, [i, j, k, l]);
            const score = only(survey, answers);
            if (score.rawScore < 8) continue;
            expect(detectRisks(survey, answers).some((r) => r.severity === "severe")).toBe(true);
          }
  });
});
