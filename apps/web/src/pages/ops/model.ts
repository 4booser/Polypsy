import type {
  ClinicalTrace,
  ClinicalTraceKey,
  OpsConnState,
  OpsErrorGroup,
  OpsHealthCheck,
  OpsJobResult,
  OpsLevel,
  OpsLogLine,
  OpsRouteStat,
  OpsTrafficBucket,
  OpsUserRow,
  Permission,
  Role,
  UiKey,
} from "@quizzy/shared";
import type { Column } from "../../charts/clinical";
import type { LinePoint } from "../../charts";
import { OPS_GROUPS, type OpsGroup, type OpsSection } from "./sections";

/**
 * Чистая логика техпанели: разбор адреса, сортировки, слияние ленты,
 * числа в человеческом виде. Без React и без «сейчас» внутри — время и
 * локаль приходят аргументами (apps/web/test/ops.test.ts).
 */

/* ─────────── адрес ─────────── */

export const LEVELS: readonly OpsLevel[] = ["debug", "info", "warn", "error"];

export function parseLevel(v: string | null): OpsLevel | null {
  return v && (LEVELS as readonly string[]).includes(v) ? (v as OpsLevel) : null;
}

/*
 * На обзоре окон два — час и сутки. Шесть часов сервер тоже умеет, но на
 * обзоре третья кнопка ничего не добавляет: час отвечает «что сейчас»,
 * сутки — «как обычно».
 */
export type OverviewWindow = "1h" | "24h";
export const parseWindow = (v: string | null): OverviewWindow => (v === "24h" ? "24h" : "1h");

export type RouteSort = "count" | "p95" | "errors";
export const parseSort = (v: string | null): RouteSort => (v === "p95" || v === "errors" ? v : "count");

/* ─────────── запросы ─────────── */

/** Величина, по которой сортируется и рисуется полоска строки */
export function sortMetric(r: OpsRouteStat, sort: RouteSort): number {
  if (sort === "p95") return r.p95 ?? 0;
  if (sort === "errors") return r.errors5xx + r.errors4xx;
  return r.requests;
}

/**
 * Порядок маршрутов. «По ошибкам» — сначала пятисотки, потом 4xx: сто
 * отказов «нет прав» — это поведение, а одна пятисотка — поломка, и
 * смешать их в одну сумму значило бы поставить поведение выше поломки.
 */
export function sortRoutes(items: readonly OpsRouteStat[], sort: RouteSort): OpsRouteStat[] {
  const out = items.slice();
  out.sort((a, b) => {
    if (sort === "errors") return b.errors5xx - a.errors5xx || b.errors4xx - a.errors4xx || b.requests - a.requests;
    if (sort === "p95") return (b.p95 ?? -1) - (a.p95 ?? -1) || b.requests - a.requests;
    return b.requests - a.requests || a.route.localeCompare(b.route);
  });
  return out;
}

export function filterRoutes(items: readonly OpsRouteStat[], q: string): OpsRouteStat[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((r) => `${r.method} ${r.route}`.toLowerCase().includes(needle));
}

/* ─────────── ошибки ─────────── */

export function filterErrors(items: readonly OpsErrorGroup[], q: string): OpsErrorGroup[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((g) =>
    [g.name, g.message, g.route ?? "", g.method ?? "", g.lastRequestId ?? ""].join(" ").toLowerCase().includes(needle),
  );
}

/* ─────────── лента ─────────── */

/** Сколько строк лента держит на экране: больше — это уже чтение архива, а не слежение */
export const FEED_CAP = 1000;

/**
 * Новые строки поверх старых, без повторов, новые первыми.
 *
 * Повторы возможны на стыке: опрос с курсором и перезагрузка по смене
 * фильтра могут вернуть одну строку дважды, если ответы пришли в обратном
 * порядке. Номер строки (seq) у буфера сквозной, по нему и отсекаем.
 */
export function mergeFeed(prev: readonly OpsLogLine[], incoming: readonly OpsLogLine[], cap = FEED_CAP): OpsLogLine[] {
  const seen = new Set(prev.map((l) => l.seq));
  const fresh = incoming.filter((l) => !seen.has(l.seq)).sort((a, b) => b.seq - a.seq);
  return [...fresh, ...prev].slice(0, cap);
}

