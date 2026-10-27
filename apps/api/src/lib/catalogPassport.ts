import {
  CATALOG_ROLES,
  estimateMinutes,
  fallbackRole,
  LOCALE_OF,
  SURVEY_DOMAINS,
  t,
  type Administration,
  type CatalogCutoff,
  type CatalogLink,
  type CatalogPassport,
  type CatalogRole,
  type CatalogRowPassport,
  type CatalogStep,
  type Lang,
  type LocalizedText,
  type SurveyDomain,
} from "@quizzy/shared";
import { CATALOG, type CatalogEntry } from "../instruments/catalog";
import { familyHead, passportSpec, shortFormsOf, type PassportSpec } from "../instruments/catalogPassport";

/**
 * Клинический паспорт методики для ответа сервера — из паспорта каталога
 * (instruments/catalogPassport.ts) по ключу строки, на языке читающего.
 *
 * Паспорт не хранится в строке методики: он читается из кода при каждой
 * выдаче (см. заголовок instruments/catalogPassport.ts). Методика учреждения
 * паспорта каталога не имеет — у неё роль по тому, кто заполняет, время по
 * числу пунктов и пустые пороги: «что измеряет» о ней знает только автор.
 *
 * Ссылки на другие методики каталога (полная форма, короткие формы, шаг
 * скрининга) — по ключу каталога, а переход — к строке учреждения, если она
 * видна читающему (`visible`, собирает маршрут в своей зоне). Методики нет или
 * она вне зоны — ссылка без перехода, с названием из каталога.
 */

const ENTRY = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.key, e] as const));

type DraftScale = { code: string; title: LocalizedText; bands?: unknown[] };

/** Шкалы черновика каталога с полосами — по ним названы пороги паспорта */
function bandedScales(key: string): DraftScale[] {
  const scales = (ENTRY.get(key)?.draft.scales ?? []) as unknown as DraftScale[];
  return scales.filter((s) => (s.bands ?? []).length > 0);
}

/**
 * Название шкалы для порога: null, когда это первая шкала с полосами —
 * главная, о ней строка и так («≥ 10 — клінічно значуща депресія»); иначе
 * название, чтобы «≥ 3» у PHQ-4 говорило, у какой подшкалы.
 */
function scaleLabel(key: string, code: string | undefined, lang: Lang): string | null {
  if (!code) return null;
  const scales = bandedScales(key);
  if (scales[0]?.code === code) return null;
  const scale = scales.find((s) => s.code === code);
  return scale ? t(scale.title, lang) : null;
}

/** Название шкалы по-украински для правила шага (instruments/catalogPassport.ts, catalogRules) */
export function ruleScaleTitle(key: string, code: string): string | null {
  return scaleLabel(key, code, "uk");
}

/** Пунктов для ответа в черновике каталога: без информационных экранов */
export function draftItems(key: string): number | null {
  const entry = ENTRY.get(key);
  return entry ? (entry.draft.questions ?? []).filter((q) => q.type !== "info").length : null;
}

/** Строка учреждения методики каталога, видимая читающему: id и название */
export interface VisibleCatalogRow {
  id: string;
  title: unknown;
}

function linkOf(key: string, lang: Lang, visible: ReadonlyMap<string, VisibleCatalogRow>): CatalogLink {
  const row = visible.get(key);
  const draftTitle = ENTRY.get(key)?.draft.title as LocalizedText | undefined;
  return {
    key,
    surveyId: row?.id ?? null,
    title: row ? t(row.title as never, lang) : draftTitle ? t(draftTitle, lang) : key,
  };
}

function cutoffsOf(key: string, spec: PassportSpec, lang: Lang): CatalogCutoff[] {
  return (spec.cutoffs ?? []).map((c) => ({
    scale: scaleLabel(key, c.scale, lang),
    op: c.op,
    value: c.value,
    means: t(c.means, lang),
  }));
}

function stepsOf(key: string, spec: PassportSpec, lang: Lang, visible: ReadonlyMap<string, VisibleCatalogRow>): CatalogStep[] {
  return (spec.steps ?? []).map((s) => ({
    scale: scaleLabel(key, s.scale, lang),
    op: s.op,
    value: s.value,
    next: linkOf(s.next, lang, visible),
    source: s.source,
  }));
}

/**
 * Ключи каталога, на которые ссылаются паспорта этих методик: полные формы,
 * короткие формы и шаги. Маршрут ищет их строки одним запросом в своей зоне.
 */
export function relatedKeys(keys: readonly (string | null | undefined)[], withShortForms = false): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    const spec = passportSpec(key);
    if (!key || !spec) continue;
    for (const k of spec.fullForms ?? []) out.add(k);
    for (const s of spec.steps ?? []) out.add(s.next);
    if (withShortForms) for (const k of shortFormsOf(key)) out.add(k);
  }
  return [...out];
}

interface PassportRow {
  catalogKey?: string | null;
  administration: Administration;
}

/**
 * Время заполнения: из руководства, если паспорт его называет; иначе по числу
 * пунктов действующей версии (`items`) — правка в учреждении меняет и время.
 */
function minutesOf(spec: PassportSpec | null, items: number, administration: Administration): number {
  return spec?.minutes ?? estimateMinutes(items, administration);
}

