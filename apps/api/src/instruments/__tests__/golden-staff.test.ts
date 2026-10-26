import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  detectBandRisks,
  isQuestionVisible,
  validateSurvey,
  type Answer,
  type SurveyFull,
} from "@quizzy/shared";
import { BAT12_FROM_BAT23, BAT_ITEMS, bat, bat12, bat12Note, batNote } from "../bat";
import { CATALOG } from "../catalog";
import { WORKING_TRANSLATION } from "../common";
import { MIOS_NOT_SCORED, mios, miosNote, miosPosition } from "../mios";
import { PROQOL_REVERSED, proqol5, proqol5Note } from "../proqol5";

/**
 * Золотые протоколы группы «персонал» (docs/instruments/dossiers/staff.json):
 * BAT-23, BAT-12, ProQOL 5, MIOS.
 *
 * Ожидаемые баллы посчитаны руками — расчёт в комментарии у каждого случая — и
 * сверены с проверочными примерами досье; у BAT-23 — с опубликованным примером
 * руководства правообладателя (User Manual v2.0, респонденты X, Y, Z). Если кто-то
 * тронет ключ, балл варианта, обратный пункт, порог или условие показа, эти тесты
 * упадут первыми.
 *
 * Отдельный файл, а не golden.test.ts: группы методик собираются параллельно в
 * разных ветках, и общий файл был бы местом конфликта при каждом слиянии.
 */

/*
 * Конвертер описания методики в SurveyFull без БД — копия toSurveyFull из
 * golden-behaviour.test.ts (с условиями показа). Копия, а не импорт: импорт из
 * тестового файла заново регистрирует все его describe в этом файле.
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
    minAnsweredShare: s.minAnsweredShare ?? null,
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

/** Ответ: номер пункта с единицы → позиция варианта с нуля (или несколько — у множественного выбора) */
type Picks = Record<number, number | number[]>;

const answersOf = (survey: SurveyFull, picks: Picks): Answer[] =>
  Object.entries(picks).map(([n, option]) => {
    const q = survey.questions[Number(n) - 1]!;
    const positions = Array.isArray(option) ? option : [option];
    return { questionId: q.id, optionIds: positions.map((p) => q.options[p]!.id) };
  });

/** Все пункты 1..n одним вариантом */
const allAt = (n: number, option: number): Picks => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, option]));

function profileOf(survey: SurveyFull, picks: Picks) {
  return computeProfile(survey, answersOf(survey, picks));
}

function scoreOf(survey: SurveyFull, picks: Picks, code: string) {
  const s = profileOf(survey, picks).scores.find((x) => x.scaleCode === code);
  if (!s) throw new Error(`нет шкалы ${code}`);
  return s;
}

const GROUP = [
  ["BAT-23", bat],
  ["BAT-12", bat12],
  ["ProQOL 5", proqol5],
  ["MIOS", mios],
] as const;

/** Поля, которые человек читает, — обязаны быть объектом с обоими языками */
const LOCALIZED_KEYS = new Set(["title", "description", "instructions", "help", "text", "label", "recommendation", "riskLabel", "safetyPlan"]);

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