/** Поля строки лога одной строкой «ключ=значение», как их пишет лог разработки */
export function fieldsText(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/** Номер запроса укороченным — так его печатает лог разработки; полный — в подсказке */
export const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

/* ─────────── графики ─────────── */

/** Столбцы нагрузки: подпись — время начала корзины */
export function trafficColumns(buckets: readonly OpsTrafficBucket[], label: (iso: string) => string): Column[] {
  return buckets.map((b) => ({ key: b.at, label: label(b.at), value: b.requests }));
}

/**
 * Линия p95 с полосой от p50 до p99.
 *
 * Только корзины, где запросы были: пустая минута — не «ноль миллисекунд»,
 * а отсутствие замера, и линия, падающая в ноль на каждой тихой минуте,
 * рисовала бы скорость, которой не было. Подпись под графиком об этом
 * говорит.
 */
export function latencySeries(buckets: readonly OpsTrafficBucket[], label: (iso: string) => string): LinePoint[] {
  return buckets
    .filter((b) => b.requests > 0 && b.p95 !== null)
    .map((b) => ({ x: label(b.at), y: b.p95!, lo: b.p50, hi: b.p99 }));
}

/* ─────────── коды → ключи словаря ─────────── */

export const LEVEL_KEY: Record<OpsLevel, UiKey> = {
  debug: "ops.level.debug",
  info: "ops.level.info",
  warn: "ops.level.warn",
  error: "ops.level.error",
};

export const CONN_KEY: Record<OpsConnState, UiKey> = {
  active: "ops.conn.active",
  idle: "ops.conn.idle",
  idle_in_transaction: "ops.conn.idleTx",
  idle_in_transaction_aborted: "ops.conn.idleTxAborted",
  fastpath: "ops.conn.fastpath",
  disabled: "ops.conn.disabled",
  hidden: "ops.conn.hidden",
};

export const RESULT_KEY: Record<OpsJobResult, UiKey> = {
  ok: "ops.result.ok",
  error: "ops.result.error",
  skipped: "ops.result.skipped",
  running: "ops.result.running",
};

export const ROLE_KEY: Record<Role, UiKey> = {
  superadmin: "adm.roleSuper",
  admin: "adm.roleAdmin",
  user: "adm.rolePatient",
};

/** Имена фоновых задач по-человечески; неизвестная задача печатается своим кодом */
export const JOB_KEY: Record<string, UiKey> = {
  schedules: "ops.job.schedules",
  "presence.sweep": "ops.job.presence",
  "clinic.noShows": "ops.job.noShows",
  notifier: "ops.job.notifier",
  "clinic.remind": "ops.job.remind",
  "mailings.push": "ops.job.mailings",
  retention: "ops.job.retention",
};

export const STATUS_KEY: Record<OpsHealthCheck["status"], UiKey> = {
  ok: "ops.status.ok",
  warn: "ops.status.warn",
  fail: "ops.status.fail",
};

export const HEALTH_NAME: Record<OpsHealthCheck["key"], UiKey> = {
  db: "ops.health.db",
  rls: "ops.health.rls",
  migrations: "ops.health.migrations",
  scheduler: "ops.health.scheduler",
  encryption: "ops.health.encryption",
  errorReport: "ops.health.errorReport",
  metricsToken: "ops.health.metricsToken",
  errorRate: "ops.health.errorRate",
};

/**
 * Пояснение к проверке — по ключу и коду причины. Неизвестная пара (сервер
 * новее консоли) даёт null: экран покажет статус без пояснения, а не чужое
 * пояснение.
 */
export function healthReason(c: OpsHealthCheck): UiKey | null {
  const table: Record<string, UiKey> = {
    "db.up": "ops.health.db.up",
    "db.down": "ops.health.db.down",
    "rls.active": "ops.health.rls.active",
    "rls.bypass": "ops.health.rls.bypass",
    "rls.unknown": "ops.health.rls.unknown",
    "migrations.current": "ops.health.migrations.current",
    "migrations.pending": "ops.health.migrations.pending",
    "migrations.unknown": "ops.health.migrations.unknown",
    "scheduler.fresh": "ops.health.scheduler.fresh",
    "scheduler.stale": "ops.health.scheduler.stale",
    "scheduler.never": "ops.health.scheduler.never",
    "scheduler.disabled": "ops.health.scheduler.disabled",
    "encryption.set": "ops.health.encryption.set",
    "encryption.missing": "ops.health.encryption.missing",
    "errorReport.set": "ops.health.errorReport.set",
    "errorReport.missing": "ops.health.errorReport.missing",
    "metricsToken.set": "ops.health.metricsToken.set",
    "metricsToken.missing": "ops.health.metricsToken.missing",
    "errorRate.low": "ops.health.errorRate.low",
    "errorRate.high": "ops.health.errorRate.high",
    "errorRate.quiet": "ops.health.errorRate.quiet",
  };
  return table[`${c.key}.${c.reason}`] ?? null;
}

/* ─────────── числа ─────────── */

/**
 * Единица под величину: байты — до гигабайт, степенями 1024 (так их считает
 * Postgres в pg_size_pretty, и две цифры на одном экране не должны
 * расходиться).
 */
export function bytesUnit(n: number): { value: number; unit: "byte" | "kilobyte" | "megabyte" | "gigabyte" } {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v, unit: units[i]! };
}

