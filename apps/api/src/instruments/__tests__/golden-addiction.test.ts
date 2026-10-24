import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  isQuestionVisible,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { detectRisks } from "../../lib/risk";
import { CATALOG } from "../catalog";
import { ciwaar } from "../ciwaar";
import { WORKING_TRANSLATION } from "../common";
import { cows } from "../cows";
import { cuditr } from "../cuditr";

/**
 * Золотые протоколы группы «addiction» (docs/instruments/dossiers/addiction.json):
 * CUDIT-R, CIWA-Ar, COWS.
 *
 * Ожидаемые баллы посчитаны руками — расчёт в комментарии у каждого случая — и
 * совпадают с проверочными примерами досье. Опубликованных пошаговых примеров у
 * всех трёх нет, поэтому примеры арифметические, а границы полос проверяются с
 * обеих сторон: у этих шкал ошибка в одном балле варианта сдвигает человека через
 * порог лечения (CIWA-Ar 10 и 20, COWS 13) или через порог «возможного
 * расстройства» (CUDIT-R 12).
 *
 * Отдельный файл, а не golden.test.ts: группы собираются параллельно в разных
 * ветках, и общий файл был бы местом конфликта.
 */

/*
 * Конвертер описания методики в SurveyFull без БД — копия toSurveyFull из
 * golden-behaviour.test.ts (с условиями показа: без них отсеивающий вопрос
 * CUDIT-R не проверить). Копия, а не импорт: импорт тестового файла заново
 * регистрирует его describe здесь.
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

/**
 * Ответы по баллам: пункт `first + i` получает вариант с баллом `scores[i]`.
 * По баллу, а не по позиции: у COWS баллы вариантов идут с пропусками (0/1/2/4),
 * и «позиция 3» там — это 4 балла, а не 3.
 */
function byScores(survey: SurveyFull, scores: number[], first = 1): Picks {
  const picks: Picks = {};
  scores.forEach((score, i) => {
    const n = first + i;
    const at = survey.questions[n - 1]!.options.findIndex((o) => o.score === score);
    if (at < 0) throw new Error(`пункт ${n}: нет варианта с баллом ${score}`);
    picks[n] = at;
  });
  return picks;
}

function scoreOf(survey: SurveyFull, picks: Picks, code: string) {
  const { scores } = computeProfile(survey, answersOf(survey, picks));
  const s = scores.find((x) => x.scaleCode === code);
  if (!s) throw new Error(`нет шкалы ${code}`);
  return s;
}

/**
 * Методики группы и то, что о каждой сказано в досье: кто заполняет, показан
 * ли результат, официальный ли украинский текст, какие варианты поднимают
 * тревогу («пункт/позиция варианта», с единицы и с нуля).
 */
interface Member {
  key: string;
  name: string;
  draft: CreateSurveyDraft;
  administration: "self" | "clinician";
  showResults: boolean;
  /** Украинский текст официальный (МОЗ) — оговорка о переводе только в русском */
  officialUk: boolean;
  flags: string[];
}

const GROUP: Member[] = [
  // CUDIT-R — самоотчёт с интерпретацией на бланке; тревога — п. 7 бланка (8-й в системе)
  {
    key: "cuditr",
    name: "CUDIT-R",
    draft: cuditr,
    administration: "self",
    showResults: true,
    officialUk: false,
    flags: ["8/1", "8/2", "8/3", "8/4"],
  },
  // CIWA-Ar — оценка специалиста, украинский текст — додаток 9 ГС 2025-1897
  {
    key: "ciwaar",
    name: "CIWA-Ar",
    draft: ciwaar,
    administration: "clinician",
    showResults: false,
    officialUk: true,
    flags: [],
  },
  // COWS — оценка специалиста, украинский текст — додаток 6 ГС 2025-1102
  {
    key: "cows",
    name: "COWS",
    draft: cows,
    administration: "clinician",
    showResults: false,
    officialUk: true,
    flags: [],
  },
];

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

