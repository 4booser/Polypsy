import { describe, expect, test } from "bun:test";
import {
  createSurveySchema,
  evaluateSubmission,
  isQuestionVisible,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { ASQ_POS, asq } from "../asq";
import { CATALOG } from "../catalog";
import { WORKING_TRANSLATION } from "../common";
import { CSSRS_POS, cssrs } from "../cssrs";
import { minimult } from "../minimult";
import { mlo } from "../mlo";
import { sadPersons } from "../sadPersons";
import { sidas } from "../sidas";
import { sr45 } from "../sr45";

/**
 * Золотые протоколы группы «суицидальный риск»: ASQ, C-SSRS Screener, SIDAS — и аудит
 * пометок риска по всему каталогу (k-suicide, 2026-10).
 *
 * Примеры — из полей `example` / `example_note` досье docs/instruments/dossiers/suicide.json,
 * расчёт — в комментарии рядом с ожиданием. У ASQ и C-SSRS первоисточник даёт не сумму, а
 * правило маршрутизации, поэтому их «золотой» результат — тяжесть риска сдачи, а не только
 * балл: ошибка здесь не сдвигает полосу, а молча оставляет острый скрининг без тревоги.
 *
 * Сдача прогоняется через evaluateSubmission — тот же вход, что у сервера и у устройства
 * без сети: отбор видимых ответов, профиль и риск вместе. Конвертер ниже — копия, а не
 * импорт (как в golden-trauma.test.ts: импорт зарегистрировал бы чужие тесты второй раз);
 * от той копии отличается тем, что переносит подсчёт, обратный ключ и минимальную долю
 * ответов — без них не проверить ни выключенный подсчёт C-SSRS, ни ключ и пропуски SIDAS.
 */
function toSurveyFull(draft: unknown): SurveyFull {
  const input = createSurveySchema.parse(draft);
  const ru = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string; uk?: string }).ru ?? ""));
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
    riskThreshold: q.riskThreshold ?? null,
    riskLabel: null,
    riskSeverity: q.riskSeverity ?? null,
    logic: q.logic.map((rule, ri) => ({
      id: `q${qi + 1}l${ri}`,
      questionId: `q${qi + 1}`,
      sourceQuestionId: `q${rule.sourceIndex + 1}`,
      operator: rule.operator,
      value: rule.value,
      action: rule.action,
    })),
    options: (q.options ?? []).map((o, oi) => ({
      id: `q${qi + 1}o${oi}`,
      questionId: `q${qi + 1}`,
      text: ru(o.text),
      keyCode: o.keyCode ?? null,
      score: o.score ?? 0,
      position: oi,
      kind: o.kind ?? "option",
      riskFlag: o.riskFlag ?? false,
      riskLabel: o.riskLabel ? ru(o.riskLabel) : null,
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
    title: "golden",
    scoringEnabled: input.scoringEnabled ?? false,
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/** Ответы «да/нет» по номеру пункта (с единицы); не названные пункты не отвечены */
function yn(survey: SurveyFull, picks: Record<number, "yes" | "no">): Answer[] {
  return Object.entries(picks).map(([n, code]) => {
    const q = survey.questions[Number(n) - 1]!;
    return { questionId: q.id, optionIds: [q.options.find((o) => o.keyCode === code)!.id] };
  });
}

/** Ответы по баллу варианта (с единицы); не названные пункты не отвечены */
function byScore(survey: SurveyFull, picks: Record<number, number>): Answer[] {
  return Object.entries(picks).map(([n, score]) => {
    const q = survey.questions[Number(n) - 1]!;
    return { questionId: q.id, optionIds: [q.options.find((o) => o.score === score)!.id] };
  });
}

const visible = (survey: SurveyFull, answers: Answer[], n: number) =>
  isQuestionVisible(survey.questions[n - 1]!, survey.questions, new Map(answers.map((a) => [a.questionId, a])));

/** Номера пунктов, на которых сработала тревога ответа — в порядке бланка */
const riskItems = (survey: SurveyFull, answers: Answer[]) =>
  evaluateSubmission(survey, answers)
    .risk.answers.map((r) => survey.questions.findIndex((q) => q.id === r.questionId) + 1)
    .sort((a, b) => a - b);

/** Все локализованные строки черновика: [путь, {uk, ru}] */
function locs(node: unknown, path = "", out: [string, { uk?: string; ru?: string }][] = []) {
  if (Array.isArray(node)) node.forEach((v, i) => locs(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.includes("uk") || keys.includes("ru")) out.push([path, node as { uk?: string; ru?: string }]);
    else for (const k of keys) locs((node as Record<string, unknown>)[k], `${path}.${k}`, out);
  }
  return out;
}

const GROUP = [
  ["asq", asq],
  ["cssrs", cssrs],
  ["sidas", sidas],
] as const;

describe("группа suicide: структура", () => {
  for (const [key, draft] of GROUP) {
    test(`${key}: схема и проверка структуры без ошибок, запись каталога на месте`, () => {
      const parsed = createSurveySchema.parse(draft);
      const errors = validateSurvey(parsed).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
      expect(CATALOG.find((e) => e.key === key)?.draft).toBe(draft);
    });

    test(`${key}: результат человеку не показывается, тревога эскалируется через час`, () => {
      expect(draft.showResultsToPatient).toBe(false);
      expect(draft.alertEscalateMinutes).toBe(60);
    });

    test(`${key}: каждый критический вариант подписан и несёт тяжесть`, () => {
      for (const q of draft.questions ?? []) {
        for (const o of q.options ?? []) {
          if (!o.riskFlag) continue;
          const label = o.riskLabel as { uk: string; ru: string };
          expect(label.uk.length > 0 && label.ru.length > 0).toBe(true);
          expect(["moderate", "severe"]).toContain(o.riskSeverity as string);
        }
      }
    });

    test(`${key}: в украинском тексте нет русских букв и латиницы внутри кириллических слов`, () => {
      /*
       * Ловушка официальных бланков: на украинском бланке C-SSRS «Ні» набрано латинскими
       * H и i, в русском ASQ — латинская «c» в «cледующий». Глазом не видно, а поиск,
       * сортировка и озвучивание экранным чтецом спотыкаются.
       */
      for (const [path, l] of locs(draft)) {
        const uk = l.uk ?? "";
        expect(/[ыэъёЫЭЪЁ]/.test(uk), `${key}${path}: русская буква в «${uk}»`).toBe(false);
        for (const text of [uk, l.ru ?? ""]) {
          for (const word of text.split(/[^\p{L}]+/u)) {
            const mixed = /\p{Script=Cyrillic}/u.test(word) && /[A-Za-z]/.test(word);
            expect(mixed, `${key}${path}: латиница в слове «${word}»`).toBe(false);
          }
        }
      }
    });
  }

  test("ASQ и C-SSRS проводит специалист, SIDAS — самоотчёт с планом безопасности", () => {
    expect(asq.administration).toBe("clinician");
    expect(cssrs.administration).toBe("clinician");
    expect(sidas.administration).toBe("self");
    expect(sidas.safetyPlan).toBeTruthy();
  });

  test("рабочий перевод назван там, где он есть", () => {
    // ASQ: украинский — рабочий, русский вопросов — официальный NIMH; SIDAS — рабочий на обоих
    const asqDesc = asq.description as { uk: string; ru: string };
    expect(asqDesc.uk).toContain(WORKING_TRANSLATION.uk);
    expect(asqDesc.ru).toContain("официальный перевод NIMH");
    const sidasDesc = sidas.description as { uk: string; ru: string };
    expect(sidasDesc.uk).toContain(WORKING_TRANSLATION.uk);
    expect(sidasDesc.ru).toContain(WORKING_TRANSLATION.ru);
    // C-SSRS: оба языка — официальные переводы правообладателя
    const cssrsDesc = cssrs.description as { uk: string; ru: string };
    expect(cssrsDesc.uk).not.toContain(WORKING_TRANSLATION.uk);
    expect(cssrsDesc.uk).toContain("офіційні переклади правовласника");
  });
});

describe("золотой протокол: ASQ", () => {
  const survey = toSurveyFull(asq);
  const P = ASQ_POS;

  test("пример досье: «Так» только на вопрос 1, на 5 — «Ні» → 1, неострый положительный скрининг", () => {
    // «Yes to any of Questions #1–#4 and … No to Question #5 — Non-acute positive screen»
    const answers = yn(survey, { [P.q1]: "yes", [P.q2]: "no", [P.q3]: "no", [P.q4]: "no", [P.q5]: "no" });
    const ev = evaluateSubmission(survey, answers);
    expect(ev.profile.scores[0]!.rawScore).toBe(1);
    expect(ev.profile.scores[0]!.band?.grade).toBe(2);
    expect(ev.risk.severity).toBe("moderate");
    expect(riskItems(survey, answers)).toEqual([P.q1]);
  });

  test("пример досье: «Так» на вопросы 3 и 5 → 1, острый положительный скрининг (тяжёлая)", () => {
    // «Yes to Question #5 = acute positive screen (imminent/acute risk identified)»
    const answers = yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q3]: "yes", [P.q4]: "no", [P.q5]: "yes" });
    const ev = evaluateSubmission(survey, answers);
    expect(ev.profile.scores[0]!.rawScore).toBe(1);
    expect(ev.risk.severity).toBe("severe");
    expect(riskItems(survey, answers)).toEqual([P.q3, P.q5]);
  });

  test("«Ні» на всё → 0, отрицательный скрининг, сигналов нет", () => {
    const answers = yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q3]: "no", [P.q4]: "no", [P.q5]: "no" });
    const ev = evaluateSubmission(survey, answers);
    expect(ev.profile.scores[0]!.rawScore).toBe(0);
    expect(ev.profile.scores[0]!.band?.severity).toBe("none");
    expect(ev.risk.severity).toBeNull();
  });

  test("четыре «Так» — тот же положительный скрининг, что и одно: градаций у бланка нет", () => {
    const answers = yn(survey, { [P.q1]: "yes", [P.q2]: "yes", [P.q3]: "yes", [P.q4]: "yes", [P.q5]: "no" });
    const ev = evaluateSubmission(survey, answers);
    expect(ev.profile.scores[0]!.rawScore).toBe(4);
    expect(ev.profile.scores[0]!.band?.grade).toBe(2);
    expect(ev.risk.severity).toBe("moderate");
  });

  test("тревога: «Так» на 1–4 — умеренная, на 5 — тяжёлая; уточнения тревоги не поднимают", () => {
    const flagged = survey.questions.map((q, i) => [i + 1, q.options.filter((o) => o.riskFlag).map((o) => o.riskSeverity)]);
    expect(flagged).toEqual([
      [P.q1, ["moderate"]],
      [P.q2, ["moderate"]],
      [P.q3, ["moderate"]],
      [P.q4, ["moderate"]],
      [P.recency, []],
      [P.q5, ["severe"]],
      [P.describe, []],
    ]);
  });

  test("вопрос 5 виден и обязателен всегда; уточнения — только после «Так»", () => {
    expect(visible(survey, [], P.q5)).toBe(true);
    expect(asq.questions![P.q5 - 1]!.required).toBe(true);
    const no4 = yn(survey, { [P.q4]: "no", [P.q5]: "no" });
    expect(visible(survey, no4, P.recency)).toBe(false);
    expect(visible(survey, no4, P.describe)).toBe(false);
    const yes4 = yn(survey, { [P.q4]: "yes", [P.q5]: "yes" });
    expect(visible(survey, yes4, P.recency)).toBe(true);
    expect(visible(survey, yes4, P.describe)).toBe(true);
  });

  test("давняя попытка без других «да» — всё равно положительный скрининг: исключение решает клиницист", () => {
    const answers = [
      ...yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q3]: "no", [P.q4]: "yes", [P.q5]: "no" }),
      { questionId: survey.questions[P.recency - 1]!.id, optionIds: [survey.questions[P.recency - 1]!.options[1]!.id] },
    ];
    expect(evaluateSubmission(survey, answers).risk.severity).toBe("moderate");
  });

  test("русский текст вопросов 1–5 — официальный перевод NIMH, слово в слово", () => {
    // asq-russian.pdf (NIMH, бланк 5/18/2017) — досье, translation.ru.note
    const ru = (n: number) => (asq.questions![n - 1]!.title as { ru: string }).ru;
    expect(ru(P.q1)).toBe("За последние несколько недель было ли у Вас желание, чтобы Вас не было в живых?");
    expect(ru(P.q2)).toBe(
      "За последние несколько недель было ли у Вас чувство, что Вам или Вашей семье было бы лучше, если бы Вас не было бы в живых?",
    );
    expect(ru(P.q3)).toBe("На прошлой неделе не было ли у Вас мыслей о том, чтобы покончить с собой?");
    expect(ru(P.q4)).toBe("Вы когда-нибудь пытались покончить с собой?");
    expect(ru(P.q5)).toBe("Думаете ли Вы о том, чтобы покончить с собой, прямо сейчас?");
    expect(ru(P.describe)).toBe("Если да, то опишите эти мысли");
  });
});

