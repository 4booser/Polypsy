import { describe, expect, test } from "bun:test";
import {
  computeProfile,
  createSurveySchema,
  detectBandRisks,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { WORKING_TRANSLATION } from "../common";
import { fas } from "../fas";
import { ris } from "../ris";
import { sci } from "../sci";

/**
 * Золотые протоколы группы «сон и утомление» (docs/instruments/dossiers/sleep.json):
 * SCI, FAS, RIS.
 *
 * Ожидаемые баллы посчитаны руками по ключу из досье — расчёт в комментарии у
 * каждого случая. Опубликованных разобранных примеров у всех трёх нет, поэтому
 * примеры построены по правилу подсчёта первоисточника и обязательно проверяют
 * его ловушки: направление «больше — лучше» у SCI и обратные пункты FAS (4, 10)
 * и RIS (9). Если кто-то тронет ключ, балл варианта, обратный пункт или полосу —
 * упадёт здесь.
 *
 * Отдельный файл, а не golden.test.ts: группы методик собираются параллельно в
 * разных ветках, и общий файл стал бы местом конфликта при слиянии.
 */

/*
 * Конвертер черновика в SurveyFull без БД — копия toSurveyFull из golden.test.ts
 * в объёме, нужном этим методикам (без условий показа, норм и стенов). Копия, а
 * не импорт: импорт тестового файла заново регистрирует его describe здесь.
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
    // правило полноты бланка — свойство методики (у FAS — все десять), его надо донести до движка
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
    title: "golden-sleep",
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/**
 * Ответы по порядку пунктов — СЫРЫМ баллом варианта, как он стоит на бланке
 * (до обратного ключа). Позиция варианта здесь не годится: у SCI и у частотных
 * пунктов RIS баллы идут 4…0 слева направо, и «позиция 0» значила бы «4 балла».
 */
function answer(survey: SurveyFull, scores: number[]): Answer[] {
  expect(scores.length, "ответов не столько, сколько пунктов").toBe(survey.questions.length);
  return survey.questions.map((q, i) => {
    const option = q.options.find((o) => o.kind === "option" && o.score === scores[i]);
    if (!option) throw new Error(`пункт ${i + 1}: нет варианта с баллом ${scores[i]}`);
    return { questionId: q.id, optionIds: [option.id] };
  });
}

function profileOf(draft: CreateSurveyDraft, scores: number[]) {
  const survey = toSurveyFull(draft);
  return computeProfile(survey, answer(survey, scores));
}

function scoreOf(draft: CreateSurveyDraft, scores: number[], code: string) {
  const s = profileOf(draft, scores).scores.find((x) => x.scaleCode === code);
  if (!s) throw new Error(`нет шкалы ${code}`);
  return s;
}

const qs = (draft: CreateSurveyDraft) => draft.questions ?? [];
const uk = (v: unknown) => (v as { uk: string }).uk;

/** Номера обратных пунктов, с единицы */
const reversed = (draft: CreateSurveyDraft) => qs(draft).flatMap((q, i) => (q.reverseScored ? [i + 1] : []));

/** Все украинские строки методики: пункты, варианты, полосы, описание, инструкция */
function ukrainianTexts(draft: CreateSurveyDraft): string[] {
  const out = [uk(draft.title), uk(draft.description), uk(draft.instructions)];
  for (const q of qs(draft)) {
    out.push(uk(q.title));
    for (const o of q.options ?? []) out.push(uk(o.text));
  }
  for (const s of draft.scales ?? []) {
    out.push(uk(s.title));
    if (s.description) out.push(uk(s.description));
    for (const b of s.bands ?? []) {
      out.push(uk(b.label));
      if (b.recommendation) out.push(uk(b.recommendation));
    }
  }
  return out;
}

describe("каталог сна: общее", () => {
  test("все три проходят схему и проверку структуры без ошибок", () => {
    for (const draft of [sci, fas, ris]) {
      const parsed = createSurveySchema.parse(draft);
      expect(validateSurvey(parsed).filter((i) => i.level === "error")).toEqual([]);
    }
  });

  test("в украинском тексте нет русских букв ы э ъ ё", () => {
    for (const draft of [sci, fas, ris]) {
      const bad = ukrainianTexts(draft).filter((t) => /[ыэъё]/i.test(t));
      expect(bad, uk(draft.title)).toEqual([]);
    }
  });

  test("пунктов риска нет ни у одной — в первоисточниках нет вопросов о самоповреждении", () => {
    for (const draft of [sci, fas, ris]) {
      expect(qs(draft).some((q) => q.options?.some((o) => o.riskFlag))).toBe(false);
    }
  });
});

describe("золотой протокол: SCI", () => {
  test("пример досье: все пункты по 2 балла → 16 — порог «≤16» достигнут", () => {
    // 8 × 2 = 16 ≤ 16 → первая полоса: grade 1, mild
    const s = scoreOf(sci, [2, 2, 2, 2, 2, 2, 2, 2], "SCI");
    expect(s.rawScore).toBe(16);
    expect(s.maxScore).toBe(32);
    expect(s.band?.grade).toBe(1);
    expect(s.band?.severity).toBe("mild");
  });

  test("граница: п. 4 «Добра» (3) при остальных по 2 → 17 — выше порога, без полосы риска", () => {
    // 7 × 2 + 3 = 17 > 16 → вторая полоса: grade 2, none
    const s = scoreOf(sci, [2, 2, 2, 3, 2, 2, 2, 2], "SCI");
    expect(s.rawScore).toBe(17);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("none");
  });

  test("направление «больше — лучше»: первый вариант каждого пункта даёт 4, последний — 0", () => {
    /*
     * Бланк: столбцы «Score 4 3 2 1 0» слева направо. Перепутать направление —
     * значит отдать «поріг не досягнуто» человеку, который засыпает больше
     * часа каждую ночь. Обратных флагов нет: вторая инверсия поверх баллов
     * вариантов сломала бы всё.
     */
    for (const q of qs(sci)) {
      expect(q.options!.map((o) => o.score)).toEqual([4, 3, 2, 1, 0]);
    }
    expect(reversed(sci)).toEqual([]);
    expect(scoreOf(sci, Array(8).fill(4), "SCI").rawScore).toBe(32);
    const worst = scoreOf(sci, Array(8).fill(0), "SCI");
    expect(worst.rawScore).toBe(0);
    expect(worst.band?.grade).toBe(1);
  });

  test("положительный скрининг не открывает случай: severity полосы — mild", () => {
    const { scores } = profileOf(sci, Array(8).fill(0));
    expect(detectBandRisks(scores)).toEqual([]);
  });

  test("перевод рабочий — оговорка в описании есть", () => {
    expect(uk(sci.description)).toContain(WORKING_TRANSLATION.uk);
  });
});

describe("золотой протокол: FAS", () => {
  test("пример досье: все пункты «Регулярно» → 30 — «Втома»", () => {
    // пп. 1–3, 5–9: 8 × 3 = 24; обратные пп. 4 и 10: 6 − 3 = 3 каждый → 30 → полоса 22–34
    const s = scoreOf(fas, Array(10).fill(3), "FAS");
    expect(s.rawScore).toBe(30);
    expect(s.maxScore).toBe(50);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("mild");
  });

  test("обратные пп. 4 и 10: «Завжди» на них при «Ніколи» на остальных → 10, а «Ніколи» → 18", () => {
    // 8 × 1 + (6 − 5) + (6 − 5) = 10 → «Втоми немає»
    const low = scoreOf(fas, [1, 1, 1, 5, 1, 1, 1, 1, 1, 5], "FAS");
    expect(low.rawScore).toBe(10);
    expect(low.band?.grade).toBe(1);
    expect(low.band?.severity).toBe("none");
    // 8 × 1 + (6 − 1) + (6 − 1) = 18 — без обратного ключа было бы 10
    expect(scoreOf(fas, Array(10).fill(1), "FAS").rawScore).toBe(18);
    expect(reversed(fas)).toEqual([4, 10]);
  });

  test("граница 34 / 35: «Втома» и «Крайня втома», последняя открывает случай умеренной тяжести", () => {
    // пп. 1–3, 5–9 «Часто»: 8 × 4 = 32; п. 4 «Завжди» → 1; п. 10 «Завжди» → 1 → 34
    const p34 = profileOf(fas, [4, 4, 4, 5, 4, 4, 4, 4, 4, 5]);
    const s34 = p34.scores.find((s) => s.scaleCode === "FAS")!;
    expect(s34.rawScore).toBe(34);
    expect(s34.band?.grade).toBe(2);
    expect(detectBandRisks(p34.scores)).toEqual([]);
    // то же, но п. 10 «Часто» → 6 − 4 = 2 → 35
    const p35 = profileOf(fas, [4, 4, 4, 5, 4, 4, 4, 4, 4, 4]);
    const s35 = p35.scores.find((s) => s.scaleCode === "FAS")!;
    expect(s35.rawScore).toBe(35);
    expect(s35.band?.grade).toBe(3);
    expect(detectBandRisks(p35.scores).map((r) => r.severity)).toEqual(["moderate"]);
  });

  test("неполный бланк не считается: без ответа на один пункт балла нет", () => {
    /*
     * Правообладатель требует ответа на каждый пункт, его онлайн-форма без
     * этого не считает. По общему правилу движка (4/5) девять ответов дали бы
     * сумму, сравнённую с границами для десяти, — заниженную усталость.
     */
    const survey = toSurveyFull(fas);
    const nine = answer(survey, [4, 4, 4, 1, 4, 4, 4, 4, 4, 1]).slice(0, 9);
    const { scores, warnings } = computeProfile(survey, nine);
    expect(scores.find((s) => s.scaleCode === "FAS")).toBeUndefined();
    expect(warnings.map((w) => w.code)).toContain("score.tooFewAnswers");
  });

  test("текст — официальный правообладателя: оговорки о рабочем переводе нет, описки бланка исправлены", () => {
    expect(uk(qs(fas)[0]!.title)).toBe("Мене турбує втома");
    expect(uk(qs(fas)[3]!.title)).toBe("У мене достатньо енергії для повсякденного життя");
    expect(uk(qs(fas)[9]!.title)).toBe("Коли я щось роблю, я можу добре сконцентруватись");
    expect(uk(fas.description)).not.toContain(WORKING_TRANSLATION.uk);
    expect(uk(fas.description)).toContain("офіційний");
  });
});

describe("золотой протокол: RIS", () => {
  test("пример досье: все пункты — средний вариант → 20 — «Ознаки психофізіологічної інсомнії»", () => {
    // п. 1 «41–60 хв» (2), п. 2 «4 год» (2), пп. 3–10 «Іноді» (2; у обратного п. 9 — 4 − 2 = 2) → 20
    const s = scoreOf(ris, Array(10).fill(2), "RIS");
    expect(s.rawScore).toBe(20);
    expect(s.maxScore).toBe(40);
    expect(s.band?.grade).toBe(2);
    expect(s.band?.severity).toBe("mild");
  });

  test("обратный п. 9: «Завжди» при самых лёгких остальных → 0, «Ніколи» → 4", () => {
    // пп. 1–8, 10 — по 0; п. 9 «Завжди»: сырой 4 → 0 + 4 − 4 = 0
    const best = scoreOf(ris, [0, 0, 0, 0, 0, 0, 0, 0, 4, 0], "RIS");
    expect(best.rawScore).toBe(0);
    expect(best.band?.grade).toBe(1);
    // п. 9 «Ніколи»: сырой 0 → 4
    expect(scoreOf(ris, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "RIS").rawScore).toBe(4);
    expect(reversed(ris)).toEqual([9]);
  });

  test("граница 12 / 13: «норма» до 12 включительно", () => {
    // пп. 1–6 по 2 = 12; пп. 7, 8, 10 — 0; п. 9 «Завжди» → 0 → 12
    const s12 = scoreOf(ris, [2, 2, 2, 2, 2, 2, 0, 0, 4, 0], "RIS");
    expect(s12.rawScore).toBe(12);
    expect(s12.band?.grade).toBe(1);
    // п. 7 «Рідко» (1) → 13
    const s13 = scoreOf(ris, [2, 2, 2, 2, 2, 2, 1, 0, 4, 0], "RIS");
    expect(s13.rawScore).toBe(13);
    expect(s13.band?.grade).toBe(2);
  });

  test("перевод рабочий — оговорка в описании есть, результат человеку не показывается", () => {
    expect(uk(ris.description)).toContain(WORKING_TRANSLATION.uk);
    expect(ris.showResultsToPatient).toBe(false);
  });
});
