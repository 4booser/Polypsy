import { Hono, type Context } from "hono";
import os from "node:os";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type {
  OpsErrors,
  OpsHealthCheck,
  OpsJobs,
  OpsLogs,
  OpsOverview,
  OpsRoutes,
  OpsSlow,
  OpsTraffic,
  OpsWindowStats,
} from "@quizzy/shared";
import pkg from "../../package.json" with { type: "json" };
import { db } from "../db";
import { asSystem } from "../db/context";
import { env } from "../env";
import { audit, type AuditAction } from "../lib/audit";
import { parseQuery } from "../lib/http";
import { logThreshold } from "../lib/log";
import {
  ERROR_CAPACITY,
  LOG_CAPACITY,
  SLOW_CAPACITY,
  SLOW_MS,
  ensureLagSampler,
  errorGroupList,
  eventLoopLag,
  normalizeMessage,
  readLogs,
  routeStats,
  slowRequests,
  startedAt,
  trafficSeries,
  windowStats,
} from "../lib/opsBuffer";
import { attempt, collectDb, dbSummary, liveProbe, type Probe } from "../lib/opsDb";
import { intervalOf, jobsSnapshot, lastStartOf } from "../lib/opsJobs";
import { checkRls } from "../lib/rlsGuard";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Техпанель: как работает система — для разработчиков.
 *
 * Решение заказчика 2026-09-26: «отдельный дашборд для супер тех админа,
 * чисто для разрабов — логи, ошибки, нагрузка, кол-во запросов и время на
 * ответ». Учётки, сессии и аудит — другие вкладки той же панели со своими
 * правами (участок accounts); здесь — только наблюдаемость.
 *
 * Закрыто правом ops.read поверх requireStaff. Право не открывает ни одной
 * клинической записи — и ответы здесь устроены так, чтобы его и не
 * открывали: запросы — шаблонами маршрутов, учётки — числами по ролям,
 * логи и ошибки — вычищенными (lib/opsBuffer.ts), ключи окружения — только
 * «задан / не задан». requireStaff — второй рубеж: исключение ops.read,
 * по ошибке выданное учётке пациента, панели не откроет.
 *
 * Память — процесса (lib/opsBuffer.ts, lib/opsJobs.ts): до перезапуска и
 * одной реплики. Каждый ответ несёт `since`, и экран говорит «з моменту
 * запуску», а не делает вид, что история полная.
 */
export const opsRoutes = new Hono<AppEnv>();

opsRoutes.use("*", requireAuth, requireStaff, requirePermission("ops.read"));

/* ─────────── журнал чтений ─────────── */

/**
 * Чтение логов и ошибок — событие журнала, как любое другое чтение.
 *
 * Но с оговоркой: живая лента опрашивает сервер раз в четыре секунды, а
 * вкладка ошибок обновляется сама раз в двадцать. Писать каждый опрос —
 * девятьсот записей в час на одного смотрящего; журнал, в котором чтение
 * карты пациента тонет среди «открыл ленту логов», перестают читать, и он
 * теряет смысл целиком. Поэтому одна запись на человека, вид и набор
 * фильтров — не чаще раза в пять минут; смена фильтра пишется сразу, потому
 * что это новый вопрос. Окно склейки записано в самой записи, чтобы читающий
 * журнал знал, что одна строка покрывает серию опросов.
 */
const AUDIT_COALESCE_MS = 5 * 60_000;
const lastRead = new Map<string, number>();

async function auditRead(
  c: Context<AppEnv>,
  action: Extract<AuditAction, "ops.logs.read" | "ops.errors.read">,
  details: Record<string, unknown>,
): Promise<void> {
  const key = `${c.get("user").id}|${action}|${JSON.stringify(details.filters ?? null)}`;
  const now = Date.now();
  const prev = lastRead.get(key);
  if (prev !== undefined && now - prev < AUDIT_COALESCE_MS) return;
  lastRead.set(key, now);
  if (lastRead.size > 2000) {
    for (const [k, at] of lastRead) if (now - at >= AUDIT_COALESCE_MS) lastRead.delete(k);
  }
  await audit(c, { action, details: { ...details, coalesceSec: AUDIT_COALESCE_MS / 1000 } });
}

/** Только для тестов: склейка чтений общая на процесс */
export function resetOpsAuditCoalescing(): void {
  lastRead.clear();
}

/* ─────────── обзор ─────────── */

/**
 * Числа, которые политики строк иначе обрезали бы по роли смотрящего
 * (учётки по ролям, открытые случаи). Отдаются только количества, без
 * единой строки, — тем же системным контекстом, что /metrics, и в своей
 * точке сохранения: отказ здесь не должен ронять обзор.
 */
const systemProbe: Probe = (query: SQL) =>
  db.transaction(() => asSystem(async () => (await db.execute(query)) as unknown as Record<string, unknown>[]));

