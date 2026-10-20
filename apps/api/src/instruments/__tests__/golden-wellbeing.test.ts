import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeProfile,
  createSurveySchema,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type ScoreResult,
  type SurveyFull,
} from "@quizzy/shared";
import { CATALOG } from "../catalog";
import { WORKING_TRANSLATION } from "../common";
import { flourishing } from "../flourishing";
import { mlq } from "../mlq";
import { pss10 } from "../pss10";
import { PSS4_FROM_PSS10, pss4 } from "../pss4";
import { spane } from "../spane";
import { swls } from "../swls";

/**
 * Золотые протоколы группы «wellbeing» (docs/instruments/dossiers/wellbeing.json):
 * SWLS, шкала процветания, SPANE, MLQ, PSS-4.
 *
 * Каждый ожидаемый балл посчитан руками по ключу из досье, расчёт — в
 * комментарии рядом. Ответ выбирается по ПОДПИСИ варианта, а не по баллу:
 * человек нажимает «Согласен», а не «6», и выбор по баллу спрятал бы ровно ту
 * ошибку, ради которой тест написан, — вариант с неверным баллом.
 *
 * Отдельный файл, как у других групп каталога: группы собираются параллельно,
 * и общий файл конфликтовал бы при каждом слиянии.
 */

/*
 * toSurveyFull — копия из golden-function.test.ts, а не импорт: там он не
 * экспортирован, а импорт из тестового файла заодно зарегистрировал бы его
 * тесты второй раз. Копия дешевле конфликта.
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
    stenTable: (s.stenTable ?? []).map((r, ri) => ({
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

/** Номер пункта (с единицы) → подпись варианта по-русски, как её видит toSurveyFull */
type Picks = Record<number, string>;

/**
 * Ответы по подписям: `picks` задаёт вариант для отдельных пунктов, `rest`
 * — для всех остальных. Подпись, которой у пункта нет, — ошибка теста, а
 * не молчаливый пропуск: пропущенный ответ движок просто не посчитал бы.
 */
function answer(survey: SurveyFull, picks: Picks, rest?: string): Answer[] {
  return survey.questions.map((q, i) => {
    const label = picks[i + 1] ?? rest;
    const option = q.options.find((o) => o.text === label);
    if (!option) throw new Error(`Пункт ${i + 1}: нет варианта «${label}»`);
    return { questionId: q.id, optionIds: [option.id] };
  });
}

/** Ответы списком подписей по порядку пунктов */
const inOrder = (labels: string[]): Picks => Object.fromEntries(labels.map((l, i) => [i + 1, l]));

function score(scores: ScoreResult[], code: string): ScoreResult {
  const found = scores.find((s) => s.scaleCode === code);
  if (!found) throw new Error(`Нет шкалы ${code}`);
  return found;
}

const GROUP: [string, CreateSurveyDraft][] = [
  ["swls", swls],
  ["flourishing", flourishing],
  ["spane", spane],
  ["mlq", mlq],
  ["pss4", pss4],
];

/* ───────────────────────────── досье ───────────────────────────── */

interface Card {
  key: string;
  items: unknown[] | null;
  reverse: number[];
  bands: { from: number; to: number }[] | null;
  risk_items: unknown[] | null;
}

const DOSSIER: Card[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../../../../docs/instruments/dossiers/wellbeing.json"), "utf8"),
);
const cardOf = (key: string): Card => {
  const card = DOSSIER.find((c) => c.key === key);
  if (!card) throw new Error(`В досье нет карточки «${key}»`);
  return card;
};

