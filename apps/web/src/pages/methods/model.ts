import type { Lang, SurveyGrant, SurveyListItem } from "@quizzy/shared";

/*
 * Чистая часть раздела «Методики» (UI 3, «Виразна»): код методики из
 * названия, числа со словом, короткие даты, состояние назначения, что в
 * каталоге требует внимания. Без React и без сервера — проверяется в
 * apps/web/test/methodsModel.test.ts.
 */

/* ─────────── код методики ─────────── */

/*
 * Код — то, чем методику называют вслух: PHQ-9, GAD-7, AUDIT-C, SAD
 * PERSONS. Латиница или кириллица прописными, цифры, точка, дефис; одно
 * слово или два прописных. Строчные допускаются только после прописной
 * («ASRS-v1.1»), иначе «демо» и «шкала Розенберга» читались бы кодом.
 */
const CODE_RE = /^(?=.*[A-ZА-ЯІЇЄҐ])[A-ZА-ЯІЇЄҐ0-9][A-ZА-ЯІЇЄҐa-z0-9.-]*(?: [A-ZА-ЯІЇЄҐ0-9-]+)?$/u;
const LEADING_RE = /^([A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐ0-9-]{1,10})\.\s+(.+)$/u;
const MAX_CODE = 14;

const isCode = (s: string) => s.length <= MAX_CODE && CODE_RE.test(s);

/**
 * Код и имя методики из названия.
 *
 * Отдельного поля «код» у методики нет — названия в каталоге устроены как
 * «Депресія (PHQ-9)», «Вигорання (Копенгагенський опитувальник, CBI)» или
 * «СР-45. Схильність до суїцидальних реакцій». Код показывается пилюлей,
 * имя — рядом; остаток скобок («6 запитань», «ВООЗ») остаётся при имени.
 * Нет кода — нет пилюли: название целиком.
 */
export function splitCode(title: string): { code: string | null; name: string } {
  const t = title.trim();
  const paren = /^(.*?)\s*\(([^()]+)\)\s*$/u.exec(t);
  if (paren && paren[1]) {
    const head = paren[1].trim();
    const parts = paren[2]!.split(",").map((p) => p.trim()).filter(Boolean);
    const at = parts.findIndex(isCode);
    if (at >= 0) {
      const rest = parts.filter((_, i) => i !== at);
      return { code: parts[at]!, name: rest.length ? `${head} (${rest.join(", ")})` : head };
    }
  }
  const lead = LEADING_RE.exec(t);
  if (lead) return { code: lead[1]!, name: lead[2]!.trim() };
  return { code: null, name: t };
}

/* ─────────── число со словом ─────────── */

export type PluralForm = "one" | "few" | "many";

/**
 * Форма слова при числе: «1 пункт», «3 пункти», «9 пунктів». Правило —
 * языка (Intl.PluralRules), как у возраста в печатных листах; дробные и
 * английский — «many»/«one» по тому же правилу.
 */
export function pluralForm(lang: Lang, n: number): PluralForm {
  const cat = new Intl.PluralRules(lang === "en" ? "en" : lang).select(n);
  if (cat === "one") return "one";
  if (cat === "few") return "few";
  return "many";
}

