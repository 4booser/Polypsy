import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSurveySchema,
  evaluateSubmission,
  validateSurvey,
  type Answer,
  type CreateSurveyDraft,
  type SurveyFull,
} from "@quizzy/shared";
import { CATALOG } from "../catalog";
import { CATALOG_BATTERIES } from "../catalogBatteries";
import { catalogDomain } from "../catalogDomains";
import { MINIMULT_NOT_SCORED, minimult, minimultNote } from "../minimult";
import { mlo, mloNote } from "../mlo";
import { sadPersons, sadPersonsNote } from "../sadPersons";
import { sr45, sr45Note } from "../sr45";

/**
 * Методики учреждения в общем каталоге (dp-inst, 2026-10-28): БОО
 * «Адаптивність-200», Міні-мульт, СР-45, SAD PERSONS.
 *
 * До выката их ставил только демонстрационный посев, и на проде, где посева
 * нет, их не было вовсе. Владелец продукта решил вывести их на рабочий
 * экземпляр; лицензии правообладателя у них нет, и основание — его решение и
 * подтверждение учреждения. Проверяется, что это записано честно (досье,
 * примечание для персонала, источник журнала) и что методика, которую теперь
 * увидит каждый врач каталога и каждый пациент, говорит с обследуемым
 * нейтрально, а с врачом — клинически точно.
 *
 * Примеры — из полей `example` досье docs/instruments/dossiers/review-institution.json
 * и из ключей методик; расчёт — в комментарии рядом с ожиданием. Сдача идёт через
 * evaluateSubmission — тот же вход, что у сервера и устройства без сети. Конвертер —
 * копия, а не импорт (как в golden-suicide.test.ts: импорт зарегистрировал бы чужие
 * тесты второй раз); от той копии отличается тем, что переносит поправки, нормы и
 * таблицы стенов — без них не посчитать ни ОАП, ни стены БОО.
 */
function toSurveyFull(draft: unknown): SurveyFull {
  const input = createSurveySchema.parse(draft);
  const ru = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string; uk?: string }).ru ?? ""));
  const uk = (v: unknown) => (typeof v === "string" ? v : ((v as { ru?: string; uk?: string }).uk ?? ""));
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
    // подпись полосы и название шкалы — украинские: так их читает врач отделения
    title: uk(s.title),
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
      label: uk(b.label),
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
    corrections: (s.corrections ?? []).map((c) => ({ sourceScaleCode: c.from, coefficient: c.coefficient })),
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
    scoringEnabled: input.scoringEnabled ?? false,
    questions,
    scales,
    sections: [],
    versionId: "v",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/** Ответы «да/нет» на все пункты: `yes` — номера с ответом «Так», остальные — «Ні» */
function yesOn(survey: SurveyFull, yes: Iterable<number>): Answer[] {
  const set = new Set(yes);
  return survey.questions.map((q, i) => ({
    questionId: q.id,
    optionIds: [q.options.find((o) => o.keyCode === (set.has(i + 1) ? "yes" : "no"))!.id],
  }));
}

const allItems = (survey: SurveyFull) => survey.questions.map((_, i) => i + 1);

/** Ключ шкалы черновика: номера пунктов с ожидаемым ответом */
const keyed = (draft: CreateSurveyDraft, code: string, match: "yes" | "no") =>
  (draft.scales ?? [])
    .find((s) => s.code === code)!
    .key!.filter((k) => k.matchKey === match)
    .map((k) => k.item);

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
  ["mlo", mlo, mloNote],
  ["minimult", minimult, minimultNote],
  ["sr45", sr45, sr45Note],
  ["sad-persons", sadPersons, sadPersonsNote],
] as const;

interface DossierCard {
  key: string;
  license: { verdict: string };
  decision?: { date: string; by: string; quote?: string | null; basis: string };
  verdict: string;
}

const DOSSIER: DossierCard[] = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../../../../docs/instruments/dossiers/review-institution.json"), "utf8"),
);

/** Обследуемый видит название, описание и инструкцию до первого вопроса (patient/Runner.tsx, мобилка) */
const ALARM = /суїцид|суицид|самогуб|самоуб|смерт|ризик|риск|MMPI|психопат|шизо/iu;