describe("группа wellbeing: структура и сверка с досье", () => {
  test("все пять стоят в каталоге под ключами досье", () => {
    for (const [key, draft] of GROUP) {
      expect(CATALOG.find((e) => e.key === key)?.draft, `«${key}» нет в каталоге`).toBe(draft);
      cardOf(key);
    }
  });

  test("не заведённые карточки досье в каталог не попали", () => {
    // GSE, LOT-R, MHC-SF, EUROHIS-QOL 8 — вердикт «не заводить» / «без текста»
    for (const key of ["gse", "lotr", "mhcsf", "eurohis8"]) {
      expect(CATALOG.some((e) => e.key === key), key).toBe(false);
      expect(cardOf(key).items, key).toBeNull();
    }
  });

  for (const [key, draft] of GROUP) {
    test(`${key}: схема принимает, структура без ошибок`, () => {
      const parsed = createSurveySchema.parse(draft);
      const errors = validateSurvey(parsed).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: каждое локализованное поле заполнено на обоих языках`, () => {
      const bad: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          if ("uk" in o || "ru" in o) {
            const ok = (x: unknown) => typeof x === "string" && x.trim().length > 0;
            if (!ok(o.uk) || !ok(o.ru)) bad.push(path);
            return;
          }
          for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
        }
      };
      walk(draft, key);
      expect(bad).toEqual([]);
    });

    test(`${key}: в украинском нет русских букв, в русском — украинских`, () => {
      /*
       * Правило каталога: украинский текст без «ы э ъ ё», русский — без «і ї є ґ»
       * и украинского апострофа. Ошибка раскладки здесь не видна глазом, а
       * человек прочтёт её как небрежность методики.
       */
      const bad: string[] = [];
      const walk = (v: unknown, path: string) => {
        if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (typeof o.uk === "string" && /[ыэъёЫЭЪЁ]/.test(o.uk)) bad.push(`${path}.uk: ${o.uk}`);
          if (typeof o.ru === "string" && /[іїєґІЇЄҐ’]/.test(o.ru)) bad.push(`${path}.ru: ${o.ru}`);
          for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
        }
      };
      walk(draft, key);
      expect(bad).toEqual([]);
    });

    test(`${key}: шкала без полос объясняет, почему их нет`, () => {
      const silent = (draft.scales ?? []).filter((s) => !s.bands?.length && !s.description);
      expect(silent.map((s) => s.code)).toEqual([]);
    });

    test(`${key}: число пунктов, обратные пункты и полосы — как в досье`, () => {
      const card = cardOf(key);
      const questions = draft.questions ?? [];
      if (card.items) expect(questions.length).toBe(card.items.length);
      const reversed = questions.flatMap((q, i) => (q.reverseScored ? [i + 1] : []));
      expect(reversed).toEqual(card.reverse);
      const withBands = (draft.scales ?? []).filter((s) => s.bands?.length);
      if (card.bands === null) expect(withBands.map((s) => s.code)).toEqual([]);
      else {
        expect(withBands.length).toBe(1);
        const have = [...(withBands[0]!.bands ?? [])]
          .sort((a, b) => a.minScore - b.minScore)
          .map((b) => [b.minScore, b.maxScore]);
        expect(have).toEqual(card.bands.map((b) => [b.from, b.to]));
      }
    });
  }

  test("тревоги в группе нет: risk_items досье пусты у всех пяти", () => {
    /*
     * Пунктов о суициде, самоповреждении или насилии ни в одной из пяти нет.
     * П. 9 MLQ («моє життя не має чіткої мети») — обратный пункт шкалы
     * наличия смысла, а не вопрос о намерении; флаг на нём был бы выдуманным
     * порогом.
     */
    const flagged: string[] = [];
    for (const [key, draft] of GROUP) {
      expect(cardOf(key).risk_items, key).toEqual([]);
      draft.questions?.forEach((q, i) => {
        if (q.options?.some((o) => o.riskFlag)) flagged.push(`${key}#${i + 1}`);
      });
    }
    expect(flagged).toEqual([]);
  });

  test("оговорка о рабочем переводе стоит ровно там, где текст рабочий", () => {
    /*
     * У SWLS и SPANE украинский текст — валидизированная адаптация под CC BY,
     * русский — рабочий перевод с неё: оговорка только в русском описании. Без
     * неё рабочий перевод выглядел бы валидизированным, с ней в украинском —
     * валидизированный текст выглядел бы рабочим.
     */
    const has = (draft: CreateSurveyDraft, lang: "uk" | "ru") => {
      const d = draft.description as { uk: string; ru: string };
      return d[lang].includes(WORKING_TRANSLATION[lang]);
    };
    for (const draft of [swls, spane]) {
      expect(has(draft, "uk")).toBe(false);
      expect(has(draft, "ru")).toBe(true);
    }
    for (const draft of [flourishing, mlq, pss4]) {
      expect(has(draft, "uk")).toBe(true);
      expect(has(draft, "ru")).toBe(true);
    }
  });
});

/* ───────────────────────────── SWLS ───────────────────────────── */