/** Все строки одного языка, с путём — для проверки букв */
function texts(value: unknown, lang: "uk" | "ru", path: string): [string, string][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => texts(v, lang, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if (typeof o.uk === "string" && typeof o.ru === "string") return [[path, o[lang] as string]];
  return Object.entries(o).flatMap(([k, v]) => texts(v, lang, `${path}.${k}`));
}

describe("группа staff: структура, язык, риск", () => {
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

    test(`${name}: в украинском нет русских букв, в русском — украинских`, () => {
      /*
       * Правило брифа каталога: «Ukrainian texts must not contain Russian letters (ы
       * э ъ ё)». Обратная проверка ловит недопереведённую русскую строку, в которую
       * попал украинский текст (і, ї, є, ґ).
       */
      const ukBad = texts(draft, "uk", name).filter(([, s]) => /[ыэъёЫЭЪЁ]/.test(s));
      const ruBad = texts(draft, "ru", name).filter(([, s]) => /[іїєґІЇЄҐ]/.test(s));
      expect(ukBad).toEqual([]);
      expect(ruBad).toEqual([]);
    });

    test(`${name}: стоит в каталоге этим же объектом`, () => {
      const key = { "BAT-23": "bat", "BAT-12": "bat12", "ProQOL 5": "proqol5", MIOS: "mios" }[name];
      expect(CATALOG.find((e) => e.key === key)?.draft, `«${key}» нет в каталоге`).toBe(draft);
    });
  }

  test("рабочий перевод назван там, где он есть, и только там", () => {
    /*
     * BAT — официальные украинский и русский тексты правообладателя: без оговорки.
     * ProQOL 5 и MIOS — рабочий перевод на обоих языках.
     */
    // в примечании для персонала («Джерело» паспорта); описание читает обследуемый — там этого нет
    for (const note of [batNote, bat12Note]) {
      expect(note).not.toContain(WORKING_TRANSLATION.uk);
      expect(note).toContain("офіційні переклади правовласника");
    }
    for (const note of [proqol5Note, miosNote]) expect(note).toContain(WORKING_TRANSLATION.uk);
    for (const d of [bat, bat12, proqol5, mios]) {
      expect((d.description as { uk: string }).uk).not.toContain(WORKING_TRANSLATION.uk);
    }
  });

  test("пунктов риска нет ни у одной: risk_items досье пусты", () => {
    // Лишний флаг тоже ошибка: тревога без правила первоисточника приучает не читать тревоги.
    for (const [name, draft] of GROUP) {
      const flagged = (draft.questions ?? []).flatMap((q, qi) =>
        (q.options ?? []).flatMap((o, oi) => (o.riskFlag ? [`${name} ${qi + 1}/${oi}`] : [])),
      );
      expect(flagged).toEqual([]);
    }
  });

  test("результат человеку: BAT и ProQOL — да (форма самооценки), MIOS — нет, и у неё план безопасности", () => {
    expect(bat.showResultsToPatient).toBe(true);
    expect(bat12.showResultsToPatient).toBe(true);
    expect(proqol5.showResultsToPatient).toBe(true);
    expect(mios.showResultsToPatient).toBe(false);
    expect((mios.safetyPlan as { uk: string }).uk.length).toBeGreaterThan(0);
  });

  test("ссылка, которой требуют правообладатели, — у специалиста, а у ProQOL — и у отвечающего", () => {
    // BAT: «the following publication should be cited»; ProQOL: «credit The Center for Victims of Torture and provide a link to www.ProQOL.org»
    for (const note of [batNote, bat12Note]) expect(note).toContain("17, 9495");
    expect(proqol5Note).toContain("www.ProQOL.org");
    expect(proqol5Note).toContain("Center for Victims of Torture");
    expect(miosNote).toContain("Frontiers in Psychiatry");
    // ProQOL копируют «as long as the author is credited»: строка правообладателя внизу инструкции, как на форме
    const ins = proqol5.instructions as { uk: string; ru: string };
    for (const text of [ins.uk, ins.ru]) {
      expect(text).toContain("© B. Hudnall Stamm, 2009");
      expect(text).toContain("Center for Victims of Torture, www.ProQOL.org");
    }
  });
});

/*
 * BAT-23: позиции вариантов 0 «Ніколи» (1) … 4 «Завжди» (5). Основные симптомы —
 * пункты 1–23, вторичные — 24–33.
 */
const B = { never: 0, rarely: 1, sometimes: 2, often: 3, always: 4 };

/** Набор BAT-23: основные пункты по номерам, вторичные — «Ніколи» */
function batPicks(core: Record<number, number>): Picks {
  const picks: Picks = {};
  for (let n = 1; n <= 33; n++) picks[n] = core[n] ?? B.never;
  return picks;
}

/** Диапазон пунктов одним вариантом */
const range = (from: number, to: number, option: number) =>
  Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [from + i, option]));