export interface HealthInput {
  production: boolean;
  db: { up: boolean; latencyMs: number | null };
  rls: { bypasses: boolean } | null;
  pendingMigrations: number | null;
  knownMigrations: number;
  scheduler: { enabled: boolean; lastTickAt: number | null; intervalMs: number | null };
  encryptionKey: boolean;
  sentryDsn: boolean;
  metricsToken: boolean;
  lastHour: OpsWindowStats;
  now: number;
}

/**
 * Проверки здоровья: статус и код причины.
 *
 * «Сбой» — только то, что ломает работу или защиту прямо сейчас: база не
 * отвечает, политики строк обходятся в бою, схема отстала от кода,
 * планировщик молчит дольше двух своих тактов, в бою нет ключа шифрования.
 * Остальное — «предупреждение»: не настроенный сбор ошибок и метрики — это
 * решение установки, а не поломка, но тот, кто смотрит панель, должен это
 * знать.
 */
export function buildHealth(h: HealthInput): OpsHealthCheck[] {
  const checks: OpsHealthCheck[] = [];

  checks.push(
    h.db.up
      ? { key: "db", status: "ok", reason: "up", value: h.db.latencyMs }
      : { key: "db", status: "fail", reason: "down" },
  );

  checks.push(
    h.rls === null
      ? { key: "rls", status: "warn", reason: "unknown" }
      : h.rls.bypasses
        ? { key: "rls", status: h.production ? "fail" : "warn", reason: "bypass" }
        : { key: "rls", status: "ok", reason: "active" },
  );

  checks.push(
    h.pendingMigrations === null
      ? { key: "migrations", status: "warn", reason: "unknown" }
      : h.pendingMigrations > 0
        ? { key: "migrations", status: "fail", reason: "pending", value: h.pendingMigrations }
        : { key: "migrations", status: "ok", reason: "current", value: h.knownMigrations },
  );

  const s = h.scheduler;
  if (!s.enabled) {
    checks.push({ key: "scheduler", status: "warn", reason: "disabled" });
  } else if (s.lastTickAt === null) {
    checks.push({ key: "scheduler", status: "warn", reason: "never" });
  } else {
    const minutes = Math.floor((h.now - s.lastTickAt) / 60_000);
    const stale = s.intervalMs !== null && h.now - s.lastTickAt > 2 * s.intervalMs;
    checks.push({ key: "scheduler", status: stale ? "fail" : "ok", reason: stale ? "stale" : "fresh", value: minutes });
  }

  checks.push(
    h.encryptionKey
      ? { key: "encryption", status: "ok", reason: "set" }
      : { key: "encryption", status: h.production ? "fail" : "warn", reason: "missing" },
  );
  checks.push(
    h.sentryDsn
      ? { key: "errorReport", status: "ok", reason: "set" }
      : { key: "errorReport", status: "warn", reason: "missing" },
  );
  checks.push(
    h.metricsToken
      ? { key: "metricsToken", status: "ok", reason: "set" }
      : { key: "metricsToken", status: "warn", reason: "missing" },
  );

  /* порог тот же, что у оповещения в RUNBOOK: больше процента пятисоток */
  const share = h.lastHour.share5xx;
  if (share === null) checks.push({ key: "errorRate", status: "ok", reason: "quiet" });
  else {
    const pct = Math.round(share * 1000) / 10;
    checks.push(
      share > 0.01
        ? { key: "errorRate", status: "warn", reason: "high", value: pct }
        : { key: "errorRate", status: "ok", reason: "low", value: pct },
    );
  }

  return checks;
}

/** Задана ли переменная окружения — да или нет, и ничего больше */
const isSet = (name: string) => Boolean(process.env[name]?.trim());

/** Метка выкатки — короткая и без посторонних знаков: она уходит на экран */
const deployTag = (name: string) => process.env[name]?.trim().replace(/[^\w.+:-]/g, "").slice(0, 64) || null;