describe("золотой протокол: SWLS", () => {
  const survey = toSurveyFull(swls);
  /** Балл 1–7 → подпись варианта (украинская адаптация, русский рабочий перевод) */
  const BY_SCORE = [
    "",
    "Полностью не согласен",
    "Не согласен",
    "Скорее не согласен",
    "Нечто среднее",
    "Скорее согласен",
    "Согласен",
    "Полностью согласен",
  ];
  const run = (scores: number[]) =>
    score(computeProfile(survey, answer(survey, inOrder(scores.map((s) => BY_SCORE[s]!)))).scores, "SWLS");

  test("пример досье: 6, 5, 6, 4, 3 → 24, незначительная удовлетворённость (21–25)", () => {
    // 6 + 5 + 6 + 4 + 3 = 24
    const s = run([6, 5, 6, 4, 3]);
    expect(s.value).toBe(24);
    expect(s.maxScore).toBe(35);
    expect(s.band?.label).toBe("Незначительная удовлетворённость жизнью");
    expect(s.band?.severity).toBe("none");
  });

  test("пример досье: все «Нечто среднее» → 20, нейтральная оценка — полоса из одного значения", () => {
    const s = score(computeProfile(survey, answer(survey, {}, "Нечто среднее")).scores, "SWLS");
    expect(s.value).toBe(20);
    expect(s.band?.label).toBe("Нейтральная оценка жизни");
  });

  test("края: 5 и 35", () => {
    const min = run([1, 1, 1, 1, 1]);
    expect(min.value).toBe(5);
    expect(min.band?.label).toBe("Выраженная неудовлетворённость жизнью");
    const max = run([7, 7, 7, 7, 7]);
    expect(max.value).toBe(35);
    expect(max.band?.label).toBe("Выраженная удовлетворённость жизнью");
  });

  /*
   * Границы бланка автора: 5–9 | 10–14 | 15–19 | 20 | 21–25 | 26–30 | 31–35.
   * Каждая граница — с обеих сторон; сумма в комментарии.
   */
  const EDGES: [number[], number, string, "none" | "mild"][] = [
    [[1, 1, 1, 1, 5], 9, "Выраженная неудовлетворённость жизнью", "mild"],
    [[2, 2, 2, 2, 2], 10, "Неудовлетворённость жизнью", "mild"],
    [[2, 3, 3, 3, 3], 14, "Неудовлетворённость жизнью", "mild"],
    [[3, 3, 3, 3, 3], 15, "Незначительная неудовлетворённость жизнью", "none"],
    [[3, 4, 4, 4, 4], 19, "Незначительная неудовлетворённость жизнью", "none"],
    [[5, 4, 4, 4, 4], 21, "Незначительная удовлетворённость жизнью", "none"],
    [[5, 5, 5, 5, 5], 25, "Незначительная удовлетворённость жизнью", "none"],
    [[6, 5, 5, 5, 5], 26, "Удовлетворённость жизнью", "none"],
    [[6, 6, 6, 6, 6], 30, "Удовлетворённость жизнью", "none"],
    [[7, 6, 6, 6, 6], 31, "Выраженная удовлетворённость жизнью", "none"],
  ];
  for (const [scores, sum, label, severity] of EDGES) {
    test(`граница: ${scores.join(" + ")} = ${sum} → «${label}»`, () => {
      const s = run(scores);
      expect(s.value).toBe(sum);
      expect(s.band?.label).toBe(label);
      expect(s.band?.severity).toBe(severity);
    });
  }
});

/* ───────────────────────────── Flourishing Scale ───────────────────────────── */

describe("золотой протокол: Flourishing Scale", () => {
  const survey = toSurveyFull(flourishing);
  const BY_SCORE = [
    "",
    "Абсолютно не согласен",
    "Не согласен",
    "Скорее не согласен",
    "Неопределенно (и согласен и не согласен)",
    "Скорее согласен",
    "Согласен",
    "Абсолютно согласен",
  ];

  test("пример досье: 6, 5, 6, 5, 6, 6, 5, 6 → 45, без полосы", () => {
    // 6 + 5 + 6 + 5 + 6 + 6 + 5 + 6 = 45
    const picks = inOrder([6, 5, 6, 5, 6, 6, 5, 6].map((s) => BY_SCORE[s]!));
    const s = score(computeProfile(survey, answer(survey, picks)).scores, "FS");
    expect(s.value).toBe(45);
    expect(s.maxScore).toBe(56);
    expect(s.band).toBeNull();
  });

  test("края: все «Абсолютно не согласен» → 8, все «Абсолютно согласен» → 56", () => {
    expect(score(computeProfile(survey, answer(survey, {}, BY_SCORE[1])).scores, "FS").value).toBe(8);
    expect(score(computeProfile(survey, answer(survey, {}, BY_SCORE[7])).scores, "FS").value).toBe(56);
  });
});

/* ───────────────────────────── SPANE ───────────────────────────── */

