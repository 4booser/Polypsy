import type { ClinicalDomain, ConditionDomain, Severity } from "@quizzy/shared";
import { CONDITION_DOMAINS } from "./conditions";

/**
 * Клинический домен шкалы — строка «Клінічної картини» на рабочем месте
 * пациента и клинический стан в строке реестра (участок dp-patient).
 *
 * Врачу между двумя приёмами нужно «депрессия — помірна и хуже, тревога —
 * без змін, алкоголь — можлива залежність», а не список методик по дате.
 * Полка каталога (surveys.domain) для этого груба: PHQ-9, GAD-7 и DASS-42
 * стоят на одной полке «дистрес», а DASS-42 меряет три разные вещи. Поэтому
 * домен решается по шкале, и по порядку:
 *
 *  1. Пара «ключ каталога — код шкалы» из состава направлений сводки
 *     состояния (lib/conditions.ts, CONDITION_DOMAINS): что стартовый экран
 *     считает депрессией, то и в карточке депрессия — правило одно.
 *  2. Свои пары для того, чего сводка не считает: короткие скрининги
 *     (PHQ-2, GAD-2, PSS-4), DASS-21 и общий балл PHQ-4.
 *  3. Ключ каталога целиком — для методик полки «дистрес», каждая из
 *     которых меряет что-то одно (K10 — общий дистресс, CESD-R — депрессию).
 *  4. Полка методики: травма, сон, суицидальный риск, залежності… Так
 *     получают домен встроенные методики без ключа каталога (СР-45 — полка
 *     «суїцид», Міні-мульт — «особистість») и методики учреждения, которым
 *     полку выбрал конструктор.
 *  5. «Інше». Название шкалы не читается: самодельная «Настрій» не обязана
 *     мерить депрессию, и догадка выглядела бы как знание.
 *
 * Отнесение — решение клиническое; спорные места (PHQ-15 — в общий
 * дистресс, FAS — в сон вслед за полкой каталога) должен подтвердить
 * клинический психолог.
 */

const FROM_CONDITION: Record<ConditionDomain, ClinicalDomain> = {
  depression: "depression",
  anxiety: "anxiety",
  stress: "stress",
  ptsd: "trauma",
  wellbeing: "wellbeing",
  burnout: "burnout",
  alcohol: "addiction",
};

const pairKey = (catalogKey: string, code: string) => `${catalogKey}:${code}`;

/** Пары «ключ каталога — код шкалы»: сначала из сводки, потом свои */
const BY_SCALE: ReadonlyMap<string, ClinicalDomain> = new Map([
  ...CONDITION_DOMAINS.flatMap((d) => d.sources.map((s) => [pairKey(s.catalogKey, s.code), FROM_CONDITION[d.key]] as const)),
  [pairKey("phq2", "PHQ2"), "depression"],
  [pairKey("gad2", "GAD2"), "anxiety"],
  [pairKey("pss4", "PSS4"), "stress"],
  [pairKey("dass21", "D"), "depression"],
  [pairKey("dass21", "A"), "anxiety"],
  [pairKey("dass21", "S"), "stress"],
  [pairKey("phq4", "PHQ4"), "distress"],
]);

/** Методики полки «дистрес», каждая из которых меряет одно */
const BY_METHOD: Readonly<Record<string, ClinicalDomain>> = {
  phq9: "depression",
  phq8: "depression",
  phq2: "depression",
  cesdr: "depression",
  gds15: "depression",
  gad7: "anxiety",
  gad2: "anxiety",
  pss10: "stress",
  pss4: "stress",
  k10: "distress",
  k6: "distress",
  core10: "distress",
  srq20: "distress",
  aaq2: "distress",
  phq15: "distress",
};

/** Полка каталога → домен; «персонал» на карточке пациента — это его вигорання */
const BY_SHELF: Readonly<Record<string, ClinicalDomain>> = {
  distress: "distress",
  trauma: "trauma",
  suicide: "suicide",
  sleep: "sleep",
  addiction: "addiction",
  wellbeing: "wellbeing",
  cognitive: "cognitive",
  personality: "personality",
  staff: "burnout",
  other: "other",
};

export function clinicalDomainOf(s: { catalogKey: string | null; surveyDomain: string | null; code: string }): ClinicalDomain {
  if (s.catalogKey) {
    const byScale = BY_SCALE.get(pairKey(s.catalogKey, s.code));
    if (byScale) return byScale;
    if (Object.hasOwn(BY_METHOD, s.catalogKey)) return BY_METHOD[s.catalogKey]!;
  }
  if (s.surveyDomain && Object.hasOwn(BY_SHELF, s.surveyDomain)) return BY_SHELF[s.surveyDomain]!;
  return "other";
}

/**
 * Домены, из которых складывается клинический стан строки реестра.
 * Личностные опросники (Міні-мульт, «Адаптивність-200») описывают склад,
 * а не нынешнее состояние, и самой тяжёлой строкой реестра встают, только
 * если других полос у человека нет.
 */
export function isKeyDomain(d: ClinicalDomain): boolean {
  return d !== "personality" && d !== "other";
}

const RANK: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };

/** Ступень тяжести числом: нет полосы — ниже «норми» */
export function severityRank(s: Severity | null | undefined): number {
  return s ? RANK[s] : -1;
}
