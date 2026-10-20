import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { CATALOG } from "../catalog";
import { WORKING_TRANSLATION } from "../common";
import { CORE10_REVERSE, CORE10_RISK_ITEM, CST_COPYRIGHT, core10 } from "../core10";
import { DASS21_KEY, DASS21_UK_WORKING_ITEM, dass21 } from "../dass21";
import { gad2 } from "../gad2";
import { gad7 } from "../gad7";
import { KESSLER_COPYRIGHT, k10 } from "../k10";
import { K6_FROM_K10, k6 } from "../k6";
import { PHQ15_WOMEN_ONLY, phq15 } from "../phq15";
import { phq2 } from "../phq2";
import { phq9 } from "../phq9";

/**
 * Золотые протоколы группы «distress» (docs/instruments/dossiers/distress.json):
 * DASS-21, K10, K6, PHQ-15, PHQ-2, GAD-2, CORE-10.
 *
 * Ответы прогоняются через движок, ожидаемые баллы — из примеров досье,
 * посчитанных по ключу из первоисточника; расчёт — в комментарии рядом. У
 * методик с подшкалами или обратными пунктами примеров по два и больше. Если
 * кто-то тронет ключ, вес, обратный пункт, вариант или полосу — упадёт здесь.
 *
 * Отдельный файл, а не golden-mood.test.ts: группы каталога 2.1 собираются
 * параллельно, и общий файл стал бы местом конфликта при слиянии.
 */

/*
 * Конвертер черновика в SurveyFull — копия из golden-mood.test.ts (там он не
 * экспортирован, а импорт тестового файла исполнил бы его describe-блоки
 * второй раз). Отличие одно: переносится minAnsweredShare — без него правило
 * CORE-10 «не больше одного пропуска» здесь не проверялось бы.
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
    minAnsweredShare: s.minAnsweredShare ?? null,
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
    title: "golden-distress",
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/**
 * Ответы по порядку пунктов: число — БАЛЛ варианта (у обратных пунктов — балл
 * до обращения, как на бланке), null — пункт пропущен. Выбор по баллу, а не по
 * позиции: у K10 баллы 1-5, и позиция с баллом не совпадает.
 */
function answer(survey: SurveyFull, picks: (number | null)[]): Answer[] {
  expect(picks.length, "ответов не столько, сколько пунктов").toBe(survey.questions.length);
  return survey.questions.flatMap((q, i) => {
    const pick = picks[i];
    if (pick === null || pick === undefined) return [];
    const option = q.options.find((o) => o.score === pick);
    if (!option) throw new Error(`пункт ${i + 1}: нет варианта с баллом ${pick}`);
    return [{ questionId: q.id, optionIds: [option.id] }];
  });
}

function profileOf(draft: CreateSurveyDraft, picks: (number | null)[]) {
  const survey = toSurveyFull(draft);
  return computeProfile(survey, answer(survey, picks));
}

function scoreOf(draft: CreateSurveyDraft, picks: (number | null)[], code: string) {
  const score = profileOf(draft, picks).scores.find((s) => s.scaleCode === code);
  if (!score) throw new Error(`нет шкалы ${code}`);
  return score;
}

/** Вопросы черновика: в типе поле необязательное, у методик каталога оно есть всегда */
const qs = (draft: CreateSurveyDraft) => draft.questions ?? [];

/** Номера пунктов (с единицы), у которых хоть один вариант поднимает тревогу */
const riskItems = (draft: CreateSurveyDraft) =>
  qs(draft).flatMap((q, i) => (q.options?.some((o) => o.riskFlag) ? [i + 1] : []));

const loc = (v: unknown) => v as { uk: string; ru: string };