describe("золотой протокол: SPANE", () => {
  const survey = toSurveyFull(spane);
  const BY_SCORE = ["", "Очень редко или никогда", "Редко", "Иногда", "Часто", "Очень часто или всегда"];

  /*
   * Ключ автора, выписанный здесь независимо от файла методики: «Positive
   * Feelings (SPANE-P): … positive, good, pleasant, happy, joyful, and
   * contented», «Negative Feelings (SPANE-N): … negative, bad, unpleasant, sad,
   * afraid, and angry» — по порядку бланка это пункты 1, 3, 5, 7, 10, 12 и
   * 2, 4, 6, 8, 9, 11.
   */
  const POSITIVE = [1, 3, 5, 7, 10, 12];
  const NEGATIVE = [2, 4, 6, 8, 9, 11];

  test("пример досье: P = 22, N = 13 (баланс автора 22 − 13 = 9)", () => {
    // P: 4 + 4 + 3 + 4 + 3 + 4 = 22; N: 2 + 2 + 3 + 2 + 1 + 3 = 13
    const picks = inOrder([4, 2, 4, 2, 3, 3, 4, 2, 1, 3, 3, 4].map((s) => BY_SCORE[s]!));
    const { scores } = computeProfile(survey, answer(survey, picks));
    expect(score(scores, "SPANE_P").value).toBe(22);
    expect(score(scores, "SPANE_N").value).toBe(13);
    expect(score(scores, "SPANE_P").band).toBeNull();
    expect(score(scores, "SPANE_N").band).toBeNull();
  });

  test("две шкалы автора, обе 6–30; отдельной шкалы баланса нет", () => {
    expect(survey.scales.map((s) => s.code)).toEqual(["SPANE_P", "SPANE_N"]);
    const low = computeProfile(survey, answer(survey, {}, BY_SCORE[1])).scores;
    const high = computeProfile(survey, answer(survey, {}, BY_SCORE[5])).scores;
    for (const code of ["SPANE_P", "SPANE_N"]) {
      expect(score(low, code).value, code).toBe(6);
      expect(score(high, code).value, code).toBe(30);
      expect(score(high, code).maxScore, code).toBe(30);
    }
  });

  for (const [mine, theirs, other] of [
    [POSITIVE, "SPANE_P", "SPANE_N"],
    [NEGATIVE, "SPANE_N", "SPANE_P"],
  ] as const) {
    for (const n of mine) {
      test(`пункт ${n} входит в ${theirs}: «Очень часто или всегда» на нём → ${theirs} 10, ${other} 6`, () => {
        // свой пункт 5 + пять других своей шкалы по 1 = 10; чужая шкала — шесть единиц = 6
        const { scores } = computeProfile(survey, answer(survey, { [n]: BY_SCORE[5]! }, BY_SCORE[1]));
        expect(score(scores, theirs).value).toBe(10);
        expect(score(scores, other).value).toBe(6);
      });
    }
  }
});

/* ───────────────────────────── MLQ ───────────────────────────── */