/*
 * Единицы — через Intl, а не словарь: «МБ», «MB», «мс», «ms», «год», «h»
 * браузер знает на всех трёх языках консоли, и второй их список в словаре
 * был бы местом, где они разойдутся.
 */
function unitFmt(loc: string, unit: string, digits: number): Intl.NumberFormat {
  return new Intl.NumberFormat(loc, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits });
}

export function fmtBytes(n: number | null, loc: string): string {
  if (n === null) return "—";
  const { value, unit } = bytesUnit(n);
  return unitFmt(loc, unit, value < 10 && unit !== "byte" ? 1 : 0).format(value);
}

export function fmtMs(n: number | null, loc: string): string {
  if (n === null) return "—";
  return unitFmt(loc, "millisecond", n < 10 ? 1 : 0).format(n);
}

export function fmtSec(n: number, loc: string): string {
  return unitFmt(loc, "second", 0).format(n);
}

/** Доля 0…1 процентами; до процента — с десятой, иначе ноль скрыл бы редкие пятисотки */
export function fmtShare(share: number | null, loc: string): string {
  if (share === null) return "—";
  return new Intl.NumberFormat(loc, {
    style: "percent",
    maximumFractionDigits: share > 0 && share < 0.1 ? 1 : 0,
  }).format(share);
}

export function fmtInt(n: number | null, loc: string): string {
  return n === null ? "—" : new Intl.NumberFormat(loc).format(n);
}

/** Время работы: «3 дн. 4 год», «4 год 12 хв», «12 хв» — две старшие единицы */
export function fmtUptime(sec: number, loc: string): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const part = (v: number, unit: string) => unitFmt(loc, unit, 0).format(v);
  if (d > 0) return h ? `${part(d, "day")} ${part(h, "hour")}` : part(d, "day");
  if (h > 0) return m ? `${part(h, "hour")} ${part(m, "minute")}` : part(h, "hour");
  if (m > 0) return part(m, "minute");
  return part(Math.max(0, Math.floor(sec)), "second");
}

/** «2 хв тому», «через 40 хв» — момент относительно «сейчас» */
export function fmtAgo(iso: string | null, now: number, loc: string): string {
  if (!iso) return "—";
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86_400), "day");
}

