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
import { asrs6 } from "../asrs6";
import { assist } from "../assist";
import { AUDIT_CONSUMPTION, audit10 } from "../audit10";
import { auditc } from "../auditc";
import { cage } from "../cage";
import { CBI_ORDER, cbi } from "../cbi";
import { WORKING_TRANSLATION } from "../common";

/**
 * Золотые протоколы группы «зависимости, внимание, выгорание»
 * (docs/instruments/dossiers/behaviour.json): CAGE, AUDIT-C, ASSIST, ASRS-6, CBI.
 *
 * Ожидаемые баллы посчитаны руками — расчёт в комментарии у каждого случая — и
 * сверены с проверочными примерами досье; у ASSIST — с опубликованным примером
 * ВОЗ (Appendix G, «Chloe»). Если кто-то тронет ключ, балл варианта, обратный
 * пункт или маршрут вопросов, эти тесты упадут первыми.
 *
 * Отдельный файл, а не golden.test.ts: группы методик собираются параллельно в
 * разных ветках, и общий файл был бы местом конфликта при каждом слиянии.
 */

/*
 * Конвертер описания методики в SurveyFull без БД — копия toSurveyFull из
 * golden.test.ts, дополненная условиями показа (ASSIST без них не проверить).
 *
 * Копия, а не импорт: golden.test.ts — тестовый файл, и импорт из него заново
 * регистрирует все его describe в этом файле, то есть гоняет чужие протоколы
 * дважды. Вынести конвертер в общий модуль — правильно, но параллельные ветки
 * сделали бы это одновременно и по-разному; это одно отдельное изменение после
 * слияния групп.
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

function scoreOf(survey: SurveyFull, picks: Picks, code: string) {
  const { scores } = computeProfile(survey, answersOf(survey, picks));
  const s = scores.find((x) => x.scaleCode === code);
  if (!s) throw new Error(`нет шкалы ${code}`);
  return s;
}

const GROUP = [
  ["CAGE", cage],
  ["AUDIT-C", auditc],
  ["ASSIST", assist],
  ["ASRS-6", asrs6],
  ["CBI", cbi],
] as const;

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

describe("группа behaviour: структура, язык, риск", () => {
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
      /*
       * Сторож двуязычия (test/content.test.ts) смотрит на посев, а каталог в
       * посев не входит — ставится установщиком. Без этой проверки одноязычная
       * строка методики каталога дошла бы до экрана пациента молча.
       */
      expect(monolingual(draft, name)).toEqual([]);
    });

    test(`${name}: у каждой шкалы есть полосы`, () => {
      // в досье полосы есть у всех пяти; шкала без них здесь — потерянная таблица
      for (const s of draft.scales ?? []) expect(s.bands?.length ?? 0, s.code).toBeGreaterThan(0);
    });
  }

  test("рабочий перевод назван там, где он есть, и только там", () => {
    /*
     * CAGE: украинский текст официальный (настанова МЗ) — без оговорки, русский
     * — рабочий, с оговоркой. Остальные четыре — рабочий перевод на обоих языках.
     */
    const desc = (d: typeof cage) => d.description as { uk: string; ru: string };
    expect(desc(cage).uk).not.toContain(WORKING_TRANSLATION.uk);
    expect(desc(cage).ru).toContain(WORKING_TRANSLATION.ru);
    for (const d of [auditc, assist, asrs6, cbi]) {
      expect(desc(d).uk).toContain(WORKING_TRANSLATION.uk);
      expect(desc(d).ru).toContain(WORKING_TRANSLATION.ru);
    }
  });

  test("пункты риска — ровно по досье: только ASSIST Q8, «да, за последние 3 месяца»", () => {
    /*
     * risk_items досье: у CAGE, AUDIT-C, ASRS-6, CBI — пусто, у ASSIST — Q8
     * (инъекции). Лишний флаг тоже ошибка: тревога без правила первоисточника
     * приучает не читать тревоги.
     */
    for (const [name, draft] of GROUP) {
      const flagged = (draft.questions ?? []).flatMap((q, qi) =>
        (q.options ?? []).flatMap((o, oi) => (o.riskFlag ? [`${name} ${qi + 1}/${oi}`] : [])),
      );
      expect(flagged).toEqual(name === "ASSIST" ? [`ASSIST ${ASSIST_Q8}/1`] : []);
    }
    const q8 = assist.questions![ASSIST_Q8 - 1]!;
    expect(q8.options![1]!.riskSeverity).toBe("moderate");
  });
});

