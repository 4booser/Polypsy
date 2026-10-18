import type {
  Lang,
  MfaCoverageRow,
  MfaPolicy,
  SuspiciousFinding,
  SuspiciousPage,
  SuspiciousThresholds,
  TemporaryGrant,
  UiKey,
  WhoViewedActor,
  WhoViewedReport,
} from "@quizzy/shared";
import { LOCALE_OF } from "@quizzy/shared";

/*
 * Чистая логика экранов безопасности техпанели в «Виразній» (Polypsy 2.0,
 * участок v2-ops-people): «Підозріла активність», «Тимчасові доступи»,
 * «Хто переглядав», «Другий фактор».
 *
 * Отдельно от разметки — ради проверок без браузера
 * (apps/web/test/opsSecurity.test.ts): кому по политике нужен фактор,
 * сколько дней до даты, куда продлится доступ, что сказать о срабатывании.
 * Всё считается из ответа сервера; своих чисел экран не придумывает.
 */

type Ut = (key: UiKey) => string;

const DAY_MS = 86_400_000;

/** Подстановки «{n}» в строку словаря */
export function fill(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/* ═══════════ даты коротко ═══════════ */

/** «08.10» — день и месяц числами, как в строках таблиц «Виразної» */
export function shortDay(iso: string, lang: Lang, timeZone?: string): string {
  return new Date(iso).toLocaleDateString(LOCALE_OF[lang], { day: "2-digit", month: "2-digit", timeZone });
}

/** «14:05» */
export function clock(iso: string, lang: Lang, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE_OF[lang], { hour: "2-digit", minute: "2-digit", timeZone });
}

/** «08.10, 14:05» — момент в строке и в подписи */
export function stamp(iso: string, lang: Lang, timeZone?: string): string {
  return `${shortDay(iso, lang, timeZone)}, ${clock(iso, lang, timeZone)}`;
}

/** «08.10.2026» — дата с годом: период отчёта, подпись «сформовано» */
export function fullDay(iso: string, lang: Lang, timeZone?: string): string {
  return new Date(iso).toLocaleDateString(LOCALE_OF[lang], { day: "2-digit", month: "2-digit", year: "numeric", timeZone });
}

/**
 * Окно серии: «08.10, 14:05–14:35» в пределах дня, «07.10, 23:10 – 08.10, 01:20»
 * через полночь, один момент — просто «08.10, 14:05».
 */
export function windowText(from: string, to: string, lang: Lang, timeZone?: string): string {
  const a = stamp(from, lang, timeZone);
  if (from === to) return a;
  if (shortDay(from, lang, timeZone) === shortDay(to, lang, timeZone)) return `${a}–${clock(to, lang, timeZone)}`;
  return `${a} – ${stamp(to, lang, timeZone)}`;
}

/* ═══════════ числа словами ═══════════ */

/**
 * Форма слова при числе — по правилу языка (Intl.PluralRules): «1 день»,
 * «2 дні», «5 днів». Ключи — семьёй `….one|few|many`, и экран зовёт их
 * шаблоном с буквальным началом (`opps.n.day.${pluralForm(n, lang)}`):
 * так проверка словаря видит, что семья в ходу. Английскому хватает one и
 * many — few у него не бывает.
 */
export function pluralForm(n: number, lang: Lang): "one" | "few" | "many" {
  const cat = new Intl.PluralRules(LOCALE_OF[lang]).select(n);
  return cat === "one" ? "one" : cat === "few" ? "few" : "many";
}

/* ═══════════ підозріла активність ═══════════ */

/** Нерозібрані, розібрані и всего — по тому же отбору правила, что и список */
export function findingCounts(page: Pick<SuspiciousPage, "open" | "total">): { open: number; resolved: number; total: number } {
  return { open: page.open, resolved: Math.max(0, page.total - page.open), total: page.total };
}

/** Срабатываний за окно графика (stats.byDay): разобранные и нет вместе */
export function findingsInWindow(byDay: SuspiciousPage["stats"]["byDay"]): number {
  return byDay.reduce((s, d) => s + d.open + d.resolved, 0);
}

/** Кто: имя, иначе почта, иначе адрес — у серии по адресу человека нет */
export function findingWho(f: SuspiciousFinding): string | null {
  if (f.rule === "failedLoginsIp") return f.ip;
  return f.actorName || f.actorEmail || f.ip || null;
}