describe("золотой протокол: BAT-23", () => {
  const survey = toSurveyFull(bat);

  test("шкалы получают свои пункты: 23 основных в общем балле, вторичные — отдельно", () => {
    const sizes = Object.fromEntries((bat.scales ?? []).map((s) => [s.code, s.key?.map((k) => k.item)]));
    expect(sizes.BAT).toEqual(range23());
    expect(sizes.EX).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sizes.MD).toEqual([9, 10, 11, 12, 13]);
    expect(sizes.CI).toEqual([14, 15, 16, 17, 18]);
    expect(sizes.EI).toEqual([19, 20, 21, 22, 23]);
    expect(sizes.SS).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 32, 33]);
    expect(bat.questions!.length).toBe(33);
    // общий балл — первой шкалой: по ней сверяются полосы досье
    expect(bat.scales![0]!.code).toBe("BAT");
  });

  /*
   * Опубликованный пример руководства (User Manual v2.0, §2.1–2.2.2): респонденты
   * X, Y, Z — суммы основных пунктов 55, 60, 75 (средние 2.39, 2.61, 3.26 — Green,
   * Orange, Red), суммы истощения 20, 25, 28 (2.50, 3.13, 3.50 — Green, Orange,
   * Red). Бланковых ответов в руководстве нет — наборы собраны под эти суммы.
   * Руководство округляет до сотых, движок — до тысячных.
   */
  test("респондент X руководства: 55 → 2,391 зелёная; истощение 20 → 2,5 зелёная", () => {
    // 1–4 «Іноді» 3×4 + 5–8 «Рідко» 2×4 = 20; 9–13 «Іноді» 3×5 = 15; 14–23 «Рідко» 2×10 = 20; всего 55
    const picks = batPicks({ ...range(1, 4, B.sometimes), ...range(5, 8, B.rarely), ...range(9, 13, B.sometimes), ...range(14, 23, B.rarely) });
    const total = scoreOf(survey, picks, "BAT");
    expect(total.rawScore).toBe(2.391);
    expect(total.band?.grade).toBe(1);
    const ex = scoreOf(survey, picks, "EX");
    expect(ex.rawScore).toBe(2.5);
    expect(ex.band?.grade).toBe(1);
  });

  test("респондент Y руководства: 60 → 2,609 оранжевая; истощение 25 → 3,125 оранжевая", () => {
    // 1–7 «Іноді» 3×7 + 8 «Часто» 4 = 25; 9–13 «Іноді» 15; 14–23 «Рідко» 20; всего 60
    const picks = batPicks({ ...range(1, 7, B.sometimes), 8: B.often, ...range(9, 13, B.sometimes), ...range(14, 23, B.rarely) });
    const total = scoreOf(survey, picks, "BAT");
    expect(total.rawScore).toBe(2.609);
    expect(total.band?.grade).toBe(2);
    expect(total.band?.severity).toBe("mild");
    const ex = scoreOf(survey, picks, "EX");
    expect(ex.rawScore).toBe(3.125);
    expect(ex.band?.grade).toBe(2);
  });

  test("респондент Z руководства: 75 → 3,261 красная (случай); истощение 28 → 3,5 красная", () => {
    // 1–4 «Часто» 4×4 + 5–8 «Іноді» 3×4 = 28; 9–10 «Часто» 8; 11–23 «Іноді» 3×13 = 39; всего 75
    const picks = batPicks({ ...range(1, 4, B.often), ...range(5, 8, B.sometimes), ...range(9, 10, B.often), ...range(11, 23, B.sometimes) });
    const total = scoreOf(survey, picks, "BAT");
    expect(total.rawScore).toBe(3.261);
    expect(total.band?.grade).toBe(3);
    // красная зона общего балла открывает случай
    expect(total.band?.severity).toBe("moderate");
    const ex = scoreOf(survey, picks, "EX");
    expect(ex.rawScore).toBe(3.5);
    expect(ex.band?.grade).toBe(3);
  });

  test("пример досье: все «Іноді» — одно среднее 3,0 и три разные зоны", () => {
    /*
     * Общий 3,0 → оранжевая (2,59–3,01); истощение 3,0 → зелёная (до 3,05);
     * дистанцирование и когнитивные 3,0 → оранжевая (2,50–3,09 и 2,70–3,09);
     * эмоциональные 3,0 → красная (от 2,90); вторичные 3,0 → оранжевая (2,85–3,34).
     */
    const picks = allAt(33, B.sometimes);
    const grade = Object.fromEntries(profileOf(survey, picks).scores.map((s) => [s.scaleCode, s.band?.grade]));
    const raw = Object.fromEntries(profileOf(survey, picks).scores.map((s) => [s.scaleCode, s.rawScore]));
    expect(raw).toEqual({ BAT: 3, EX: 3, MD: 3, CI: 3, EI: 3, SS: 3 });
    expect(grade).toEqual({ BAT: 2, EX: 1, MD: 2, CI: 2, EI: 3, SS: 2 });
  });

  test("красная подшкала случая не открывает, красный общий балл — открывает", () => {
    // все «Іноді»: эмоциональные нарушения 3,0 — красная, но mild; общий 3,0 — оранжевая
    const sometimes = profileOf(survey, allAt(33, B.sometimes));
    expect(sometimes.scores.find((s) => s.scaleCode === "EI")!.band?.severity).toBe("mild");
    expect(detectBandRisks(sometimes.scores)).toEqual([]);
    // все «Часто»: общий 4,0 — красная, moderate; случай один — по общему баллу
    const often = profileOf(survey, allAt(33, B.often));
    expect(detectBandRisks(often.scores).map((r) => r.severity)).toEqual(["moderate"]);
  });

  test("границы общего балла: 59/23 — зелёная, 60/23 — оранжевая, 69/23 — оранжевая, 70/23 — красная", () => {
    // n пунктов «Іноді» (3), остальные «Рідко» (2): сумма 46 + n
    const total = (n: number) => scoreOf(survey, batPicks({ ...range(1, 23, B.rarely), ...range(1, n, B.sometimes) }), "BAT");
    expect(total(13).rawScore).toBe(2.565); // 59/23
    expect(total(13).band?.grade).toBe(1);
    expect(total(14).rawScore).toBe(2.609); // 60/23
    expect(total(14).band?.grade).toBe(2);
    expect(total(23).rawScore).toBe(3); // 69/23
    expect(total(23).band?.grade).toBe(2);
    // 70/23: все «Іноді» и один «Часто»
    const red = scoreOf(survey, batPicks({ ...range(1, 23, B.sometimes), 1: B.often }), "BAT");
    expect(red.rawScore).toBe(3.043);
    expect(red.band?.grade).toBe(3);
  });

  test("вторичные симптомы в общий балл не входят", () => {
    // основные все «Ніколи», вторичные все «Завжди»: общий 1,0, вторичные 5,0
    const picks: Picks = { ...range(1, 23, B.never), ...range(24, 33, B.always) };
    expect(scoreOf(survey, picks, "BAT").rawScore).toBe(1);
    expect(scoreOf(survey, picks, "SS").rawScore).toBe(5);
    expect(scoreOf(survey, picks, "SS").band?.grade).toBe(3);
  });
});