describe("золотой протокол: CAGE", () => {
  const survey = toSurveyFull(cage);

  test("пример досье: «да» на C и G — 2 балла, порог достигнут", () => {
    // [Да, Нет, Да, Нет] → 1+0+1+0 = 2 ≥ 2 → «подальша оцінка»
    const s = scoreOf(survey, inOrder([1, 0, 1, 0]), "CAGE");
    expect(s.rawScore).toBe(2);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("moderate");
  });

  test("одно «да» — ниже порога", () => {
    // [Нет, Нет, Нет, Да] → 1 < 2
    const s = scoreOf(survey, inOrder([0, 0, 0, 1]), "CAGE");
    expect(s.rawScore).toBe(1);
    expect(s.band?.grade).toBe(1);
  });
});

describe("золотой протокол: AUDIT-C", () => {
  const survey = toSurveyFull(auditc);

  test("пример досье: 3 + 2 + 2 = 7 — положительный (≥4, мужской порог)", () => {
    // «2–3 рази на тиждень» = 3, «5–6» = 2, «Щомісяця» = 2
    const s = scoreOf(survey, inOrder([3, 2, 2]), "AUDITC");
    expect(s.rawScore).toBe(7);
    expect(s.band?.grade).toBe(2);
  });

  test("граница: 3 — отрицательный, 4 — положительный", () => {
    // 2 + 1 + 0 = 3; 2 + 1 + 1 = 4
    expect(scoreOf(survey, inOrder([2, 1, 0]), "AUDITC").band?.grade).toBe(1);
    expect(scoreOf(survey, inOrder([2, 1, 1]), "AUDITC").band?.grade).toBe(2);
  });

  test("вопросы — те же, что пункты 1–3 AUDIT каталога, буква в букву", () => {
    /*
     * Если кто-то поправит формулировку или балл в AUDIT, AUDIT-C обязан
     * измениться вместе с ним — иначе два замера одного человека по одинаковым
     * вопросам перестанут сравниваться.
     */
    const strip = (q: NonNullable<typeof audit10.questions>[number]) => ({ ...q, scaleCode: null });
    expect(AUDIT_CONSUMPTION.length).toBe(3);
    expect(auditc.questions!.map(strip)).toEqual(audit10.questions!.slice(0, 3).map(strip));
  });
});

describe("золотой протокол: ASRS-6", () => {
  const survey = toSurveyFull(asrs6);
  // позиции вариантов: 0 Никогда, 1 Редко, 2 Иногда, 3 Часто, 4 Очень часто

  test("пример досье: четыре отметки в затемнённой зоне — положительный", () => {
    // Иногда(зона) · Часто(зона) · Иногда(зона) · Часто(зона) · Редко · Никогда → 4
    const s = scoreOf(survey, inOrder([2, 3, 2, 3, 1, 0]), "ASRS");
    expect(s.rawScore).toBe(4);
    expect(s.band?.grade).toBe(2);
  });

  test("шесть «Иногда» — три отметки: в пунктах 4–6 «Иногда» вне зоны", () => {
    // 1+1+1 (пункты 1–3) + 0+0+0 (пункты 4–6) = 3 < 4
    const s = scoreOf(survey, inOrder([2, 2, 2, 2, 2, 2]), "ASRS");
    expect(s.rawScore).toBe(3);
    expect(s.band?.grade).toBe(1);
  });

  test("высокая сумма частот при трёх отметках — отрицательный", () => {
    /*
     * Главная ловушка. Редко ×3 + Очень часто ×3: сумма частот 1+1+1+4+4+4 = 15
     * — больше, чем у положительного примера выше (2+3+2+3+1+0 = 11). Но
     * отметок в зоне три (только пункты 4–6), и скрининг отрицательный.
     * Реализация «сумма частот с порогом» здесь ответила бы наоборот.
     */
    const s = scoreOf(survey, inOrder([1, 1, 1, 4, 4, 4]), "ASRS");
    expect(s.rawScore).toBe(3);
    expect(s.band?.grade).toBe(1);
    expect(s.maxScore).toBe(6);
  });
});