describe("золотой протокол: DASS-21", () => {
  test("пример досье: депрессия 30, тревога 4, стресс 16 — сумма семи пунктов × 2", () => {
    /*
     * D = пп. 3,5,10,13,16,17,21: 2+2+2+3+2+2+2 = 15, ×2 = 30
     * A = пп. 2,4,7,9,15,19,20:  0+0+0+1+0+0+1 = 2,  ×2 = 4
     * S = пп. 1,6,8,11,12,14,18: 1+1+2+1+1+1+1 = 8,  ×2 = 16
     */
    const picks = [1, 0, 2, 0, 2, 1, 0, 2, 1, 2, 1, 1, 3, 1, 0, 2, 2, 1, 0, 1, 2];
    const d = scoreOf(dass21, picks, "D");
    expect(d.rawScore).toBe(30);
    expect(d.maxScore).toBe(42);
    expect(d.band).toBeNull();
    expect(scoreOf(dass21, picks, "A").rawScore).toBe(4);
    expect(scoreOf(dass21, picks, "S").rawScore).toBe(16);
  });

  test("второй пример досье: каждому пункту балл его шкалы — 42 / 14 / 28", () => {
    // D-пункты по 3 → 7×3×2 = 42; A-пункты по 1 → 7×1×2 = 14; S-пункты по 2 → 7×2×2 = 28
    const picks = Array.from({ length: 21 }, (_, i) =>
      (DASS21_KEY.D as readonly number[]).includes(i + 1) ? 3 : (DASS21_KEY.A as readonly number[]).includes(i + 1) ? 1 : 2,
    );
    expect(picks).toEqual([2, 1, 3, 1, 3, 2, 1, 2, 1, 3, 2, 2, 3, 2, 1, 3, 3, 2, 1, 1, 3]);
    expect(scoreOf(dass21, picks, "D").rawScore).toBe(42);
    expect(scoreOf(dass21, picks, "A").rawScore).toBe(14);
    expect(scoreOf(dass21, picks, "S").rawScore).toBe(28);
  });

  test("ключ: три шкалы по 7 пунктов, каждый из 21 — ровно в одной, вес везде 2, полос нет", () => {
    const all: number[] = [...DASS21_KEY.D, ...DASS21_KEY.A, ...DASS21_KEY.S].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    for (const scale of dass21.scales ?? []) {
      expect(scale.key?.length).toBe(7);
      expect(scale.key?.every((k) => k.weight === 2)).toBe(true);
      expect(scale.bands ?? []).toEqual([]);
    }
    qs(dass21).forEach((q, i) => {
      expect(q.scaleCode, `пункт ${i + 1}`).toBe(
        (["D", "A", "S"] as const).find((c) => (DASS21_KEY[c] as readonly number[]).includes(i + 1)),
      );
    });
  });

  test("перевод: пункт 18 — рабочий, и описание об этом говорит; опечатка варианта исправлена", () => {
    expect(DASS21_UK_WORKING_ITEM).toBe(18);
    const d = loc(dass21.description);
    expect(d.uk).toContain("пункту 18");
    expect(d.uk).toContain("робочий переклад");
    expect(d.ru).toContain("рабочий перевод");
    // вариант 2 бланка: «часто бо значну» — опечатка, в системе «часто або»
    const second = loc(qs(dass21)[0]!.options![2]!.text);
    expect(second.uk).toBe("Стосувалося мене часто або значну частину часу");
  });
});

describe("золотой протокол: K10", () => {
  test("пример досье: 23 — «легкий дистрес» (20-24)", () => {
    // баллы вариантов 1-5: 2+3+2+2+3+2+2+2+3+2 = 23
    const s = scoreOf(k10, [2, 3, 2, 2, 3, 2, 2, 2, 3, 2], "K10");
    expect(s.rawScore).toBe(23);
    expect(s.maxScore).toBe(50);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("mild");
  });

  test("все «Іноді» (3): 30 — «тяжкий дистрес»; все «Ніколи»: 10 — минимум шкалы", () => {
    const high = scoreOf(k10, Array(10).fill(3), "K10");
    expect(high.rawScore).toBe(30);
    expect(high.band?.grade).toBe(4);
    expect(high.band?.severity).toBe("severe");
    const low = scoreOf(k10, Array(10).fill(1), "K10");
    expect(low.rawScore).toBe(10);
    expect(low.band?.grade).toBe(1);
  });

  test("границы групп ABS: 19 — ещё «не выявлено», 20 — уже «легкий», 25 — «помірний»", () => {
    expect(scoreOf(k10, [1, ...Array(9).fill(2)], "K10").band?.grade).toBe(1);
    expect(scoreOf(k10, Array(10).fill(2), "K10").band?.grade).toBe(2);
    expect(scoreOf(k10, [3, 3, 3, 3, 3, 2, 2, 2, 2, 2], "K10").band?.grade).toBe(3);
  });

  test("копирайт разработчика виден отвечающему (инструкция) и стоит в описании", () => {
    const ins = loc(k10.instructions);
    expect(ins.uk).toContain(KESSLER_COPYRIGHT);
    expect(ins.ru).toContain(KESSLER_COPYRIGHT);
    expect(loc(k10.description).uk).toContain(KESSLER_COPYRIGHT);
  });
});