/** Пункты 1..23 */
function range23() {
  return Array.from({ length: 23 }, (_, i) => i + 1);
}

describe("золотой протокол: BAT-12", () => {
  const survey = toSurveyFull(bat12);

  test("пункты — звёздочные пункты BAT-23, буква в букву", () => {
    /*
     * Если кто-то поправит формулировку в BAT-23, краткая версия обязана
     * измениться вместе с ней: иначе одни и те же вопросы разойдутся по версиям.
     */
    const strip = (q: NonNullable<typeof bat.questions>[number]) => ({ ...q, scaleCode: null });
    expect(BAT12_FROM_BAT23).toEqual([1, 3, 4, 9, 11, 13, 14, 17, 18, 19, 20, 23]);
    expect(bat12.questions!.map(strip)).toEqual(BAT12_FROM_BAT23.map((n) => strip(bat.questions![n - 1]!)));
    // по три пункта на каждый основной симптом
    const per = BAT12_FROM_BAT23.map((n) => BAT_ITEMS[n - 1]!.scale);
    expect(per).toEqual(["EX", "EX", "EX", "MD", "MD", "MD", "CI", "CI", "CI", "EI", "EI", "EI"]);
  });

  test("пример досье: все «Іноді» — 3,0, красная зона (в BAT-23 те же ответы — оранжевая)", () => {
    const s = scoreOf(survey, allAt(12, B.sometimes), "BAT12");
    expect(s.rawScore).toBe(3);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
    expect(scoreOf(toSurveyFull(bat), allAt(33, B.sometimes), "BAT").band?.grade).toBe(2);
  });

  test("пример досье: границы — 30/12 зелёная, 31/12 оранжевая, 35/12 оранжевая, 36/12 красная", () => {
    // n пунктов «Іноді» (3), остальные «Рідко» (2): сумма 24 + n
    const at = (n: number) => scoreOf(survey, { ...allAt(12, B.rarely), ...range(1, n, B.sometimes) }, "BAT12");
    expect(at(6).rawScore).toBe(2.5);
    expect(at(6).band?.grade).toBe(1);
    expect(at(7).rawScore).toBe(2.583);
    expect(at(7).band?.grade).toBe(2);
    expect(at(11).rawScore).toBe(2.917);
    expect(at(11).band?.grade).toBe(2);
    expect(at(12).rawScore).toBe(3);
    expect(at(12).band?.grade).toBe(3);
  });
});

