import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  evaluateSubmission,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { detectRisks } from "../../lib/risk";
import { ADEXI_INHIBITION, ADEXI_WORKING_MEMORY, adexi } from "../adexi";
import { WORKING_TRANSLATION } from "../common";
import { fourAt } from "../fourAt";

/**
 * Золотые протоколы группы «когнитивные функции, внимание, ЧМТ»
 * (docs/instruments/dossiers/cognitive.json): 4AT и ADEXI.
 *
 * У 4AT ожидаемые баллы — из клинических случаев, опубликованных самим
 * правообладателем (https://www.the4at.com/4atcases, CC BY 4.0): ответы по
 * пунктам и итог там напечатаны. У ADEXI опубликованного примера нет — ожидания
 * посчитаны руками по документу правообладателя «Subscales for ADEXI», расчёт в
 * комментарии у каждого случая. Если кто-то тронет балл варианта, ключ
 * подшкалы или способ агрегации, эти тесты упадут первыми.
 *
 * Отдельный файл, а не golden.test.ts: группы методик собираются параллельно в
 * разных ветках, и общий файл был бы местом конфликта при каждом слиянии.
 */

/*
 * Конвертер описания методики в SurveyFull без БД — копия toSurveyFull из
 * golden-behaviour.test.ts (импорт тестового файла заново зарегистрировал бы
 * чужие describe). Добавлен scoringEnabled: им пользуется evaluateSubmission,
 * через который проверяется, какая полоса поднимает тревогу.
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
    logic: (q.logic ?? []).map((r, ri) => ({
      id: `q${qi + 1}l${ri}`,
      questionId: `q${qi + 1}`,
      sourceQuestionId: `q${r.sourceIndex + 1}`,
      operator: r.operator,
      value: r.value ?? null,
      action: r.action,
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
    scoringEnabled: true,
  } as unknown as SurveyFull;
}

/** Ответ: номер пункта с единицы → позиция варианта с нуля */
type Picks = Record<number, number>;

const answersOf = (survey: SurveyFull, picks: Picks): Answer[] =>
  Object.entries(picks).map(([n, option]) => {
    const q = survey.questions[Number(n) - 1]!;
    return { questionId: q.id, optionIds: [q.options[option]!.id] };
  });

/** Ответы по порядку пунктов 1..n */
const inOrder = (options: number[]): Picks => Object.fromEntries(options.map((o, i) => [i + 1, o]));

/** Один и тот же вариант во всех пунктах 1..n */
const allAt = (n: number, option: number): Picks => inOrder(Array.from({ length: n }, () => option));

function scoreOf(survey: SurveyFull, picks: Picks, code: string) {
  const { scores } = computeProfile(survey, answersOf(survey, picks));
  const s = scores.find((x) => x.scaleCode === code);
  if (!s) throw new Error(`нет шкалы ${code}`);
  return s;
}

const GROUP = [
  ["4AT", fourAt],
  ["ADEXI", adexi],
] as const satisfies readonly (readonly [string, CreateSurveyDraft])[];

/** Поля, которые человек читает, — обязаны быть объектом с обоими языками */
const LOCALIZED_KEYS = new Set([
  "title",
  "description",
  "instructions",
  "help",
  "text",
  "label",
  "recommendation",
  "riskLabel",
]);

function monolingual(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => monolingual(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if ("uk" in o || "ru" in o) {
    const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;
    return filled(o.uk) && filled(o.ru) ? [] : [path];
  }
  return Object.entries(o).flatMap(([k, v]) =>
    LOCALIZED_KEYS.has(k) && typeof v === "string" ? [`${path}.${k}`] : monolingual(v, `${path}.${k}`),
  );
}

/** Все украинские строки описания — для проверки букв */
function ukrainianStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(ukrainianStrings);
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if (typeof o.uk === "string") return [o.uk];
  return Object.values(o).flatMap(ukrainianStrings);
}

const desc = (d: CreateSurveyDraft) => d.description as { uk: string; ru: string };