const minutesOf = (f: SuspiciousFinding) =>
  Math.max(1, Math.round((new Date(f.windowTo).getTime() - new Date(f.windowFrom).getTime()) / 60_000));

/**
 * Что случилось — одной фразой после имени: «картки 34 різних пацієнтів за
 * 30 хв; поріг — 25». Числа — из срабатывания и порогов сервера.
 */
export function findingText(f: SuspiciousFinding, th: SuspiciousThresholds, ut: Ut, lang: Lang, timeZone?: string): string {
  const d = f.details ?? {};
  const text = ut(`opps.fact.${f.rule}` as UiKey);
  switch (f.rule) {
    case "failedLoginsAccount":
      return fill(text, { n: f.hits, th: th.failedPerAccount });
    case "failedLoginsIp":
      return fill(text, { n: f.hits, accounts: Number(d.accounts ?? 0) });
    case "newDevice":
      return fill(text, { client: String(d.client ?? "—") });
    case "massReads":
      return fill(text, { n: f.hits, min: minutesOf(f), th: th.massReadPatients });
    case "nightActivity":
      return fill(text, {
        n: f.hits,
        patients: Number(d.patients ?? 0),
        from: clock(f.windowFrom, lang, timeZone),
        to: clock(f.windowTo, lang, timeZone),
      });
    case "namedExport":
      return fill(text, { n: f.hits });
    case "impersonation":
      return d.reason
        ? fill(ut("opps.fact.impersonationWhy"), { subject: f.subjectName ?? "—", reason: String(d.reason) })
        : fill(text, { subject: f.subjectName ?? "—" });
  }
}

export interface FindingChip {
  key: string;
  text: string;
  /** Янтарь — сверх порога */
  tone?: "warn";
  icon?: "clock" | "monitor";
  /** Адрес и коды — моноширинным */
  mono?: boolean;
}

/** Пилюли фактов под фразой: окно, счёт, порог, клиент, адрес */
export function findingChips(f: SuspiciousFinding, th: SuspiciousThresholds, ut: Ut, lang: Lang, timeZone?: string): FindingChip[] {
  const d = f.details ?? {};
  const chips: FindingChip[] = [{ key: "window", text: windowText(f.windowFrom, f.windowTo, lang, timeZone), icon: "clock" }];
  const n = (key: string, params: Record<string, string | number>, tone?: "warn") =>
    chips.push({ key, text: fill(ut(`opps.chip.${key}` as UiKey), params), tone });
  switch (f.rule) {
    case "failedLoginsAccount":
      n("attempts", { n: f.hits }, f.hits >= th.failedPerAccount ? "warn" : undefined);
      if (d.lockedOut) n("lockedOut", {}, "warn");
      break;
    case "failedLoginsIp":
      n("attempts", { n: f.hits }, "warn");
      n("accounts", { n: Number(d.accounts ?? 0) });
      break;
    case "newDevice":
      if (d.client) chips.push({ key: "client", text: String(d.client), icon: "monitor" });
      break;
    case "massReads":
      n("patients", { n: f.hits, th: th.massReadPatients }, "warn");
      if (d.reads) n("reads", { n: Number(d.reads) });
      break;
    case "nightActivity":
      n("reads", { n: f.hits });
      n("patientsN", { n: Number(d.patients ?? 0) });
      break;
    case "namedExport":
      n("rows", { n: f.hits });
      break;
    case "impersonation":
      n("readOnly", {});
      break;
  }
  if (f.ip && f.rule !== "failedLoginsIp") chips.push({ key: "ip", text: f.ip, mono: true });
  return chips;
}

/** Поиск по списку срабатываний: человек, почта, адрес, клиент, тот, от чьего имени смотрели */
export function findingMatches(f: SuspiciousFinding, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return true;
  const hay = [f.actorName, f.actorEmail, f.ip, f.subjectName, f.resolvedByEmail, String(f.details?.client ?? "")]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return hay.includes(needle);
}

/* ═══════════ тимчасові доступи ═══════════ */