describe("золотой протокол: CBI", () => {
  const survey = toSurveyFull(cbi);
  /** Номер пункта на экране по шкале и номеру пункта у правообладателя */
  const at = (scale: string, n: number) => CBI_ORDER.findIndex((o) => o.scale === scale && o.n === n) + 1;
  // позиции вариантов: 0 — 100 баллов (Всегда / В очень высокой степени) … 4 — 0 баллов

  test("пример досье: личное выгорание, все шесть «Иногда» — 50", () => {
    // среднее (50×6)/6 = 50,0; датская форма: 2×6 = 12 из 24 → полоса 12–17 = 50–74,999
    const picks: Picks = {};
    for (let n = 1; n <= 6; n++) picks[at("PB", n)] = 2;
    const s = scoreOf(survey, picks, "PB");
    expect(s.rawScore).toBe(50);
    expect(s.band?.grade).toBe(3);
    // mild: полоса 50–74 не открывает случай в очереди риска (см. cbi.ts)
    expect(s.band?.severity).toBe("mild");
  });

  test("пример досье: обратный пункт 7 шкалы работы — «Всегда» даёт 0, а не 100", () => {
    /*
     * Пункты 1–6 — 0 баллов, пункт 7 («хватает ли сил на семью и друзей») —
     * «Всегда» = 100 до инверсии, 0 после. Итог (0×6 + 0)/7 = 0. Без реверса тот
     * же набор дал бы 100/7 ≈ 14,286.
     */
    const picks: Picks = {};
    for (let n = 1; n <= 6; n++) picks[at("WB", n)] = 4;
    picks[at("WB", 7)] = 0;
    const s = scoreOf(survey, picks, "WB");
    expect(s.rawScore).toBe(0);
    expect(s.band?.grade).toBe(1);
  });

  test("клиенты: смешанные ответы — 45,833, вторая полоса; сверка с датской суммой", () => {
    /*
     * 1 «В очень высокой степени» 100, 2 «В высокой» 75, 3 «В некоторой» 50,
     * 4 «В низкой» 25, 5 «Редко» 25, 6 «Никогда» 0: (100+75+50+25+25+0)/6 =
     * 275/6 = 45,833. Датская форма: 4+3+2+1+1+0 = 11 из 24 → полоса 6–11, вторая.
     */
    const picks: Picks = {
      [at("CB", 1)]: 0,
      [at("CB", 2)]: 1,
      [at("CB", 3)]: 2,
      [at("CB", 4)]: 3,
      [at("CB", 5)]: 3,
      [at("CB", 6)]: 4,
    };
    const s = scoreOf(survey, picks, "CB");
    expect(s.rawScore).toBe(45.833);
    expect(s.band?.grade).toBe(2);
  });

  test("границы полос совпадают с датскими: 6 из 24 и 7 из 28 — это ровно 25", () => {
    // личное: пять «Никогда» и одно «Всегда» → 100/6 = 16,667 (1-я); датская сумма 4 из 24
    const low: Picks = {};
    for (let n = 1; n <= 6; n++) low[at("PB", n)] = 4;
    low[at("PB", 1)] = 0;
    expect(scoreOf(survey, low, "PB").band?.grade).toBe(1);
    // работа: пункт 1 «В очень высокой степени» (100), 2–6 «0», 7 «Никогда» (0 → реверс 100)
    // (100 + 0×5 + 100)/7 = 28,571; датская сумма 4+0+4 = 8 из 28 → 7–13, вторая
    const work: Picks = {};
    for (let n = 1; n <= 6; n++) work[at("WB", n)] = 4;
    work[at("WB", 1)] = 0;
    work[at("WB", 7)] = 4;
    const w = scoreOf(survey, work, "WB");
    expect(w.rawScore).toBe(28.571);
    expect(w.band?.grade).toBe(2);
  });

  test("каждая из трёх шкал получает все свои пункты и только их", () => {
    const sizes = Object.fromEntries((cbi.scales ?? []).map((s) => [s.code, s.key?.length]));
    expect(sizes).toEqual({ PB: 6, WB: 7, CB: 6 });
    expect(cbi.questions!.length).toBe(19);
  });
});