/** Часы, минуты и секунды: в ленте и в отметке «оновлено о» секунды — и есть смысл */
export function clock(iso: string | number | Date, loc: string): string {
  return new Date(iso).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Час и минута — подпись столбца */
export function hhmm(iso: string, loc: string): string {
  return new Date(iso).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
}

/* ═══════════ учётки, сессии, журнал (участок accounts) ═══════════ */

/*
 * Чистая логика техпанели: какие вкладки кому, как назвать действие журнала,
 * что держит учётку, какой пароль выдать. Отдельно от экранов — ради
 * проверок (apps/web/test/opsModel.test.ts): правило «вкладка по своему
 * праву» и перечень «что держит» должны проверяться без браузера.
 */

/* ─────────── вкладки и дверь в панель ─────────── */

export interface OpsTab {
  to: string;
  key: UiKey;
  /** Право раздела; у разделов только для суперадмина его нет */
  permission?: Permission;
  end?: boolean;
  group: OpsGroup["key"];
}

/**
 * Разделы техпанели — каждый по своему праву.
 *
 * Решение заказчика 2026-09-26: панель — «для супер тех админа», но о людях
 * и о системе в ней разные работы. Наблюдаемость — ops.read, учётки и
 * сессии — users.manage, журнал — audit.read, управление системой —
 * ops.manage, самое опасное — только суперадмину (role в реестре). Панель
 * открывается, если доступен хоть один раздел, и показывает только те, на
 * которые пустит сервер: раздел, ведущий в отказ, хуже отсутствующего.
 *
 * Список не пишется здесь второй раз — он выводится из реестра
 * `sections.ts`, куда каждый участок дописывает свои разделы.
 */
export type Can = (permission: Permission) => boolean;

function allowed(s: OpsSection, can: Can, isSuper: boolean): boolean {
  if (s.role === "superadmin") return isSuper;
  const perms = s.perm === undefined ? [] : Array.isArray(s.perm) ? s.perm : [s.perm];
  return perms.length === 0 ? isSuper : perms.some((p) => can(p));
}

/** Группы с доступными разделами; пустые группы не показываются */
export function opsGroups(can: Can, isSuper = false): { key: OpsGroup["key"]; label: UiKey; tabs: OpsTab[] }[] {
  return OPS_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    tabs: g.sections
      .filter((s) => allowed(s, can, isSuper))
      .map((s) => ({
        to: s.to,
        key: s.label,
        permission: Array.isArray(s.perm) ? s.perm[0] : s.perm,
        end: s.to === "/ops",
        group: g.key,
      })),
  })).filter((g) => g.tabs.length > 0);
}

export function opsTabs(can: Can, isSuper = false): OpsTab[] {
  return opsGroups(can, isSuper).flatMap((g) => g.tabs);
}

/** Пускать ли в панель вовсе — то же правило решает пункт бургера */
export function canOpenOps(can: Can, isSuper = false): boolean {
  return opsTabs(can, isSuper).length > 0;
}

/** Первая доступная вкладка: туда ведёт /ops тому, у кого нет наблюдаемости */
export function opsHome(can: Can, isSuper = false): string | null {
  return opsTabs(can, isSuper)[0]?.to ?? null;
}

/**
 * Группа, в которой стоит адрес: раздел с самым длинным совпавшим началом.
 * `/ops` совпадает только сам с собой — иначе он поглотил бы все разделы.
 */
export function groupOf(pathname: string, tabs: readonly OpsTab[]): OpsTab["group"] | null {
  let best: OpsTab | null = null;
  for (const t of tabs) {
    const hit = t.to === "/ops" ? pathname === "/ops" : pathname === t.to || pathname.startsWith(`${t.to}/`);
    if (hit && (!best || t.to.length > best.to.length)) best = t;
  }
  return best?.group ?? null;
}

/* ROLE_KEY — выше, в части наблюдаемости: одна таблица ролей на всю панель */

/**
 * Куда ведёт имя в строке: сотрудник — в карточку сотрудника, пациент — в
 * карточку пациента. Одна карточка на человека, как во всей консоли.
 */
export function personHref(row: Pick<OpsUserRow, "id" | "role">): string {
  return row.role === "user" ? `/patients/${row.id}` : `/staff/${row.id}`;
}

/* ─────────── что держит учётку ─────────── */

export type HoldKey = ClinicalTraceKey | "journal";

export interface Hold {
  key: HoldKey;
  count: number;
}

/**
 * Порядок источников — тот же, что у сервера (lib/accounts.ts, TRACE_SOURCES):
 * сначала то, о чём спросят первым, — прохождения и заключения.
 */
export const TRACE_ORDER: readonly ClinicalTraceKey[] = [
  "responses",
  "conclusions",
  "notes",
  "cases",
  "surveys",
  "referrals",
  "appointments",
  "episodes",
  "safetyPlans",
  "recordings",
  "consents",
  "threads",
  "dispensary",
];

/** Ненулевые источники следа */
export function traceParts(trace: ClinicalTrace): Hold[] {
  return TRACE_ORDER.filter((k) => (trace[k] ?? 0) > 0).map((k) => ({ key: k, count: trace[k] }));
}