describe("золотой протокол: C-SSRS Screener", () => {
  const survey = toSurveyFull(cssrs);
  const P = CSSRS_POS;

  test("суммы нет: шкал нет, профиль пуст, а риск всё равно поднимается", () => {
    expect(cssrs.scales).toEqual([]);
    // подсчёт включён, как у всего каталога (test/catalog.test.ts), — профиль просто пуст
    expect(cssrs.scoringEnabled).toBe(true);
    const ev = evaluateSubmission(survey, yn(survey, { [P.q1]: "yes", [P.q2]: "yes", [P.q3]: "yes" }));
    expect(ev.profile.scores).toEqual([]);
    expect(ev.risk.severity).toBe("moderate");
  });

  test("разметка бланка: Low и Moderate Risk — умеренная, High Risk — тяжёлая", () => {
    // вопросы 1–2 Low, 3 Moderate, 4–5 High, 6 «за всё время» Moderate, «за 3 месяца» High
    const severities = survey.questions.map((q) => q.options.filter((o) => o.riskFlag).map((o) => o.riskSeverity));
    expect(severities).toEqual([["moderate"], ["moderate"], ["moderate"], ["severe"], ["severe"], ["moderate"], ["severe"]]);
    // «Ні» тревоги не поднимает нигде
    expect(survey.questions.every((q) => !q.options.find((o) => o.keyCode === "no")!.riskFlag)).toBe(true);
  });

  test("«If YES to 2, ask questions 3, 4, 5 … If NO to 2, go directly to question 6»", () => {
    const no2 = yn(survey, { [P.q1]: "yes", [P.q2]: "no" });
    for (const n of [P.q3, P.q4, P.q5]) expect(visible(survey, no2, n)).toBe(false);
    expect(visible(survey, no2, P.q6)).toBe(true);
    const yes2 = yn(survey, { [P.q1]: "no", [P.q2]: "yes" });
    for (const n of [P.q3, P.q4, P.q5, P.q6]) expect(visible(survey, yes2, n)).toBe(true);
    // «If YES, ask: Was this within the past three months?»
    expect(visible(survey, yn(survey, { [P.q6]: "no" }), P.recent)).toBe(false);
    expect(visible(survey, yn(survey, { [P.q6]: "yes" }), P.recent)).toBe(true);
  });

  test("пример досье: «Так» только на 1 → низкий риск по бланку, умеренная тревога", () => {
    const answers = yn(survey, { [P.q1]: "yes", [P.q2]: "no", [P.q6]: "no" });
    expect(evaluateSubmission(survey, answers).risk.severity).toBe("moderate");
    expect(riskItems(survey, answers)).toEqual([P.q1]);
  });

  test("пример досье: «Так» на 2 и 4 → высокий риск, тяжёлая тревога", () => {
    const answers = yn(survey, { [P.q1]: "no", [P.q2]: "yes", [P.q3]: "no", [P.q4]: "yes", [P.q5]: "no", [P.q6]: "no" });
    expect(evaluateSubmission(survey, answers).risk.severity).toBe("severe");
    expect(riskItems(survey, answers)).toEqual([P.q2, P.q4]);
  });

  test("пример досье: поведение давнее 3 месяцев — умеренная, за последние 3 месяца — тяжёлая", () => {
    const old = yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q6]: "yes", [P.recent]: "no" });
    expect(evaluateSubmission(survey, old).risk.severity).toBe("moderate");
    const recent = yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q6]: "yes", [P.recent]: "yes" });
    expect(evaluateSubmission(survey, recent).risk.severity).toBe("severe");
  });

  test("«Ні» на всё → сигналов нет", () => {
    expect(evaluateSubmission(survey, yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q6]: "no" })).risk.severity).toBeNull();
  });

  test("ответ на скрытый вопрос риска не поднимает: при «Ні» на 2 вопрос 4 не задавали", () => {
    // устаревший ответ от прежней ветки (человек сменил «Так» на 2 на «Ні») не должен звать дежурного
    const answers = yn(survey, { [P.q1]: "no", [P.q2]: "no", [P.q4]: "yes", [P.q6]: "no" });
    expect(evaluateSubmission(survey, answers).risk.severity).toBeNull();
  });

  test("официальный украинский текст: опечатка «накаласти» исправлена, «Ні» — кириллицей", () => {
    const q6 = (cssrs.questions![P.q6 - 1]!.title as { uk: string }).uk;
    expect(q6).toContain("накласти на себе руки");
    expect(q6).not.toContain("накаласти");
    expect((cssrs.questions![0]!.options![1]!.text as { uk: string }).uk).toBe("Ні");
    expect((cssrs.questions![0]!.title as { uk: string }).uk).toBe(
      "Чи хотіли Ви бути мертвим або хотіли б Ви заснути і не прокидатися?",
    );
    expect((cssrs.questions![0]!.title as { ru: string }).ru).toBe(
      "Возникало ли у Вас желание умереть или заснуть и не просыпаться?",
    );
  });
});