describe("методики учреждения: запись каталога", () => {
  for (const [key, draft, note] of GROUP) {
    test(`${key}: запись каталога на месте, схема и проверка структуры без ошибок`, () => {
      const entry = CATALOG.find((e) => e.key === key);
      expect(entry?.draft).toBe(draft);
      expect(entry?.note).toBe(note);
      const errors = validateSurvey(createSurveySchema.parse(draft)).filter((i) => i.level === "error");
      expect(errors.map((e) => `${e.where}: ${e.message}`)).toEqual([]);
    });

    test(`${key}: основание — решение владельца продукта, без выдуманной лицензии`, () => {
      /*
       * Правило каталога — цитата правообладателя в досье. У этих четырёх её нет,
       * и запись обязана это сказать: кто решил, когда, что учреждение
       * подтверждает право, — и не утверждать свободной лицензии. Мутация:
       * вписать в примечание «вільне використання» — падает вторая группа.
       */
      const source = CATALOG.find((e) => e.key === key)!.source;
      for (const text of [note, source]) {
        expect(text).toContain("28.10.2026");
        expect(text).toContain("власника продукту");
        expect(text).toContain("підтверджує");
        expect(text, "запись выдаёт решение за лицензию").not.toMatch(/public domain|суспільн\S* надбанн|вільн\S* використанн|CC BY/iu);
      }
      const card = DOSSIER.find((c) => c.key === key)!;
      expect(card.decision).toEqual({
        date: "2026-10-28",
        by: "владелец продукта Polypsy",
        quote: "ставь тесты",
        basis: expect.stringContaining("Учреждение подтверждает право её использования"),
      });
      // лицензия правообладателя по-прежнему не выяснена — решение её не подменяет
      expect(["не выяснено", "ограничена"]).toContain(card.license.verdict);
      expect(card.verdict).toContain("с 2026-10-28");
    });

    test(`${key}: название, описание и инструкция — без тревожных слов; результат обследуемому не показывается`, () => {
      expect(draft.showResultsToPatient).toBe(false);
      // SAD PERSONS обследуемый не видит вовсе: её заполняет специалист (проверка ниже)
      if (draft.administration === "clinician") return;
      const parsed = createSurveySchema.parse(draft);
      for (const field of [parsed.title, parsed.description, parsed.instructions]) {
        for (const lang of ["uk", "ru"] as const) {
          const text = (field as { uk?: string; ru?: string } | undefined)?.[lang] ?? "";
          expect(text.trim(), `${key}/${lang}: пусто`).not.toBe("");
          expect(text, `${key}/${lang}`).not.toMatch(ALARM);
        }
      }
    });

    test(`${key}: в украинском тексте нет русских букв и латиницы внутри кириллических слов`, () => {
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

  test("СР-45: нейтральное название с кодом в скобках, клинический смысл — в шкале", () => {
    /*
     * «СР-45. Схильність до суїцидальних реакцій» человек читал до первого
     * вопроса. Код в скобках — как у всего каталога: по нему строки персонала и
     * плитка кабинета узнают методику. Мутация: вернуть прежнее название —
     * падает первое ожидание и проверка тревожных слов выше.
     */
    expect(sr45.title).toEqual({ uk: "Опитувальник (СР-45)", ru: "Опросник (СР-45)" });
    const scale = sr45.scales!.find((s) => s.code === "Sr")!;
    expect(scale.title).toEqual({ uk: "Схильність до суїцидальних реакцій", ru: "Склонность к суицидальным реакциям" });
  });

  test("SAD PERSONS заполняет специалист и закрыта; остальные — самоотчёт", () => {
    // фильтр видимости пациента пропускает только самоотчёт (routes/access.ts)
    expect(sadPersons.administration).toBe("clinician");
    expect(sadPersons.visibility).toBe("restricted");
    for (const draft of [mlo, minimult, sr45]) expect(draft.administration).toBe("self");
  });

  test("тревоги по суицидальному риску эскалируются через час; план безопасности — у самоотчётов с пунктами риска", () => {
    expect(sr45.alertEscalateMinutes).toBe(60);
    expect(sadPersons.alertEscalateMinutes).toBe(60);
    expect(sr45.safetyPlan).toBeTruthy();
    expect(mlo.safetyPlan).toBeTruthy();
  });

  test("направления: БОО и Міні-мульт — личность, СР-45 и SAD PERSONS — суицидальный риск", () => {
    expect(catalogDomain("mlo")).toBe("personality");
    expect(catalogDomain("minimult")).toBe("personality");
    expect(catalogDomain("sr45")).toBe("suicide");
    expect(catalogDomain("sad-persons")).toBe("suicide");
  });

  test("Міні-мульт: вне ключа только пункт 20, и он объявлен с причиной", () => {
    const used = new Set(minimult.scales!.flatMap((s) => (s.key ?? []).map((k) => k.item)));
    const outside = allItems(toSurveyFull(minimult)).filter((n) => !used.has(n));
    expect(outside).toEqual([20]);
    expect(MINIMULT_NOT_SCORED.items).toEqual([20]);
    expect(CATALOG.find((e) => e.key === "minimult")!.notScored).toBe(MINIMULT_NOT_SCORED);
  });

  test("набор «Поглиблене психологічне обстеження»: СР-45 первым, порядок не строгий", () => {
    const tpl = CATALOG_BATTERIES.find((b) => b.key === "psych-deep")!;
    expect(tpl.title.uk).toBe("Поглиблене психологічне обстеження");
    expect(tpl.items.map((i) => i.key)).toEqual(["sr45", "mlo", "minimult"]);
    expect(tpl.strictOrder).toBe(false);
  });
});

describe("золотой протокол: SAD PERSONS", () => {
  const survey = toSurveyFull(sadPersons);
  const ev = (yes: number[]) => evaluateSubmission(survey, yesOn(survey, yes));
  const sp = (yes: number[]) => ev(yes).profile.scores.find((s) => s.scaleCode === "SP")!;

  test("пример досье: имеются S и A → 2, полоса 0–2, тревоги нет", () => {
    // по баллу за каждый имеющийся фактор (Bolton et al., 2012): 1 + 1 = 2
    expect(sp([1, 2]).rawScore).toBe(2);
    expect(sp([1, 2]).band?.label).toBe("Низький ризик");
    expect(ev([1, 2]).risk.severity).toBeNull();
  });

  test("пример досье: имеются все десять → 10, полоса 7–10 и тяжёлая тревога", () => {
    const all = allItems(survey);
    expect(sp(all).rawScore).toBe(10);
    expect(sp(all).band?.label).toBe("Дуже високий ризик");
    expect(ev(all).risk.severity).toBe("severe");
  });

  test("границы 2/3, 4/5, 6/7: «Низький» → «Середній» (умеренная) → «Високий» (тяжёлая) → «Дуже високий»", () => {
    // S, A, D, E, R, So, N — без P (4) и O (8): границы смотрятся без тревоги по фактору
    const plain = [1, 2, 3, 5, 6, 7, 9];
    const at = (n: number) => sp(plain.slice(0, n));
    expect([2, 3, 4, 5, 6, 7].map((n) => at(n).band?.label)).toEqual([
      "Низький ризик",
      "Середній ризик",
      "Середній ризик",
      "Високий ризик",
      "Високий ризик",
      "Дуже високий ризик",
    ]);
    expect(ev(plain.slice(0, 3)).risk.severity).toBe("moderate");
    expect(ev(plain.slice(0, 5)).risk.severity).toBe("severe");
  });

  test("P (спроби в анамнезі) или O (план) — тяжёлая тревога при любой сумме", () => {
    // 1 балл — полоса «Низький ризик», но фактор P или O сам по себе требует внимания немедленно
    for (const factor of [4, 8]) {
      const e = ev([factor]);
      expect(e.profile.scores[0]!.rawScore).toBe(1);
      expect(e.profile.scores[0]!.band?.severity).toBe("none");
      expect(e.risk.severity).toBe("severe");
    }
    expect(survey.questions[3]!.title).toBe("Previous attempt — суицидальные попытки в анамнезе");
  });
});

describe("золотой протокол: БОО «Адаптивність-200»", () => {
  const survey = toSurveyFull(mlo);
  const ev = (yes: Iterable<number>) => evaluateSubmission(survey, yesOn(survey, yes));
  const score = (e: ReturnType<typeof ev>, code: string) => e.profile.scores.find((s) => s.scaleCode === code)!;

  test("пример досье: всё «Ні» → Д = 13, профиль недостоверен; стены — по таблицам пособия", () => {
    /*
     * Ключ Д — 13 пунктов «Ні»: все совпали, 13 > 9 («10 і більше збігів» — недостоверно).
     * Остальные шкалы при сплошных «Ні» набирают только «ні»-часть ключа:
     *   ПР 22 → стен 5 (19–26), КП 12 → 6 (11–12), МН 6 → 8 (5–6), ВПН 3 → 8 (2–3),
     *   ДАП 3 → 10 (0–3), СР 2 → 7 (2–2); ОАП = 22 + 12 + 6 = 40 → 6 (30–42).
     */
    const e = ev([]);
    expect(score(e, "D").rawScore).toBe(13);
    expect(e.profile.reliable).toBe(false);
    const stens = Object.fromEntries(["PR", "KP", "MN", "VPN", "DAP", "SR", "LAP"].map((c) => [c, [score(e, c).rawScore, score(e, c).value]]));
    expect(stens).toEqual({ PR: [22, 5], KP: [12, 6], MN: [6, 8], VPN: [3, 8], DAP: [3, 10], SR: [2, 7], LAP: [0, 6] });
    expect(score(e, "LAP").correctedScore).toBe(40);
    // ни одной полосы с тревогой и ни одного «Так» на критическом пункте
    expect(e.risk.severity).toBeNull();
  });

  test("пример досье: всё «Так» → Д = 0, профиль достоверен; все шкалы — 1–2 стена, тревога тяжёлая", () => {
    /*
     * «Так» на всё: Д не набирает ничего (ключ — одни «Ні»). Содержательные шкалы — вся
     * «так»-часть ключа: ПР 74 → 1 (≥ 57), КП 20 → 2 (20–22), МН 18 → 1 (≥ 17),
     * ВПН 22 → 1 (≥ 18), ДАП 33 → 1 (≥ 25), СР 18 → 1 (≥ 15); ОАП = 74 + 20 + 18 = 112 → 1 (≥ 97).
     */
    const e = ev(allItems(survey));
    expect(score(e, "D").rawScore).toBe(0);
    expect(e.profile.reliable).toBe(true);
    const stens = Object.fromEntries(["PR", "KP", "MN", "VPN", "DAP", "SR"].map((c) => [c, [score(e, c).rawScore, score(e, c).value]]));
    expect(stens).toEqual({ PR: [74, 1], KP: [20, 2], MN: [18, 1], VPN: [22, 1], DAP: [33, 1], SR: [18, 1] });
    expect(score(e, "LAP").correctedScore).toBe(112);
    expect(score(e, "LAP").value).toBe(1);
    expect(e.risk.severity).toBe("severe");
  });

  test("подпись полосы называет то, о чём шкала: у СР — риск, у ДАП — склонность, у остальных — уровень", () => {
    /*
     * Стен обратен сырому баллу, и «Суїцидальний ризик: високий рівень» читался как
     * высокий риск, хотя значил самый низкий. Мутация: вернуть общие подписи
     * уровней шкале СР — падает первое ожидание.
     */
    const worst = ev(allItems(survey));
    expect(score(worst, "SR").band?.label).toBe("Високий ризик");
    expect(score(worst, "DAP").band?.label).toBe("Виражена схильність");
    expect(score(worst, "PR").band?.label).toBe("Вкрай низький рівень");
    const best = ev([]);
    expect(score(best, "SR").band?.label).toBe("Низький ризик");
    expect(score(best, "DAP").band?.label).toBe("Дуже низька схильність");
    expect(score(best, "MN").band?.label).toBe("Високий рівень");
    // тревога по полосе несёт ту же подпись — в очереди разбора тоже «Високий ризик»
    expect(worst.risk.bands.map((b) => b.label)).toContain("Суїцидальний ризик (СР): Високий ризик");
  });

  test("СР: 6 совпадений — стен 4, «Ризик не підвищений» без тревоги; 7 — стен 3, «Підвищений ризик», тяжёлая", () => {
    // «ні»-часть ключа СР (32, 105) при сплошных «Ні» даёт 2; ещё «Так» на 4, 8, 10, 28 — 6, и на 29 — 7
    const sr = keyed(mlo, "SR", "yes");
    expect(sr.slice(0, 5)).toEqual([4, 8, 10, 28, 29]);
    const six = ev(sr.slice(0, 4));
    expect([score(six, "SR").rawScore, score(six, "SR").value, score(six, "SR").band?.label]).toEqual([6, 4, "Ризик не підвищений"]);
    expect(six.risk.bands.filter((b) => b.label.startsWith("Суїцидальний ризик"))).toEqual([]);
    const seven = ev(sr.slice(0, 5));
    expect([score(seven, "SR").rawScore, score(seven, "SR").value, score(seven, "SR").band?.label]).toEqual([7, 3, "Підвищений ризик"]);
    expect(seven.risk.bands.find((b) => b.label.startsWith("Суїцидальний ризик"))?.severity).toBe("severe");
  });

  test("достоверность: 9 совпадений по Д — ещё достоверно, 10 — уже нет", () => {
    // «Так» на всё, кроме девяти (десяти) пунктов ключа Д — на них «Ні»
    const d = keyed(mlo, "D", "no");
    const yes = (skip: number) => allItems(survey).filter((n) => !d.slice(0, skip).includes(n));
    expect(score(ev(yes(9)), "D").rawScore).toBe(9);
    expect(ev(yes(9)).profile.reliable).toBe(true);
    expect(score(ev(yes(10)), "D").rawScore).toBe(10);
    expect(ev(yes(10)).profile.reliable).toBe(false);
  });

  test("критические пункты: «Так» на 119 — тяжёлая, на 36, 47, 50 — умеренная; «Ні» тревоги не поднимает", () => {
    const answerRisk = (n: number) => ev([n]).risk.answers.map((r) => r.severity);
    expect(answerRisk(119)).toEqual(["severe"]);
    for (const n of [36, 47, 50]) expect(answerRisk(n)).toEqual(["moderate"]);
    expect(ev([]).risk.answers).toEqual([]);
  });
});

describe("СР-45 и Мини-мульт: примеры досье на том же входе, что у сервера", () => {
  /*
   * Их золотые протоколы — в golden.test.ts (подсчёт через computeProfile). Здесь — примеры
   * карточек досье через evaluateSubmission: вместе с достоверностью и тревогой, которую
   * человек получит на самом деле.
   */
  test("СР-45, всё «Так»: Sr = 24/35 = 0,686 («Вище середнього»), L = 9/10 — протокол недостоверен", () => {
    const survey = toSurveyFull(sr45);
    const e = evaluateSubmission(survey, yesOn(survey, allItems(survey)));
    const sr = e.profile.scores.find((s) => s.scaleCode === "Sr")!;
    const l = e.profile.scores.find((s) => s.scaleCode === "L")!;
    expect([sr.rawScore, sr.value, sr.band?.label]).toEqual([24, 0.686, "Вище середнього"]);
    expect([l.rawScore, l.value]).toEqual([9, 0.9]);
    expect(e.profile.reliable).toBe(false);
    // недостоверный протокол тревог не отменяет: «Так» на пунктах о попытках — тяжёлая
    expect(e.risk.severity).toBe("severe");
  });

  test("СР-45, всё «Ні»: Sr = 11/35 = 0,314 («Нижче середнього»), L = 1/10; «Ні» на п. 30 — тяжёлая тревога", () => {
    const survey = toSurveyFull(sr45);
    const e = evaluateSubmission(survey, yesOn(survey, []));
    const sr = e.profile.scores.find((s) => s.scaleCode === "Sr")!;
    expect([sr.rawScore, sr.value, sr.band?.label]).toEqual([11, 0.314, "Нижче середнього"]);
    expect(e.profile.scores.find((s) => s.scaleCode === "L")!.value).toBe(0.1);
    expect(e.profile.reliable).toBe(true);
    // «Ніколи нікому не писав передсмертної записки» — «Ні» значит, что писал
    expect(e.risk.answers.map((r) => survey.questions.findIndex((q) => q.id === r.questionId) + 1)).toEqual([30]);
    expect(e.risk.severity).toBe("severe");
  });

  test("Мини-мульт: всё «Вірно» → Ma = 11 (K = 0); всё «Невірно» → Ma = 1 + 0,2 × 16 = 4,2", () => {
    const survey = toSurveyFull(minimult);
    const ma = (yes: number[]) =>
      evaluateSubmission(survey, yesOn(survey, yes), { sex: "male", age: 30 }).profile.scores.find((s) => s.scaleCode === "Ma")!;
    expect([ma(allItems(survey)).rawScore, ma(allItems(survey)).correctedScore]).toEqual([11, 11]);
    expect([ma([]).rawScore, ma([]).correctedScore]).toEqual([1, 4.2]);
    // норм у шкалы 9 нет — значение остаётся сырым (с поправкой)
    expect(ma([]).normalization).toBe("raw");
  });
});