/**
 * Что держит учётку от удаления: след и журнал.
 *
 * Экран считает это сам, по строке списка, — чтобы пункт «Видалити» у
 * учётки со следом сразу объяснял, почему нельзя, а не вёл в подтверждение
 * и отказ. Решает всё равно сервер (DELETE отвечает 409 теми же holds).
 */
export function holdsOfRow(row: Pick<OpsUserRow, "trace" | "journalEntries">): Hold[] {
  const holds = traceParts(row.trace);
  if (row.journalEntries > 0) holds.push({ key: "journal", count: row.journalEntries });
  return holds;
}

export function holdKey(key: HoldKey): UiKey {
  return `ops.hold.${key}` as UiKey;
}

/* ─────────── временный пароль ─────────── */

/*
 * Алфавит — тот же, что у сервера (lib/accounts.ts): без 0/O и 1/l/I.
 * Пароль диктуют и переписывают с экрана, и «это ноль или буква?» стоит
 * попытки входа из пяти до блокировки.
 */
export const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Временный пароль для новой учётки — четыре группы по четыре знака.
 *
 * Генерирует экран, а не сервер, потому что заведение идёт штатным POST
 * /api/users, который принимает пароль, а не выдаёт его. Источник —
 * crypto.getRandomValues, с отбраковкой: остаток от деления 256 на 56
 * смещал бы выбор к первым знакам.
 */
export function generatePassword(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const out: string[] = [];
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < 16) {
    for (const b of random(new Uint8Array(32))) {
      if (b >= limit) continue;
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]!);
      if (out.length === 16) break;
    }
  }
  return [0, 4, 8, 12].map((i) => out.slice(i, i + 4).join("")).join("-");
}

/* ─────────── журнал ─────────── */

/**
 * Действия журнала человеческими словами.
 *
 * Карта переехала сюда из прежнего экрана «Журнал доступу» (pages/Audit.tsx,
 * снят в пользу вкладки техпанели) и пополнена действиями над учётками.
 * Незнакомое действие показывается кодом — лучше сырой код, чем пустая
 * ячейка: код хотя бы ищется в исходниках.
 */
export const AUDIT_ACTION_KEY: Readonly<Record<string, UiKey>> = {
  "auth.login": "act.auth_login",
  "auth.login_failed": "act.auth_login_failed",
  "auth.register": "act.auth_register",
  "auth.password_change": "ops.act.passwordChange",
  "auth.refresh_failed": "ops.act.refreshFailed",
  "user.create": "act.user_create",
  "user.list": "act.user_list",
  "user.role_change": "ops.act.roleChange",
  "user.disable": "ops.act.disable",
  "user.enable": "ops.act.enable",
  "user.delete": "ops.act.delete",
  "user.password_reset": "ops.act.passwordReset",
  "user.sessions_revoke": "ops.act.sessionsRevoke",
  "session.list": "ops.act.sessionList",
  "session.revoke": "ops.act.sessionRevoke",
  "permission.exception": "ops.act.permissionException",
  "permission.exception_revoke": "ops.act.permissionExceptionRevoke",
  "user.roles_change": "ops.act.rolesChange",
  "survey.create": "act.survey_create",
  "survey.catalog_update": "act.survey_catalog_update",
  "survey.update": "act.survey_update",
  "survey.publish": "act.survey_publish",
  "survey.duplicate": "act.survey_duplicate",
  "group.create": "act.group_create",
  "group.admin_assign": "act.group_admin_assign",
  "group.admin_revoke": "act.group_admin_revoke",
  "access.grant": "act.access_grant",
  "access.revoke": "act.access_revoke",
  "access.grant_list": "act.access_grant_list",
  "access.denied": "act.access_denied",
  "response.submit": "act.response_submit",
  "response.list": "act.response_list",
  "response.read": "act.response_read",
  "patient.card_read": "ops.act.patientCard",
  "analytics.overview": "act.analytics_overview",
  "analytics.survey": "act.analytics_survey",
  "analytics.export": "act.analytics_export",
  "report.render": "act.report_render",
  "alert.list": "act.alert_list",
  "alert.acknowledge": "act.alert_acknowledge",
  "audit.read": "act.audit_read",
  "audit.export": "ops.act.auditExport",
  "device.wipe_requested": "ops.act.deviceWipe",
  /* люди и безопасность (people2) */
  "impersonation.start": "ops.act.impStart",
  "impersonation.end": "ops.act.impEnd",
  "impersonation.view": "ops.act.impView",
  "auth.mfa_challenge": "ops.act.mfaChallenge",
  "mfa.setup": "ops.act.mfaSetup",
  "mfa.enable": "ops.act.mfaEnable",
  "mfa.disable": "ops.act.mfaDisable",
  "mfa.reset": "ops.act.mfaReset",
  "security.policy_update": "ops.act.policy",
  "suspicious.read": "ops.act.suspRead",
  "suspicious.resolve": "ops.act.suspResolve",
  "suspicious.scan": "ops.act.suspScan",
  "permission.exception_list": "ops.act.grantsList",
  "permission.exception_extend": "ops.act.grantExtend",
  "user.bulk": "ops.act.bulk",
  "user.import": "ops.act.import",
  "audit.subject_report": "ops.act.subjectReport",
  /*
   * Действий ниже код больше не пишет, но журнал вечен: строки с ними лежат
   * в нём с тех времён, когда писал, и читаться они должны словами, как
   * читались на прежнем экране.
   */
  "survey.delete": "act.survey_delete",
  "response.draft": "act.response_draft",
};

