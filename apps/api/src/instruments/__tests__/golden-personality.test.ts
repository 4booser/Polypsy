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
import { aaq2 } from "../aaq2";
import { aq10 } from "../aq10";
import { CATALOG } from "../catalog";
import { WORKING_TRANSLATION } from "../common";
import { maas } from "../maas";
import { scsSf } from "../scsSf";
import { tipi } from "../tipi";

/**
 * Золотые протоколы группы «personality» (docs/instruments/dossiers/
 * personality.json): TIPI, SCS-SF, MAAS, AAQ-II, AQ-10.
 *
 * Каждый ожидаемый балл посчитан руками по ключу из досье — расчёт в
 * комментарии рядом; у TIPI первый случай — опубликованный пример автора.
 * Ответ выбирается по ПОДПИСИ варианта, а не по баллу: человек нажимает
 * «Скорее редко», а не «4», и выбор по баллу спрятал бы ровно ту ошибку, ради
 * которой тест написан, — вариант с неверным баллом.
 *
 * Сверх примеров файл держит связь «досье → код»: число пунктов, обратные
 * пункты, границы полос и пункты риска сравниваются с карточкой досье на
 * диске. Лист сверки (instrumentSheets) пишет такое расхождение замечанием, а
 * здесь оно роняет тест — правка ключа без правки досье не пройдёт молча.
 *
 * Отдельный файл, а не golden.test.ts: группы каталога собираются в
 * параллельных ветках, и общий файл конфликтовал бы при каждом слиянии.
 */

/*
 * toSurveyFull — копия из golden-function.test.ts, а не импорт: импорт из
 * тестового файла заново зарегистрировал бы его протоколы, а вынос в общий
 * модуль тронул бы чужие файлы во всех параллельных ветках сразу.
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

/** Номер пункта (с единицы) → подпись варианта по-русски, как её видит toSurveyFull */
type Picks = Record<number, string>;

/**
 * Ответы по подписям: `picks` задаёт вариант для отдельных пунктов, `rest` —
 * для всех остальных. Подпись, которой у пункта нет, — ошибка теста, а не
 * молчаливый пропуск: пропущенный ответ движок просто не посчитал бы.
 */
function answer(survey: SurveyFull, picks: Picks, rest?: string): Answer[] {
  return survey.questions.map((q, i) => {
    const label = picks[i + 1] ?? rest;
    const option = q.options.find((o) => o.text === label);
    if (!option) throw new Error(`Пункт ${i + 1}: нет варианта «${label}»`);
    return { questionId: q.id, optionIds: [option.id] };
  });
}

/** Ответы списком подписей — по одной на пункт, по порядку */
const inOrder = (labels: string[]): Picks => Object.fromEntries(labels.map((l, i) => [i + 1, l]));

function score(scores: ScoreResult[], code: string): ScoreResult {
  const found = scores.find((s) => s.scaleCode === code);
  if (!found) throw new Error(`Нет шкалы ${code}`);
  return found;
}

const profile = (survey: SurveyFull, picks: Picks, rest?: string) =>
  computeProfile(survey, answer(survey, picks, rest)).scores;

const GROUP = [
  ["tipi", tipi],
  ["scs_sf", scsSf],
  ["maas", maas],
  ["aaq2", aaq2],
  ["aq10", aq10],
] as const;

/* ───────────────────────── досье на диске ───────────────────────── */

interface Card {
  key: string;
  items: string[] | null;
  reverse: number[] | null;
  bands: { min: number; max: number }[] | null;
  risk_items: number[] | null;
  verdict: string;
}

const DOSSIER: Card[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../../../../docs/instruments/dossiers/personality.json"), "utf8"),
);
const card = (key: string): Card => {
  const found = DOSSIER.find((c) => c.key === key);
  if (!found) throw new Error(`В досье нет карточки ${key}`);
  return found;
};