/** Все пары «uk/ru» методики */
function pairs(value: unknown, path: string): { path: string; uk: string; ru: string }[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => pairs(v, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  if (typeof o.uk === "string" && typeof o.ru === "string") return [{ path, uk: o.uk, ru: o.ru }];
  return Object.entries(o).flatMap(([k, v]) => pairs(v, `${path}.${k}`));
}

/** Наибольшая возможная сумма шкалы — сумма верхних баллов её пунктов */
function maxOf(survey: SurveyFull, code: string): number {
  const scale = survey.scales.find((s) => s.code === code)!;
  return scale.items.reduce((sum, it) => {
    const q = survey.questions.find((x) => x.id === it.questionId)!;
    return sum + Math.max(...q.options.map((o) => o.score));
  }, 0);
}

describe("группа addiction: структура, язык, риск", () => {
  for (const m of GROUP) {
    const { key, name, draft } = m;

    test(`${name}: стоит в каталоге под ключом досье «${key}»`, () => {
      expect(CATALOG.find((e) => e.key === key)?.draft, `«${key}» нет в каталоге`).toBe(draft);
    });

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
       * Официальный украинский текст МОЗ здесь перенесён руками, и русская буква,
       * попавшая в него при наборе, выглядит на экране как опечатка МОЗ. Русский
       * текст с «і» или «є» — признак строки, скопированной не в то поле.
       */
      const bad = pairs(draft, name).flatMap(({ path, uk, ru }) => [
        ...(/[ыэъёЫЭЪЁ]/.test(uk) ? [`${path}.uk: ${uk.slice(0, 60)}`] : []),
        ...(/[іїєґІЇЄҐ]/.test(ru) ? [`${path}.ru: ${ru.slice(0, 60)}`] : []),
        // латинская буква внутри кириллического слова — невидимая опечатка набора
        ...[uk, ru].flatMap((text) =>
          text
            .split(/[^\p{L}]+/u)
            .filter((w) => /\p{Script=Cyrillic}/u.test(w) && /[A-Za-z]/.test(w))
            .map((w) => `${path}: латиница в слове «${w}»`),
        ),
      ]);
      expect(bad).toEqual([]);
    });

    test(`${name}: полосы покрывают каждый балл от 0 до максимума`, () => {
      const survey = toSurveyFull(draft);
      const scale = survey.scales[0]!;
      const max = maxOf(survey, scale.code);
      const holes: number[] = [];
      for (let v = 0; v <= max; v++) {
        if (!scale.bands.some((b) => v >= b.minScore && v <= b.maxScore)) holes.push(v);
      }
      expect(holes).toEqual([]);
      expect(Math.max(...scale.bands.map((b) => b.maxScore))).toBe(max);
    });

    test(`${name}: кто заполняет и показан ли результат — по досье`, () => {
      expect(draft.administration).toBe(m.administration);
      expect(draft.showResultsToPatient).toBe(m.showResults);
    });

    test(`${name}: рабочий перевод назван там, где он есть, и только там`, () => {
      /*
       * Официальный украинский текст (стандарты МОЗ 2025) — без оговорки, русский
       * при нём — рабочий, с оговоркой; без официального текста оговорка на обоих.
       */
      const desc = draft.description as { uk: string; ru: string };
      if (m.officialUk) expect(desc.uk).not.toContain(WORKING_TRANSLATION.uk);
      else expect(desc.uk).toContain(WORKING_TRANSLATION.uk);
      expect(desc.ru).toContain(WORKING_TRANSLATION.ru);
    });

    test(`${name}: пункты риска — ровно по досье`, () => {
      /*
       * risk_items досье: у CIWA-Ar и COWS — пусто, у CUDIT-R — употребление в
       * физически опасных ситуациях. Лишний флаг — тоже ошибка: тревога без
       * обоснования приучает не читать тревоги.
       */
      const flagged = (draft.questions ?? []).flatMap((q, qi) =>
        (q.options ?? []).flatMap((o, oi) => (o.riskFlag ? [`${qi + 1}/${oi}`] : [])),
      );
      expect(flagged).toEqual(m.flags);
      const severities = (draft.questions ?? []).flatMap((q) =>
        (q.options ?? []).filter((o) => o.riskFlag).map((o) => o.riskSeverity),
      );
      expect(severities.every((s) => s === "moderate")).toBe(true);
    });
  }
});