describe("золотой протокол: SIDAS", () => {
  const survey = toSurveyFull(sidas);
  const total = (answers: Answer[]) => evaluateSubmission(survey, answers).profile.scores[0]!;

  test("пример досье: 5, 3, 2, 6, 4 → 5 + (10 − 3) + 2 + 6 + 4 = 24, высокий риск", () => {
    const answers = byScore(survey, { 1: 5, 2: 3, 3: 2, 4: 6, 5: 4 });
    const s = total(answers);
    expect(s.rawScore).toBe(24);
    expect(s.band?.grade).toBe(3);
    expect(evaluateSubmission(survey, answers).risk.severity).toBe("severe");
  });

  test("ловушка ключа: без обратного второго пункта было бы 20 — ниже порога 21", () => {
    // 5 + 3 + 2 + 6 + 4 = 20; с обратным ключом — 24. Проверяем, что движок берёт 24, а не 20
    expect(total(byScore(survey, { 1: 5, 2: 3, 3: 2, 4: 6, 5: 4 })).rawScore).not.toBe(20);
    // полный контроль даёт 0, отсутствие контроля — 10
    expect(total(byScore(survey, { 1: 1, 2: 10, 3: 0, 4: 0, 5: 0 })).rawScore).toBe(1);
    expect(total(byScore(survey, { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0 })).rawScore).toBe(11);
  });

  test("пример досье: «0» на первом — остальные скрыты, сумма 0, сигналов нет", () => {
    const answers = byScore(survey, { 1: 0 });
    for (const n of [2, 3, 4, 5]) expect(visible(survey, answers, n)).toBe(false);
    const s = total(answers);
    expect(s.rawScore).toBe(0);
    expect(s.band?.severity).toBe("none");
    expect(evaluateSubmission(survey, answers).risk.severity).toBeNull();
  });

  test("пример досье: 1, 10, 0, 0, 0 → 1 — мысли есть (порог 1), умеренная тревога", () => {
    const answers = byScore(survey, { 1: 1, 2: 10, 3: 0, 4: 0, 5: 0 });
    const s = total(answers);
    expect(s.rawScore).toBe(1);
    expect(s.band?.grade).toBe(2);
    expect(evaluateSubmission(survey, answers).risk.severity).toBe("moderate");
    // единственный сигнал — частота: контроль полный, остальное — нули
    expect(riskItems(survey, answers)).toEqual([1]);
  });

  test("граница 20/21: 20 — умеренная полоса, 21 — тяжёлая", () => {
    // 10 + (10 − 10) + 10 + 0 + 0 = 20
    const twenty = total(byScore(survey, { 1: 10, 2: 10, 3: 9, 4: 1, 5: 0 }));
    expect(twenty.rawScore).toBe(20);
    expect(twenty.band?.severity).toBe("moderate");
    // 10 + 0 + 9 + 2 + 0 = 21
    const twentyOne = total(byScore(survey, { 1: 10, 2: 10, 3: 9, 4: 2, 5: 0 }));
    expect(twentyOne.rawScore).toBe(21);
    expect(twentyOne.band?.severity).toBe("severe");
  });

  test("максимум: 10, 0, 10, 10, 10 → 50", () => {
    const s = total(byScore(survey, { 1: 10, 2: 0, 3: 10, 4: 10, 5: 10 }));
    expect(s.rawScore).toBe(50);
    expect(s.maxScore).toBe(50);
  });

  test("пропуск видимого пункта — сумма не вычислена («If any item is missing, the Total Score is set as missing»)", () => {
    // 4 ответа из 5 заданных при минимальной доле 1 — шкала не вычислена, а не «сумма по четырём»
    const { profile } = evaluateSubmission(survey, byScore(survey, { 1: 5, 3: 2, 4: 6, 5: 4 }));
    expect(profile.scores).toEqual([]);
    expect(profile.warnings.map((w) => w.code)).toContain("score.tooFewAnswers");
  });

  test("тревога: каждый вариант, кроме отрицающего, — умеренная; «10 — попытка» на пункте 3 — тяжёлая", () => {
    survey.questions.forEach((q, i) => {
      const denial = i === 1 ? 10 : 0;
      for (const o of q.options) {
        if (o.score === denial) expect(o.riskFlag, `пункт ${i + 1}, вариант ${o.score}`).toBe(false);
        else {
          expect(o.riskFlag, `пункт ${i + 1}, вариант ${o.score}`).toBe(true);
          expect(o.riskSeverity).toBe(i === 2 && o.score === 10 ? "severe" : "moderate");
        }
      }
    });
  });

  test("сумма от 21 без тяжёлой полосы и сумма от 1 без тревоги недостижимы", () => {
    // перебор по сумме: первый пункт 1–10, остальные — все значения через шаг, чтобы покрыть 1…50
    for (let a = 1; a <= 10; a++)
      for (let b = 0; b <= 10; b += 5)
        for (let c = 0; c <= 10; c += 2)
          for (let d = 0; d <= 10; d += 2)
            for (let e = 0; e <= 10; e += 5) {
              const answers = byScore(survey, { 1: a, 2: b, 3: c, 4: d, 5: e });
              const ev = evaluateSubmission(survey, answers);
              const sum = ev.profile.scores[0]!.rawScore!;
              expect(ev.risk.severity).not.toBeNull();
              if (sum >= 21) expect(ev.risk.severity).toBe("severe");
            }
  });
});

