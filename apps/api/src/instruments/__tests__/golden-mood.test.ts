import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { cesdr } from "../cesdr";
import { WORKING_TRANSLATION } from "../common";
import { DASS_KEY, dass42 } from "../dass42";
import { gad7 } from "../gad7";
import { gds15 } from "../gds15";
import { phq4 } from "../phq4";
import { phq8 } from "../phq8";
import { phq9 } from "../phq9";
import { pss10 } from "../pss10";
import { srq20 } from "../srq20";

/**
 * Золотые протоколы группы «mood» (досье docs/instruments/dossiers/mood.json).
 *
 * Как и в golden.test.ts: ответы прогоняются через движок, ожидаемые баллы
 * посчитаны руками по ключу из досье, расчёт — в комментарии рядом. По
 * примеру на каждую подшкалу. Если кто-то тронет ключ, обратный пункт, вес
 * варианта или полосу — упадёт здесь.
 *
 * Отдельный файл, а не golden.test.ts: четыре группы методик собираются
 * параллельно, и общий файл стал бы местом конфликта при слиянии.
 */

/*
 * Конвертер черновика в SurveyFull — копия toSurveyFull из golden.test.ts.
 *
 * Копия, а не импорт: там функция не экспортирована, а импорт из файла
 * тестов исполнил бы его верхний уровень, и describe-блоки СР-45 и
 * Мини-мульта прогонялись бы второй раз под именем этого файла. Вынести в
 * общий модуль — значит править golden.test.ts, который параллельно правят
 * соседние группы. Здесь нужно меньше полей: ни норм, ни стенов, ни поправок
 * у методик группы нет.
 */
