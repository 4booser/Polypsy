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
import { CATALOG } from "../catalog";
import { cgiI, cgiS } from "../cgi";
import { WORKING_TRANSLATION } from "../common";
import { hama } from "../hama";
import { hamd17 } from "../hamd17";

/**
 * Золотые протоколы группы «шкалы, которые заполняет специалист»
 * (docs/instruments/dossiers/clinician.json).
 *
 * Ожидаемые баллы посчитаны руками — расчёт в комментарии у каждого случая — и
 * совпадают с примерами досье. Опубликованных пошаговых примеров у шкал нет,
 * поэтому примеры арифметические, а границы полос проверяются с обеих сторон:
 * ошибка в одном балле якоря сдвигает человека через границу тяжести.
 *
 * Отдельный файл, а не golden.test.ts: группы собираются параллельно в разных
 * ветках, и общий файл был бы местом конфликта.
 */

/*
 * Конвертер описания методики в SurveyFull без БД — копия toSurveyFull из
 * golden-cognitive.test.ts (импорт тестового файла заново зарегистрировал бы
 * чужие describe), со scoringEnabled: им пользуется evaluateSubmission, через
 * который проверяется, что поднимает тревогу, а что — нет.
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

/**
 * Ответы по баллам: пункт `first + i` получает первый вариант с баллом
 * `scores[i]`. По баллу, а не по позиции: у пункта 16 HAM-D баллы 0–2 идут
 * дважды (по анамнезу и по взвешиванию).
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

/** Наибольшая возможная сумма шкалы — сумма верхних баллов её пунктов */
function maxOf(survey: SurveyFull, code: string): number {
  const scale = survey.scales.find((s) => s.code === code)!;
  return scale.items.reduce((sum, it) => {
    const q = survey.questions.find((x) => x.id === it.questionId)!;
    return sum + Math.max(...q.options.map((o) => o.score));
  }, 0);
}

/** Наименьшая возможная сумма шкалы — у шкал 1–7 она не ноль */
function minOf(survey: SurveyFull, code: string): number {
  const scale = survey.scales.find((s) => s.code === code)!;
  return scale.items.reduce((sum, it) => {
    const q = survey.questions.find((x) => x.id === it.questionId)!;
    return sum + Math.min(...q.options.map((o) => o.score));
  }, 0);
}

/**
 * Методики группы и то, что о каждой сказано в досье: какие варианты поднимают
 * тревогу («пункт/позиция варианта:тяжесть», с единицы и с нуля).
 */
interface Member {
  key: string;
  name: string;
  draft: CreateSurveyDraft;
  flags: string[];
}