describe("золотой протокол: MLQ", () => {
  const survey = toSurveyFull(mlq);
  const BY_SCORE = [
    "",
    "Абсолютно неверно",
    "В основном неверно",
    "Скорее неверно",
    "Не могу сказать, верно это или нет",
    "Скорее верно",
    "В основном верно",
    "Абсолютно верно",
  ];

  /*
   * Ключ автора, выписанный независимо от файла методики: «Presence of
   * Meaning — 1, 4, 5, 6, 9 — (8 - item 9) + items 1, 4, 5, 6»; «Search for
   * Meaning — 2, 3, 7, 8, 10 — Add items 2, 3, 7, 8, 10».
   */
  const PRESENCE = [1, 4, 5, 6];
  const SEARCH = [2, 3, 7, 8, 10];

  test("пример досье: наличие 28, поиск 13", () => {
    // наличие: 6 + 6 + 5 + 5 + (8 − 2) = 28; поиск: 3 + 2 + 3 + 2 + 3 = 13
    const picks = inOrder([6, 3, 2, 6, 5, 5, 3, 2, 2, 3].map((s) => BY_SCORE[s]!));
    const { scores } = computeProfile(survey, answer(survey, picks));
    expect(score(scores, "PRESENCE").value).toBe(28);
    expect(score(scores, "SEARCH").value).toBe(13);
    expect(score(scores, "PRESENCE").band).toBeNull();
  });

  test("края с обратным пунктом 9: все «1» → 11 и 5, все «7» → 29 и 35", () => {
    // наличие: 4 × 1 + (8 − 1) = 11 и 4 × 7 + (8 − 7) = 29; поиск: 5 и 35
    const low = computeProfile(survey, answer(survey, {}, BY_SCORE[1])).scores;
    expect(score(low, "PRESENCE").value).toBe(11);
    expect(score(low, "SEARCH").value).toBe(5);
    const high = computeProfile(survey, answer(survey, {}, BY_SCORE[7])).scores;
    expect(score(high, "PRESENCE").value).toBe(29);
    expect(score(high, "SEARCH").value).toBe(35);
    expect(score(high, "PRESENCE").maxScore).toBe(35);
    expect(score(high, "SEARCH").maxScore).toBe(35);
  });

  /*
   * Каждый пункт — отдельно: «7» на нём, «4» на остальных. Фон: наличие
   * 4 × 4 + (8 − 4) = 20, поиск 5 × 4 = 20. Прямой пункт наличия даёт 23,
   * обратный девятый — 4 × 4 + (8 − 7) = 17, пункт поиска — поиску 23.
   */
  const MID = BY_SCORE[4]!;
  for (const n of PRESENCE) {
    test(`пункт ${n} — прямой пункт наличия смысла: 23 и 20`, () => {
      const { scores } = computeProfile(survey, answer(survey, { [n]: BY_SCORE[7]! }, MID));
      expect(score(scores, "PRESENCE").value).toBe(23);
      expect(score(scores, "SEARCH").value).toBe(20);
    });
  }
  test("пункт 9 — обратный пункт наличия смысла: 17 и 20", () => {
    const { scores } = computeProfile(survey, answer(survey, { 9: BY_SCORE[7]! }, MID));
    expect(score(scores, "PRESENCE").value).toBe(17);
    expect(score(scores, "SEARCH").value).toBe(20);
  });
  for (const n of SEARCH) {
    test(`пункт ${n} — пункт поиска смысла: 20 и 23`, () => {
      const { scores } = computeProfile(survey, answer(survey, { [n]: BY_SCORE[7]! }, MID));
      expect(score(scores, "PRESENCE").value).toBe(20);
      expect(score(scores, "SEARCH").value).toBe(23);
    });
  }
});

/* ───────────────────────────── PSS-4 ───────────────────────────── */

describe("золотой протокол: PSS-4", () => {
  const survey = toSurveyFull(pss4);
  const BY_SCORE = ["Никогда", "Почти никогда", "Иногда", "Довольно часто", "Очень часто"];
  const run = (scores: number[]) =>
    score(computeProfile(survey, answer(survey, inOrder(scores.map((s) => BY_SCORE[s]!)))).scores, "PSS4");

  test("пример досье: 3, 1, 1, 3 → 3 + (4 − 1) + (4 − 1) + 3 = 12, без полосы", () => {
    const s = run([3, 1, 1, 3]);
    expect(s.value).toBe(12);
    expect(s.maxScore).toBe(16);
    expect(s.band).toBeNull();
  });

  test("обратный ключ ровно на пунктах 2 и 3: края 0 и 16, все «Никогда» → 8", () => {
    expect(run([0, 4, 4, 0]).value).toBe(0);
    expect(run([4, 0, 0, 4]).value).toBe(16);
    // 0 + (4 − 0) + (4 − 0) + 0 = 8
    expect(run([0, 0, 0, 0]).value).toBe(8);
  });

  test("пункты — те же, что 2, 4, 5 и 10 PSS-10 каталога: текст, варианты, обратный ключ", () => {
    /*
     * PSS-4 — это пункты 2, 6, 7, 14 PSS-14, они же 2, 4, 5, 10 PSS-10
     * (Cohen et al., 1983, с. 392 и Appendix A). Расхождение в одном слове
     * сделало бы короткий и полный замер одного человека несравнимыми.
     */
    expect([...PSS4_FROM_PSS10]).toEqual([2, 4, 5, 10]);
    const full = pss10.questions ?? [];
    (pss4.questions ?? []).forEach((q, i) => {
      const src = full[PSS4_FROM_PSS10[i]! - 1]!;
      expect(q.title, `пункт ${i + 1}`).toEqual(src.title);
      expect(q.reverseScored, `пункт ${i + 1}`).toBe(src.reverseScored);
      expect(q.options, `пункт ${i + 1}`).toEqual(src.options);
    });
    expect((pss4.questions ?? []).map((q) => q.reverseScored)).toEqual([false, true, true, false]);
    expect(pss4.instructions).toEqual(pss10.instructions);
  });
});
