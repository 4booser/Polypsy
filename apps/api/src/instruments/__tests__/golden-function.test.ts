import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  validateSurvey,
  type Answer,
  type ScoreResult,
  type SurveyFull,
} from "@quizzy/shared";
import { briefCope } from "../briefCope";
import { CATALOG } from "../catalog";
import { mspss } from "../mspss";
import { osss3 } from "../osss3";
import { rses } from "../rses";
import { ucla3 } from "../ucla3";

/**
 * Золотые протоколы группы «function» (docs/instruments/dossiers/function.json):
 * MSPSS, OSSS-3, RSES, UCLA-3, Brief COPE.
 *
 * Каждый ожидаемый балл посчитан руками по ключу из досье, расчёт — в
 * комментарии рядом. Ответ выбирается по ПОДПИСИ варианта, а не по баллу:
 * человек нажимает «Согласен», а не «2», и выбор по баллу спрятал бы ровно
 * ту ошибку, ради которой тест написан, — вариант с неверным баллом.
 *
 * Отдельный файл, а не golden.test.ts: четыре группы каталога собираются
 * параллельно, и общий файл конфликтовал бы при каждом слиянии.
 */

/*
 * toSurveyFull — копия из golden.test.ts, а не импорт. Там он не
 * экспортирован, а импорт из тестового файла заодно зарегистрировал бы его
 * тесты второй раз; вынос в общий модуль тронул бы golden.test.ts во всех
 * четырёх параллельных ветках сразу. Копия дешевле конфликта.
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

function score(scores: ScoreResult[], code: string): ScoreResult {
  const found = scores.find((s) => s.scaleCode === code);
  if (!found) throw new Error(`Нет шкалы ${code}`);
  return found;
}

const GROUP = [
  ["mspss", mspss],
  ["osss3", osss3],
  ["rses", rses],
  ["ucla3", ucla3],
  ["brief_cope", briefCope],
] as const;

describe("группа function: структура", () => {
  test("все пять стоят в каталоге под ключами досье", () => {
    for (const [key, draft] of GROUP) {
      expect(CATALOG.find((e) => e.key === key)?.draft, `«${key}» нет в каталоге`).toBe(draft);
    }
  });

  for (const [key, draft] of GROUP) {
    test(`${key}: схема принимает, структура без ошибок`, () => {
      const parsed = createSurveySchema.parse(draft);
      const errors = validateSurvey(parsed).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: каждое локализованное поле заполнено на обоих языках`, () => {
      /*
       * Каталог не посевается в базу проверки двуязычности (content.test.ts
       * гоняет seed.ts, а не установщик каталога), поэтому одноязычная
       * строка методики каталога ловится здесь, на файле.
       */
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

    test(`${key}: шкала без полос объясняет, почему их нет`, () => {
      // молчаливое отсутствие полос неотличимо от забытой таблицы
      const silent = (draft.scales ?? []).filter((s) => !s.bands?.length && !s.description);
      expect(silent.map((s) => s.code)).toEqual([]);
    });
  }

  test("тревога только там, где её требует досье: Brief COPE, пункты 4 и 11", () => {
    /*
     * risk_items досье: у brief_cope — [4, 11], у остальных четырёх — null.
     * Пункты 9 и 10 RSES («почуваюся непотрібним», «нікуди не годжуся») и
     * 6/16 Brief COPE по смыслу близки к безнадёжности, но правила тревоги
     * по ним досье не даёт — флаг там был бы выдуманным порогом.
     */
    const flagged: string[] = [];
    for (const [key, draft] of GROUP) {
      draft.questions?.forEach((q, i) => {
        for (const o of q.options ?? []) {
          if (o.riskFlag) flagged.push(`${key}#${i + 1}@${o.score}:${o.riskSeverity}`);
        }
      });
    }
    // любой ответ, кроме «совсем этого не делаю» (1), то есть баллы 2, 3, 4
    expect(flagged.sort()).toEqual(
      [
        "brief_cope#11@2:moderate",
        "brief_cope#11@3:moderate",
        "brief_cope#11@4:moderate",
        "brief_cope#4@2:moderate",
        "brief_cope#4@3:moderate",
        "brief_cope#4@4:moderate",
      ].sort(),
    );
    // подпись тревоги обязана называть это правилом отделения, а не порогом методики
    for (const n of [4, 11]) {
      for (const o of briefCope.questions?.[n - 1]?.options ?? []) {
        if (!o.riskFlag) continue;
        const label = o.riskLabel as { uk: string; ru: string };
        expect(label.uk).toContain("правило відділення");
        expect(label.ru).toContain("правило отделения");
      }
    }
  });
});