/** Сколько срока прошло, 0…100: полоска под «через 5 год» */
export function elapsedPct(g: Pick<TemporaryGrant, "grantedAt" | "expiresAt">, now: number): number {
  const a = new Date(g.grantedAt).getTime();
  const b = new Date(g.expiresAt).getTime();
  if (!(b > a)) return 100;
  return Math.round(Math.min(1, Math.max(0, (now - a) / (b - a))) * 100);
}

/** Закончатся в ближайшие сутки — «требует внимания» */
export function endingSoon(active: readonly Pick<TemporaryGrant, "expiresAt">[], now: number): number {
  return active.filter((g) => {
    const left = new Date(g.expiresAt).getTime() - now;
    return left > 0 && left < DAY_MS;
  }).length;
}

/**
 * Новый срок продления — то же правило, что у сервера (routes/opsPeople.ts):
 * от нынешнего окончания, если оно впереди, и от «сейчас», если доступ уже
 * истёк. Экран показывает его до нажатия.
 */
export function extendedUntil(expiresAt: string, days: number, now: number): string {
  const base = Math.max(now, new Date(expiresAt).getTime());
  return new Date(base + days * DAY_MS).toISOString();
}

/** Продлить на — дни, как в наборе: сутки, три, неделя, две, месяц */
export const EXTEND_DAYS: readonly number[] = [1, 3, 7, 14, 30];

/** Дольше этого исключение не выдаётся — тот же потолок, что у сервера (365 дней) */
export const GRANT_MAX_DAYS = 365;

const dayStart = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
};

/** «YYYY-MM-DD» местного календаря */
export function isoDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * Сколько дней до выбранной даты — столько и уйдёт серверу (`days`): срок
 * кончится в этот день в тот же час, что сейчас. Сегодня и прошлое — null.
 */
export function daysUntil(day: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const n = Math.round((dayStart(day) - dayStart(isoDay(now))) / DAY_MS);
  return n >= 1 && n <= GRANT_MAX_DAYS ? n : null;
}

/* ═══════════ хто переглядав ═══════════ */

export type PeriodPreset = "7" | "30" | "90" | "365";
export const PERIOD_PRESETS: readonly PeriodPreset[] = ["7", "30", "90", "365"];

/** Последние N дней по местному календарю, сегодня включительно */
export function presetPeriod(preset: PeriodPreset, now: Date): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(from.getDate() - (Number(preset) - 1));
  return { from: isoDay(from), to: isoDay(now) };
}

/** Какой из готовых периодов выбран; свой — null */
export function presetOf(period: { from: string; to: string }, now: Date): PeriodPreset | null {
  return PERIOD_PRESETS.find((p) => {
    const x = presetPeriod(p, now);
    return x.from === period.from && x.to === period.to;
  }) ?? null;
}

/** Период без перевёрнутых дат и без будущего «по» */
export function periodOk(period: { from: string; to: string }): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(period.from) && /^\d{4}-\d{2}-\d{2}$/.test(period.to) && period.from <= period.to;
}

/** Дней в периоде отчёта, оба края включительно */
export function periodDays(from: string, to: string): number {
  return Math.max(0, Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1);
}

export interface ReportSummary {
  staff: number;
  /** Из них смотрели под входом «від імені» */
  asOther: number;
  total: number;
  /** Дней, в которые что-то было */
  activeDays: number;
  periodDays: number;
}

export function reportSummary(report: WhoViewedReport): ReportSummary {
  const days = new Set<string>();
  for (const a of report.actors) for (const d of a.days) days.add(d.day);
  return {
    staff: report.actors.length,
    asOther: report.actors.filter((a) => actorAs(a).length > 0).length,
    total: report.total,
    activeDays: days.size,
    periodDays: periodDays(report.from, report.to),
  };
}

/** От чьего имени смотрел сотрудник (почты), без повторов */
export function actorAs(a: WhoViewedActor): string[] {
  const out = new Set<string>();
  for (const d of a.days) for (const x of d.actions) if (x.asUserEmail) out.add(x.asUserEmail);
  return [...out];
}

/** Последний раз, когда сотрудник что-то делал с данными пациента */
export function actorLast(a: WhoViewedActor): string | null {
  let last: string | null = null;
  for (const d of a.days) for (const x of d.actions) if (!last || x.last > last) last = x.last;
  return last;
}