/* ProQOL 5: позиции вариантов 0 «Ніколи» (1) … 4 «Дуже часто» (5) */
const P = { never: 0, rarely: 1, sometimes: 2, often: 3, veryOften: 4 };
const CS_ITEMS = [3, 6, 12, 16, 18, 20, 22, 24, 27, 30];
const BO_ITEMS = [1, 4, 8, 10, 15, 17, 19, 21, 26, 29];
const STS_ITEMS = [2, 5, 7, 9, 11, 13, 14, 23, 25, 28];

describe("золотой протокол: ProQOL 5", () => {
  const survey = toSurveyFull(proqol5);

  test("ключи — дословно формы самооценки, обратные — 1, 4, 15, 17, 29", () => {
    const keys = Object.fromEntries((proqol5.scales ?? []).map((s) => [s.code, s.key?.map((k) => k.item)]));
    expect(keys).toEqual({ CS: CS_ITEMS, BO: BO_ITEMS, STS: STS_ITEMS });
    expect(PROQOL_REVERSED).toEqual([1, 4, 15, 17, 29]);
    const reversed = proqol5.questions!.flatMap((q, i) => (q.reverseScored ? [i + 1] : []));
    expect(reversed).toEqual([1, 4, 15, 17, 29]);
  });

  test("пример досье: все «Іноді» — 30 по каждой шкале, помірний рівень", () => {
    // 10 × 3 = 30; у обратных «Іноді» остаётся 3
    const scores = profileOf(survey, allAt(30, P.sometimes)).scores;
    expect(Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]))).toEqual({ CS: 30, BO: 30, STS: 30 });
    expect(scores.map((s) => s.band?.grade)).toEqual([2, 2, 2]);
  });

  test("пример досье: обратный ключ — «Дуже часто» на «Я почуваюся щасливою людиною» снижает вигорання", () => {
    /*
     * CS — «Дуже часто» (5) × 10 = 50; прямые BO — «Ніколи» (1) × 5; обратные BO
     * (1, 4, 15, 17, 29) — «Дуже часто» (5 → 1) × 5; BO = 10. STS — «Ніколи» × 10 =
     * 10. Без реверса BO было бы 5 + 25 = 30 («Помірний»).
     */
    const picks: Picks = {};
    for (const n of CS_ITEMS) picks[n] = P.veryOften;
    for (const n of BO_ITEMS) picks[n] = PROQOL_REVERSED.includes(n) ? P.veryOften : P.never;
    for (const n of STS_ITEMS) picks[n] = P.never;
    const bo = scoreOf(survey, picks, "BO");
    expect(bo.rawScore).toBe(10);
    expect(bo.band?.grade).toBe(1);
    expect(scoreOf(survey, picks, "CS").rawScore).toBe(50);
    expect(scoreOf(survey, picks, "CS").band?.grade).toBe(3);
    expect(scoreOf(survey, picks, "STS").rawScore).toBe(10);
  });

  test("границы формы самооценки: 22 — низький, 23 — помірний, 41 — помірний, 42 — високий", () => {
    // STS: k пунктов «Дуже часто» (5), остальные «Рідко» (2): сумма 20 + 3k; 22 и 23 — отдельно
    const sts = (picks: Picks) => scoreOf(survey, { ...allAt(30, P.sometimes), ...picks }, "STS");
    const base = Object.fromEntries(STS_ITEMS.map((n) => [n, P.rarely]));
    // 2×8 + 3×2 = 22
    expect(sts({ ...base, [STS_ITEMS[0]!]: P.sometimes, [STS_ITEMS[1]!]: P.sometimes }).rawScore).toBe(22);
    expect(sts({ ...base, [STS_ITEMS[0]!]: P.sometimes, [STS_ITEMS[1]!]: P.sometimes }).band?.grade).toBe(1);
    // 2×7 + 3×3 = 23
    const s23 = sts({ ...base, [STS_ITEMS[0]!]: P.sometimes, [STS_ITEMS[1]!]: P.sometimes, [STS_ITEMS[2]!]: P.sometimes });
    expect(s23.rawScore).toBe(23);
    expect(s23.band?.grade).toBe(2);
    // 4×9 + 5 = 41 и 4×8 + 5×2 = 42
    const top = Object.fromEntries(STS_ITEMS.map((n) => [n, P.often]));
    expect(sts({ ...top, [STS_ITEMS[0]!]: P.veryOften }).rawScore).toBe(41);
    expect(sts({ ...top, [STS_ITEMS[0]!]: P.veryOften }).band?.grade).toBe(2);
    const s42 = sts({ ...top, [STS_ITEMS[0]!]: P.veryOften, [STS_ITEMS[1]!]: P.veryOften });
    expect(s42.rawScore).toBe(42);
    expect(s42.band?.grade).toBe(3);
    expect(s42.band?.severity).toBe("mild");
  });

  test("случаев в очереди риска ProQOL не открывает даже при худших ответах", () => {
    // высокое выгорание и STS, низкое удовлетворение — всё mild
    const picks: Picks = {};
    for (const n of CS_ITEMS) picks[n] = P.never;
    for (const n of BO_ITEMS) picks[n] = PROQOL_REVERSED.includes(n) ? P.never : P.veryOften;
    for (const n of STS_ITEMS) picks[n] = P.veryOften;
    const scores = profileOf(survey, picks).scores;
    expect(Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]))).toEqual({ CS: 10, BO: 50, STS: 50 });
    expect(scores.map((s) => s.band?.severity)).toEqual(["mild", "mild", "mild"]);
    expect(detectBandRisks(scores)).toEqual([]);
  });
});