export function actionLabel(action: string, ut: (key: UiKey) => string): string {
  const key = AUDIT_ACTION_KEY[action];
  return key ? ut(key) : action;
}

/**
 * Пункты выбора «дія»: сперва то, что разбирают чаще, — доступ к картам,
 * выгрузки, отказы и входы, — затем действия над учётками. Действие, которого
 * здесь нет, но которое пришло в адресе, выбор добавляет сам (AuditLog.tsx).
 */
export const AUDIT_ACTION_CHOICES: readonly string[] = [
  "response.read",
  "patient.card_read",
  "analytics.export",
  "access.grant",
  "access.denied",
  "auth.login_failed",
  "auth.login",
  "user.create",
  "user.role_change",
  "user.disable",
  "user.enable",
  "user.delete",
  "user.password_reset",
  "user.sessions_revoke",
  "session.revoke",
  "permission.exception",
  /* people2: вход «от имени» и второй фактор ищут в журнале первыми */
  "impersonation.start",
  "impersonation.view",
  "mfa.reset",
  "user.bulk",
  "audit.read",
  "audit.export",
];

/**
 * Быстрые отборы прежнего экрана — кнопками над списком, теми же словами,
 * что там: «Усе · Доступ до карток · Вивантаження · Призначення · Відмови ·
 * Невдалі входи». Кто привык разбирать журнал так, находит тот же путь.
 */
export const AUDIT_PRESETS: readonly { action: string; key: UiKey }[] = [
  { action: "", key: "aud.allEvents" },
  { action: "response.read", key: "aud.cardAccess" },
  { action: "analytics.export", key: "aud.exports" },
  { action: "access.grant", key: "aud.grants" },
  { action: "access.denied", key: "aud.denials" },
  { action: "auth.login_failed", key: "aud.failedLogins" },
];

/** Поля отбора журнала — ровно те, что понимает GET /api/audit; все живут в адресе */
export const AUDIT_FILTERS = ["q", "actor", "subject", "action", "resourceType", "outcome", "from", "to"] as const;
export type AuditFilterKey = (typeof AUDIT_FILTERS)[number];
export type AuditFilters = Partial<Record<AuditFilterKey, string>>;

/** Отбор из адреса: пустое не передаётся вовсе — «action=» не то же, что «без действия» */
export function auditFiltersFrom(params: URLSearchParams): AuditFilters {
  const out: AuditFilters = {};
  for (const key of AUDIT_FILTERS) {
    const v = params.get(key)?.trim();
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Подробности записи для раскрытия — отступами, ключи по алфавиту.
 *
 * Ничего не добавляется и не расшифровывается: показывается ровно то, что
 * лежит в журнале. requestId остаётся — по нему запись находится в логе
 * процесса одним поиском.
 */
export function prettyDetails(details: Record<string, unknown> | null): string {
  if (!details) return "—";
  const sorted = Object.fromEntries(Object.keys(details).sort().map((k) => [k, details[k]]));
  return JSON.stringify(sorted, null, 2);
}
