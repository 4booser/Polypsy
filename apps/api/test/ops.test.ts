import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { OpsDb, OpsErrors, OpsLogs, OpsOverview, OpsRoutes } from "@quizzy/shared";
import { auditLog, permissionExceptions, staffRoles } from "../src/db/schema";
import { FORBIDDEN } from "../src/lib/errorReport";
import { log, withRequestId } from "../src/lib/log";
import {
  LOG_CAPACITY,
  PERSONAL_KEYS,
  captureLog,
  errorGroupList,
  framesOf,
  normalizeMessage,
  quantile,
  readLogs,
  recordError,
  recordRequest,
  resetOpsBuffers,
  routeStats,
  slowRequests,
  trafficSeries,
  windowStats,
} from "../src/lib/opsBuffer";
import { collectDb, liveProbe, normalizeSql, type Probe } from "../src/lib/opsDb";
import { jobsSnapshot, registerJob, resetJobs, trackJob } from "../src/lib/opsJobs";
import { buildHealth, resetOpsAuditCoalescing, type HealthInput } from "../src/routes/ops";
import { underAppRole } from "./appRole";
import { adminA, api, db, issueToken, makeUser, root } from "./fixtures";

/**
 * Техпанель: наблюдаемость (routes/ops.ts, lib/opsBuffer.ts, lib/opsDb.ts).
 *
 * Проверяется четыре вещи, и порядок их важности такой:
 *
 *   1. Кто видит. Панель открывает логи и ошибки процесса — то, что
 *      клиническому администратору не положено, а разработчику положено без
 *      пациентов. Отказ без права — первым.
 *   2. Что уходит на экран. Ни персональных данных, ни значений секретов: про
 *      ключи окружения — только «задан / нет».
 *   3. Что цифры честные: корзины, перцентили, группировка, курсор ленты.
 *   4. Что «нет прав на pg_stat_activity» — состояние установки, а не
 *      пятисотка на весь раздел.
 */

const OPS_GETS = [
  "/api/ops/overview",
  "/api/ops/traffic",
  "/api/ops/routes",
  "/api/ops/slow",
  "/api/ops/errors",
  "/api/ops/logs",
  "/api/ops/db",
  "/api/ops/jobs",
];