/* ───────────────────────────── MSPSS ───────────────────────────── */

describe("золотой протокол: MSPSS", () => {
  const survey = toSurveyFull(mspss);
  const LOW = "Низкая поддержка";
  const MID = "Умеренная поддержка";
  const HIGH = "Высокая поддержка";

  test("пример досье: все «Нейтрально» → 4.00 везде, умеренная поддержка", () => {
    // 12 × 4 = 48, 48 / 12 = 4.00; каждая подшкала 4 × 4 = 16, 16 / 4 = 4.00
    const { scores } = computeProfile(survey, answer(survey, {}, "Нейтрально"));
    for (const code of ["MSPSS", "SO", "FAM", "FRI"]) {
      const s = score(scores, code);
      expect(s.value, code).toBe(4);
      expect(s.band?.label, code).toBe(MID);
      expect(s.maxScore, code).toBe(7);
    }
  });

  /*
   * Ключ автора, выписанный здесь независимо от файла методики: «Significant
   * Other: 1, 2, 5, 10; Family: 3, 4, 8, 11; Friends: 6, 7, 9, 12».
   */
  const SUBSCALES: [string, number[]][] = [
    ["SO", [1, 2, 5, 10]],
    ["FAM", [3, 4, 8, 11]],
    ["FRI", [6, 7, 9, 12]],
  ];

  for (const [code, items] of SUBSCALES) {
    test(`подшкала ${code}: «Полностью согласен» на пунктах ${items.join(", ")}, прочее — минимум`, () => {
      /*
       * Свои четыре пункта по 7: 28 / 4 = 7.00 → высокая.
       * Две другие подшкалы по 1: 4 / 4 = 1.00 → низкая.
       * Общая: (4 × 7 + 8 × 1) / 12 = 36 / 12 = 3.00 → умеренная (нижний край 3–5).
       */
      const picks = Object.fromEntries(items.map((n) => [n, "Полностью согласен"]));
      const { scores } = computeProfile(survey, answer(survey, picks, "Полностью не согласен"));
      expect(score(scores, code).value).toBe(7);
      expect(score(scores, code).band?.label).toBe(HIGH);
      for (const [other] of SUBSCALES.filter(([c]) => c !== code)) {
        expect(score(scores, other).value, other).toBe(1);
        expect(score(scores, other).band?.label, other).toBe(LOW);
      }
      expect(score(scores, "MSPSS").value).toBe(3);
      expect(score(scores, "MSPSS").band?.label).toBe(MID);
    });
  }

  test("дыра автора между 2.9 и 3.0 закрыта вниз: 35/12 — низкая", () => {
    // все «Скорее не согласен» (3): 36 / 12 = 3.00 → умеренная
    const at3 = computeProfile(survey, answer(survey, {}, "Скорее не согласен"));
    expect(score(at3.scores, "MSPSS").value).toBe(3);
    expect(score(at3.scores, "MSPSS").band?.label).toBe(MID);
    // пункт 1 → «Не согласен» (2): 35 / 12 = 2.9166… → 2.917, в авторскую полосу не попадает
    const below = computeProfile(survey, answer(survey, { 1: "Не согласен" }, "Скорее не согласен"));
    expect(score(below.scores, "MSPSS").value).toBe(2.917);
    expect(score(below.scores, "MSPSS").band?.label).toBe(LOW);
  });

  test("дыра автора между 5.0 и 5.1 закрыта вверх: 61/12 — высокая", () => {
    // все «Скорее согласен» (5): 60 / 12 = 5.00 → умеренная
    const at5 = computeProfile(survey, answer(survey, {}, "Скорее согласен"));
    expect(score(at5.scores, "MSPSS").value).toBe(5);
    expect(score(at5.scores, "MSPSS").band?.label).toBe(MID);
    // пункт 1 → «Согласен» (6): 61 / 12 = 5.0833… → 5.083
    const above = computeProfile(survey, answer(survey, { 1: "Согласен" }, "Скорее согласен"));
    expect(score(above.scores, "MSPSS").value).toBe(5.083);
    expect(score(above.scores, "MSPSS").band?.label).toBe(HIGH);
  });
});

