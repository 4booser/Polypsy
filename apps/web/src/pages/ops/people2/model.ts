import type {
  AccountState,
  AuditDaily,
  BulkResult,
  BulkSkipReason,
  GrantStats,
  ImportCreated,
  ImportRowError,
  MfaCoverageRow,
  OpsSessionsSummary,
  OpsUsersRoleSummary,
  OpsUsersSummary,
  Role,
  SessionAgeBucket,
  SuspiciousFinding,
  SuspiciousRule,
  SuspiciousStats,
  SuspiciousThresholds,
  UiKey,
  WhoViewedReport,
} from "@quizzy/shared";
import type { Column, HBar, SharePart } from "../../../charts/clinical";

/*
 * Чистая логика раздела «Люди й безпека» (участок people2): выбор строк,
 * итог пачки, CSV, пояснения правил, ссылки в журнал, сроки доступов.
 *
 * Отдельно от экранов — ради проверок без браузера (apps/web/test/people2.test.ts):
 * «выбрать всех на странице» и «что вышло из пачки» должны проверяться
 * функцией, а не кликом.
 */

type Ut = (key: UiKey) => string;

/* ═══════════ выбор строк ═══════════ */

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Состояние флажка «вся страница»: ни одного, часть, все */
export function pageSelection(selected: ReadonlySet<string>, pageIds: readonly string[]): "none" | "some" | "all" {
  if (!pageIds.length) return "none";
  const n = pageIds.filter((id) => selected.has(id)).length;
  return n === 0 ? "none" : n === pageIds.length ? "all" : "some";
}

/**
 * Отметить или снять страницу — не трогая выбранных на других страницах:
 * человек листает, отмечает на каждой, и перелистывание не должно стирать
 * то, что он уже выбрал.
 */
export function withPage(selected: ReadonlySet<string>, pageIds: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of pageIds) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/* ═══════════ итог пачки ═══════════ */

export const skipKey = (r: BulkSkipReason): UiKey => `ops.skip.${r}` as UiKey;

/**
 * Пропущенные — сгруппированы по причине: «пропущено 3: двое — уже
 * вимкнено, один — останній суперадмін» читается, а тридцать строк с
 * одинаковой причиной — нет. Порядок — по числу, почты — для «кого именно».
 */