export interface ActorLine {
  key: string;
  day: string;
  action: string;
  count: number;
  first: string;
  last: string;
  asUserEmail: string | null;
}

/** Раскладка сотрудника строками «день — действие»: свежие дни сверху, внутри дня — по времени */
export function actorLines(a: WhoViewedActor): ActorLine[] {
  return [...a.days]
    .sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0))
    .flatMap((d) =>
      [...d.actions]
        .sort((x, y) => (x.first < y.first ? -1 : x.first > y.first ? 1 : 0))
        .map((x) => ({
          key: `${d.day}|${x.action}|${x.asUserEmail ?? ""}`,
          day: d.day,
          action: x.action,
          count: x.count,
          first: x.first,
          last: x.last,
          asUserEmail: x.asUserEmail,
        })),
    );
}

/** Сколько дней скрыто за «Ще N днів», если показаны первые `shown` строк */
export function hiddenDays(lines: readonly ActorLine[], shown: number): number {
  const visible = new Set(lines.slice(0, shown).map((l) => l.day));
  return new Set(lines.slice(shown).map((l) => l.day).filter((d) => !visible.has(d))).size;
}

/* ═══════════ другий фактор ═══════════ */

/**
 * Требует ли политика фактор от этой строки — то же правило, что у сервера
 * (lib/secondFactor.ts, requiredBecause): суперадмин держит все права,
 * значит, и ops.*, — позначка «для ops» касается и его.
 */
export function requiredBy(row: Pick<MfaCoverageRow, "because">, policy: Pick<MfaPolicy, "superadmins" | "ops">): boolean {
  return row.because === "superadmin" ? policy.superadmins || policy.ops : policy.ops;
}

/** Кому фактор обязателен, а его нет: следующий вход остановится на настройке. Выключенные не входят */
export function missingRequired<T extends Pick<MfaCoverageRow, "because" | "enabled" | "disabled">>(
  rows: readonly T[],
  policy: Pick<MfaPolicy, "superadmins" | "ops">,
): T[] {
  return rows.filter((r) => !r.disabled && !r.enabled && requiredBy(r, policy));
}

export interface CoverageGroup {
  key: "superadmin" | "ops" | "staff";
  on: number;
  total: number;
  /** Полностью — зелёным; обязателен и неполон — янтарём; для справки — фиолетовым */
  tone: "good" | "warn" | "plain";
}

/**
 * Доля с фактором: по суперадминам, по держателям ops.* и по всему
 * действующему персоналу для справки. Выключенные не считаются; группа без
 * действующих учёток не рисуется — доли от нуля нет.
 */
export function coverageGroups(
  rows: readonly MfaCoverageRow[],
  staff: { total: number; enabled: number } | undefined,
  policy: Pick<MfaPolicy, "superadmins" | "ops">,
): CoverageGroup[] {
  const out: CoverageGroup[] = [];
  for (const key of ["superadmin", "ops"] as const) {
    const live = rows.filter((r) => r.because === key && !r.disabled);
    if (!live.length) continue;
    const on = live.filter((r) => r.enabled).length;
    const required = requiredBy({ because: key }, policy);
    out.push({ key, on, total: live.length, tone: on === live.length ? "good" : required ? "warn" : "plain" });
  }
  if (staff && staff.total > 0) out.push({ key: "staff", on: staff.enabled, total: staff.total, tone: "plain" });
  return out;
}

/** Последний вход был до того, как требование включили: человек ещё не видел экрана настройки */
export function seenBeforePolicy(lastSeenAt: string | null | undefined, policyAt: string | null): boolean {
  if (!lastSeenAt || !policyAt) return false;
  return lastSeenAt < policyAt;
}

export type MfaView = "all" | "missing" | "superadmin" | "ops";
export const MFA_VIEWS: readonly MfaView[] = ["all", "missing", "superadmin", "ops"];

export function mfaViewRows<T extends Pick<MfaCoverageRow, "because" | "enabled" | "disabled">>(
  rows: readonly T[],
  view: MfaView,
): T[] {
  if (view === "missing") return rows.filter((r) => !r.enabled && !r.disabled);
  if (view === "superadmin" || view === "ops") return rows.filter((r) => r.because === view);
  return [...rows];
}