/* ───────────────────────────── OSSS-3 ───────────────────────────── */

describe("золотой протокол: OSSS-3", () => {
  const survey = toSurveyFull(osss3);
  const run = (a: string, b: string, c: string) =>
    score(computeProfile(survey, answer(survey, { 1: a, 2: b, 3: c })).scores, "OSSS3");

  test("пример досье: «5+», «some», «easy» → 4 + 4 + 4 = 12, сильная поддержка", () => {
    const s = run("5 и более", "Отчасти интересуются", "Легко");
    expect(s.value).toBe(12);
    expect(s.band?.label).toBe("Сильная поддержка");
  });

  test("края: минимум 3, максимум 14 — у первого пункта четыре варианта, а не пять", () => {
    // 1 + 1 + 1 = 3 → слабая
    const min = run("Ни одного", "Совсем не интересуются", "Очень трудно");
    expect(min.value).toBe(3);
    expect(min.band?.label).toBe("Слабая поддержка");
    // 4 + 5 + 5 = 14 → сильная; максимум шкалы тоже 14, не 15
    const max = run("5 и более", "Очень интересуются", "Очень легко");
    expect(max.value).toBe(14);
    expect(max.maxScore).toBe(14);
    expect(max.band?.label).toBe("Сильная поддержка");
  });

  test("границы полос Bøen: 8 | 9 и 11 | 12", () => {
    // «1–2» (2) + «uncertain» (3) + «possible» (3) = 8 → слабая
    expect(run("1–2", "Трудно сказать", "Возможно").band?.label).toBe("Слабая поддержка");
    // «3–5» (3) + 3 + 3 = 9 → умеренная
    expect(run("3–5", "Трудно сказать", "Возможно").band?.label).toBe("Умеренная поддержка");
    // 3 + «some» (4) + «easy» (4) = 11 → умеренная
    const eleven = run("3–5", "Отчасти интересуются", "Легко");
    expect(eleven.value).toBe(11);
    expect(eleven.band?.label).toBe("Умеренная поддержка");
  });
});

/* ───────────────────────────── RSES ───────────────────────────── */

describe("золотой протокол: RSES", () => {
  const survey = toSurveyFull(rses);
  const DIRECT = [1, 2, 4, 6, 7];
  const REVERSED = [3, 5, 8, 9, 10];
  const each = (items: number[], label: string) => Object.fromEntries(items.map((n) => [n, label]));

  test("пример досье: A, A, D, A, D, A, A, D, D, D → 20, без полосы", () => {
    /*
     * Прямые 1, 2, 4, 6, 7 — «Agree» = 2 каждый: 10.
     * Обратные 3, 5, 8, 9, 10 — «Disagree»: сырой 1, обратный 3 − 1 = 2 каждый: 10.
     * Итого 20 из 30.
     */
    const answers = answer(survey, { ...each(DIRECT, "Согласен"), ...each(REVERSED, "Не согласен") });
    const s = score(computeProfile(survey, answers).scores, "RSES");
    expect(s.value).toBe(20);
    expect(s.maxScore).toBe(30);
    expect(s.band).toBeNull();
  });

  test("края: 0 и 30 — обратный ключ стоит ровно на 3, 5, 8, 9, 10", () => {
    // прямые «Strongly Disagree» = 0, обратные «Strongly Agree» = 3 − 3 = 0 → 0
    const low = answer(survey, {
      ...each(DIRECT, "Полностью не согласен"),
      ...each(REVERSED, "Полностью согласен"),
    });
    expect(score(computeProfile(survey, low).scores, "RSES").value).toBe(0);
    // зеркально: прямые 3, обратные 3 − 0 = 3 → 30
    const high = answer(survey, {
      ...each(DIRECT, "Полностью согласен"),
      ...each(REVERSED, "Полностью не согласен"),
    });
    expect(score(computeProfile(survey, high).scores, "RSES").value).toBe(30);
  });
});

