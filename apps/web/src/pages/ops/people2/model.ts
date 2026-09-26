import type {
  BulkResult,
  BulkSkipReason,
  ImportCreated,
  ImportRowError,
  SuspiciousFinding,
  SuspiciousRule,
  SuspiciousThresholds,
  UiKey,
  WhoViewedReport,
} from "@quizzy/shared";

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
