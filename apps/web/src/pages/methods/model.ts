import { LOCALE_OF, type Lang, type SurveyGrant, type SurveyListItem } from "@quizzy/shared";

/*
 * Чистая часть раздела «Методики» (UI 3, «Виразна»): код методики из
 * названия, числа со словом, короткие даты, состояние назначения, что в
 * каталоге требует внимания. Без React и без сервера — проверяется в
 * apps/web/test/methodsModel.test.ts.
 */

/* ─────────── код методики ─────────── */

/*
 * Код — то, чем методику называют вслух: PHQ-9, GAD-7, AUDIT-C, SAD
 * PERSONS, TGI-SR+. Латиница или кириллица прописными, цифры, точка, дефис,
 * плюс; одно слово или два прописных. Строчные допускаются только после
 * прописной («ASRS-v1.1»), иначе «демо» и «шкала Розенберга» читались бы кодом.
 */
const CODE_RE = /^(?=.*[A-ZА-ЯІЇЄҐ])[A-ZА-ЯІЇЄҐ0-9][A-ZА-ЯІЇЄҐa-z0-9.+-]*(?: [A-ZА-ЯІЇЄҐ0-9-]+)?$/u;
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

/**
 * Дробное число на языке экрана: «0,82» в uk и ru, «0.82» в en; `pad` — с
 * нулями в конце («50,0»), без него — сколько есть («2,3», «2»). Запятая,
 * поставленная руками (`.replace(".", ",")`), шла и в английский.
 */
export function fixedIn(lang: Lang, v: number, digits: number, pad = true): string {
  return new Intl.NumberFormat(LOCALE_OF[lang], {
    minimumFractionDigits: pad ? digits : 0,
    maximumFractionDigits: digits,
  }).format(v);
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
 * выдают пациентам сейчас); черновики — свежие сверху и только те, что
 * читающий правит (editable): черновик общего каталога дописывают его
 * администраторы, а не каждый, кто каталогом пользуется.
 */
export function attentionOf(items: readonly SurveyListItem[]): Attention {
  const live = items.filter((s) => !s.archivedAt);
  const published = live.filter((s) => s.status === "published");
  return {
    keys: published.filter(keysPending),
    rights: published.filter(rightsPending),
    drafts: live
      .filter((s) => s.status === "draft" && s.editable !== false)
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

/* ─────────── огляд методики ─────────── */

const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Понедельник недели дня «ГГГГ-ММ-ДД» (местный календарь) — тем же видом */
export function weekStart(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00`);
  const back = (d.getDay() + 6) % 7;
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/**
 * Проходження по неделям из счёта по дням: последние `weeks` недель до
 * текущей включительно, пустые — нулём (неделя без проходжень — тоже ответ),
 * последняя помечена `partial`, пока не кончилась.
 */
export function weeklyCounts(
  timeline: readonly { date: string; count: number }[],
  weeks: number,
  now: Date = new Date(),
): { week: string; count: number; partial: boolean }[] {
  const by = new Map<string, number>();
  for (const p of timeline) {
    const w = weekStart(p.date);
    by.set(w, (by.get(w) ?? 0) + p.count);
  }
  const base = new Date(`${weekStart(ymd(now))}T00:00:00`);
  const out: { week: string; count: number; partial: boolean }[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const w = ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 7 * i));
    out.push({ week: w, count: by.get(w) ?? 0, partial: i === 0 });
  }
  return out;
}

/** Пункты, после которых бросали чаще всего: только с потерями, по убыванию, не больше `n` */
export function topLosses<T extends { lost: number; position: number }>(rows: readonly T[], n: number): T[] {
  return rows
    .filter((r) => r.lost > 0)
    .sort((a, b) => b.lost - a.lost || a.position - b.position)
    .slice(0, n);
}