function toSurveyFull(draft: unknown): SurveyFull {
  const input = createSurveySchema.parse(draft);
  const ru = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string }).ru ?? ""));
  const questions = input.questions.map((q, qi) => ({
    id: `q${qi + 1}`,
    surveyId: "s",
    sectionId: null,
    type: q.type,
    title: ru(q.title),
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
      text: ru(o.text),
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
    title: ru(s.title),
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
      label: ru(b.label),
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
    title: "golden-mood",
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/**
 * Ответы по порядку пунктов: число — позиция варианта (у всех методик
 * группы с вариантами-баллами она совпадает с баллом, кроме верхнего
 * варианта CESD-R), строка — код варианта «yes»/«no».
 */
function answer(survey: SurveyFull, picks: (number | string)[]): Answer[] {
  expect(picks.length, "ответов не столько, сколько пунктов").toBe(survey.questions.length);
  return survey.questions.map((q, i) => {
    const pick = picks[i]!;
    const option = typeof pick === "number" ? q.options[pick] : q.options.find((o) => o.keyCode === pick);
    if (!option) throw new Error(`пункт ${i + 1}: нет варианта «${pick}»`);
    return { questionId: q.id, optionIds: [option.id] };
  });
}

function scoreOf(draft: CreateSurveyDraft, picks: (number | string)[], code: string) {
  const survey = toSurveyFull(draft);
  const { scores } = computeProfile(survey, answer(survey, picks));
  const score = scores.find((s) => s.scaleCode === code);
  if (!score) throw new Error(`нет шкалы ${code}`);
  return score;
}

/** Вопросы черновика: в типе поле необязательное, у методик каталога оно есть всегда */
const qs = (draft: CreateSurveyDraft) => draft.questions ?? [];

/** Номера пунктов (с единицы), у которых хоть один вариант поднимает тревогу */
const riskItems = (draft: CreateSurveyDraft) =>
  qs(draft).flatMap((q, i) => (q.options?.some((o) => o.riskFlag) ? [i + 1] : []));

describe("золотой протокол: PHQ-9", () => {
  test("пример руководства: 16 баллов — «середньої тяжкості»", () => {
    // INSTRUCTION MANUAL, Table 3: три пункта по 1, два по 2, три по 3 (+ один 0).
    // 3+2+1+1+0+2+1+3+3 = 16 → полоса 15-19, grade 4, severe
    const s = scoreOf(phq9, [3, 2, 1, 1, 0, 2, 1, 3, 3], "PHQ");
    expect(s.rawScore).toBe(16);
    expect(s.maxScore).toBe(27);
    expect(s.band?.grade).toBe(4);
    expect(s.band?.severity).toBe("severe");
  });

  test("девятый пункт: любой ненулевой ответ — тревога, «декілька днів» умеренная, чаще — тяжёлая", () => {
    const options = qs(phq9)[8]!.options!;
    expect(options.map((o) => o.riskFlag ?? false)).toEqual([false, true, true, true]);
    expect(options.map((o) => o.riskSeverity ?? null)).toEqual([null, "moderate", "severe", "severe"]);
    expect(options.every((o) => !o.riskFlag || o.riskLabel)).toBe(true);
  });

  test("украинский текст — официальный МОЗ, оговорка о рабочем переводе только у русского", () => {
    /*
     * Первый пункт сверяется дословно с додатком 1 наказу МОЗ №1003: если его
     * «улучшат», текст перестанет быть официальным, а оговорки в описании
     * так и не появится.
     */
    expect(qs(phq9)[0]!.title).toEqual(
      expect.objectContaining({
        uk: "Дуже низька зацікавленість або задоволення від звичайних справ (відсутність бажання щось робити)",
      }),
    );
    const d = phq9.description as { uk: string; ru: string };
    expect(d.uk).not.toContain(WORKING_TRANSLATION.uk);
    expect(d.uk).toContain("№1003");
    expect(d.ru).toContain("рабочий перевод");
  });
});

describe("золотой протокол: PHQ-8", () => {
  test("пример руководства без девятого пункта: 16 − 3 = 13 — «помірної тяжкості»", () => {
    // 3+2+1+1+0+2+1+3 = 13 → полоса 10-14, grade 3, moderate
    const s = scoreOf(phq8, [3, 2, 1, 1, 0, 2, 1, 3], "PHQ8");
    expect(s.rawScore).toBe(13);
    expect(s.maxScore).toBe(24);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
  });

  test("пункты — ровно первые восемь пунктов PHQ-9, ни словом больше", () => {
    expect(qs(phq8).map((q) => q.title)).toEqual(qs(phq9).slice(0, 8).map((q) => q.title));
    expect(qs(phq8).map((q) => q.options)).toEqual(qs(phq9).slice(0, 8).map((q) => q.options));
  });
});

describe("золотой протокол: PHQ-4", () => {
  test("пример досье: общий 9, тревога 6, депрессия 3 — обе подшкалы положительны", () => {
    // пункты 1-2 — GAD-2, 3-4 — PHQ-2; ответы 3, 3, 2, 1
    const picks = [3, 3, 2, 1];
    // общий: 3+3+2+1 = 9 → полоса 9-12, grade 4, severe
    const total = scoreOf(phq4, picks, "PHQ4");
    expect(total.rawScore).toBe(9);
    expect(total.band?.grade).toBe(4);
    // тревога: 3+3 = 6 ≥ 3 → «скринінг позитивний»
    const anx = scoreOf(phq4, picks, "ANX");
    expect(anx.rawScore).toBe(6);
    expect(anx.band?.grade).toBe(2);
    // депрессия: 2+1 = 3 ≥ 3 — ровно на пороге, тоже положительна
    const dep = scoreOf(phq4, picks, "DEP");
    expect(dep.rawScore).toBe(3);
    expect(dep.band?.grade).toBe(2);
  });

  test("подшкала на балл ниже порога — отрицательна", () => {
    // тревога 1+1 = 2 < 3; депрессия 2+0 = 2 < 3; общий 4 → полоса 3-5
    const picks = [1, 1, 2, 0];
    expect(scoreOf(phq4, picks, "ANX").band?.grade).toBe(1);
    expect(scoreOf(phq4, picks, "DEP").band?.grade).toBe(1);
    expect(scoreOf(phq4, picks, "PHQ4").band?.grade).toBe(2);
  });
});

describe("золотой протокол: GAD-7", () => {
  test("все по 2: 7×2 = 14 — умеренная тревога", () => {
    const s = scoreOf(gad7, [2, 2, 2, 2, 2, 2, 2], "GAD");
    expect(s.rawScore).toBe(14);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
  });
});

describe("золотой протокол: CESD-R", () => {
  test("все «3-4 дні»: 20×2 = 40 — выше границы 16", () => {
    const s = scoreOf(cesdr, Array(20).fill(2), "CESDR");
    expect(s.rawScore).toBe(40);
    expect(s.band?.grade).toBe(2);
  });

  test("верхняя категория весит 3, а не 4: максимум 60, а не 80", () => {
    // «майже щодня протягом двох тижнів» — пятый вариант (позиция 4), CESD style score = 3
    const s = scoreOf(cesdr, Array(20).fill(4), "CESDR");
    expect(s.rawScore).toBe(60);
    expect(s.maxScore).toBe(60);
  });

  test("15 баллов — ещё ниже границы", () => {
    // пятнадцать пунктов по 1 («1-2 дні»), пять по 0: 15 < 16
    const s = scoreOf(cesdr, [...Array(15).fill(1), ...Array(5).fill(0)], "CESDR");
    expect(s.rawScore).toBe(15);
    expect(s.band?.grade).toBe(1);
  });
});

describe("золотой протокол: SRQ-20", () => {
  test("пример досье: девять «так» — выше бразильского порога 7/8", () => {
    // «так» на пунктах 1, 2, 3, 6, 8, 9, 11, 12, 18 → 9 ≥ 8
    const yes = new Set([1, 2, 3, 6, 8, 9, 11, 12, 18]);
    const picks = Array.from({ length: 20 }, (_, i) => (yes.has(i + 1) ? "yes" : "no"));
    const s = scoreOf(srq20, picks, "SRQ");
    expect(s.rawScore).toBe(9);
    expect(s.band?.grade).toBe(2);
  });

  test("семь «так» — ниже порога", () => {
    const picks = Array.from({ length: 20 }, (_, i) => (i < 7 ? "yes" : "no"));
    expect(scoreOf(srq20, picks, "SRQ").band?.grade).toBe(1);
  });
});

describe("золотой протокол: GDS-15", () => {
  test("пример досье: 7 баллов — «ознаки депресії»", () => {
    /*
     * Депрессивное направление: «так» у 2,3,4,6,8,9,10,12,14,15; «ні» у 1,5,7,11,13.
     * п.1 ні=1, п.2 так=1, п.3 так=1, п.4 так=1, п.5 так=0, п.6 так=1, п.7 так=0,
     * п.8 так=1, п.9 ні=0, п.10 так=1, п.11 так=0, п.12 ні=0, п.13 так=0,
     * п.14 ні=0, п.15 ні=0 → 7 → полоса 6-10
     */
    const picks = ["no", "yes", "yes", "yes", "yes", "yes", "yes", "yes", "no", "yes", "yes", "no", "yes", "no", "no"];
    const s = scoreOf(gds15, picks, "GDS");
    expect(s.rawScore).toBe(7);
    expect(s.band?.grade).toBe(2);
  });

  test("все «ні»: балл дают только пять обратных пунктов", () => {
    // 1, 5, 7, 11, 13 засчитываются за «ні» → 5 → полоса 0-5
    const s = scoreOf(gds15, Array(15).fill("no"), "GDS");
    expect(s.rawScore).toBe(5);
    expect(s.band?.grade).toBe(1);
  });
});

describe("золотой протокол: PSS-10", () => {
  test("пример досье: 26 из 40 — и никакой полосы", () => {
    /*
     * Прямые 1,2,3,6,9,10: 2+3+3+2+3+2 = 15.
     * Обратные 4,5,7,8 (0↔4, 1↔3): 1→3, 1→3, 2→2, 1→3 = 11. Итого 26.
     * Полосы нет: у разработчика порогов не существует.
     */
    const s = scoreOf(pss10, [2, 3, 3, 1, 1, 2, 2, 1, 3, 2], "PSS");
    expect(s.rawScore).toBe(26);
    expect(s.maxScore).toBe(40);
    expect(s.band).toBeNull();
  });

  test("полос у шкалы нет вовсе", () => {
    expect(pss10.scales?.every((s) => !s.bands?.length)).toBe(true);
  });
});

describe("золотой протокол: DASS-42", () => {
  /*
   * Ответы досье по пунктам 1-42:
   * 1,0,2,0,2,1,0,2,1,2, 1,1,3,1,0,2,2,1,0,1, 2,2,0,3,0,3,1,1,2,0, 2,1,2,2,1,0,2,2,1,0, 0,3
   */
  const picks = [
    1, 0, 2, 0, 2, 1, 0, 2, 1, 2, 1, 1, 3, 1, 0, 2, 2, 1, 0, 1, 2, 2, 0, 3, 0, 3, 1, 1, 2, 0, 2, 1, 2, 2, 1, 0,
    2, 2, 1, 0, 0, 3,
  ];

  test("депрессия: 32", () => {
    // пункты 3,5,10,13,16,17,21,24,26,31,34,37,38,42: 2+2+2+3+2+2+2+3+3+2+2+2+2+3 = 32
    const s = scoreOf(dass42, picks, "D");
    expect(s.rawScore).toBe(32);
    expect(s.maxScore).toBe(42);
    expect(s.band).toBeNull();
  });

  test("тревога: 3", () => {
    // пункты 2,4,7,9,15,19,20,23,25,28,30,36,40,41: 0+0+0+1+0+0+1+0+0+1+0+0+0+0 = 3
    const s = scoreOf(dass42, picks, "A");
    expect(s.rawScore).toBe(3);
    expect(s.band).toBeNull();
  });

  test("стресс: 18", () => {
    // пункты 1,6,8,11,12,14,18,22,27,29,32,33,35,39: 1+1+2+1+1+1+1+2+1+2+1+2+1+1 = 18
    const s = scoreOf(dass42, picks, "S");
    expect(s.rawScore).toBe(18);
    expect(s.band).toBeNull();
  });

  test("ключ шаблона: три подшкалы по 14 пунктов, каждый из 42 — ровно в одной", () => {
    const all: number[] = [...DASS_KEY.D, ...DASS_KEY.A, ...DASS_KEY.S].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
    for (const code of ["D", "A", "S"] as const) expect(DASS_KEY[code].length).toBe(14);
    // код шкалы у вопроса выведен из того же ключа
    qs(dass42).forEach((q, i) => {
      expect(q.scaleCode, `пункт ${i + 1}`).toBe(
        (["D", "A", "S"] as const).find((c) => (DASS_KEY[c] as readonly number[]).includes(i + 1)),
      );
    });
  });
});

/*
 * ─── Целостность группы ───
 *
 * То же, что integrity.test.ts делает для встроенных методик, но для группы
 * «mood» и здесь — по той же причине, что и золотые протоколы: общий список
 * INSTRUMENTS там правят все четыре группы сразу.
 */
const GROUP: [string, CreateSurveyDraft][] = [
  ["phq9", phq9],
  ["gad7", gad7],
  ["phq4", phq4],
  ["phq8", phq8],
  ["cesdr", cesdr],
  ["srq20", srq20],
  ["gds15", gds15],
  ["pss10", pss10],
  ["dass42", dass42],
];

/**
 * Пункты риска по досье (поле risk_items). Пропуск здесь — самая дорогая
 * ошибка каталога: ответ «хотів би померти» ляжет ждать приёма. Лишняя
 * разметка — тоже ошибка: тревога, которая звонит на всё, перестаёт звонить.
 * Поэтому сравнивается множество целиком, а не «содержит».
 */
const RISK_ITEMS: Record<string, number[]> = {
  phq9: [9],
  gad7: [],
  phq4: [],
  phq8: [],
  cesdr: [14, 15],
  srq20: [17],
  gds15: [],
  pss10: [],
  // пункт 21 — по досье; 38 — «близкий пункт» из того же обоснования досье
  dass42: [21, 38],
};

/** Все локализованные строки черновика: объекты ровно с ключами uk и ru */
function locs(node: unknown, path = "", out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(node)) node.forEach((v, i) => locs(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.includes("uk") || keys.includes("ru")) out.push([path, node]);
    else for (const k of keys) locs((node as Record<string, unknown>)[k], `${path}.${k}`, out);
  }
  return out;
}

describe("целостность группы «mood»", () => {
  for (const [key, draft] of GROUP) {
    test(`${key}: схема и структура без ошибок`, () => {
      const parsed = createSurveySchema.safeParse(draft);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
      }
      const errors = validateSurvey(parsed.data).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: пункты риска — по досье (DASS-42 п. 38 — по обоснованию досье к п. 21)`, () => {
      expect(riskItems(draft)).toEqual(RISK_ITEMS[key]!);
      // каждый критический вариант подписан: иначе персонал увидит голый текст пункта
      for (const q of qs(draft)) {
        for (const o of q.options ?? []) if (o.riskFlag) expect(o.riskLabel && o.riskSeverity).toBeTruthy();
      }
    });

    test(`${key}: шкала без полос объясняет, почему их нет`, () => {
      const silent = (draft.scales ?? []).filter((s) => !s.bands?.length && !s.description);
      expect(silent.map((s) => s.code)).toEqual([]);
    });

    test(`${key}: каждая строка на обоих языках`, () => {
      const mono = locs(draft).filter(([, v]) => {
        const l = v as { uk?: unknown; ru?: unknown };
        return !(typeof l.uk === "string" && l.uk.trim() && typeof l.ru === "string" && l.ru.trim());
      });
      expect(mono.map(([p]) => p)).toEqual([]);
    });
  }
});