describe("золотой протокол: K6", () => {
  test("пример досье: все «Іноді» — 18, на балл ниже порога", () => {
    const s = scoreOf(k6, Array(6).fill(3), "K6");
    expect(s.rawScore).toBe(18);
    expect(s.maxScore).toBe(30);
    expect(s.band?.grade).toBe(1);
  });

  test("пример досье: одно «Більшу частину часу» — 19, порог разработчика достигнут", () => {
    const s = scoreOf(k6, [3, 3, 3, 3, 3, 4], "K6");
    expect(s.rawScore).toBe(19);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("moderate");
  });

  test("пункты — ровно пункты 2, 4, 5, 8, 9, 10 K10, ни словом больше", () => {
    expect(qs(k6).map((q) => q.title)).toEqual(K6_FROM_K10.map((n) => qs(k10)[n - 1]!.title));
    expect(qs(k6).map((q) => q.options)).toEqual(K6_FROM_K10.map((n) => qs(k10)[n - 1]!.options));
  });
});

describe("золотой протокол: PHQ-15", () => {
  test("пример досье (женщина): 16 — высокая выраженность", () => {
    // 1+1+2+1+2+0+1+0+1+1+0+1+1+2+2 = 16 → полоса 15-30
    const s = scoreOf(phq15, [1, 1, 2, 1, 2, 0, 1, 0, 1, 1, 0, 1, 1, 2, 2], "PHQ15");
    expect(s.rawScore).toBe(16);
    expect(s.maxScore).toBe(30);
    expect(s.band?.grade).toBe(4);
    expect(s.band?.severity).toBe("severe");
  });

  test("пример досье (мужчина): пункт 4 пропущен — сумма 14 пунктов без пересчёта, 10", () => {
    // 1+0+1+—+1+0+1+0+0+1+0+1+1+2+1 = 10 → полоса 10-14; пересчёта на 15/14 нет
    const picks = [1, 0, 1, null, 1, 0, 1, 0, 0, 1, 0, 1, 1, 2, 1];
    const s = scoreOf(phq15, picks, "PHQ15");
    expect(s.rawScore).toBe(10);
    expect(s.band?.grade).toBe(3);
    expect(s.band?.severity).toBe("moderate");
  });

  test("необязателен только пункт «лише для жінок», и у него есть подсказка", () => {
    expect(qs(phq15).flatMap((q, i) => (q.required === false ? [i + 1] : []))).toEqual([PHQ15_WOMEN_ONLY]);
    expect(loc(qs(phq15)[PHQ15_WOMEN_ONLY - 1]!.help).uk).toContain("Лише для жінок");
  });

  test("пороги руководства 5/10/15: 4 — минимальная, 5 — низкая, 9 → 10 и 14 → 15 меняют полосу", () => {
    const sum = (n: number) => [...Array(n).fill(1), ...Array(15 - n).fill(0)];
    expect(scoreOf(phq15, sum(4), "PHQ15").band?.grade).toBe(1);
    expect(scoreOf(phq15, sum(5), "PHQ15").band?.grade).toBe(2);
    expect(scoreOf(phq15, sum(9), "PHQ15").band?.grade).toBe(2);
    expect(scoreOf(phq15, sum(10), "PHQ15").band?.grade).toBe(3);
    expect(scoreOf(phq15, sum(14), "PHQ15").band?.grade).toBe(3);
    expect(scoreOf(phq15, sum(15), "PHQ15").band?.grade).toBe(4);
  });

  test("русский текст — официальный MAPI: шапка и первый пункт дословно", () => {
    expect(loc(phq15.instructions).ru).toStartWith(
      "Насколько сильно вас беспокоили какие-либо из перечисленных ниже проблем на протяжении последних 4 недель?",
    );
    expect(loc(qs(phq15)[0]!.title).ru).toBe("Боль в желудке");
  });
});

describe("золотой протокол: PHQ-2", () => {
  test("пример досье: 2 + 1 = 3 — ровно порог, скрининг положительный", () => {
    const s = scoreOf(phq2, [2, 1], "PHQ2");
    expect(s.rawScore).toBe(3);
    expect(s.maxScore).toBe(6);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("moderate");
  });

  test("1 + 1 = 2 — ниже порога", () => {
    expect(scoreOf(phq2, [1, 1], "PHQ2").band?.grade).toBe(1);
  });

  test("пункты — ровно первые два пункта PHQ-9; украинский — официальный текст МОЗ", () => {
    expect(qs(phq2).map((q) => q.title)).toEqual(qs(phq9).slice(0, 2).map((q) => q.title));
    expect(qs(phq2).map((q) => q.options)).toEqual(qs(phq9).slice(0, 2).map((q) => q.options));
    const d = loc(phq2.description);
    expect(d.uk).not.toContain(WORKING_TRANSLATION.uk);
    expect(d.uk).toContain("№1003");
    expect(d.ru).toContain("рабочий перевод");
  });
});