/* ─────────────────────── аудит пометок риска (k-suicide, 2026-10) ─────────────────────── */

/** Пометки риска методики: «пункт:ответ:тяжесть» — ответ по коду «yes/no» или по баллу */
function marks(draft: CreateSurveyDraft): string[] {
  return (draft.questions ?? []).flatMap((q, i) =>
    (q.options ?? [])
      .filter((o) => o.riskFlag)
      .map((o) => `${i + 1}:${o.keyCode ?? o.score}:${o.riskSeverity ?? "severe"}`),
  );
}

describe("аудит пометок риска: встроенные методики учреждения", () => {
  test("СР-45: прежние девять пунктов, «Ні» на 30 (писал предсмертную записку) и «Так» на 44", () => {
    expect(marks(sr45)).toEqual([
      "3:yes:severe",
      "9:yes:severe",
      "13:yes:severe",
      "19:yes:severe",
      "24:yes:severe",
      "30:no:severe",
      "31:yes:severe",
      "33:yes:severe",
      "40:yes:severe",
      "43:yes:severe",
      "44:yes:moderate",
    ]);
    // пункт 30 сформулирован отрицанием: рискованный ответ — «Ні», и он же ключ шкалы Sr
    const sr = sr45.scales!.find((s) => s.code === "Sr")!;
    expect(sr.key!.find((k) => k.item === 30)?.matchKey).toBe("no");
    expect(sr.key!.find((k) => k.item === 44)?.matchKey).toBe("yes");
  });

  test("БОО: «Так» на 119 — тяжёлая, на 36, 47, 50 — умеренная", () => {
    expect(marks(mlo)).toEqual(["36:yes:moderate", "47:yes:moderate", "50:yes:moderate", "119:yes:severe"]);
  });

  test("SAD PERSONS — P и O без изменений; Мини-мульт — пунктов о суициде нет", () => {
    expect(marks(sadPersons)).toEqual(["4:yes:severe", "8:yes:severe"]);
    expect(marks(minimult)).toEqual([]);
  });
});