/** Разработчик: учётка сотрудника без клинической роли и с одним исключением ops.read */
async function makeDeveloper() {
  const dev = await makeUser("admin", `ops-dev-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, dev.id));
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: dev.id,
    permission: "ops.read",
    mode: "grant",
    reason: "Разработчик: разбор нагрузки и ошибок",
    grantedBy: root.id,
  });
  return dev;
}

beforeEach(() => {
  resetOpsBuffers();
  resetOpsAuditCoalescing();
});

describe("кто видит техпанель", () => {
  test("клинический администратор без ops.read получает отказ на каждом маршруте", async () => {
    for (const path of OPS_GETS) {
      const res = await api(path, adminA.token);
      expect(res.status, path).toBe(403);
      // отказ именно по праву, а не чей-то чужой 403
      expect(String(res.body?.error ?? ""), path).toContain("ops.read");
    }
  });

  test("пациент не доходит даже до проверки права", async () => {
    const patient = await makeUser("user", `ops-p-${crypto.randomUUID()}@test`);
    const res = await api("/api/ops/overview", patient.token);
    expect(res.status).toBe(403);
  });

  test("разработчик с ops.read видит панель — и не видит пациентов", async () => {
    const dev = await makeDeveloper();
    for (const path of OPS_GETS) {
      const res = await api(path, dev.token);
      expect(res.status, path).toBe(200);
    }
    /*
     * Право смотреть, как работает система, не открывает людей: ровно ради
     * этого оно отдельной группой, а не ещё одной строкой администрирования.
     */
    const people = await api("/api/patients", dev.token);
    expect(people.status).toBe(403);
  });

  test("суперадмин видит панель без исключений", async () => {
    const res = await api("/api/ops/overview", root.token);
    expect(res.status).toBe(200);
  });
});

describe("корзины и перцентили", () => {
  test("перцентиль по корзинам: интерполяция внутри корзины и потолок по максимуму", () => {
    // 50 запросов до 5 мс и 50 — от 5 до 10: медиана на границе, p95 внутри второй корзины
    const hist = [50, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(quantile(hist, 0.5, 10)).toBe(5);
    expect(quantile(hist, 0.95, 10)).toBe(10); // 9,5 → 10
    // сто запросов по 30 мс: середина корзины 25–50 дала бы 38, но больше максимума перцентиль не бывает
    expect(quantile([0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0], 0.5, 30)).toBe(30);
    // выше последней границы интерполировать не к чему — отдаётся максимум
    expect(quantile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4], 0.95, 7300)).toBe(7300);
    // пусто — не ноль, а «не знаем»
    expect(quantile(new Array(11).fill(0), 0.5, 0)).toBeNull();
  });

  test("окна считают только свои минуты; сутки назад — уже не в счёт", () => {
    const now = Date.UTC(2026, 8, 26, 12, 30, 20);
    const base = { method: "GET", route: "/api/x", role: null, requestId: "r" } as const;
    /*
     * Ровно сутки назад — та же ячейка кольца, что у текущей минуты. Время
     * идёт вперёд, поэтому она пишется первой, а свежая минута обязана её
     * обнулить, а не приплюсовать.
     */
    recordRequest({ ...base, code: 200, ms: 20, at: now - 1440 * 60_000 });
    recordRequest({ ...base, code: 200, ms: 20, at: now - 30 * 60_000 });
    recordRequest({ ...base, code: 404, ms: 8, at: now - 3 * 60_000 });
    for (let i = 0; i < 10; i++) recordRequest({ ...base, code: 200, ms: 20, at: now - 10_000 });
    recordRequest({ ...base, code: 500, ms: 40, at: now - 10_000 });
    for (let i = 0; i < 10; i++) recordRequest({ ...base, code: 200, ms: 20, at: now });

    const m5 = windowStats(5, now);
    expect(m5.requests).toBe(22);
    expect(m5.errors5xx).toBe(1);
    expect(m5.errors4xx).toBe(1);
    expect(m5.share5xx).toBeCloseTo(1 / 22);
    expect(windowStats(60, now).requests).toBe(23);
    // запись суточной давности вытеснена текущей минутой и в сутки не входит
    expect(windowStats(1440, now).requests).toBe(23);
  });

  test("ряд нагрузки: выровнен по шагу, последняя корзина — текущая", () => {
    const now = Date.UTC(2026, 8, 26, 12, 31, 5);
    const base = { method: "GET", route: "/api/x", role: null, requestId: "r" } as const;
    recordRequest({ ...base, code: 200, ms: 12, at: now });
    recordRequest({ ...base, code: 503, ms: 30, at: now - 5 * 60_000 });

    const hour = trafficSeries("1h", now);
    expect(hour.stepSec).toBe(60);
    expect(hour.buckets).toHaveLength(60);
    expect(hour.buckets.at(-1)!.at).toBe(new Date(Date.UTC(2026, 8, 26, 12, 31)).toISOString());
    expect(hour.buckets.at(-1)!.requests).toBe(1);
    expect(hour.buckets.at(-6)!.errors5xx).toBe(1);
    expect(hour.buckets.reduce((s, b) => s + b.requests, 0)).toBe(2);

    const day = trafficSeries("24h", now);
    expect(day.stepSec).toBe(900);
    expect(day.buckets).toHaveLength(96);
    // 12:31 падает в корзину 12:30, 12:26 — в 12:15
    expect(day.buckets.at(-1)!.at).toBe(new Date(Date.UTC(2026, 8, 26, 12, 30)).toISOString());
    expect(day.buckets.at(-1)!.requests).toBe(1);
    expect(day.buckets.at(-2)!.requests).toBe(1);
    expect(trafficSeries("6h", now).buckets).toHaveLength(72);
  });

  test("маршрут считается шаблоном, медленные — отдельным кольцом", async () => {
    recordRequest({ method: "GET", route: "/api/responses/:id", code: 200, ms: 12, role: "admin", requestId: "a" });
    recordRequest({ method: "GET", route: "/api/responses/:id", code: 404, ms: 9, role: "admin", requestId: "b" });
    recordRequest({ method: "POST", route: "/api/x", code: 500, ms: 1500, role: "user", requestId: "slow-1" });

    const byRoute = routeStats();
    const responses = byRoute.find((r) => r.route === "/api/responses/:id")!;
    expect(responses.requests).toBe(2);
    expect(responses.errors4xx).toBe(1);
    expect(responses.maxMs).toBe(12);

    const slow = slowRequests();
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ requestId: "slow-1", code: 500, ms: 1500, role: "user", route: "/api/x" });

    /*
     * Сквозь приложение: адрес с идентификатором попадает в сводку шаблоном.
     * Иначе каждая карта пациента стала бы своей строкой, и в сводке
     * лежали бы идентификаторы людей.
     */
    const id = crypto.randomUUID();
    await api(`/api/surveys/${id}`, root.token);
    const res = await api<OpsRoutes>("/api/ops/routes", root.token);
    expect(res.status).toBe(200);
    expect(res.body.items.some((r) => r.method === "GET" && r.route === "/api/surveys/:id")).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(id);
  });
});

describe("группировка ошибок", () => {
  test("одна ошибка на разных людях — одна группа; другой маршрут — другая", () => {
    const boom = (who: string) => {
      const e = new Error(`invalid input syntax for type uuid: "${who}"`);
      e.stack = `Error: ${e.message}\n    at loadCard (/srv/deploy/app/apps/api/src/routes/patients.ts:41:13)\n    at dispatch (/srv/deploy/app/node_modules/hono/dist/compose.js:22:23)`;
      return e;
    };
    recordError({ error: boom("11111111-2222-4333-8444-555555555555"), method: "GET", route: "/api/patients/:id", requestId: "q1" });
    recordError({ error: boom("ivanenko@example.com"), method: "GET", route: "/api/patients/:id", requestId: "q2" });
    recordError({ error: boom("x"), method: "GET", route: "/api/timeline/:userId", requestId: "q3" });

    const { items } = errorGroupList();
    expect(items).toHaveLength(2);
    const card = items.find((g) => g.route === "/api/patients/:id")!;
    expect(card.count).toBe(2);
    expect(card.lastRequestId).toBe("q2");
    expect(card.message).toBe('invalid input syntax for type uuid: "?"');
    // кадры — без абсолютного пути машины и без сообщения
    expect(card.frames[0]).toBe("at loadCard (apps/api/src/routes/patients.ts:41:13)");
    expect(card.frames[1]).toBe("at dispatch (node_modules/hono/dist/compose.js:22:23)");
    expect(JSON.stringify(items)).not.toContain("ivanenko");
  });

  test("log.error вне запроса — тоже группа, без данных", () => {
    log.error("schedule.failed", { scheduleId: "s-1", error: "SMTP отказал для olena@example.com, код 5500123" });
    log.error("schedule.failed", { scheduleId: "s-2", error: "SMTP отказал для petro@example.com, код 5500124" });
    const { items } = errorGroupList();
    const failed = items.find((g) => g.name === "schedule.failed")!;
    expect(failed.origin).toBe("log");
    expect(failed.count).toBe(2);
    expect(failed.message).toBe("SMTP отказал для [email], код N");
  });

  test("сообщение: имена оставлены, значения убраны", () => {
    expect(normalizeMessage("Cannot read properties of undefined (reading 'units')")).toBe(
      "Cannot read properties of undefined (reading 'units')",
    );
    expect(normalizeMessage("bad value 'Іваненко Петро' in 'x'")).toBe("bad value '?' in 'x'");
    expect(normalizeMessage("call +380501234567 now")).toBe("call [phone] now");
    expect(framesOf(undefined)).toEqual([]);
  });
});

describe("лента логов", () => {
  test("уровень, поиск, номер запроса и курсор", async () => {
    log.info("ops.test.alpha", { n: 1 });
    log.warn("ops.test.beta", { n: 2 });
    withRequestId("req-ops-0123456789", () => log.error("ops.test.gamma", { reason: "zeta" }));

    const warn = await api<OpsLogs>("/api/ops/logs?level=warn", root.token);
    expect(warn.status).toBe(200);
    expect(warn.body.items.map((l) => l.message)).toEqual(["ops.test.beta", "ops.test.gamma"]);

    const found = await api<OpsLogs>("/api/ops/logs?q=ZETA", root.token);
    expect(found.body.items.map((l) => l.message)).toEqual(["ops.test.gamma"]);

    // укороченный номер запроса — так его печатает лог разработки
    const byId = await api<OpsLogs>("/api/ops/logs?requestId=req-ops-01", root.token);
    expect(byId.body.items.map((l) => l.message)).toEqual(["ops.test.gamma"]);

    const cursor = warn.body.cursor;
    log.info("ops.test.delta");
    const next = await api<OpsLogs>(`/api/ops/logs?after=${cursor}`, root.token);
    expect(next.body.items.map((l) => l.message)).toEqual(["ops.test.delta"]);
    expect(next.body.gap).toBe(false);

    // пустой параметр — то же, что его отсутствие, а не 400
    expect((await api("/api/ops/logs?level=&q=", root.token)).status).toBe(200);
    expect((await api("/api/ops/logs?level=loud", root.token)).status).toBe(400);
  });

  test("запросы самой панели в ленту не попадают, иначе она не замолкает", async () => {
    await api("/api/ops/routes", root.token);
    await api("/api/ops/slow", root.token);
    const page = readLogs({ q: "/api/ops" });
    expect(page.items).toEqual([]);
  });

  test("курсор, выпавший из кольца, помечается разрывом", () => {
    captureLog("info", "first", {}, null);
    const start = readLogs({}).cursor;
    for (let i = 0; i < LOG_CAPACITY + 10; i++) captureLog("debug", `fill-${i}`, {}, null);
    const page = readLogs({ after: start, limit: 5 });
    expect(page.gap).toBe(true);
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(5);
    expect(page.items.at(-1)!.message).toBe(`fill-${LOG_CAPACITY + 9}`);
  });

  test("чтение ленты пишется в журнал, опросы одного вида склеиваются", async () => {
    const dev = await makeDeveloper();
    const reads = async () =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.actorId, dev.id), eq(auditLog.action, "ops.logs.read")));

    await api("/api/ops/logs?level=warn", dev.token);
    await api("/api/ops/logs?level=warn&after=3", dev.token);
    expect(await reads()).toHaveLength(1);
    // новый вопрос — новая запись сразу
    await api("/api/ops/logs?level=error", dev.token);
    const rows = await reads();
    expect(rows).toHaveLength(2);
    expect((rows[0]!.details as { coalesceSec: number }).coalesceSec).toBe(300);

    await api("/api/ops/errors", dev.token);
    const errs = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, dev.id), eq(auditLog.action, "ops.errors.read")));
    expect(errs).toHaveLength(1);

    // числа и графики — без журнала
    await api("/api/ops/overview", dev.token);
    await api("/api/ops/traffic?window=24h", dev.token);
    const all = await db.select().from(auditLog).where(eq(auditLog.actorId, dev.id));
    expect(all.filter((r) => r.action.startsWith("ops.")).map((r) => r.action).sort()).toEqual([
      "ops.errors.read",
      "ops.logs.read",
      "ops.logs.read",
    ]);
  });
});

describe("ни персональных данных, ни секретов", () => {
  test("список запрещённых полей панели шире, чем у сборщика ошибок", () => {
    const missing = FORBIDDEN.filter((k) => !PERSONAL_KEYS.has(k.toLowerCase()));
    expect(missing).toEqual([]);
  });

  test("поля лога с данными закрыты, почта и телефоны замаскированы", async () => {
    log.info("ops.test.pii", {
      email: "ivan.franko@example.com",
      firstName: "Іван",
      nested: { lastName: "Франко", note: "дзвонити +380501234567 або 0671234567" },
      route: "/api/patients/:id",
    });
    const res = await api<OpsLogs>("/api/ops/logs?q=ops.test.pii", root.token);
    const text = JSON.stringify(res.body);
    for (const leak of ["ivan.franko@example.com", "Іван", "Франко", "+380501234567", "0671234567"]) {
      expect(text, leak).not.toContain(leak);
    }
    const line = res.body.items[0]!;
    expect(line.fields.email).toBe("[hidden]");
    expect((line.fields.nested as { note: string }).note).toBe("дзвонити [phone] або [phone]");
    expect(line.fields.route).toBe("/api/patients/:id");
  });

  test("обзор: про ключи — только «задан / нет», значений нет нигде", async () => {
    const saved = { m: process.env.METRICS_TOKEN, s: process.env.SENTRY_DSN, v: process.env.QUIZZY_VERSION };
    const metrics = `metrics-${crypto.randomUUID()}`;
    const sentryKey = `sentrykey${crypto.randomUUID().slice(0, 8)}`;
    process.env.METRICS_TOKEN = metrics;
    process.env.SENTRY_DSN = `https://${sentryKey}@glitch.invalid/7`;
    process.env.QUIZZY_VERSION = "2026.9.26";
    let res: { status: number; body: OpsOverview };
    try {
      res = await api<OpsOverview>("/api/ops/overview", root.token);
    } finally {
      /* SENTRY_DSN живёт на весь процесс: оставь его — и чужие тесты пошли бы в сеть */
      for (const [k, v] of [
        ["METRICS_TOKEN", saved.m],
        ["SENTRY_DSN", saved.s],
        ["QUIZZY_VERSION", saved.v],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    const secrets = [
      metrics,
      sentryKey,
      process.env.JWT_SECRET!,
      process.env.ENCRYPTION_KEY!,
      process.env.DATABASE_URL!,
      process.env.PHONE_INDEX_SECRET,
      process.env.EXPORT_SECRET,
    ].filter((s): s is string => Boolean(s && s.length > 6));
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain("root@test");

    const health = Object.fromEntries(res.body.health.map((h) => [h.key, h]));
    expect(health.metricsToken).toEqual({ key: "metricsToken", status: "ok", reason: "set" });
    expect(health.errorReport).toEqual({ key: "errorReport", status: "ok", reason: "set" });
    expect(health.encryption).toEqual({ key: "encryption", status: "ok", reason: "set" });
    expect(res.body.build.version).toBe("2026.9.26");

    // учётки — только числа по ролям
    expect(Object.keys(res.body.accounts!).sort()).toEqual(["admin", "superadmin", "user"]);
    expect(Object.values(res.body.accounts!).every((n) => Number.isInteger(n))).toBe(true);
    expect(res.body.accounts!.superadmin).toBeGreaterThanOrEqual(1);

    // схема не отстала от кода: миграции тестовой базы применены все
    expect(res.body.db.pendingMigrations).toBe(0);
    expect(health.migrations!.status).toBe("ok");
  });

  test("ошибки на экране — без почты и значений из сообщения", async () => {
    recordError({ error: new Error("no user olena.pchilka@example.com"), method: "POST", route: "/api/x", requestId: "z" });
    const res = await api<OpsErrors>("/api/ops/errors", root.token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("olena.pchilka");
    expect(res.body.items[0]!.message).toBe("no user [email]");
  });
});

describe("проверки здоровья", () => {
  const calm: HealthInput = {
    production: true,
    db: { up: true, latencyMs: 1.2 },
    rls: { bypasses: false },
    pendingMigrations: 0,
    knownMigrations: 88,
    scheduler: { enabled: true, lastTickAt: 1_000_000, intervalMs: 3_600_000 },
    encryptionKey: true,
    sentryDsn: true,
    metricsToken: true,
    lastHour: { requests: 0, errors4xx: 0, errors5xx: 0, share5xx: null, avgMs: null, p50: null, p95: null, p99: null, maxMs: null },
    now: 1_000_000 + 10 * 60_000,
  };

  test("спокойная установка — всё «гаразд»", () => {
    expect(buildHealth(calm).filter((c) => c.status !== "ok")).toEqual([]);
  });

  test("в бою сбой — обход политик, отставшая схема, молчащий планировщик, нет ключа", () => {
    const bad = buildHealth({
      ...calm,
      rls: { bypasses: true },
      pendingMigrations: 2,
      scheduler: { ...calm.scheduler, lastTickAt: calm.now - 3 * 3_600_000 },
      encryptionKey: false,
      sentryDsn: false,
      lastHour: { ...calm.lastHour, requests: 100, errors5xx: 3, share5xx: 0.03 },
    });
    const by = Object.fromEntries(bad.map((c) => [c.key, c]));
    expect(by.rls!.status).toBe("fail");
    expect(by.migrations).toMatchObject({ status: "fail", reason: "pending", value: 2 });
    expect(by.scheduler).toMatchObject({ status: "fail", reason: "stale", value: 180 });
    expect(by.encryption!.status).toBe("fail");
    expect(by.errorReport!.status).toBe("warn");
    expect(by.errorRate).toMatchObject({ status: "warn", reason: "high", value: 3 });
  });

  test("в разработке обход политик — предупреждение, выключенный планировщик — тоже", () => {
    const dev = buildHealth({ ...calm, production: false, rls: { bypasses: true }, scheduler: { ...calm.scheduler, enabled: false } });
    const by = Object.fromEntries(dev.map((c) => [c.key, c]));
    expect(by.rls!.status).toBe("warn");
    expect(by.scheduler).toMatchObject({ status: "warn", reason: "disabled" });
  });
});

describe("фоновые задачи", () => {
  test("такт отмечается: успех, сбой с вычищенной ошибкой, следующий запуск", async () => {
    resetJobs();
    const t0 = Date.now();
    registerJob("ops.test.job", 60_000, t0);
    await trackJob("ops.test.job", async () => 3);
    await expect(
      trackJob("ops.test.job", async () => {
        throw new Error("mail to taras@example.com failed");
      }),
    ).rejects.toThrow();
    const [job] = jobsSnapshot(t0 + 90_000);
    expect(job).toMatchObject({ name: "ops.test.job", runs: 2, failures: 1, lastResult: "error", intervalSec: 60 });
    expect(job!.lastError).toBe("mail to [email] failed");
    expect(job!.nextAt).toBe(new Date(t0 + 120_000).toISOString());
  });

  test("маршрут отдаёт реестр и срабатывания расписаний из базы", async () => {
    const res = await api("/api/ops/jobs", root.token);
    expect(res.status).toBe(200);
    // в тестах планировщик выключен (preload) — и экран обязан это сказать
    expect(res.body.schedulerEnabled).toBe(false);
    expect(Array.isArray(res.body.scheduleRuns)).toBe(true);
  });
});

describe("база", () => {
  test("под владельцем — все разделы на месте", async () => {
    const res = await api<OpsDb>("/api/ops/db", root.token);
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
    expect(res.body.tables!.length).toBeGreaterThan(5);
    expect(res.body.tables!.length).toBeLessThanOrEqual(25);
    expect(res.body.connections!.total).toBeGreaterThanOrEqual(1);
    expect(res.body.migrations!.pending).toBe(0);
    expect(res.body.migrations!.appliedCount).toBe(res.body.migrations!.known);
    expect(res.body.migrations!.applied[0]!.tag).toMatch(/^\d{4}_/);
    expect(Array.isArray(res.body.longQueries)).toBe(true);
    expect(Array.isArray(res.body.locks)).toBe(true);
  });

  test("нет прав на pg_stat_activity — разделы null с пояснением, остальное на месте", async () => {
    const dialect = new PgDialect();
    const denying: Probe = async (query) => {
      if (dialect.sqlToQuery(query).sql.includes("pg_stat_activity")) {
        throw Object.assign(new Error("permission denied for view pg_stat_activity"), { code: "42501" });
      }
      return liveProbe(query);
    };
    const out = await collectDb(denying);
    expect(out.connections).toBeNull();
    expect(out.longQueries).toBeNull();
    expect(out.locks).toBeNull();
    expect(out.notes).toContain("activityDenied");
    expect(out.tables!.length).toBeGreaterThan(0);
    expect(out.migrations).not.toBeNull();
  });

  test("под боевой ролью приложения: чужие сессии скрыты, журнал миграций закрыт — ответ 200", async () => {
    /*
     * Не подстановка, а настоящая роль без прав владельца, как в бою
     * (appRole.ts). Ей не выдан pg_read_all_stats и нет USAGE на схему
     * drizzle — ровно то, что бывает на установке.
     */
    const token = await issueToken({ id: root.id, role: "superadmin" });
    const out = await underAppRole<{ dbStatus: number; db: OpsDb; ovStatus: number; ov: OpsOverview }>(`
      const h = { headers: { Authorization: "Bearer ${token}" } };
      const d = await app.request("/api/ops/db", h);
      out.dbStatus = d.status;
      out.db = await d.json();
      const o = await app.request("/api/ops/overview", h);
      out.ovStatus = o.status;
      out.ov = await o.json();
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.dbStatus).toBe(200);
    expect(out.db!.notes).toContain("migrationsDenied");
    expect(out.db!.migrations).toBeNull();
    expect(out.db!.tables!.length).toBeGreaterThan(0);
    expect(out.ovStatus).toBe(200);
    expect(out.ov!.health.find((h) => h.key === "migrations")).toMatchObject({ status: "warn", reason: "unknown" });
    expect(out.ov!.health.find((h) => h.key === "rls")).toMatchObject({ status: "ok", reason: "active" });
  });

  test("текст запроса: литералы — «?», длина — 200", () => {
    expect(normalizeSql("select *  from users\n where email = 'a@b.c' and note = E'x''y'")).toBe(
      "select * from users where email = ? and note = ?",
    );
    expect(normalizeSql(`select ${"x, ".repeat(200)}1`).length).toBe(200);
  });
});