/* ───────────────────────────── UCLA-3 ───────────────────────────── */

describe("золотой протокол: UCLA-3", () => {
  const survey = toSurveyFull(ucla3);

  test("пример досье: «Often», «Often», «Some of the time» → 3 + 3 + 2 = 8, без полосы", () => {
    const s = score(
      computeProfile(survey, answer(survey, { 1: "Часто", 2: "Часто", 3: "Иногда" })).scores,
      "UCLA3",
    );
    expect(s.value).toBe(8);
    expect(s.maxScore).toBe(9);
    expect(s.band).toBeNull();
  });

  test("края: все «Hardly ever» → 3, все «Often» → 9", () => {
    expect(score(computeProfile(survey, answer(survey, {}, "Почти никогда")).scores, "UCLA3").value).toBe(3);
    expect(score(computeProfile(survey, answer(survey, {}, "Часто")).scores, "UCLA3").value).toBe(9);
  });
});

/* ───────────────────────────── Brief COPE ───────────────────────────── */

describe("золотой протокол: Brief COPE", () => {
  const survey = toSurveyFull(briefCope);
  const NONE = "Совсем этого не делаю";
  const LOT = "Делаю это много";

  /*
   * Ключ Карвера, выписанный здесь независимо от файла методики: Self-
   * distraction 1, 19; Active coping 2, 7; Denial 3, 8; Substance use 4, 11;
   * Emotional support 5, 15; Instrumental support 10, 23; Behavioral
   * disengagement 6, 16; Venting 9, 21; Positive reframing 12, 17;
   * Planning 14, 25; Humor 18, 28; Acceptance 20, 24; Religion 22, 27;
   * Self-blame 13, 26.
   */
  const KEY: [string, [number, number]][] = [
    ["DISTR", [1, 19]],
    ["ACTIVE", [2, 7]],
    ["DENIAL", [3, 8]],
    ["SUBST", [4, 11]],
    ["EMOSUP", [5, 15]],
    ["INSTSUP", [10, 23]],
    ["DISENG", [6, 16]],
    ["VENT", [9, 21]],
    ["REFRAME", [12, 17]],
    ["PLAN", [14, 25]],
    ["HUMOR", [18, 28]],
    ["ACCEPT", [20, 24]],
    ["RELIG", [22, 27]],
    ["BLAME", [13, 26]],
  ];

  test("четырнадцать шкал по два пункта, общего балла нет, полос нет", () => {
    expect(survey.scales.map((s) => s.code).sort()).toEqual(KEY.map(([c]) => c).sort());
    for (const s of survey.scales) {
      expect(s.items.length, s.code).toBe(2);
      expect(s.bands, s.code).toEqual([]);
    }
  });

  test("пример досье: п. 4 = 3, п. 11 = 4 → «употребление веществ» 7, прочие по 2", () => {
    // 3 + 4 = 7 из 8; все остальные пункты «совсем не делаю» (1) → 1 + 1 = 2
    const { scores } = computeProfile(survey, answer(survey, { 4: "Делаю это умеренно", 11: LOT }, NONE));
    expect(score(scores, "SUBST").value).toBe(7);
    expect(score(scores, "SUBST").band).toBeNull();
    for (const [code] of KEY.filter(([c]) => c !== "SUBST")) {
      expect(score(scores, code).value, code).toBe(2);
    }
  });

  for (const [code, [a, b]] of KEY) {
    test(`шкала ${code}: «много» на пунктах ${a} и ${b} → 8, остальные шкалы 2`, () => {
      /*
       * 4 + 4 = 8 у своей шкалы; у каждой из тринадцати других оба пункта
       * «совсем не делаю»: 1 + 1 = 2. Пункт, ошибочно отнесённый не к той
       * шкале, даст здесь 5 вместо 8 у своей и 5 вместо 2 у чужой.
       */
      const { scores } = computeProfile(survey, answer(survey, { [a]: LOT, [b]: LOT }, NONE));
      expect(score(scores, code).value).toBe(8);
      expect(score(scores, code).maxScore).toBe(8);
      for (const [other] of KEY.filter(([c]) => c !== code)) {
        expect(score(scores, other).value, other).toBe(2);
      }
    });
  }
});