/** Все локализованные строки черновика: [путь, объект { uk, ru }] */
function localized(draft: unknown): [string, { uk: string; ru: string }][] {
  const out: [string, { uk: string; ru: string }][] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ("uk" in o || "ru" in o) {
        out.push([path, o as { uk: string; ru: string }]);
        return;
      }
      for (const [k, x] of Object.entries(o)) walk(x, `${path}.${k}`);
    }
  };
  walk(draft, "");
  return out;
}

describe("группа personality: структура", () => {
  test("все пять стоят в каталоге под ключами досье", () => {
    for (const [key, draft] of GROUP) {
      expect(CATALOG.find((e) => e.key === key)?.draft, `«${key}» нет в каталоге`).toBe(draft);
      expect(card(key).verdict.startsWith("завести"), `${key}: досье не разрешает заводить`).toBe(true);
    }
  });

  test("отвергнутые карточки досье в каталог не попали", () => {
    const rejected = DOSSIER.filter((c) => c.verdict.startsWith("не заводить")).map((c) => c.key);
    expect(rejected.sort()).toEqual(["bis11", "bis_bas", "ders16", "ecr_rs", "erq", "mini_ipip", "pid5bf"]);
    for (const key of rejected) expect(CATALOG.some((e) => e.key === key), key).toBe(false);
  });

  for (const [key, draft] of GROUP) {
    test(`${key}: схема принимает, структура без ошибок`, () => {
      const parsed = createSurveySchema.parse(draft);
      const errors = validateSurvey(parsed).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: каждое локализованное поле заполнено на обоих языках`, () => {
      // каталог не посевается в базу проверки двуязычности — одноязычная строка ловится здесь
      const bad = localized(draft)
        .filter(([, o]) => !(typeof o.uk === "string" && o.uk.trim() && typeof o.ru === "string" && o.ru.trim()))
        .map(([path]) => path);
      expect(bad).toEqual([]);
    });

    test(`${key}: в украинском нет русских букв, в русском — украинских`, () => {
      const uk = localized(draft).filter(([, o]) => /[ыэъёЫЭЪЁ]/.test(o.uk)).map(([p, o]) => `${p}: ${o.uk}`);
      const ru = localized(draft).filter(([, o]) => /[іїєґІЇЄҐ]/.test(o.ru)).map(([p, o]) => `${p}: ${o.ru}`);
      expect(uk).toEqual([]);
      expect(ru).toEqual([]);
    });

    test(`${key}: шкала без полос объясняет, почему их нет`, () => {
      // молчаливое отсутствие полос неотличимо от забытой таблицы
      const silent = (draft.scales ?? []).filter((s) => !s.bands?.length && !s.description);
      expect(silent.map((s) => s.code)).toEqual([]);
    });

    test(`${key}: пункты, обратный ключ, полосы и риск — как в досье`, () => {
      const c = card(key);
      const questions = draft.questions ?? [];
      expect(questions.length, "число пунктов").toBe(c.items?.length ?? -1);
      const reverse = questions.flatMap((q, i) => (q.reverseScored ? [i + 1] : []));
      expect(reverse, "обратные пункты").toEqual(c.reverse ?? []);
      const withBands = (draft.scales ?? []).filter((s) => s.bands?.length);
      if (c.bands === null) {
        expect(withBands.map((s) => s.code), "полос в досье нет").toEqual([]);
      } else {
        expect(withBands.length, "полосы — у одной шкалы").toBe(1);
        const have = [...(withBands[0]!.bands ?? [])]
          .sort((a, b) => a.minScore - b.minScore)
          .map((b) => [b.minScore, b.maxScore]);
        expect(have).toEqual(c.bands.map((b) => [b.min, b.max]));
      }
      const flagged = questions.flatMap((q, i) => ((q.options ?? []).some((o) => o.riskFlag) ? [i + 1] : []));
      expect(flagged, "пункты риска").toEqual(c.risk_items ?? []);
    });
  }

  test("ни одна полоса не тяжелее «mild»: ни одна из пяти методик не меряет риск", () => {
    /*
     * «moderate» открывает случай в очереди риска рядом с суицидальными
     * пунктами. У AAQ-II авторы прямо пишут, что диагностического порога нет,
     * у AQ-10 порог — направления, у SCS-SF — «ad hoc rubric» без норм.
     */
    for (const [key, draft] of GROUP) {
      for (const s of draft.scales ?? []) {
        for (const b of s.bands ?? []) {
          expect(["none", "mild"], `${key}/${s.code}: ${JSON.stringify(b.label)}`).toContain(b.severity ?? "none");
        }
      }
    }
    // у черт и у ориентира авторки SCS-SF — вообще без тяжести
    for (const draft of [tipi, scsSf] as CreateSurveyDraft[]) {
      for (const s of draft.scales ?? []) for (const b of s.bands ?? []) expect(b.severity).toBe("none");
    }
  });

  test("оговорка о рабочем переводе — ровно там, где текст наш", () => {
    // оговорка — в примечании для персонала («Джерело» паспорта), описание для обследуемого о ней молчит
    const note = (d: CreateSurveyDraft) => CATALOG.find((e) => e.draft === d)!.note;
    const has = (d: CreateSurveyDraft) => note(d).includes(WORKING_TRANSLATION.uk);
    // TIPI — обе адаптации валидизированы и перечислены автором: оговорка была бы неправдой
    expect(has(tipi)).toBe(false);
    for (const d of [scsSf, maas, aq10]) expect(has(d)).toBe(true);
    // AAQ-II: украинские пункты — адаптация УКУ, инструкция и русский — рабочий перевод
    expect(has(aaq2)).toBe(false);
    expect(note(aaq2)).toContain("інструкція й російський текст — робочий переклад");
    for (const d of [tipi, scsSf, maas, aq10, aaq2]) {
      expect((d.description as { uk: string }).uk).not.toContain(WORKING_TRANSLATION.uk);
    }
  });

  test("результат человеку: черты и самосострадание — да, остальное — нет", () => {
    expect(tipi.showResultsToPatient).toBe(true);
    expect(scsSf.showResultsToPatient).toBe(true);
    expect(maas.showResultsToPatient).toBe(false);
    expect(aaq2.showResultsToPatient).toBe(false);
    expect(aq10.showResultsToPatient).toBe(false);
  });
});

/* ───────────────────────────── TIPI ───────────────────────────── */

describe("золотой протокол: TIPI", () => {
  const survey = toSurveyFull(tipi);
  /** Подписи TIPI-RU: подписаны только 1, 4 и 7 */
  const RU = ["", "1 — полное несогласие с утверждением", "2", "3", "4 — нечто среднее", "5", "6", "7 — полное согласие с утверждением"];
  const at = (scores: number[]) => inOrder(scores.map((s) => RU[s]!));

  /*
   * Ключ автора, выписанный здесь независимо от файла методики: «Extraversion:
   * 1, 6R; Agreeableness: 2R, 7; Conscientiousness; 3, 8R; Emotional
   * Stability: 4R, 9; Openness to Experiences: 5, 10R».
   */
  const KEY: [string, [number, number]][] = [
    ["E", [1, 6]],
    ["A", [2, 7]],
    ["C", [3, 8]],
    ["ES", [4, 9]],
    ["O", [5, 10]],
  ];

  test("пять шкал по два пункта, среднее 1–7, полос нет; общая основа — раздел у всех десяти", () => {
    expect(survey.scales.map((s) => s.code).sort()).toEqual(KEY.map(([c]) => c).sort());
    for (const [code, pair] of KEY) {
      const s = survey.scales.find((x) => x.code === code)!;
      expect(s.aggregation, code).toBe("average");
      expect(s.bands, code).toEqual([]);
      expect(s.items.map((i) => Number(i.questionId.slice(1))).sort((a, b) => a - b), code).toEqual(pair);
    }
    const parsed = createSurveySchema.parse(tipi);
    expect(parsed.sections.map((s) => s.key)).toEqual(["stem"]);
    expect(parsed.questions.every((q) => q.sectionKey === "stem")).toBe(true);
  });

  test("пример автора: п. 1 = 5, п. 6 = 2 → экстравертность (5 + 6) / 2 = 5,5", () => {
    // остальные пункты «4»: прямой 4 и обратный 8 − 4 = 4 → остальные шкалы 4,0
    const scores = profile(survey, at([5, 4, 4, 4, 4, 2, 4, 4, 4, 4]));
    expect(score(scores, "E").value).toBe(5.5);
    expect(score(scores, "E").band).toBeNull();
    expect(score(scores, "E").maxScore).toBe(7);
    for (const code of ["A", "C", "ES", "O"]) expect(score(scores, code).value, code).toBe(4);
  });

  test("прямые 7, обратные 1 → все пять шкал 7; все ответы 7 → все пять шкал 4", () => {
    /*
     * Первый случай: 7 и 8 − 1 = 7 у каждой шкалы. Второй: 7 и 8 − 7 = 1,
     * (7 + 1) / 2 = 4. Обратный ключ, поставленный не на тот пункт, даст в
     * одной из шкал 7 вместо 4 во втором случае и 4 вместо 7 в первом.
     */
    const high = profile(survey, at([7, 1, 7, 1, 7, 1, 7, 1, 7, 1]));
    for (const [code] of KEY) expect(score(high, code).value, code).toBe(7);
    const flat = profile(survey, {}, RU[7]);
    for (const [code] of KEY) expect(score(flat, code).value, code).toBe(4);
  });

  test("эмоциональная стабильность растёт к спокойствию: «тревожная» 7 и «спокойная» 1 → 1", () => {
    // п. 4 «тревожного» 7 → 8 − 7 = 1; п. 9 «спокойного» 1 → (1 + 1) / 2 = 1
    const scores = profile(survey, { 4: RU[7]!, 9: RU[1]! }, RU[4]);
    expect(score(scores, "ES").value).toBe(1);
  });
});

/* ───────────────────────────── SCS-SF ───────────────────────────── */

describe("золотой протокол: SCS-SF", () => {
  const survey = toSurveyFull(scsSf);
  const RU = ["", "1 — почти никогда", "2", "3", "4", "5 — почти всегда"];
  const at = (scores: number[]) => inOrder(scores.map((s) => RU[s]!));
  const REVERSED = [1, 4, 8, 9, 11, 12];
  const LOW = "Низкое самосострадание";
  const MID = "Умеренное самосострадание";
  const HIGH = "Высокое самосострадание";

  test("пример досье: 4, 2, 3, 4, 2, 2, 3, 4, 4, 2, 4, 4 → 26 / 12 = 2,167, низкое", () => {
    // обратные 1, 4, 8, 9, 11, 12 ответом 4 → 6 − 4 = 2, сумма 12; прямые 2 + 3 + 2 + 2 + 3 + 2 = 14
    const s = score(profile(survey, at([4, 2, 3, 4, 2, 2, 3, 4, 4, 2, 4, 4])), "SCS");
    expect(s.value).toBe(2.167);
    expect(s.maxScore).toBe(5);
    expect(s.band?.label).toBe(LOW);
    expect(s.band?.severity).toBe("none");
  });

  test("края: все 3 → 3,0 умеренное; прямые 5 и обратные 1 → 5,0; прямые 1 и обратные 5 → 1,0", () => {
    expect(score(profile(survey, {}, RU[3]), "SCS").band?.label).toBe(MID);
    const kind = Object.fromEntries(REVERSED.map((n) => [n, RU[1]!]));
    const high = score(profile(survey, kind, RU[5]), "SCS");
    expect(high.value).toBe(5);
    expect(high.band?.label).toBe(HIGH);
    const harsh = Object.fromEntries(REVERSED.map((n) => [n, RU[5]!]));
    const low = score(profile(survey, harsh, RU[1]), "SCS");
    expect(low.value).toBe(1);
    expect(low.band?.label).toBe(LOW);
  });

  test("границы ориентира: 29/12 → низкое, 30/12 = 2,5 → умеренное; 42/12 = 3,5 → умеренное, 43/12 → высокое", () => {
    /*
     * Все ответы 3 дают по 3 на пункт после обращения (сумма 36). Сдвиг
     * прямого пункта на ±k меняет сумму на ±k, обратного — на ∓k.
     * 36 − 6 = 30: пп. 2, 3, 5, 6, 7, 10 ответом 2 → 2,5. Ещё −1: п. 1 ответом
     * 4 (обратный 6 − 4 = 2) → 29 → 2,417. 36 + 6 = 42: те же прямые ответом 4
     * → 3,5; ещё +1: п. 1 ответом 2 (6 − 2 = 4) → 43 → 3,583.
     */
    const direct = (v: number) => Object.fromEntries([2, 3, 5, 6, 7, 10].map((n) => [n, RU[v]!]));
    const at30 = score(profile(survey, direct(2), RU[3]), "SCS");
    expect(at30.value).toBe(2.5);
    expect(at30.band?.label).toBe(MID);
    const at29 = score(profile(survey, { ...direct(2), 1: RU[4]! }, RU[3]), "SCS");
    expect(at29.value).toBe(2.417);
    expect(at29.band?.label).toBe(LOW);
    const at42 = score(profile(survey, direct(4), RU[3]), "SCS");
    expect(at42.value).toBe(3.5);
    expect(at42.band?.label).toBe(MID);
    const at43 = score(profile(survey, { ...direct(4), 1: RU[2]! }, RU[3]), "SCS");
    expect(at43.value).toBe(3.583);
    expect(at43.band?.label).toBe(HIGH);
  });
});

/* ───────────────────────────── MAAS ───────────────────────────── */

describe("золотой протокол: MAAS", () => {
  const survey = toSurveyFull(maas);
  const RU = ["", "Почти всегда", "Очень часто", "Скорее часто", "Скорее редко", "Очень редко", "Почти никогда"];

  test("пример досье: 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3 → 48 / 15 = 3,2, без полосы", () => {
    const s = score(profile(survey, inOrder([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3].map((v) => RU[v]!))), "MAAS");
    expect(s.value).toBe(3.2);
    expect(s.maxScore).toBe(6);
    expect(s.band).toBeNull();
  });

  test("края и направление: «почти всегда» → 1, «почти никогда» → 6 — выше значит осознаннее, обратных нет", () => {
    expect(score(profile(survey, {}, RU[1]), "MAAS").value).toBe(1);
    expect(score(profile(survey, {}, RU[6]), "MAAS").value).toBe(6);
    expect(survey.questions.some((q) => q.reverseScored)).toBe(false);
  });
});

/* ───────────────────────────── AAQ-II ───────────────────────────── */

describe("золотой протокол: AAQ-II", () => {
  const survey = toSurveyFull(aaq2);
  const RU = ["", "1 — никогда", "2", "3", "4", "5", "6", "7 — всегда"];
  const BELOW = "Ниже диапазона дистресса";
  const WITHIN = "В диапазоне дистресса";
  const ABOVE = "Выше диапазона дистресса";
  const run = (scores: number[]) => score(profile(survey, inOrder(scores.map((v) => RU[v]!))), "AAQ2");

  test("пример досье: все семь ответов 4 → 28, диапазон 24–28, лёгкая тяжесть", () => {
    const s = run([4, 4, 4, 4, 4, 4, 4]);
    expect(s.value).toBe(28);
    expect(s.maxScore).toBe(49);
    expect(s.band?.label).toBe(WITHIN);
    expect(s.band?.severity).toBe("mild");
  });

  test("границы полос авторов: 23 | 24 и 28 | 29; края 7 и 49", () => {
    // 3 × 6 + 5 = 23; 3 × 5 + 4 + 5 = 24; 4 × 6 + 5 = 29
    expect(run([3, 3, 3, 3, 3, 3, 5]).band?.label).toBe(BELOW);
    expect(run([3, 3, 3, 3, 3, 4, 5]).band?.label).toBe(WITHIN);
    const above = run([4, 4, 4, 4, 4, 4, 5]);
    expect(above.value).toBe(29);
    expect(above.band?.label).toBe(ABOVE);
    expect(run([1, 1, 1, 1, 1, 1, 1]).value).toBe(7);
    expect(run([7, 7, 7, 7, 7, 7, 7]).value).toBe(49);
  });
});

/* ───────────────────────────── AQ-10 ───────────────────────────── */

describe("золотой протокол: AQ-10", () => {
  const survey = toSurveyFull(aq10);
  const AGREE = "Полностью соглашаюсь";
  const SLIGHT_AGREE = "Скорее соглашаюсь";
  const SLIGHT_DISAGREE = "Скорее не соглашаюсь";
  const DISAGREE = "Совсем не соглашаюсь";
  const BELOW = "Ниже порога направления";
  const REFER = "Выше порога направления";

  /*
   * Ключ бланка, выписанный здесь независимо от файла методики: балл за
   * согласие — пункты 1, 7, 8, 10; балл за несогласие — 2, 3, 4, 5, 6, 9.
   */
  const AGREE_SCORED = [1, 7, 8, 10];
  const DISAGREE_SCORED = [2, 3, 4, 5, 6, 9];

  test("пример досье: «совсем не соглашаюсь» на всех десяти → 6, порог направления", () => {
    const s = score(profile(survey, {}, DISAGREE), "AQ10");
    expect(s.value).toBe(6);
    expect(s.maxScore).toBe(10);
    expect(s.band?.label).toBe(REFER);
    expect(s.band?.severity).toBe("mild");
  });

  test("зеркально: «полностью соглашаюсь» на всех десяти → 4, ниже порога", () => {
    const s = score(profile(survey, {}, AGREE), "AQ10");
    expect(s.value).toBe(4);
    expect(s.band?.label).toBe(BELOW);
  });

  test("«скорее» весит столько же, сколько «полностью»: один балл за пункт", () => {
    expect(score(profile(survey, {}, SLIGHT_DISAGREE), "AQ10").value).toBe(6);
    expect(score(profile(survey, {}, SLIGHT_AGREE), "AQ10").value).toBe(4);
  });

  test("каждый пункт по отдельности даёт балл ровно в своём направлении", () => {
    // нулевой ответ: несогласие для 1, 7, 8, 10 и согласие для остальных
    const zero: Picks = Object.fromEntries([
      ...AGREE_SCORED.map((n) => [n, DISAGREE]),
      ...DISAGREE_SCORED.map((n) => [n, AGREE]),
    ]);
    expect(score(profile(survey, zero), "AQ10").value).toBe(0);
    for (const n of AGREE_SCORED) {
      expect(score(profile(survey, { ...zero, [n]: AGREE }), "AQ10").value, `п. ${n}`).toBe(1);
    }
    for (const n of DISAGREE_SCORED) {
      expect(score(profile(survey, { ...zero, [n]: DISAGREE }), "AQ10").value, `п. ${n}`).toBe(1);
    }
    // 5 | 6: пять «аутистических» ответов — ниже порога, шесть — порог
    const five = { ...zero, 1: AGREE, 7: AGREE, 8: AGREE, 10: AGREE, 2: DISAGREE };
    expect(score(profile(survey, five), "AQ10").band?.label).toBe(BELOW);
    expect(score(profile(survey, { ...five, 3: DISAGREE }), "AQ10").band?.label).toBe(REFER);
  });
});