const GROUP: Member[] = [
  // HAM-D-17 — тревога по пункту 3: 1–2 балла — умеренная, 3–4 — тяжёлая
  {
    key: "hamd17",
    name: "HAM-D-17",
    draft: hamd17,
    flags: ["3/1:moderate", "3/2:moderate", "3/3:severe", "3/4:severe"],
  },
  // HAM-A — пунктов о суициде и вреде нет, тревоги нет
  { key: "hama", name: "HAM-A", draft: hama, flags: [] },
  // CGI-S — одна общая оценка, пунктов риска нет
  { key: "cgi_s", name: "CGI-S", draft: cgiS, flags: [] },
  // CGI-I — одна оценка изменения, пунктов риска нет
  { key: "cgi_i", name: "CGI-I", draft: cgiI, flags: [] },
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

describe("группа «шкалы специалиста»: структура, язык, риск", () => {
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

    test(`${name}: в украинском нет русских букв, в русском — украинских, в словах нет латиницы`, () => {
      const bad = pairs(draft, name).flatMap(({ path, uk, ru }) => [
        ...(/[ыэъёЫЭЪЁ]/.test(uk) ? [`${path}.uk: ${uk.slice(0, 60)}`] : []),
        ...(/[іїєґІЇЄҐ]/.test(ru) ? [`${path}.ru: ${ru.slice(0, 60)}`] : []),
        ...[uk, ru].flatMap((text) =>
          text
            .split(/[^\p{L}]+/u)
            .filter((w) => /\p{Script=Cyrillic}/u.test(w) && /[A-Za-z]/.test(w))
            .map((w) => `${path}: латиница в слове «${w}»`),
        ),
      ]);
      expect(bad).toEqual([]);
    });

    test(`${name}: полосы покрывают каждый балл от минимума до максимума`, () => {
      const survey = toSurveyFull(draft);
      for (const scale of survey.scales.filter((s) => s.bands.length)) {
        const min = minOf(survey, scale.code);
        const max = maxOf(survey, scale.code);
        const holes: number[] = [];
        for (let v = min; v <= max; v++) {
          if (!scale.bands.some((b) => v >= b.minScore && v <= b.maxScore)) holes.push(v);
        }
        expect(holes, scale.code).toEqual([]);
        expect(Math.max(...scale.bands.map((b) => b.maxScore)), scale.code).toBe(max);
      }
    });

    test(`${name}: заполняет специалист, результат пациенту не показывается`, () => {
      expect(draft.administration).toBe("clinician");
      expect(draft.showResultsToPatient).toBe(false);
    });

    test(`${name}: рабочий перевод назван в примечании для персонала, а не в описании`, () => {
      const note = CATALOG.find((e) => e.draft === draft)!.note;
      expect(note).toContain(WORKING_TRANSLATION.uk);
      expect((draft.description as { uk: string }).uk).not.toContain(WORKING_TRANSLATION.uk);
    });

    test(`${name}: пункты риска — ровно по досье`, () => {
      /*
       * Лишний флаг — тоже ошибка: тревога без обоснования приучает не читать
       * тревоги. Тяжесть — в записи флага.
       */
      const flagged = (draft.questions ?? []).flatMap((q, qi) =>
        (q.options ?? []).flatMap((o, oi) => (o.riskFlag ? [`${qi + 1}/${oi}:${o.riskSeverity}`] : [])),
      );
      expect(flagged).toEqual(m.flags);
    });

    test(`${name}: полосы случая риска не открывают — это оценка самого специалиста`, () => {
      /*
       * Полоса moderate или severe поднимает тревогу и случай с оповещением
       * дежурному (packages/shared/src/risk.ts, detectBandRisks). У шкалы,
       * которую заполняет специалист, это сигнал ему же о том, что он только
       * что записал, — поэтому тяжесть полос не выше mild (hamd17.ts).
       * Мутация: вернуть «moderate» полосе «Помірна депресія» — падает здесь.
       */
      const heavy = (draft.scales ?? []).flatMap((s) =>
        (s.bands ?? []).filter((b) => b.severity === "moderate" || b.severity === "severe").map((b) => `${s.code}: ${b.minScore}–${b.maxScore}`),
      );
      expect(heavy).toEqual([]);
    });
  }
});

