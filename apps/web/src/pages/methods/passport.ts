import { instrumentCode, type Administration, type CatalogCutoff, type CatalogLink, type CatalogStep, type CutoffOp, type Lang, type RuleHit, type UiKey } from "@quizzy/shared";
import { fixedIn, splitCode } from "./model";

/*
 * Клинический паспорт методики словами экрана: порог, шаг скрининга, кто
 * заполняет, строка «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10». Одно место
 * на строку каталога, «Коротко про методику», страницу методики, протокол и
 * ящик назначения — без React, проверяется в apps/web/test/catalogPassport.test.ts.
 */

const SIGN: Record<CutoffOp, string> = { ">=": "≥", "<=": "≤", ">": ">", "<": "<" };

/** «≥ 10», «≤ 2», «≥ 2,54»; со шкалой — «Депресія (PHQ-2) ≥ 3» */
export function condText(c: Pick<CatalogCutoff, "scale" | "op" | "value">, lang: Lang): string {
  return `${c.scale ? `${c.scale} ` : ""}${SIGN[c.op]} ${fixedIn(lang, c.value, 2, false)}`;
}

/** Порог словами: «≥ 10 — клінічно значуща депресія» */
export function cutoffText(c: CatalogCutoff, lang: Lang): string {
  return `${condText(c, lang)} — ${c.means}`;
}

/** Код методики по ссылке паспорта: «PHQ-9»; без кода — название целиком */
export function linkCode(link: Pick<CatalogLink, "title">): string {
  return splitCode(link.title).code ?? link.title;
}

/** Шаг скрининга коротко, для строки каталога: «≥ 3 → PHQ-9» */
export function stepText(s: CatalogStep, lang: Lang): string {
  return `${condText(s, lang)} → ${linkCode(s.next)}`;
}

/** Кто заполняет — строкой каталога («заповнює пацієнт») */
export function fillsKey(administration: Administration): UiKey {
  return administration === "clinician" ? "bt.byClinician" : administration === "informant" ? "dpc.fillsInformant" : "dpc.fillsSelf";
}

/** Кто заполняет — значением строки паспорта («Хто заповнює: фахівець») */
export function whoKey(administration: Administration): UiKey {
  return administration === "clinician" ? "dpc.whoClinician" : administration === "informant" ? "dpc.whoInformant" : "mc.bySelf";
}

/* ─────────── предложение правила ─────────── */

/** Предложенная методика, которую ещё есть смысл назначить: не назначена и не пройдена после срабатывания */
export type Suggestion = NonNullable<RuleHit["suggested"]>[number];

export function suggestionOpen(s: Suggestion): boolean {
  return !s.assigned && !s.doneAt;
}

/**
 * Чем сработало правило: «PHQ-2 = 4»; не по главной шкале — со шкалой,
 * «PHQ-4, Депресія (PHQ-2) = 4» (главную сервер не называет). Без баллов
 * (правило по флагу риска) — код методики.
 */
export function basisText(hit: Pick<RuleHit, "surveyTitle" | "basis">, lang: Lang): string {
  /* код — общим правилом консоли: «МЛО» из «МЛО «Адаптивность-200»», а не название целиком */
  const code = hit.surveyTitle ? instrumentCode(hit.surveyTitle) : "";
  const basis = hit.basis ?? [];
  if (!basis.length) return code;
  return basis.map((b) => `${code}${b.scale ? `, ${b.scale}` : ""} = ${fixedIn(lang, b.value, 2, false)}`).join("; ");
}

/**
 * Открытые предложения правил человеку — по одному на методику: два
 * срабатывания (PHQ-2 вчера и сегодня) предлагают одну PHQ-9, и строка
 * «Рекомендовано» одна — по свежему срабатыванию (список приходит свежими
 * первыми). Назначенное и пройденное после срабатывания — не предложение.
 */
export function openSuggestions(hits: readonly RuleHit[]): { hit: RuleHit; target: Suggestion }[] {
  const seen = new Set<string>();
  const out: { hit: RuleHit; target: Suggestion }[] = [];
  for (const hit of hits) {
    if (hit.status !== "suggested") continue;
    for (const target of hit.suggested ?? []) {
      if (!suggestionOpen(target) || seen.has(target.surveyId)) continue;
      seen.add(target.surveyId);
      out.push({ hit, target });
    }
  }
  return out;
}