/**
 * Сторож: пункт о суициде, самоповреждении или вреде другим без пометки риска.
 *
 * Правило каталога: каждый такой пункт несёт пометку, как девятый пункт PHQ-9; пропуск —
 * клинический дефект: ответ «часто хочеться померти» ложится ждать приёма. Аудит нашёл
 * шесть таких пунктов (СР-45 30 и 44, БОО 36, 47, 50, 119) — этот сторож держит их и
 * ловит следующие, в том числе в методиках, которые добавят после.
 *
 * Узнаёт по словам украинского текста. Слова — те, что говорят о собственном суициде,
 * самоповреждении или вреде другому; «смерть», «загибель», «травма» в списке нет — иначе
 * сторож звонил бы на каждый вопрос о боевом опыте. Исключения перечислены поимённо и с
 * причиной: пункт об отношении к суициду вообще — не пункт о собственном риске.
 */
const RISK_WORDS =
  /суїцид|самогуб|покінч\S*\s+(з|із)\s+(собою|життям)|(у|в)бити\s+себе|накласти на себе руки|(піти|відход\S*|відхід)\s+(з|із)\s+(цього\s+)?житт|бути\s+мертв|не було в живих|не прокида|не прокинут|(хоч\S*|хоті\S*|бажан\S*|краще\s+було\s+б)\s+(б\s+)?померти|собі\s+смерт|самоушкод|заподіяти\s+собі|ушкодження\s+собі|завдати\s+собі|передсмертн|нашкодити|бійк/i;