describe("золотой протокол: CUDIT-R", () => {
  const survey = toSurveyFull(cuditr);
  const YES = { 1: 1 } as Picks;
  const NO = { 1: 0 } as Picks;

  test("раскладка: отсеивающий вопрос вне ключа, восемь пунктов за ним, баллы бланка", () => {
    expect(cuditr.questions!.length).toBe(9);
    expect(cuditr.questions![0]!.scaleCode).toBeNull();
    expect(cuditr.scales![0]!.key!.map((k) => k.item)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    // пункты 1–7 бланка — 0…4; пункт 8 — 0 / 2 / 4
    for (let n = 2; n <= 8; n++) expect(survey.questions[n - 1]!.options.map((o) => o.score)).toEqual([0, 1, 2, 3, 4]);
    expect(survey.questions[8]!.options.map((o) => o.score)).toEqual([0, 2, 4]);
    expect(maxOf(survey, "CUDITR")).toBe(32);
  });

  test("пример досье: 3+2+1+1+0+2+0+2 = 11 — опасное употребление", () => {
    const s = scoreOf(survey, { ...YES, ...byScores(survey, [3, 2, 1, 1, 0, 2, 0, 2], 2) }, "CUDITR");
    expect(s.rawScore).toBe(11);
    expect(s.band?.grade).toBe(2);
    // mild: опасное употребление случая в очереди не открывает
    expect(s.band?.severity).toBe("mild");
  });

  test("пример досье: 4+3+2+2+1+3+1+4 = 20 — возможное расстройство, и тревога по пункту 7 бланка", () => {
    const picks = { ...YES, ...byScores(survey, [4, 3, 2, 2, 1, 3, 1, 4], 2) };
    const s = scoreOf(survey, picks, "CUDITR");
    expect(s.rawScore).toBe(20);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
    // «реже раза в месяц» в опасной ситуации — уже тревога
    expect(detectRisks(survey, answersOf(survey, picks)).map((r) => r.severity)).toEqual(["moderate"]);
  });

  test("«Ні» на отсеивающий вопрос: восемь пунктов скрыты, балл 0", () => {
    const answers = answersOf(survey, NO);
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    expect(visible.map((q) => q.id)).toEqual(["q1"]);
    const s = scoreOf(survey, NO, "CUDITR");
    expect(s.rawScore).toBe(0);
    expect(s.band?.grade).toBe(1);
  });

  test("«Так» на отсеивающий вопрос открывает все восемь пунктов", () => {
    const answers = answersOf(survey, YES);
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    expect(visible.length).toBe(9);
  });

  test("границы бланка: 7 | 8 и 11 | 12", () => {
    // 4+3+0+0+0+0+0+0 = 7 → ниже порога; +1 в пункте 3 бланка = 8 → опасное
    const grade = (scores: number[]) => scoreOf(survey, { ...YES, ...byScores(survey, scores, 2) }, "CUDITR").band?.grade;
    expect(grade([4, 3, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(grade([4, 3, 1, 0, 0, 0, 0, 0])).toBe(2);
    // 4+3+2+2+0+0+0+0 = 11 → опасное; 4+3+2+2+1 = 12 → возможное расстройство
    expect(grade([4, 3, 2, 2, 0, 0, 0, 0])).toBe(2);
    expect(grade([4, 3, 2, 2, 1, 0, 0, 0])).toBe(3);
  });

  test("пункт 7 бланка: «ніколи» — без тревоги, любая другая частота — умеренная", () => {
    const hazard = 8;
    expect((cuditr.questions![hazard - 1]!.title as { uk: string }).uk).toContain("фізично небезпечними");
    const calm = answersOf(survey, { ...YES, [hazard]: 0 });
    expect(detectRisks(survey, calm)).toEqual([]);
    for (let pos = 1; pos <= 4; pos++) {
      const risky = answersOf(survey, { ...YES, [hazard]: pos });
      expect(detectRisks(survey, risky).map((r) => r.severity), `вариант ${pos}`).toEqual(["moderate"]);
    }
  });
});

describe("золотой протокол: CIWA-Ar", () => {
  const survey = toSurveyFull(ciwaar);

  test("раскладка: десять пунктов, девять 0–7 и ориентировка 0–4, максимум 67", () => {
    expect(ciwaar.questions!.length).toBe(10);
    for (let n = 1; n <= 9; n++) {
      expect(survey.questions[n - 1]!.options.map((o) => o.score), `пункт ${n}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
    expect(survey.questions[9]!.options.map((o) => o.score)).toEqual([0, 1, 2, 3, 4]);
    expect(maxOf(survey, "CIWA")).toBe(67);
    // промежуточный балл без описания — одна цифра, как на бланке
    expect((ciwaar.questions![0]!.options![2]!.text as { uk: string }).uk).toBe("2");
    expect((ciwaar.questions![0]!.options![4]!.text as { uk: string }).uk).toBe(
      "4 — Періодична нудота з позивами на блювоту",
    );
  });

  test("пример досье: 1+0+4+0+1+0+4+1+1+0 = 12 — умеренный синдром отмены", () => {
    const s = scoreOf(survey, byScores(survey, [1, 0, 4, 0, 1, 0, 4, 1, 1, 0]), "CIWA");
    expect(s.rawScore).toBe(12);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("moderate");
  });

  test("пример досье: 4+3+4+2+4+2+4+2+4+2 = 31 — тяжёлый синдром отмены", () => {
    const s = scoreOf(survey, byScores(survey, [4, 3, 4, 2, 4, 2, 4, 2, 4, 2]), "CIWA");
    expect(s.rawScore).toBe(31);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("severe");
  });

  test("границы Стандарта МОЗ: 9 | 10 и 20 | 21", () => {
    const grade = (scores: number[]) => scoreOf(survey, byScores(survey, scores), "CIWA").band?.grade;
    // 7+2 = 9 → лёгкий; 7+3 = 10 → умеренный
    expect(grade([7, 2, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(grade([7, 3, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    // 7+7+6 = 20 → умеренный; 7+7+7 = 21 → тяжёлый
    expect(grade([7, 7, 6, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    expect(grade([7, 7, 7, 0, 0, 0, 0, 0, 0, 0])).toBe(3);
  });

  test("ноль и максимум: 0 — лёгкий (без тревоги), 67 — тяжёлый", () => {
    const zero = scoreOf(survey, byScores(survey, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "CIWA");
    expect(zero.rawScore).toBe(0);
    expect(zero.band?.severity).toBe("mild");
    const top = scoreOf(survey, byScores(survey, [7, 7, 7, 7, 7, 7, 7, 7, 7, 4]), "CIWA");
    expect(top.rawScore).toBe(67);
    expect(top.band?.severity).toBe("severe");
  });
});

describe("золотой протокол: COWS", () => {
  const survey = toSurveyFull(cows);

  test("раскладка: одиннадцать пунктов, баллы вариантов — как на бланке, с пропусками; максимум 48", () => {
    expect(cows.questions!.length).toBe(11);
    expect(survey.questions.map((q) => q.options.map((o) => o.score))).toEqual([
      [0, 1, 2, 4], // пульс
      [0, 1, 2, 3, 4], // потливость
      [0, 1, 3, 5], // беспокойство
      [0, 1, 2, 5], // зрачки
      [0, 1, 2, 4], // боль в костях и суставах
      [0, 1, 2, 4], // насморк, слезотечение
      [0, 1, 2, 3, 5], // ЖКТ
      [0, 1, 2, 4], // тремор
      [0, 1, 2, 4], // зевота
      [0, 1, 2, 4], // тревога, раздражительность
      [0, 3, 5], // «гусиная кожа»
    ]);
    expect(maxOf(survey, "COWS")).toBe(48);
  });

  test("пример досье: десять признаков по 1 и «гусиная кожа» 0 = 10 — лёгкий синдром", () => {
    const s = scoreOf(survey, byScores(survey, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]), "COWS");
    expect(s.rawScore).toBe(10);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("mild");
  });

  test("пример досье: 2+2+3+2+2+2+2+2+2+2+3 = 24 — умеренный, на балл выше — умеренно тяжёлый", () => {
    const s = scoreOf(survey, byScores(survey, [2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 3]), "COWS");
    expect(s.rawScore).toBe(24);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
    // 2+3+3+2+2+2+2+2+2+2+3 = 25
    const next = scoreOf(survey, byScores(survey, [2, 3, 3, 2, 2, 2, 2, 2, 2, 2, 3]), "COWS");
    expect(next.rawScore).toBe(25);
    expect(next.band?.grade).toBe(4);
    expect(next.band?.severity).toBe("moderate");
  });

  test("границы бланка: 4 | 5, 12 | 13, 36 | 37", () => {
    const at = (scores: number[]) => scoreOf(survey, byScores(survey, scores), "COWS");
    // 4 → ниже порога лёгкого; 4+1 = 5 → лёгкий
    expect(at([4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).band?.grade).toBe(1);
    expect(at([4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]).band?.grade).toBe(2);
    // пульс 4 + пот 4 + суставы 4 = 12 → лёгкий; пульс 4 + пот 4 + беспокойство 5 = 13 → умеренный
    const twelve = at([4, 4, 0, 0, 4, 0, 0, 0, 0, 0, 0]);
    expect(twelve.rawScore).toBe(12);
    expect(twelve.band?.grade).toBe(2);
    const thirteen = at([4, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(thirteen.rawScore).toBe(13);
    expect(thirteen.band?.grade).toBe(3);
    // 4+4+5+5+4+4+5+4+1 = 36 → умеренно тяжёлый; +1 = 37 → тяжёлый
    const moderatelySevere = at([4, 4, 5, 5, 4, 4, 5, 4, 1, 0, 0]);
    expect(moderatelySevere.rawScore).toBe(36);
    expect(moderatelySevere.band?.grade).toBe(4);
    const severe = at([4, 4, 5, 5, 4, 4, 5, 4, 2, 0, 0]);
    expect(severe.rawScore).toBe(37);
    expect(severe.band?.grade).toBe(5);
    expect(severe.band?.severity).toBe("severe");
  });

  test("все верхние варианты — 48, тяжёлый; все нижние — 0, без полосы тревоги", () => {
    const top = scoreOf(survey, byScores(survey, [4, 4, 5, 5, 4, 4, 5, 4, 4, 4, 5]), "COWS");
    expect(top.rawScore).toBe(48);
    expect(top.band?.severity).toBe("severe");
    const zero = scoreOf(survey, byScores(survey, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "COWS");
    expect(zero.rawScore).toBe(0);
    expect(zero.band?.severity).toBe("none");
  });
});