describe("золотой протокол: GAD-2", () => {
  test("пример досье: 1 + 2 = 3 — ровно порог, скрининг положительный", () => {
    const s = scoreOf(gad2, [1, 2], "GAD2");
    expect(s.rawScore).toBe(3);
    expect(s.band?.grade).toBe(2);
  });

  test("1 + 1 = 2 — ниже порога", () => {
    expect(scoreOf(gad2, [1, 1], "GAD2").band?.grade).toBe(1);
  });

  test("пункты — ровно первые два пункта GAD-7, и статус перевода тот же, что у GAD-7", () => {
    expect(qs(gad2).map((q) => q.title)).toEqual(qs(gad7).slice(0, 2).map((q) => q.title));
    expect(qs(gad2).map((q) => q.options)).toEqual(qs(gad7).slice(0, 2).map((q) => q.options));
    /*
     * Пункты GAD-2 приходят из gad7.ts, а описание — нет. Если GAD-7 перейдёт на
     * официальный украинский текст издателя и снимет оговорку, GAD-2 должен
     * снять её тоже — иначе описание соврёт о тексте, который на экране.
     */
    const working = (draft: CreateSurveyDraft) => loc(draft.description).uk.includes(WORKING_TRANSLATION.uk);
    expect(working(gad2)).toBe(working(gad7));
  });
});

describe("золотой протокол: CORE-10", () => {
  test("пример досье: все «Іноді» — 20, обратные пункты дают те же 2", () => {
    const s = scoreOf(core10, Array(10).fill(2), "CORE10");
    expect(s.rawScore).toBe(20);
    expect(s.maxScore).toBe(40);
    expect(s.band?.grade).toBe(4);
    expect(s.band?.severity).toBe("severe");
  });

  test("пример досье: все «Зовсім ні» — 8, а не 0: пункты 2 и 3 обратные", () => {
    // пп. 2 и 3: 0 → 4; остальные 0 → 8 → неклинический диапазон
    const s = scoreOf(core10, Array(10).fill(0), "CORE10");
    expect(s.rawScore).toBe(8);
    expect(s.band?.grade).toBe(1);
  });

  test("пример досье: 3, 1, 0, 2, 2, 0, 3, 2, 3, 2 — 24; без пункта 10 — среднее × 10 = 24,444", () => {
    // пп. 2 и 3 обращаются: 1 → 3, 0 → 4; 3+3+4+2+2+0+3+2+3+2 = 24
    const full = scoreOf(core10, [3, 1, 0, 2, 2, 0, 3, 2, 3, 2], "CORE10");
    expect(full.rawScore).toBe(24);
    expect(full.band?.grade).toBe(4);
    // девять ответов: 22 / 9 × 10 = 24,444 — бланк велит пересчитывать, а не терять балл
    const nine = scoreOf(core10, [3, 1, 0, 2, 2, 0, 3, 2, 3, null], "CORE10");
    expect(nine.rawScore).toBeCloseTo(24.444, 3);
    expect(nine.band?.grade).toBe(4);
  });

  test("два пропуска — балл не считается (правило бланка: не больше одного)", () => {
    const profile = profileOf(core10, [3, 1, 0, 2, 2, 0, 3, 2, null, null]);
    expect(profile.scores.find((s) => s.scaleCode === "CORE10")).toBeUndefined();
  });

  test("порог клинического диапазона: 10 — неклинический, 11 — «легкий»", () => {
    // пп. 2 и 3 = 4 (обратные дают 0), остальные — десять баллов россыпью
    expect(scoreOf(core10, [2, 4, 4, 2, 2, 0, 2, 2, 0, 0], "CORE10").rawScore).toBe(10);
    expect(scoreOf(core10, [2, 4, 4, 2, 2, 0, 2, 2, 0, 0], "CORE10").band?.grade).toBe(1);
    expect(scoreOf(core10, [2, 4, 4, 2, 2, 0, 2, 2, 1, 0], "CORE10").band?.grade).toBe(2);
  });

  test("обратные пункты, пункт риска и неизменённый текст CST", () => {
    expect(qs(core10).flatMap((q, i) => (q.reverseScored ? [i + 1] : []))).toEqual([...CORE10_REVERSE]);
    // пункт 6 (планы покончить с жизнью): любая ненулевая частота — тяжёлая тревога
    const options = qs(core10)[CORE10_RISK_ITEM - 1]!.options!;
    expect(options.map((o) => o.riskFlag ?? false)).toEqual([false, true, true, true, true]);
    expect(options.filter((o) => o.riskFlag).every((o) => o.riskSeverity === "severe")).toBe(true);
    // ударение в п. 10 — часть утверждённого текста: без него «образи» читается как «обиды»
    expect(loc(qs(core10)[9]!.title).uk).toContain("о̀брази");
    // копирайт CST виден отвечающему — условие лицензии
    expect(loc(core10.instructions).uk).toContain(CST_COPYRIGHT);
    expect(loc(core10.instructions).ru).toContain(CST_COPYRIGHT);
  });
});