/** Паспорт строки каталога: роль, время, что измеряет, пороги и шаги, ключ полной методики */
export function rowPassport(
  row: PassportRow,
  items: number,
  lang: Lang,
  visible: ReadonlyMap<string, VisibleCatalogRow>,
): CatalogRowPassport {
  const key = row.catalogKey ?? null;
  const spec = passportSpec(key);
  if (!key || !spec) {
    return {
      role: fallbackRole(row.administration),
      minutes: minutesOf(null, items, row.administration),
      purpose: null,
      cutoffs: [],
      parent: null,
      steps: [],
    };
  }
  return {
    role: spec.role,
    minutes: minutesOf(spec, items, row.administration),
    purpose: t(spec.purpose, lang),
    cutoffs: cutoffsOf(key, spec, lang),
    parent: spec.fullForms?.[0] ?? null,
    steps: stepsOf(key, spec, lang, visible),
  };
}

/**
 * Паспорт методики для её страницы: то же, что у строки, и ссылки на формы в
 * обе стороны — полная знает свои короткие формы (от короткой к длинной),
 * короткая — свою полную. null — у методики учреждения паспорта каталога нет:
 * страница показывает то, что знает о методике сама (роль, время, кто заполняет).
 */
export function surveyPassport(
  row: PassportRow,
  items: number,
  lang: Lang,
  visible: ReadonlyMap<string, VisibleCatalogRow>,
): CatalogPassport {
  const key = row.catalogKey ?? null;
  const spec = passportSpec(key);
  if (!key || !spec) {
    return {
      role: fallbackRole(row.administration),
      minutes: minutesOf(null, items, row.administration),
      purpose: null,
      cutoffs: [],
      fullForms: [],
      shortForms: [],
      steps: [],
    };
  }
  const shortForms = shortFormsOf(key).sort((a, b) => (draftItems(a) ?? 0) - (draftItems(b) ?? 0) || a.localeCompare(b));
  return {
    role: spec.role,
    minutes: minutesOf(spec, items, row.administration),
    purpose: t(spec.purpose, lang),
    cutoffs: cutoffsOf(key, spec, lang),
    fullForms: (spec.fullForms ?? []).map((k) => linkOf(k, lang, visible)),
    shortForms: shortForms.map((k) => linkOf(k, lang, visible)),
    steps: stepsOf(key, spec, lang, visible),
  };
}

/* ─────────── порядок каталога ─────────── */

const ROLE_RANK: Record<CatalogRole, number> = Object.fromEntries(CATALOG_ROLES.map((r, i) => [r, i])) as Record<
  CatalogRole,
  number
>;

/** Направление по порядку перечня (чипы «Напрям»); без направления — в конце */
function domainRank(domain: SurveyDomain | null | undefined): number {
  const at = domain ? SURVEY_DOMAINS.indexOf(domain) : -1;
  return at < 0 ? SURVEY_DOMAINS.length : at;
}

export interface OrderRow {
  id: string;
  catalogKey?: string | null;
  domain?: SurveyDomain | null;
  administration: Administration;
  title: unknown;
}

/**
 * Порядок каталога для специалиста (?sort=catalog): по направлению, внутри —
 * полные методики, затем короткие формы без полной в каталоге, затем оценки
 * фахівцем; внутри роли — по названию. Короткая форма, чья полная методика
 * есть среди строк, стоит сразу под ней — от короткой к длинной («PHQ-9, под
 * ней PHQ-2, PHQ-4, PHQ-8»), а не отдельной строкой по алфавиту.
 *
 * Считается здесь, а не в SQL: семья (глава и её короткие формы) — знание
 * каталога в коде, а методик в учреждении сотни, не тысячи — сортировка всего
 * отобранного списка дешевле второго словаря в запросе. Название сравнивается
 * правилами языка (Intl.Collator), как titleOrder маршрута сравнивает ICU в
 * базе; английского текста у методик нет — английский экран сортирует
 * украинские названия по-украински.
 */
export function catalogOrder<R extends OrderRow>(rows: readonly R[], lang: Lang): R[] {
  const collator = new Intl.Collator(LOCALE_OF[lang === "en" ? "uk" : lang]);
  const byKey = new Map<string, R>();
  for (const r of rows) if (r.catalogKey) byKey.set(r.catalogKey, r);
  const titleOf = (r: R) => t(r.title as never, lang);
  const roleOf = (r: R) => passportSpec(r.catalogKey)?.role ?? fallbackRole(r.administration);

  const keyed = rows.map((r) => {
    const headKey = r.catalogKey ? familyHead(r.catalogKey) : null;
    const head = headKey && headKey !== r.catalogKey ? (byKey.get(headKey) ?? null) : null;
    const family = head ?? r;
    return {
      row: r,
      domain: domainRank(r.domain),
      role: ROLE_RANK[roleOf(family)],
      familyTitle: titleOf(family),
      familyId: family.id,
      member: head ? 1 : 0,
      items: r.catalogKey ? (draftItems(r.catalogKey) ?? 0) : 0,
      title: titleOf(r),
    };
  });

  keyed.sort(
    (a, b) =>
      a.domain - b.domain ||
      a.role - b.role ||
      collator.compare(a.familyTitle, b.familyTitle) ||
      a.familyId.localeCompare(b.familyId) ||
      a.member - b.member ||
      a.items - b.items ||
      collator.compare(a.title, b.title) ||
      a.row.id.localeCompare(b.row.id),
  );
  return keyed.map((k) => k.row);
}