/* MIOS: позиции вариантов утверждений 0 «Цілком не погоджуюсь» (0) … 4 «Цілком погоджуюсь» (4) */
const SR_FORM = [1, 3, 7, 8, 12, 13, 14];
const TVR_FORM = [2, 4, 5, 6, 9, 10, 11];

describe("золотой протокол: MIOS", () => {
  const survey = toSurveyFull(mios);
  const YES = { 1: 1, 2: [0] } as Picks; // «Так», тип А

  /** Утверждения бланка (номер 1–14) → вариант */
  function statements(byForm: Record<number, number>): Picks {
    const picks: Picks = { ...YES };
    for (const [n, option] of Object.entries(byForm)) picks[miosPosition(Number(n))] = option;
    return picks;
  }

  test("раскладка: отсеивающий вопрос, тип события, 14 утверждений; ключи подшкал — по бланку", () => {
    expect(mios.questions!.length).toBe(16);
    expect(mios.questions![1]!.type).toBe("multiple");
    const keys = Object.fromEntries((mios.scales ?? []).map((s) => [s.code, s.key?.map((k) => k.item)]));
    expect(keys.MIOS).toEqual(Array.from({ length: 14 }, (_, i) => i + 3));
    expect(keys.SR).toEqual(SR_FORM.map(miosPosition));
    expect(keys.TVR).toEqual(TVR_FORM.map(miosPosition));
    expect(MIOS_NOT_SCORED.items).toEqual([2]);
    // полос нет — правообладатель: «no proposed scoring categories or cut offs»
    for (const s of mios.scales ?? []) expect(s.bands ?? []).toEqual([]);
  });

  test("пример досье: «Так», все утверждения «Ні погоджуюсь, ні не погоджуюсь» — 28, подшкалы по 14", () => {
    const picks = statements(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i + 1, 2])));
    const scores = profileOf(survey, picks).scores;
    expect(Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]))).toEqual({ MIOS: 28, SR: 14, TVR: 14 });
    expect(scores.every((s) => s.band === null || s.band === undefined)).toBe(true);
  });

  test("пример досье: стыд «Цілком погоджуюсь», доверие «Цілком не погоджуюсь» — 28 / 0, общий 28", () => {
    // если ключи подшкал перепутаны, стыд и доверие поменяются местами
    const byForm: Record<number, number> = {};
    for (const n of SR_FORM) byForm[n] = 4;
    for (const n of TVR_FORM) byForm[n] = 0;
    const scores = profileOf(survey, statements(byForm)).scores;
    expect(Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]))).toEqual({ MIOS: 28, SR: 28, TVR: 0 });
  });

  test("пример досье: «Ні» на отсеивающий вопрос — дальше ничего не спрашивается, баллы 0", () => {
    // «Persons who answer no should not complete the MIOS»
    const answers = answersOf(survey, { 1: 0 });
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    expect(visible.map((q) => q.id)).toEqual(["q1"]);
    const scores = computeProfile(survey, answers).scores;
    expect(Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]))).toEqual({ MIOS: 0, SR: 0, TVR: 0 });
  });

  test("тип события в баллы не идёт", () => {
    // одни и те же утверждения при разных типах (А против Б и В) — один и тот же балл
    const base = statements(Object.fromEntries(Array.from({ length: 14 }, (_, i) => [i + 1, 3])));
    const a = scoreOf(survey, base, "MIOS");
    const bc = scoreOf(survey, { ...base, 2: [1, 2] }, "MIOS");
    expect(a.rawScore).toBe(42);
    expect(bc.rawScore).toBe(42);
  });
});
