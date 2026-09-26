import type {
  OpsConnState,
  OpsErrorGroup,
  OpsHealthCheck,
  OpsJobResult,
  OpsLevel,
  OpsLogLine,
  OpsRouteStat,
  OpsTrafficBucket,
  Role,
  UiKey,
} from "@quizzy/shared";
import type { Column } from "../../charts/clinical";
import type { LinePoint } from "../../charts";

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
  /* участок obs2b: задачи, которые запускают и руками (apps/api/src/lib/opsManual.ts) */
  "analytics.cache": "o2b.job.analyticsCache",
  "search.reindex": "o2b.job.searchReindex",
  "catalog.install": "o2b.job.catalogInstall",
  "ops.alerts": "o2b.job.alerts",
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