/* ─────────── даты ─────────── */

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * «12.09» — короткая дата строки и плашки; год — только не текущий
 * («12.09.2025»). Числом, а не словом: колонка дат в таблице одной ширины,
 * и так даты сверяют с бумажным журналом.
 */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const base = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}.${d.getFullYear()}`;
}

/** «12.09, 11:05» — дата и время действия */
export function shortDateTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${shortDate(iso, now)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Полночь местного дня — для счёта «сколько дней» по календарю, а не сутками */
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Календарных дней от `from` до `to`: 0 — тот же день, 1 — завтра, −2 — позавчера */
export function dayDiff(from: Date, to: Date): number {
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/* ─────────── назначение методики ─────────── */

/**
 * Состояние назначения в таблице «Кому призначено».
 *
 *  - done — человек прошёл методику хоть раз;
 *  - late — срок прошёл, а не прошёл: назначение больше не действует, и
 *    методику он уже не видит (если она «лише за призначенням»);
 *  - soon — срок сегодня или завтра;
 *  - open — ждём.
 */
export type GrantState = "done" | "late" | "soon" | "open";

export function grantState(g: Pick<SurveyGrant, "completed" | "expiresAt">, now: Date = new Date()): GrantState {
  if (g.completed) return "done";
  if (!g.expiresAt) return "open";
  const end = new Date(g.expiresAt);
  if (end.getTime() <= now.getTime()) return "late";
  return dayDiff(now, end) <= 1 ? "soon" : "open";
}

export interface GrantCounts {
  all: number;
  /** Не пройдено (в том числе просрочено) */
  open: number;
  late: number;
  done: number;
  /** Срок — в ближайшие 7 днів, ещё не пройдено */
  expiring: number;
  /** Без срока */
  forever: number;
}

export function grantCounts(grants: readonly Pick<SurveyGrant, "completed" | "expiresAt">[], now: Date = new Date()): GrantCounts {
  const out: GrantCounts = { all: grants.length, open: 0, late: 0, done: 0, expiring: 0, forever: 0 };
  for (const g of grants) {
    const s = grantState(g, now);
    if (s === "done") out.done += 1;
    else out.open += 1;
    if (s === "late") out.late += 1;
    if (!g.expiresAt) out.forever += 1;
    if (s !== "done" && s !== "late" && g.expiresAt && dayDiff(now, new Date(g.expiresAt)) <= 7) out.expiring += 1;
  }
  return out;
}

/** Ближайший срок среди не пройденных и не просроченных — «перший — 09.10, Бойко Т. І.» */
export function nextExpiring<G extends Pick<SurveyGrant, "completed" | "expiresAt">>(grants: readonly G[], now: Date = new Date()): G | null {
  let best: G | null = null;
  for (const g of grants) {
    const s = grantState(g, now);
    if (s === "done" || s === "late" || !g.expiresAt) continue;
    if (!best || new Date(g.expiresAt) < new Date(best.expiresAt!)) best = g;
  }
  return best;
}

/** Срок из поля даты (ГГГГ-ММ-ДД) через `days` календарных дней от сегодня */
export function dueIn(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ─────────── каталог: что требует внимания ─────────── */

/** Ключи не сверены: методика считает баллы, а сверки с пособием не было */
export const keysPending = (s: Pick<SurveyListItem, "scoringEnabled" | "keysVerifiedAt">) =>
  s.scoringEnabled && !s.keysVerifiedAt;

/** Права на текст не выяснены (нет записи — то же, что «не з’ясовано») */
export const rightsPending = (s: Pick<SurveyListItem, "rightsStatus">) => !s.rightsStatus || s.rightsStatus === "unclear";

export interface Attention {
  keys: SurveyListItem[];
  rights: SurveyListItem[];
  drafts: SurveyListItem[];
}

/**
 * Что в каталоге ждёт человека — для строки внимания над таблицей.
 *
 * Только методики в работе: снятая с использования уже никому не выдаётся,
 * и её непроверенный ключ не долг. Ключи и права — у опубликованных (их
 * выдают пациентам сейчас); черновики — свежие сверху.
 */
export function attentionOf(items: readonly SurveyListItem[]): Attention {
  const live = items.filter((s) => !s.archivedAt);
  const published = live.filter((s) => s.status === "published");
  return {
    keys: published.filter(keysPending),
    rights: published.filter(rightsPending),
    drafts: live
      .filter((s) => s.status === "draft")
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
  };
}

/* ─────────── норми ─────────── */

/**
 * Зсув середнього T вибірки під чинною нормою: 50 + 10·(Mв − Mн)/SDн − 50.
 * null — норми немає або SD нульове: зсув не означений.
 */
export function tShift(manual: { mean: number; sd: number } | undefined, sample: { mean: number } | undefined): number | null {
  if (!manual || !sample || !(manual.sd > 0)) return null;
  return Math.round(((10 * (sample.mean - manual.mean)) / manual.sd) * 10) / 10;
}

/** Межа, за якою вибірка систематично відрізняється від нормувальної */
export const T_SHIFT_LIMIT = 5;