opsRoutes.get("/overview", async (c) => {
  ensureLagSampler();
  const now = Date.now();
  const database = await dbSummary();
  const rls = await attempt("rls", () => checkRls(((q: SQL) => liveProbe(q)) as never));

  const accounts = await attempt("accounts", async () => {
    const rows = await systemProbe(sql`select role, count(*)::int as n from users group by role`);
    const by = Object.fromEntries(rows.map((r) => [String(r.role), Number(r.n)]));
    return { superadmin: by.superadmin ?? 0, admin: by.admin ?? 0, user: by.user ?? 0 };
  });
  const cases = await attempt("openCases", async () => {
    const [row] = await systemProbe(sql`select count(*)::int as n from alert_cases where acknowledged_at is null`);
    return Number(row?.n ?? 0);
  });

  const traffic = { m5: windowStats(5, now), h1: windowStats(60, now), h24: windowStats(1440, now) };
  const lastTick = lastStartOf("schedules");
  const mem = process.memoryUsage();
  const load = os.loadavg();

  const body: OpsOverview = {
    since: startedAt,
    build: {
      version: deployTag("QUIZZY_VERSION"),
      commit: deployTag("QUIZZY_BUILD"),
      packageVersion: pkg.version,
      env: env.isProduction ? "production" : "development",
      runtime: `Bun ${Bun.version}`,
      startedAt,
    },
    process: {
      uptimeSec: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      loadAvg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0].map((v) => Math.round(v * 100) / 100) as [number, number, number],
      cpus: os.cpus().length,
      eventLoopLagMs: eventLoopLag(),
    },
    db: {
      bytes: database.bytes,
      latencyMs: database.latencyMs,
      connections: database.connections,
      lastMigration: database.lastMigration,
      pendingMigrations: database.pendingMigrations,
    },
    scheduler: {
      enabled: env.schedulerEnabled,
      lastTickAt: lastTick === null ? null : new Date(lastTick).toISOString(),
    },
    openCases: cases.ok ? cases.value : null,
    accounts: accounts.ok ? accounts.value : null,
    traffic,
    health: buildHealth({
      production: env.isProduction,
      db: { up: database.up, latencyMs: database.latencyMs },
      rls: rls.ok ? { bypasses: rls.value.bypasses } : null,
      pendingMigrations: database.pendingMigrations,
      knownMigrations: database.knownMigrations,
      scheduler: { enabled: env.schedulerEnabled, lastTickAt: lastTick, intervalMs: intervalOf("schedules") },
      /* про ключи — только «задан ли»: значение дальше этой строки не уходит */
      encryptionKey: Boolean(env.encryptionKeys.trim()),
      sentryDsn: isSet("SENTRY_DSN"),
      metricsToken: isSet("METRICS_TOKEN"),
      lastHour: traffic.h1,
      now,
    }),
  };
  return c.json(body);
});

/* ─────────── нагрузка ─────────── */

const trafficQuery = z.object({ window: z.enum(["1h", "6h", "24h"]).default("1h") });

opsRoutes.get("/traffic", (c) => {
  const { window } = parseQuery(c, trafficQuery);
  const body: OpsTraffic = { since: startedAt, window, ...trafficSeries(window) };
  return c.json(body);
});

opsRoutes.get("/routes", (c) => {
  const body: OpsRoutes = { since: startedAt, items: routeStats() };
  return c.json(body);
});

opsRoutes.get("/slow", (c) => {
  const body: OpsSlow = { since: startedAt, thresholdMs: SLOW_MS, capacity: SLOW_CAPACITY, items: slowRequests() };
  return c.json(body);
});

/* ─────────── ошибки и логи ─────────── */

opsRoutes.get("/errors", async (c) => {
  const { items, dropped } = errorGroupList();
  await auditRead(c, "ops.errors.read", { returned: items.length });
  const body: OpsErrors = { since: startedAt, capacity: ERROR_CAPACITY, dropped, items };
  return c.json(body);
});

/* пустой параметр адреса — то же, что его отсутствие: «?level=» не повод для 400 */
const blank = (v: unknown) => (v === "" ? undefined : v);
const logsQuery = z.object({
  level: z.preprocess(blank, z.enum(["debug", "info", "warn", "error"]).optional()),
  q: z.preprocess(blank, z.string().max(200).optional()),
  requestId: z.preprocess(blank, z.string().max(64).optional()),
  after: z.preprocess(blank, z.coerce.number().int().min(0).optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(1000).optional()),
});

opsRoutes.get("/logs", async (c) => {
  const query = parseQuery(c, logsQuery);
  const page = readLogs(query);
  await auditRead(c, "ops.logs.read", {
    filters: { level: query.level ?? null, q: query.q ?? null, requestId: query.requestId ?? null },
    returned: page.items.length,
  });
  const body: OpsLogs = { since: startedAt, capacity: LOG_CAPACITY, threshold: logThreshold(), ...page };
  return c.json(body);
});

/* ─────────── база и фоновые задачи ─────────── */

opsRoutes.get("/db", async (c) => c.json(await collectDb()));

opsRoutes.get("/jobs", async (c) => {
  /*
   * Срабатывания расписаний — из базы: они переживают перезапуск, в отличие
   * от реестра тактов. Без названия расписания и без людей — только когда,
   * сколько назначено и примечание (текст ошибки, вычищенный как в логе).
   */
  const runs = await attempt("scheduleRuns", () =>
    systemProbe(sql`select ran_at, assigned, skipped, note from schedule_runs order by ran_at desc limit 10`),
  );
  const body: OpsJobs = {
    since: startedAt,
    schedulerEnabled: env.schedulerEnabled,
    items: jobsSnapshot(),
    scheduleRuns: runs.ok
      ? runs.value.map((r) => ({
          at: new Date(r.ran_at as string).toISOString(),
          assigned: Number(r.assigned),
          skipped: Number(r.skipped),
          note: r.note ? normalizeMessage(String(r.note)) : null,
        }))
      : null,
  };
  return c.json(body);
});