describe("золотой протокол: HAM-D-17", () => {
  const survey = toSurveyFull(hamd17);

  test("раскладка: 17 пунктов, девять 0–4 и восемь 0–2, пункт 16 — два способа оценки; максимум 52", () => {
    expect(hamd17.questions!.length).toBe(17);
    const five = [1, 2, 3, 7, 8, 9, 10, 11, 15];
    survey.questions.forEach((q, i) => {
      const n = i + 1;
      const scores = q.options.map((o) => o.score);
      if (n === 16) expect(scores, "пункт 16").toEqual([0, 1, 2, 0, 1, 2]);
      else if (five.includes(n)) expect(scores, `пункт ${n}`).toEqual([0, 1, 2, 3, 4]);
      else expect(scores, `пункт ${n}`).toEqual([0, 1, 2]);
    });
    expect(maxOf(survey, "HAMD")).toBe(52);
  });

  test("пример досье: 2+1+0+1+1+1+2+1+0+1+1+1+1+0+0+0+0 = 13 — лёгкая депрессия, тревоги нет", () => {
    const picks = byScores(survey, [2, 1, 0, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
    const s = scoreOf(survey, picks, "HAMD");
    expect(s.rawScore).toBe(13);
    expect(s.band?.grade).toBe(2);
    expect(evaluateSubmission(survey, answersOf(survey, picks)).risk.severity).toBeNull();
  });

  test("пример досье: 3+2+3+2+2+2+3+2+2+3+2+1+2+1+2+1+1 = 34 — тяжёлая депрессия; тяжёлая тревога — от пункта 3, а не от полосы", () => {
    const picks = byScores(survey, [3, 2, 3, 2, 2, 2, 3, 2, 2, 3, 2, 1, 2, 1, 2, 1, 1]);
    const s = scoreOf(survey, picks, "HAMD");
    expect(s.rawScore).toBe(34);
    expect(s.band?.grade).toBe(4);
    const risk = evaluateSubmission(survey, answersOf(survey, picks)).risk;
    expect(risk.severity).toBe("severe");
    expect(risk.bands).toEqual([]);
    expect(risk.answers.map((a) => a.questionId)).toEqual(["q3"]);
  });

  test("границы Zimmerman и соавт., 2013: 7 | 8, 16 | 17, 23 | 24", () => {
    // пункт 3 держится нулём: проверяются полосы, а не тревога
    const grade = (scores: number[]) => scoreOf(survey, byScores(survey, scores), "HAMD").band?.grade;
    // 4+3 = 7 → нет депрессии; 4+4 = 8 → лёгкая
    expect(grade([4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(grade([4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    // 4+4+4+4 = 16 → лёгкая; +1 в пункте 4 = 17 → умеренная
    expect(grade([4, 4, 0, 0, 0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    expect(grade([4, 4, 0, 1, 0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(3);
    // 4+4+4+4+4+3 = 23 → умеренная; 4×6 = 24 → тяжёлая
    expect(grade([4, 4, 0, 0, 0, 0, 4, 4, 4, 3, 0, 0, 0, 0, 0, 0, 0])).toBe(3);
    expect(grade([4, 4, 0, 0, 0, 0, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0])).toBe(4);
  });

  test("ноль и максимум: 0 — депрессия отсутствует, 52 — тяжёлая", () => {
    const zero = scoreOf(survey, byScores(survey, Array(17).fill(0)), "HAMD");
    expect(zero.rawScore).toBe(0);
    expect(zero.band?.severity).toBe("none");
    const top = byScores(survey, [4, 4, 4, 2, 2, 2, 4, 4, 4, 4, 4, 2, 2, 2, 4, 2, 2]);
    expect(scoreOf(survey, top, "HAMD").rawScore).toBe(52);
    expect(scoreOf(survey, top, "HAMD").band?.grade).toBe(4);
  });

  test("пункт 3: «немає» — без тревоги, 1–2 балла — умеренная, 3–4 — тяжёлая", () => {
    const at = (option: number) => {
      const scores = Array(17).fill(0);
      scores[2] = option;
      return evaluateSubmission(survey, answersOf(survey, byScores(survey, scores))).risk.severity;
    };
    expect((hamd17.questions![2]!.title as { uk: string }).uk).toContain("Суїцид");
    expect(at(0)).toBeNull();
    expect(at(1)).toBe("moderate");
    expect(at(2)).toBe("moderate");
    expect(at(3)).toBe("severe");
    expect(at(4)).toBe("severe");
  });

  test("пункт 16: по анамнезу и по взвешиванию — одни и те же баллы", () => {
    const history = byScores(survey, [...Array(15).fill(0), 2, 0]);
    expect(scoreOf(survey, history, "HAMD").rawScore).toBe(2);
    const weighed = { ...history, 16: 5 }; // «за зважуванням: понад 1 кг»
    expect(scoreOf(survey, weighed, "HAMD").rawScore).toBe(2);
    expect((hamd17.questions![15]!.options![5]!.text as { uk: string }).uk).toContain("За зважуванням");
  });
});

describe("золотой протокол: HAM-A", () => {
  const survey = toSurveyFull(hama);

  test("раскладка: 14 пунктов, у всех одна шкала 0–4; максимум 56", () => {
    expect(hama.questions!.length).toBe(14);
    for (const q of survey.questions) expect(q.options.map((o) => o.score)).toEqual([0, 1, 2, 3, 4]);
    expect(maxOf(survey, "HAMA")).toBe(56);
  });

  test("пример досье: 2+2+1+2+1+1+1+1+1+1+1+0+1+1 = 16 — умеренная тревога", () => {
    const s = scoreOf(survey, byScores(survey, [2, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1]), "HAMA");
    expect(s.rawScore).toBe(16);
    expect(s.band?.grade).toBe(3);
  });

  test("пример досье: 3+3+2+3+2+2+2+2+2+2+2+1+2+2 = 30 — тяжёлая тревога, но ни тревоги, ни случая", () => {
    const picks = byScores(survey, [3, 3, 2, 3, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2]);
    const s = scoreOf(survey, picks, "HAMA");
    expect(s.rawScore).toBe(30);
    expect(s.band?.grade).toBe(4);
    expect(evaluateSubmission(survey, answersOf(survey, picks)).risk.severity).toBeNull();
  });

  test("границы Matza и соавт., 2010: 7 | 8, 14 | 15, 23 | 24", () => {
    const grade = (scores: number[]) => scoreOf(survey, byScores(survey, scores), "HAMA").band?.grade;
    // 4+3 = 7 → нет; 4+4 = 8 → лёгкая
    expect(grade([4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(1);
    expect(grade([4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    // 4+4+4+2 = 14 → лёгкая; 4+4+4+3 = 15 → умеренная
    expect(grade([4, 4, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(2);
    expect(grade([4, 4, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(3);
    // 4×5 + 3 = 23 → умеренная; 4×6 = 24 → тяжёлая
    expect(grade([4, 4, 4, 4, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(3);
    expect(grade([4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(4);
  });

  test("ноль и максимум: 0 — тревога отсутствует, 56 — тяжёлая", () => {
    const zero = scoreOf(survey, byScores(survey, Array(14).fill(0)), "HAMA");
    expect(zero.rawScore).toBe(0);
    expect(zero.band?.severity).toBe("none");
    const top = scoreOf(survey, byScores(survey, Array(14).fill(4)), "HAMA");
    expect(top.rawScore).toBe(56);
    expect(top.band?.grade).toBe(4);
  });
});

describe("золотой протокол: CGI-S", () => {
  const survey = toSurveyFull(cgiS);

  test("раскладка: один пункт, ступени 1–7 без «не оценивалось»", () => {
    expect(cgiS.questions!.length).toBe(1);
    expect(survey.questions[0]!.options.map((o) => o.score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("каждая ступень — своя полоса с той же подписью, что у варианта", () => {
    for (let n = 1; n <= 7; n++) {
      const s = scoreOf(survey, { 1: n - 1 }, "CGIS");
      expect(s.rawScore).toBe(n);
      expect(s.band?.grade).toBe(n);
      expect(s.band?.label).toBe(survey.questions[0]!.options[n - 1]!.text);
    }
  });

  test("примеры досье: 4 — умеренное, 6 — тяжёлое; тревоги нет ни при какой ступени", () => {
    expect(scoreOf(survey, { 1: 3 }, "CGIS").band?.grade).toBe(4);
    expect(scoreOf(survey, { 1: 5 }, "CGIS").band?.grade).toBe(6);
    for (let pos = 0; pos < 7; pos++) {
      expect(evaluateSubmission(survey, answersOf(survey, { 1: pos })).risk.severity, `ступень ${pos + 1}`).toBeNull();
    }
  });

  test("полярность: «норма» — none, выше — mild: «краще ↓» выводится из полос", () => {
    const sev = survey.scales[0]!.bands.map((b) => b.severity);
    expect(sev).toEqual(["none", "mild", "mild", "mild", "mild", "mild", "mild"]);
  });
});

describe("золотой протокол: CGI-I", () => {
  const survey = toSurveyFull(cgiI);

  test("раскладка: один пункт, ступени 1–7 без «не оценивалось»; середина — «без изменений»", () => {
    expect(cgiI.questions!.length).toBe(1);
    expect(survey.questions[0]!.options.map((o) => o.score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((cgiI.questions![0]!.options![3]!.text as { uk: string }).uk).toBe("Без змін");
  });

  test("каждая ступень — своя полоса; улучшение — none, без изменений и ухудшение — mild", () => {
    for (let n = 1; n <= 7; n++) {
      const s = scoreOf(survey, { 1: n - 1 }, "CGII");
      expect(s.rawScore).toBe(n);
      expect(s.band?.grade).toBe(n);
      expect(s.band?.severity).toBe(n <= 3 ? "none" : "mild");
    }
  });

  test("примеры досье: 2 — значительное улучшение, 6 — значительное ухудшение; тревоги нет", () => {
    expect(scoreOf(survey, { 1: 1 }, "CGII").band?.grade).toBe(2);
    expect(scoreOf(survey, { 1: 5 }, "CGII").band?.grade).toBe(6);
    for (let pos = 0; pos < 7; pos++) {
      expect(evaluateSubmission(survey, answersOf(survey, { 1: pos })).risk.severity, `ступень ${pos + 1}`).toBeNull();
    }
  });
});