/*
 * Раскладка ASSIST — порядок бланка ВОЗ: Q1 a–j (1–10), уточнение «другие» (11),
 * Q2 a–j (12–21), Q3 a–j (22–31), Q4 a–j (32–41), Q5 b–j (42–50, у табака Q5
 * нет), Q6 a–j (51–60), Q7 a–j (61–70), Q8 (71). Посчитана здесь независимо от
 * сборки методики: ошибка порядка в сборке уронит проверку заголовков ниже.
 */
const LETTERS = "abcdefghij";
function assistItem(question: number, letter: string): number {
  const i = LETTERS.indexOf(letter);
  if (question === 1) return 1 + i;
  if (question === 5) {
    if (letter === "a") throw new Error("Q5 по табаку не кодируется");
    return 42 + i - 1;
  }
  const start: Record<number, number> = { 2: 12, 3: 22, 4: 32, 6: 51, 7: 61 };
  return start[question]! + i;
}
const ASSIST_Q8 = 71;
const ASSIST_SPECIFY = 11;

describe("золотой протокол: ASSIST", () => {
  const survey = toSurveyFull(assist);
  const Q1 = { no: 0, yes: 1 };
  const F = { never: 0, onceTwice: 1, monthly: 2, weekly: 3, daily: 4 };
  const LIFE = { no: 0, yes3m: 1, yesBefore: 2 };

  test("раскладка: 71 пункт, заголовки на своих местах", () => {
    expect(assist.questions!.length).toBe(71);
    const uk = (n: number) => (assist.questions![n - 1]!.title as { uk: string }).uk;
    expect(uk(assistItem(1, "b"))).toContain("алкогольні напої");
    expect(uk(assistItem(2, "c"))).toContain("як часто ви вживали канабіс");
    expect(uk(assistItem(3, "i"))).toContain("потяг вжити опіоїди");
    expect(uk(assistItem(4, "a"))).toContain("вживання тютюнових виробів");
    expect(uk(assistItem(5, "b"))).toContain("не робили того");
    expect(uk(assistItem(5, "b"))).toContain("алкогольних напоїв");
    expect(uk(assistItem(5, "j"))).toContain("інших речовин");
    expect(uk(assistItem(6, "g"))).toContain("седативних або снодійних засобів");
    expect(uk(assistItem(7, "j"))).toContain("інших речовин");
    expect(uk(ASSIST_Q8)).toContain("ін’єкційно");
    expect(assist.questions![ASSIST_SPECIFY - 1]!.type).toBe("text");
  });

  /*
   * Опубликованный пример ВОЗ: Appendix G, «Client script ASSIST v3.1 (Chloe)»
   * и таблица «Role play Chloe's scoring». Ответы в скобках в сценарии — те, что
   * интервьюер задавать не должен был (фильтр); здесь их нет.
   */
  const chloe: Picks = {
    [assistItem(1, "a")]: Q1.yes,
    [assistItem(1, "b")]: Q1.yes,
    [assistItem(1, "c")]: Q1.yes,
    [assistItem(1, "d")]: Q1.no,
    [assistItem(1, "e")]: Q1.yes,
    [assistItem(1, "f")]: Q1.yes,
    [assistItem(1, "g")]: Q1.yes,
    [assistItem(1, "h")]: Q1.no,
    [assistItem(1, "i")]: Q1.no,
    [assistItem(1, "j")]: Q1.no,
    // Q2: табак, алкоголь — каждый день; каннабис — раз-два; ATS — раз в неделю;
    // ингалянты — «nitrous oxide twice»; седативные — не за 3 месяца
    [assistItem(2, "a")]: F.daily,
    [assistItem(2, "b")]: F.daily,
    [assistItem(2, "c")]: F.onceTwice,
    [assistItem(2, "e")]: F.weekly,
    [assistItem(2, "f")]: F.onceTwice,
    [assistItem(2, "g")]: F.never,
    // Q3–Q5 — только a, b, c, e, f (употреблялись за 3 месяца)
    [assistItem(3, "a")]: F.daily,
    [assistItem(3, "b")]: F.never,
    [assistItem(3, "c")]: F.never,
    [assistItem(3, "e")]: F.onceTwice,
    [assistItem(3, "f")]: F.never,
    [assistItem(4, "a")]: F.onceTwice,
    [assistItem(4, "b")]: F.monthly, // «once every fortnight» → monthly
    [assistItem(4, "c")]: F.never,
    [assistItem(4, "e")]: F.onceTwice,
    [assistItem(4, "f")]: F.never,
    [assistItem(5, "b")]: F.never,
    [assistItem(5, "c")]: F.never,
    [assistItem(5, "e")]: F.never,
    [assistItem(5, "f")]: F.never,
    // Q6–Q7 — по всем, что употреблялись когда-либо: a, b, c, e, f, g
    [assistItem(6, "a")]: LIFE.yesBefore,
    [assistItem(6, "b")]: LIFE.yesBefore,
    [assistItem(6, "c")]: LIFE.no,
    [assistItem(6, "e")]: LIFE.yes3m,
    [assistItem(6, "f")]: LIFE.no,
    [assistItem(6, "g")]: LIFE.yesBefore,
    [assistItem(7, "a")]: LIFE.yes3m,
    [assistItem(7, "b")]: LIFE.no,
    [assistItem(7, "c")]: LIFE.no,
    [assistItem(7, "e")]: LIFE.no,
    [assistItem(7, "f")]: LIFE.no,
    [assistItem(7, "g")]: LIFE.no, // «cut down … successful the first time» — не «failed»
    [ASSIST_Q8]: LIFE.no,
  };

  test("Chloe: маршрут бланка — показано ровно то, что спрошено", () => {
    /*
     * Каждый отвеченный пункт виден при этих ответах, и каждый видимый
     * обязательный пункт отвечен. Кокаин, галлюциногены, опиоиды, «другие»
     * отфильтрованы Q1; Q3–Q5 по седативным — Q2 («не за 3 месяца»).
     */
    const answers = answersOf(survey, chloe);
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    const answered = new Set(answers.map((a) => a.questionId));
    expect(visible.map((q) => q.id).sort()).toEqual([...answered].sort());
  });

  test("Chloe: баллы по веществам совпадают с таблицей ВОЗ", () => {
    /*
     * a 6+6+4+(Q5 нет)+3+6 = 25 · b 6+0+5+0+3+0 = 14 · c 2+0+0+0+0+0 = 2 · d 0 ·
     * e 4+3+4+0+6+0 = 17 · f 2+0+0+0+0+0 = 2 · g 0+3+0 = 3 · h, i, j — 0.
     */
    const { scores } = computeProfile(survey, answersOf(survey, chloe));
    const got = Object.fromEntries(scores.map((s) => [s.scaleCode, s.rawScore]));
    expect(got).toEqual({
      TOB: 25,
      ALC: 14,
      CAN: 2,
      COC: 0,
      ATS: 17,
      INH: 2,
      SED: 3,
      HAL: 0,
      OPI: 0,
      OTH: 0,
    });
    const grade = Object.fromEntries(scores.map((s) => [s.scaleCode, s.band?.grade]));
    // 25, 17 → 4–26 краткое вмешательство; 14 → у алкоголя 11–26 тоже краткое;
    // 2, 2, 3 → 0–3 вмешательство не нужно
    expect(grade).toMatchObject({ TOB: 2, ALC: 2, ATS: 2, CAN: 1, INH: 1, SED: 1 });
  });

  test("у алкоголя порог выше: 10 — ещё без вмешательства, у каннабиса 4 — уже краткое", () => {
    // алкоголь: Q2 раз в неделю 4 + Q4 раз-два 4 + Q6 «да, раньше» 3 = 11 → краткое;
    // без Q6: 8 → вмешательство не нужно
    const base: Picks = {
      [assistItem(1, "b")]: Q1.yes,
      [assistItem(2, "b")]: F.weekly,
      [assistItem(3, "b")]: F.never,
      [assistItem(4, "b")]: F.onceTwice,
      [assistItem(5, "b")]: F.never,
      [assistItem(6, "b")]: LIFE.no,
      [assistItem(7, "b")]: LIFE.no,
    };
    expect(scoreOf(survey, base, "ALC").rawScore).toBe(8);
    expect(scoreOf(survey, base, "ALC").band?.grade).toBe(1);
    const more = { ...base, [assistItem(6, "b")]: LIFE.yesBefore };
    expect(scoreOf(survey, more, "ALC").rawScore).toBe(11);
    expect(scoreOf(survey, more, "ALC").band?.grade).toBe(2);
    // каннабис: Q2 ежемесячно 3 + Q3 никогда 0 … = 3 → нет; Q2 еженедельно 4 → краткое
    const can = (freq: number): Picks => ({
      [assistItem(1, "c")]: Q1.yes,
      [assistItem(2, "c")]: freq,
      [assistItem(3, "c")]: F.never,
      [assistItem(4, "c")]: F.never,
      [assistItem(5, "c")]: F.never,
      [assistItem(6, "c")]: LIFE.no,
      [assistItem(7, "c")]: LIFE.no,
    });
    expect(scoreOf(survey, can(F.monthly), "CAN").band?.grade).toBe(1);
    expect(scoreOf(survey, can(F.weekly), "CAN").band?.grade).toBe(2);
  });

  test("верх шкал: табак 31 (без Q5), алкоголь 39, «другие» 38 (Q5j по бланку 0/4/5/6/7)", () => {
    const worst = (letter: string): Picks => {
      const p: Picks = { [assistItem(1, letter)]: Q1.yes };
      for (const q of [2, 3, 4, 5]) if (!(q === 5 && letter === "a")) p[assistItem(q, letter)] = F.daily;
      p[assistItem(6, letter)] = LIFE.yes3m;
      p[assistItem(7, letter)] = LIFE.yes3m;
      return p;
    };
    // табак 6+6+7+6+6 = 31; алкоголь 6+6+7+8+6+6 = 39; другие 6+6+7+7+6+6 = 38
    for (const [letter, code, max] of [
      ["a", "TOB", 31],
      ["b", "ALC", 39],
      ["j", "OTH", 38],
    ] as const) {
      const s = scoreOf(survey, worst(letter), code);
      expect(s.rawScore).toBe(max);
      expect(s.maxScore).toBe(max);
      expect(s.band?.grade).toBe(3);
      expect(s.band?.severity).toBe("moderate");
    }
  });

  test("Q1 переключили на «нет» после ответа на Q2 — Q3–Q5 снова скрыты", () => {
    /*
     * Прежний ответ Q2 остаётся в памяти формы. Одно условие «Q2 > 0» снова
     * показало бы Q3–Q5 по веществу, которого человек не употреблял.
     */
    const stale = answersOf(survey, {
      [assistItem(1, "c")]: Q1.no,
      [assistItem(2, "c")]: F.weekly,
    });
    const map = new Map(stale.map((a) => [a.questionId, a]));
    for (const q of [3, 4, 5]) {
      const question = survey.questions[assistItem(q, "c") - 1]!;
      expect(isQuestionVisible(question, survey.questions, map), `Q${q}c`).toBe(false);
    }
  });

  test("все «нет» в Q1: показаны только Q1 и Q8, все баллы — ноль", () => {
    const picks: Picks = {};
    for (const letter of LETTERS) picks[assistItem(1, letter)] = Q1.no;
    picks[ASSIST_Q8] = LIFE.no;
    const answers = answersOf(survey, picks);
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    expect(visible.length).toBe(11);
    const { scores } = computeProfile(survey, answers);
    expect(scores.every((s) => s.rawScore === 0 && s.band?.grade === 1)).toBe(true);
  });

  test("Q8: инъекции за 3 месяца поднимают тревогу, но в балл не входят", () => {
    const recent = answersOf(survey, { [ASSIST_Q8]: LIFE.yes3m });
    expect(detectRisks(survey, recent).map((r) => r.severity)).toEqual(["moderate"]);
    expect(detectRisks(survey, answersOf(survey, { [ASSIST_Q8]: LIFE.yesBefore }))).toEqual([]);
    const { scores } = computeProfile(survey, recent);
    expect(scores.every((s) => s.rawScore === 0)).toBe(true);
  });
});