const NOT_RISK_ITEMS: Record<string, string> = {
  "sr45#14": "отношение к суициду других («дивно, що дехто … не хоче покінчити з собою»), а не собственные мысли",
  "sr45#15": "отношение к суициду вообще («відчуття приреченості призводить до … відходу з життя»)",
  "sr45#16": "отношение к допустимости ухода из жизни, без мысли или намерения",
  "sr45#38": "отношение к эвтаназии при неизлечимой болезни",
  "pcl5#20": "сон: «щоб не прокидатися» — непрерывный сон, а не желание не проснуться",
  "ris#3": "сон: «не прокидаючись» — сон без пробуждений, а не желание не проснуться",
  "lec5#14": "перечень пережитых событий: внезапная насильственная смерть (в том числе самоубийство) другого человека — событие, а не собственный риск (как pcptsd5#1)",
  "pcptsd5#1": "отсеивающий вопрос о травматическом событии: гибель близкого от самоубийства — пережитое событие, а не собственный риск",
};

describe("сторож: пункт о суициде, самоповреждении или вреде другим без пометки риска", () => {
  const ALL: [string, CreateSurveyDraft][] = [
    ["sr45", sr45],
    ["sad-persons", sadPersons],
    ["minimult", minimult],
    ["mlo", mlo],
    ...CATALOG.map((e): [string, CreateSurveyDraft] => [e.key, e.draft]),
  ];

  test("каждый такой пункт размечен; исключения — только из списка, с причиной", () => {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const [key, draft] of ALL) {
      (draft.questions ?? []).forEach((q, i) => {
        const title = q.title as { uk?: string; ru?: string };
        const text = title.uk || title.ru || "";
        if (!RISK_WORDS.test(text)) return;
        const id = `${key}#${i + 1}`;
        const flagged = (q.options ?? []).some((o) => o.riskFlag) || (q.riskThreshold ?? null) !== null;
        if (NOT_RISK_ITEMS[id]) {
          seen.add(id);
          return;
        }
        if (!flagged) missing.push(`${id}: ${text}`);
      });
    }
    expect(missing, "пункт о суициде, самоповреждении или вреде другим без пометки риска").toEqual([]);
    // исключение, которое больше ни с чем не совпадает, — мёртвое: оно молча разрешило бы новый пункт
    expect([...seen].sort()).toEqual(Object.keys(NOT_RISK_ITEMS).sort());
  });
});