export function skippedByReason(result: BulkResult): { reason: BulkSkipReason; count: number; emails: string[] }[] {
  const by = new Map<BulkSkipReason, string[]>();
  for (const s of result.skipped) {
    const list = by.get(s.reason) ?? [];
    list.push(s.email ?? s.id);
    by.set(s.reason, list);
  }
  return [...by.entries()]
    .map(([reason, emails]) => ({ reason, count: emails.length, emails }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/* ═══════════ CSV ═══════════ */

/**
 * Ячейка CSV. Начинающееся с «=», «+», «-», «@» экранируется апострофом —
 * то же правило, что у выгрузки журнала на сервере (routes/audit.ts):
 * причины и имена — свободный текст, и табличный редактор выполнил бы
 * такую ячейку как формулу.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* метка порядка байтов — кодом, а не символом в исходнике: невидимый знак в строке не заметит ни глаз, ни ревью */
const BOM = String.fromCharCode(0xfeff);

/** Таблица в CSV с BOM: Excel без него читает UTF-8 кракозябрами */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return `${BOM}${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Заголовки шаблона импорта — ровно те, что понимает сервер (lib/people.ts, IMPORT_COLUMNS) */
export const IMPORT_HEADER = [
  "last_name",
  "first_name",
  "middle_name",
  "email",
  "role",
  "role_template",
  "position",
  "unit",
] as const;

/*
 * Шаблон с одной строкой-образцом: по образцу заполняют быстрее, чем по
 * описанию. Образец латиницей — это данные-пример, а не текст интерфейса, и
 * переводить его на три языка незачем; кириллицу сервер принимает так же.
 */
export function importTemplateCsv(): string {
  return toCsv([IMPORT_HEADER, ["Kovalenko", "Olena", "Petrivna", "o.kovalenko@example.org", "", "specialist", "psychologist", "Unit 1"]]);
}

export const importErrorKey = (e: ImportRowError): UiKey => `ops.import.err.${e}` as UiKey;

/** Созданные с временными паролями — один раз, файлом */
export function passwordsCsv(created: ImportCreated["created"], headers: readonly string[]): string {
  return toCsv([headers, ...created.map((p) => [p.fullName, p.email, p.password])]);
}

/**
 * Отчёт «хто переглядав» таблицей: строка на сотрудника, день и действие.
 * Действие — человеческими словами (label), а не кодом журнала: файл
 * читает пациент или проверяющий, а не разработчик.
 */
export function whoViewedCsv(
  report: WhoViewedReport,
  label: (action: string) => string,
  headers: readonly string[],
): string {
  const rows: (string | number | null)[][] = [];
  for (const a of report.actors) {
    for (const d of a.days) {
      for (const act of d.actions) {
        rows.push([a.actorName ?? "", a.actorEmail ?? "", a.actorRole ?? "", d.day, label(act.action), act.count, act.first, act.last, act.asUserEmail ?? ""]);
      }
    }
  }
  return toCsv([headers, ...rows]);
}

/* ═══════════ подозрительная активность ═══════════ */

export const RULES: readonly SuspiciousRule[] = [
  "failedLoginsAccount",
  "failedLoginsIp",
  "newDevice",
  "massReads",
  "nightActivity",
  "namedExport",
  "impersonation",
];

export const ruleKey = (r: SuspiciousRule): UiKey => `ops.rule.${r}` as UiKey;

function fill(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/**
 * Почему правило сработало — числами с сервера, а не словом «много»:
 * пороги приходят вместе со списком (SuspiciousThresholds), и экран не
 * держит своей второй копии, которая разошлась бы с сервером.
 */
export function ruleExplanation(rule: SuspiciousRule, th: SuspiciousThresholds, ut: Ut): string {
  const text = ut(`ops.ruleWhy.${rule}` as UiKey);
  switch (rule) {
    case "failedLoginsAccount":
      return fill(text, { n: th.failedPerAccount, min: th.failedWindowMin });
    case "failedLoginsIp":
      return fill(text, { n: th.failedPerIp, min: th.failedWindowMin, accounts: th.failedIpAccounts });
    case "massReads":
      return fill(text, { n: th.massReadPatients, min: th.massReadWindowMin });
    case "nightActivity":
      return fill(text, {
        n: th.nightMinReads,
        from: th.nightFrom,
        to: th.nightTo,
        tz: th.timezone,
        source: ut(th.hoursSource === "schedule" ? "ops.susp.hoursSchedule" : "ops.susp.hoursDefault"),
      });
    default:
      return text;
  }
}

/** Что именно случилось в этой серии — короткой строкой под правилом */
export function findingFacts(f: SuspiciousFinding, ut: Ut): string {
  const d = f.details ?? {};
  const parts: string[] = [];
  switch (f.rule) {
    case "failedLoginsAccount":
      parts.push(`${f.hits} ${ut("ops.susp.events")}`);
      break;
    case "failedLoginsIp":
      parts.push(`${f.hits} ${ut("ops.susp.events")}`, `${Number(d.accounts ?? 0)} ${ut("ops.susp.accounts")}`);
      break;
    case "newDevice":
      parts.push(`${ut("ops.susp.client")}: ${String(d.client ?? "—")}`);
      break;
    case "massReads":
      parts.push(`${f.hits} ${ut("ops.susp.patients")}`, `${Number(d.reads ?? f.hits)} ${ut("ops.susp.events")}`);
      break;
    case "nightActivity":
      parts.push(`${f.hits} ${ut("ops.susp.events")}`, `${Number(d.patients ?? 0)} ${ut("ops.susp.patients")}`);
      break;
    case "namedExport":
      parts.push(`${f.hits} ${ut("ops.susp.patients")}`);
      break;
    case "impersonation":
      if (d.reason) parts.push(`${ut("ops.susp.reason")}: ${String(d.reason)}`);
      break;
  }
  if (f.ip && f.rule !== "impersonation") parts.push(f.ip);
  return parts.join(" · ");
}

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Ссылка в журнал на то, из чего сложилось срабатывание: отбор «Аудиту»
 * адресом (AuditLog.tsx читает те же поля). Даты — днями включительно, с
 * первого по последний день серии: журнал фильтрует по дням, а серия ночной
 * работы переходит через полночь.
 */
export function journalLink(f: SuspiciousFinding): string {
  const qs = new URLSearchParams();
  switch (f.rule) {
    case "failedLoginsAccount":
      qs.set("action", "auth.login_failed");
      if (f.actorEmail) qs.set("q", f.actorEmail);
      break;
    case "failedLoginsIp":
      qs.set("action", "auth.login_failed");
      if (f.ip) qs.set("q", f.ip);
      break;
    case "newDevice":
      qs.set("action", "auth.login");
      if (f.actorId) qs.set("actor", f.actorId);
      break;
    case "namedExport":
      qs.set("action", "analytics.export");
      if (f.actorId) qs.set("actor", f.actorId);
      break;
    case "impersonation": {
      if (f.actorId) qs.set("actor", f.actorId);
      const session = f.details?.session;
      if (typeof session === "string") qs.set("q", session);
      break;
    }
    default:
      if (f.actorId) qs.set("actor", f.actorId);
  }
  qs.set("from", dayOf(f.windowFrom));
  qs.set("to", dayOf(f.windowTo));
  return `/ops/audit?${qs}`;
}

/* ═══════════ временные доступы ═══════════ */

/** Сколько осталось: днями, а в последние сутки — часами; прошедшее — null */
export function timeLeft(expiresAt: string, now: number): { unit: "days" | "hours"; n: number } | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  if (ms < 86_400_000) return { unit: "hours", n: Math.max(1, Math.ceil(ms / 3_600_000)) };
  return { unit: "days", n: Math.ceil(ms / 86_400_000) };
}

/** Продлить на — выбор, а не поле: сроки исключений меряют неделями и сменами */
export const EXTEND_CHOICES: readonly number[] = [7, 14, 30, 90];

/* ═══════════ хто переглядав ═══════════ */

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Период по умолчанию — последние 30 дней по местному календарю, сегодня включительно */
export function defaultPeriod(now: Date): { from: string; to: string } {
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  return { from: isoDay(from), to: isoDay(now) };
}

/* ═══════════ графики разделов людей (волна 11) ═══════════ */

/*
 * Ряды для графиков «Користувачів», «Сесій», «Аудиту», «Підозрілої
 * активності», «Тимчасових доступів», «Хто переглядав» и «Другого
 * фактора». Чистыми функциями — ради проверок без браузера
 * (apps/web/test/opsPeopleCharts.test.ts): что скрытое порогом не
 * превращается в ноль, что пустой день остаётся днём, что «інші»
 * складываются, а не теряются.
 *
 * Подписи дат приходят параметром (как у dayColumns раздела «Дані й
 * продукт»): формат зависит от языка страницы, а проверке нужен свой,
 * неизменный.
 */

/** Ряд столбцов из частей: `values` — по значению на ряд в порядке `series`; null — скрыто порогом */
export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackColumn {
  key: string;
  label: string;
  values: readonly (number | null)[];
}

/*
 * Место в упорядоченном ряду (SharePart.step): одна величина — один тон,
 * порядок читается светлотой. Первое — самое тёмное: то, ради чего смотрят.
 */
const steps = (n: number): number[] => Array.from({ length: n }, (_, i) => (n > 1 ? 1 - i / (n - 1) : 1));

export const STATE_KEY: Record<AccountState, UiKey> = {
  active: "opsp.state.active",
  never: "opsp.state.never",
  locked: "opsp.state.locked",
  disabled: "opsp.state.disabled",
};

/** Состояния роли — частями полосы, в постоянном порядке; скрытое порогом — null, а не ноль */
export function stateParts(role: OpsUsersRoleSummary, ut: Ut): SharePart[] {
  const tone = steps(role.states.length);
  return role.states.map((s, i) => ({ key: s.key, label: ut(STATE_KEY[s.key]), value: s.count, step: tone[i] }));
}

/** Второй фактор роли: есть / нет — из действующих учёток */
export function mfaParts(mfa: { enabled: number; total: number }, ut: Ut): SharePart[] {
  return [
    { key: "on", label: ut("opsp.mfa.on"), value: mfa.enabled, step: 1 },
    { key: "off", label: ut("opsp.mfa.off"), value: Math.max(0, mfa.total - mfa.enabled), step: 0 },
  ];
}

/** Новые учётки по неделям: персонал и пациенты; неделя пациентов под порогом — null */
export function newAccountColumns(rows: OpsUsersSummary["newByWeek"], label: (iso: string) => string): StackColumn[] {
  return rows.map((r) => ({ key: r.week, label: label(r.week), values: [r.staff, r.patients] }));
}

/** Входы по дням: удачные снизу, неудачные сверху — янтарная шапка столбца видна сразу */
export function loginColumns(rows: OpsUsersSummary["loginsByDay"], label: (iso: string) => string): StackColumn[] {
  return rows.map((r) => ({ key: r.date, label: label(r.date), values: [r.success, r.failed] }));
}

export const AGE_KEY: Record<SessionAgeBucket, UiKey> = {
  day: "opsp.age.day",
  week: "opsp.age.week",
  month: "opsp.age.month",
  older: "opsp.age.older",
};

export function ageParts(buckets: OpsSessionsSummary["byAge"][number]["buckets"], ut: Ut): SharePart[] {
  const tone = steps(buckets.length);
  return buckets.map((b, i) => ({ key: b.key, label: ut(AGE_KEY[b.key]), value: b.count, step: tone[i] }));
}

/** Сессии по роли — полосами; у пациентов под порогом — прочерк без полосы */
export function sessionRoleBars(rows: OpsSessionsSummary["byRole"], roleLabel: (role: Role) => string): HBar[] {
  return rows.map((r) => ({ key: r.role, label: roleLabel(r.role), value: r.sessions }));
}

/**
 * Срабатывания по правилам: длина — всего, жирным — где есть нерозібрані.
 * Правил семь, «інші» не нужны; порядок — по числу, как пришло с сервера.
 */
export function ruleBars(rows: SuspiciousStats["byRule"], ut: Ut): HBar[] {
  return rows.map((r) => ({
    key: r.rule,
    label: ut(ruleKey(r.rule)),
    value: r.total,
    text: r.open ? `${r.total} · ${ut("opsp.susp.newOf")} ${r.open}` : String(r.total),
    strong: r.open > 0,
  }));
}

/** По дням: разобранные снизу, нерозібрані — янтарём сверху */
export function findingColumns(rows: SuspiciousStats["byDay"], label: (iso: string) => string): StackColumn[] {
  return rows.map((r) => ({ key: r.date, label: label(r.date), values: [r.resolved, r.open] }));
}

export function grantParts(stats: GrantStats, ut: Ut): SharePart[] {
  const order = [
    ["active", "opsp.grant.active", stats.active],
    ["permanent", "opsp.grant.permanent", stats.permanent],
    ["expired", "opsp.grant.expired", stats.expired],
    ["revoked", "opsp.grant.revoked", stats.revoked],
  ] as const;
  const tone = steps(order.length);
  return order.map(([key, text, value], i) => ({ key, label: ut(text), value, step: tone[i] }));
}

export function weekColumns(rows: GrantStats["byWeek"], label: (iso: string) => string): Column[] {
  return rows.map((r) => ({ key: r.week, label: label(r.week), value: r.count }));
}

/** Журнал по отбору: удачные снизу, отказы и сбои — янтарём сверху */
export function auditColumns(daily: AuditDaily, label: (iso: string, step: AuditDaily["step"]) => string): StackColumn[] {
  return daily.buckets.map((b) => ({ key: b.start, label: label(b.start, daily.step), values: [b.ok, b.refused] }));
}

export const STEP_KEY: Record<AuditDaily["step"], UiKey> = {
  day: "opsp.audit.stepDay",
  week: "opsp.audit.stepWeek",
  month: "opsp.audit.stepMonth",
};

const addDay = (iso: string): string => {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * «Хто переглядав» по дням: все сотрудники вместе, сплошным рядом от «з» до
 * «по». Сервер отдаёт только дни, где что-то было, — пустой день здесь
 * становится нулём: в отчёте «ничего не открывали» — это ответ, а дыра в
 * оси сжала бы время. Больше года столбцами не рисуется — отчёт о таком
 * периоде читают таблицей.
 */
export function whoViewedDays(report: WhoViewedReport, label: (iso: string) => string): Column[] {
  if (report.to < report.from) return [];
  const byDay = new Map<string, number>();
  for (const a of report.actors) {
    for (const d of a.days) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.actions.reduce((s, x) => s + x.count, 0));
  }
  const out: Column[] = [];
  for (let day = report.from; day <= report.to && out.length < 366; day = addDay(day)) {
    out.push({ key: day, label: label(day), value: byDay.get(day) ?? 0 });
  }
  return out;
}

/**
 * Первые строки по убыванию, остальное — одной строкой «інші»; всего строк
 * не больше `n`. Сумма сохраняется: хвост, выброшенный молча, делал бы
 * картину полнее, чем она есть.
 */
export function topWithOthers(rows: readonly { key: string; label: string; value: number }[], n: number, othersLabel: string): HBar[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  const bar = (r: { key: string; label: string; value: number }): HBar => ({ key: r.key, label: r.label, value: r.value });
  if (sorted.length <= n) return sorted.map(bar);
  const rest = sorted.slice(n - 1).reduce((s, r) => s + r.value, 0);
  return [...sorted.slice(0, n - 1).map(bar), { key: "__others", label: othersLabel, value: rest }];
}

/** Что делали с данными человека — по действию, человеческими словами; восемь строк, дальше «інші» */
export function whoViewedActions(report: WhoViewedReport, label: (action: string) => string, othersLabel: string): HBar[] {
  const by = new Map<string, number>();
  for (const a of report.actors) {
    for (const d of a.days) for (const x of d.actions) by.set(x.action, (by.get(x.action) ?? 0) + x.count);
  }
  return topWithOthers(
    [...by].map(([action, value]) => ({ key: action, label: label(action), value })),
    8,
    othersLabel,
  );
}

/**
 * Охват вторым фактором по причине требования: доля действующих учёток с
 * подтверждённым фактором. Длина — процент (ось 0–100 задаёт экран), рядом
 * — «2 з 3 · 67%». Выключенные не считаются: войти они не могут, и «не
 * налаштовано» у них ничего не требует. Группа без действующих учёток не
 * рисуется вовсе: доли от нуля нет, а 0 % соврал бы, что все без фактора.
 */
export function coverageBars(rows: readonly MfaCoverageRow[], ut: Ut): HBar[] {
  const groups: MfaCoverageRow["because"][] = ["superadmin", "ops"];
  const out: HBar[] = [];
  for (const because of groups) {
    const live = rows.filter((r) => r.because === because && !r.disabled);
    if (!live.length) continue;
    const on = live.filter((r) => r.enabled).length;
    const pct = Math.round((on / live.length) * 100);
    out.push({
      key: because,
      label: ut(because === "superadmin" ? "ops.mfa.because.superadmin" : "ops.mfa.because.ops"),
      value: pct,
      text: `${on} ${ut("an.of")} ${live.length} · ${pct}%`,
      strong: pct < 100,
    });
  }
  return out;
}