/*
 * ─── Целостность группы ───
 *
 * То же, что golden-mood.test.ts делает для своей группы: схема, пункты риска
 * по досье, объяснение отсутствия полос, оба языка — и буквы: украинский без
 * русских букв, русский без украинских.
 */
const GROUP: [string, CreateSurveyDraft][] = [
  ["dass21", dass21],
  ["k10", k10],
  ["k6", k6],
  ["phq15", phq15],
  ["phq2", phq2],
  ["gad2", gad2],
  ["core10", core10],
];

/**
 * Пункты риска по досье (поле risk_items). Сравнивается множество целиком:
 * пропуск оставит «планував покінчити з життям» ждать приёма, лишняя разметка
 * научит не замечать тревогу.
 */
const RISK_ITEMS: Record<string, number[]> = {
  dass21: [21],
  k10: [],
  k6: [],
  phq15: [],
  phq2: [],
  gad2: [],
  core10: [6],
};

/** Все локализованные строки черновика: объекты с ключами uk и ru */
function locs(node: unknown, path = "", out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(node)) node.forEach((v, i) => locs(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.includes("uk") || keys.includes("ru")) out.push([path, node]);
    else for (const k of keys) locs((node as Record<string, unknown>)[k], `${path}.${k}`, out);
  }
  return out;
}

describe("целостность группы «distress»", () => {
  test("все семь — в каталоге, ключ каталога равен ключу досье", () => {
    for (const [key, draft] of GROUP) {
      expect(CATALOG.find((e) => e.key === key)?.draft, key).toBe(draft);
    }
  });

  for (const [key, draft] of GROUP) {
    test(`${key}: схема и структура без ошибок`, () => {
      const parsed = createSurveySchema.safeParse(draft);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
      }
      const errors = validateSurvey(parsed.data).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: пункты риска — по досье, каждый подписан`, () => {
      expect(riskItems(draft)).toEqual(RISK_ITEMS[key]!);
      for (const q of qs(draft)) {
        for (const o of q.options ?? []) if (o.riskFlag) expect(o.riskLabel && o.riskSeverity).toBeTruthy();
      }
      // методика с пунктом риска не ждёт общей очереди
      if (RISK_ITEMS[key]!.length) expect(draft.alertEscalateMinutes).toBe(60);
    });

    test(`${key}: шкала без полос объясняет, почему их нет`, () => {
      const silent = (draft.scales ?? []).filter((s) => !s.bands?.length && !s.description);
      expect(silent.map((s) => s.code)).toEqual([]);
    });

    test(`${key}: каждая строка на обоих языках, украинский без русских букв, русский без украинских`, () => {
      const all = locs(draft) as [string, { uk?: unknown; ru?: unknown }][];
      const mono = all.filter(([, l]) => !(typeof l.uk === "string" && l.uk.trim() && typeof l.ru === "string" && l.ru.trim()));
      expect(mono.map(([p]) => p)).toEqual([]);
      const ukRussian = all.filter(([, l]) => /[ыэъёЫЭЪЁ]/.test(String(l.uk)));
      expect(ukRussian.map(([p, l]) => `${p}: ${String(l.uk)}`)).toEqual([]);
      const ruUkrainian = all.filter(([, l]) => /[іїєґІЇЄҐ]/.test(String(l.ru)));
      expect(ruUkrainian.map(([p, l]) => `${p}: ${String(l.ru)}`)).toEqual([]);
    });
  }
});