describe("группа cognitive: структура, язык, риск", () => {
  for (const [name, draft] of GROUP) {
    test(`${name}: принимается схемой и валидатором без ошибок`, () => {
      const parsed = createSurveySchema.safeParse(draft);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
      }
      const errors = validateSurvey(parsed.data).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${name}: всё, что читает человек, — на обоих языках`, () => {
      expect(monolingual(draft, name)).toEqual([]);
    });

    test(`${name}: в украинском тексте нет русских букв`, () => {
      const wrong = ukrainianStrings(draft).filter((s) => /[ыэъё]/i.test(s));
      expect(wrong).toEqual([]);
    });

    test(`${name}: пунктов риска нет — их нет и в досье`, () => {
      /*
       * risk_items досье у обеих методик пустые: о суициде, самоповреждении и
       * вреде другим пунктов нет. Лишний флаг — тревога без правила
       * первоисточника, а такие приучают не читать тревоги.
       */
      const flagged = (draft.questions ?? []).flatMap((q, qi) =>
        (q.options ?? []).flatMap((o, oi) => (o.riskFlag ? [`${qi + 1}/${oi}`] : [])),
      );
      expect(flagged).toEqual([]);
    });

    test(`${name}: результат человеку не показывается`, () => {
      // 4AT — инструмент специалиста у постели человека, возможно, в делирии; у ADEXI нет норм
      expect(draft.showResultsToPatient).toBe(false);
    });
  }

  test("рабочий перевод назван только у украинского текста", () => {
    /*
     * У обеих методик украинского текста у правообладателя нет — рабочий перевод
     * с оговоркой. Русский — перевод с сайта правообладателя: оговорка «рабочий
     * перевод» назвала бы его чужим текстом каталога, то есть соврала бы в
     * обратную сторону (как у CAGE).
     */
    for (const d of [fourAt, adexi]) {
      expect(desc(d).uk).toContain(WORKING_TRANSLATION.uk);
      expect(desc(d).ru).not.toContain(WORKING_TRANSLATION.ru);
    }
  });
});

/* ───────────────────────────── 4AT ───────────────────────────── */

describe("золотой протокол: 4AT", () => {
  const survey = toSurveyFull(fourAt);
  /*
   * Позиции вариантов:
   *   п. 1 — 0 норма, 1 сонливость < 10 с (0 баллов), 2 явно изменено (4);
   *   п. 2 — 0 без ошибок, 1 одна ошибка (1), 2 две и более / невозможно оценить (2);
   *   п. 3 — 0 семь месяцев и более, 1 меньше семи / отказ (1), 2 невозможно оценить (2);
   *   п. 4 — 0 нет, 1 да (4).
   */

  test("баллы вариантов — как на бланке v1.2", () => {
    const scores = (fourAt.questions ?? []).map((q) => (q.options ?? []).map((o) => o.score));
    expect(scores).toEqual([
      [0, 0, 4],
      [0, 1, 2],
      [0, 1, 2],
      [0, 4],
    ]);
    expect(fourAt.administration).toBe("clinician");
  });

  test("пример правообладателя, Case 2: 0 + 1 + 1 + 4 = 6 — возможный делирий", () => {
    // Mr AY: alertness 0, AMT4 1 (не назвал больницу), months backwards 1, acute change 4 → 6/12
    const s = scoreOf(survey, inOrder([0, 1, 1, 1]), "4AT");
    expect(s.rawScore).toBe(6);
    expect(s.maxScore).toBe(12);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
  });

  test("пример правообладателя, Case 3: 0 + 2 + 1 + 0 = 3 — когнитивное нарушение без делирия", () => {
    // Mr JB: AMT4 2 (не знал возраст, год, место), months backwards 1, изменений нет → 3/12
    const s = scoreOf(survey, inOrder([0, 2, 1, 0]), "4AT");
    expect(s.rawScore).toBe(3);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("mild");
  });

  test("пример правообладателя, Case 1: всё по максимуму — 12", () => {
    // Mrs SA: явно изменённое сознание 4, AMT4 и месяцы — «невозможно оценить» 2 + 2, изменение 4 → 12/12
    const s = scoreOf(survey, inOrder([2, 2, 2, 1]), "4AT");
    expect(s.rawScore).toBe(12);
    expect(s.band?.grade).toBe(3);
  });

  test("пример правообладателя, Case 5: только острое изменение — уже 4, возможный делирий", () => {
    // Mr IR: все когнитивные пункты 0, пункт 4 = 4 → 4/12 «based on the evidence of change alone»
    const s = scoreOf(survey, inOrder([0, 0, 0, 1]), "4AT");
    expect(s.rawScore).toBe(4);
    expect(s.band?.grade).toBe(3);
  });

  test("пункт 1: короткая сонливость после пробуждения — 0, как норма", () => {
    const s = scoreOf(survey, inOrder([1, 0, 0, 0]), "4AT");
    expect(s.rawScore).toBe(0);
    expect(s.band?.grade).toBe(1);
    expect(s.band?.severity).toBe("none");
  });

  test("«невозможно оценить» в пунктах 2 и 3 вместе дают 4 — человек, не способный отвечать, не теряется", () => {
    // руководство: «Untestable status on both of these items yields a score of 4, which suggests possible delirium»
    const s = scoreOf(survey, inOrder([0, 2, 2, 0]), "4AT");
    expect(s.rawScore).toBe(4);
    expect(s.band?.grade).toBe(3);
  });

  test("тревогу поднимает только полоса «возможный делирий», и умеренную", () => {
    /*
     * Тяжесть полос — решение системы (см. fourAt.ts): 1–3 — "mild", случай не
     * открывается; 4–12 — "moderate". Флагов у вариантов нет — тревога только
     * от полосы.
     */
    const risk = (picks: Picks) => evaluateSubmission(survey, answersOf(survey, picks)).risk.severity;
    expect(risk(inOrder([0, 0, 0, 0]))).toBeNull();
    expect(risk(inOrder([0, 2, 1, 0]))).toBeNull();
    expect(risk(inOrder([0, 1, 1, 1]))).toBe("moderate");
    expect(risk(inOrder([2, 2, 2, 1]))).toBe("moderate");
    expect(detectRisks(survey, answersOf(survey, inOrder([2, 2, 2, 1])))).toEqual([]);
  });

  test("атрибуция CC BY 4.0 — на обоих языках, с перечнем изменений", () => {
    for (const text of [desc(fourAt).uk, desc(fourAt).ru]) {
      expect(text).toContain("Adapted from the 4AT © 2011–2014 Alasdair MacLullich, Tracy Ryan and Helen Cash.");
      expect(text).toContain("Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/.");
      expect(text).toContain("This version has been modified. Changes:");
      expect(text).toContain("The published validation evidence for the official 4AT should not be assumed to apply");
    }
  });
});

/* ───────────────────────────── ADEXI ───────────────────────────── */

describe("золотой протокол: ADEXI", () => {
  const survey = toSurveyFull(adexi);
  // позиции вариантов: 0 «Совершенно неверно» (1) … 4 «Совершенно верно» (5)

  test("подшкалы — ровно по документу правообладателя, без пересечений", () => {
    /*
     * Списки заданы здесь независимо от сборки методики («Subscales for ADEXI»):
     * пункт, попавший не в ту подшкалу, сдвинет обе, и итог этого не покажет.
     */
    const keyOf = (code: string) =>
      (adexi.scales ?? []).find((s) => s.code === code)!.key!.map((k) => k.item).sort((a, b) => a - b);
    expect(keyOf("WM")).toEqual([1, 2, 5, 7, 8, 9, 11, 12, 13]);
    expect(keyOf("INH")).toEqual([3, 4, 6, 10, 14]);
    expect(keyOf("ADEXI")).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(ADEXI_WORKING_MEMORY.filter((n) => ADEXI_INHIBITION.includes(n))).toEqual([]);
    expect(adexi.questions!.length).toBe(14);
  });

  test("у шкал нет полос, и каждая объясняет почему", () => {
    // норм нет у самого разработчика; шкала без полос и без объяснения неотличима от забытой таблицы
    for (const s of adexi.scales ?? []) {
      expect(s.bands ?? [], s.code).toEqual([]);
      expect((s.description as { uk: string }).uk, s.code).toContain("Норм і порогів немає");
      expect(s.aggregation, s.code).toBe("average");
    }
  });

  test("пример досье: рабочая память «Верно», торможение «Неверно» — 4, 2 и 46/14", () => {
    // WM: 9 × 4 / 9 = 4; INH: 5 × 2 / 5 = 2; общий: (36 + 10) / 14 = 3,2857… → 3,286
    const picks: Picks = {};
    for (const n of [1, 2, 5, 7, 8, 9, 11, 12, 13]) picks[n] = 3;
    for (const n of [3, 4, 6, 10, 14]) picks[n] = 1;
    expect(scoreOf(survey, picks, "WM").rawScore).toBe(4);
    expect(scoreOf(survey, picks, "INH").rawScore).toBe(2);
    expect(scoreOf(survey, picks, "ADEXI").rawScore).toBe(3.286);
  });

  test("пример досье: все «Отчасти верно» — 3 на всех шкалах; баллы вариантов 1–5, а не 0–4", () => {
    for (const code of ["ADEXI", "WM", "INH"]) expect(scoreOf(survey, allAt(14, 2), code).rawScore).toBe(3);
    expect(scoreOf(survey, allAt(14, 0), "ADEXI").rawScore).toBe(1);
    const top = scoreOf(survey, allAt(14, 4), "ADEXI");
    expect(top.rawScore).toBe(5);
    expect(top.maxScore).toBe(5);
  });

  test("подшкалы не смешиваются: трудности только с торможением не трогают рабочую память", () => {
    // INH «Совершенно верно» (5), WM «Совершенно неверно» (1): INH 5, WM 1, общий (9 + 25) / 14 = 2,4286 → 2,429
    const picks: Picks = {};
    for (const n of [1, 2, 5, 7, 8, 9, 11, 12, 13]) picks[n] = 0;
    for (const n of [3, 4, 6, 10, 14]) picks[n] = 4;
    expect(scoreOf(survey, picks, "INH").rawScore).toBe(5);
    expect(scoreOf(survey, picks, "WM").rawScore).toBe(1);
    expect(scoreOf(survey, picks, "ADEXI").rawScore).toBe(2.429);
  });

  test("тревоги нет ни при каких ответах", () => {
    expect(evaluateSubmission(survey, answersOf(survey, allAt(14, 4))).risk.severity).toBeNull();
  });
});
