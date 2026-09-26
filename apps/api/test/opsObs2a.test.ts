import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { and, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { OpsErrors, OpsLogs, OpsReleaseCompare, OpsReleases, OpsStatementPlan, OpsStatements, OpsTrace, User } from "@quizzy/shared";
import { auditLog, permissionExceptions, rolePermissions, roles, staffRoles } from "../src/db/schema";
import { log, withRequestId } from "../src/lib/log";
import { captureLog, instanceId, recordError, recordRequest, resetOpsBuffers } from "../src/lib/opsBuffer";
import { liveProbe, type Probe } from "../src/lib/opsDb";
import { compareDesc, decodeCursor, encodeCursor, mergeErrorGroups, mergeHistory } from "../src/lib/opsHistory";
import {
  COMPARE_WINDOW_MIN,
  ERROR_MIN,
  MIN_SAMPLE,
  compareReleases,
  errorShift,
  latencyShift,
  listReleases,
} from "../src/lib/opsReleases";
import { rememberRequestSql, resetRequestSql } from "../src/lib/opsSql";
import { collectStatements, explainStatement, explainable, liveExplainer } from "../src/lib/opsStatements";
import {
  ERROR_RETENTION_DAYS,
  HOUR_RETENTION_DAYS,
  LOG_RETENTION_DAYS,
  MINUTE_RETENTION_DAYS,
  PENDING_LOG_CAP,
  aggUpsertRows,
  flushOpsStore,
  releaseTag,
  rotateOpsStore,
  storeState,
} from "../src/lib/opsStore";
import { permissionsOf } from "../src/lib/permissions";
import { resetOpsAuditCoalescing } from "../src/routes/ops";
import { rlsRoleUrl, underAppRole } from "./appRole";
import { adminA, api, db, issueToken, makeUser, root, sql } from "./fixtures";

/**
 * Техпанель, вторая половина (участок obs2a): история в базе, трасса
 * запроса, сравнение выкаток, медленные SQL.
 *
 * Порядок важности тот же, что у первой половины (ops.test.ts): сначала
 * кто видит — политики новых таблиц и право ops.read в SQL; потом что
 * история честная — пачки, ротация, переживание перезапуска, склейка без
 * дублей; потом что трасса собирает своё и только своё; и что отсутствие
 * pg_stat_statements — состояние установки, а не пятисотка.
 *
 * «Перезапуск процесса» здесь — resetOpsBuffers(): буферы пусты, очередь
 * записи пуста, номер экземпляра новый. Всё, что осталось видно после
 * него, пришло из базы.
 */

const DAY = 86_400_000;

/** Текст вопроса к базе — чтобы подставной зонд мог решить, что отвечать */
const dialect = new PgDialect();
const textOf = (q: SQL) => dialect.sqlToQuery(q).sql;

async function makeDeveloper(tag = "dev") {
  const dev = await makeUser("admin", `obs2a-${tag}-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, dev.id));
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: dev.id,
    permission: "ops.read",
    mode: "grant",
    reason: "Разработчик: разбор истории",
    grantedBy: root.id,
  });
  return dev;
}

/** Строки истории этого экземпляра — чтобы чужие тесты в той же базе не мешали */
async function storedLines(instance: string) {
  return [...(await db.execute(sql`select seq, message, request_id, fields, sql from ops_log_lines where instance = ${instance} order by seq`))];
}

beforeEach(() => {
  resetOpsBuffers();
  resetRequestSql();
  resetOpsAuditCoalescing();
});

/* ─────────────────────────── кто видит ─────────────────────────── */

describe("кто видит историю", () => {
  const NEW_GETS = [
    "/api/ops/trace/abcd1234",
    "/api/ops/releases",
    "/api/ops/releases/compare",
    "/api/ops/statements",
    "/api/ops/statements/1/plan",
    "/api/ops/logs?window=24h",
    "/api/ops/errors?window=24h",
  ];

  test("клинический администратор без ops.read — отказ на каждом новом маршруте", async () => {
    for (const path of NEW_GETS) {
      const res = await api(path, adminA.token);
      expect(res.status, path).toBe(403);
      expect(String(res.body?.error ?? ""), path).toContain("ops.read");
    }
  });

  test("разработчик с ops.read — пускают", async () => {
    const dev = await makeDeveloper();
    for (const path of NEW_GETS) {
      const res = await api(path, dev.token);
      expect(res.status, path).toBe(200);
    }
  });

  test("право ops.read в SQL — зеркало permissionsOf, и расходиться им не с чего", async () => {
    /*
     * Политики новых таблиц спрашивают право через rls_has_permission() — это
     * вторая копия правила «роли плюс выдачи минус отъёмы». Сторож: на
     * каждом виде человека оба ответа совпадают.
     */
    const withGrant = await makeDeveloper("grant");
    const revoked = await makeDeveloper("revoked");
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: revoked.id,
      permission: "ops.read",
      mode: "revoke",
      reason: "Отозвано",
      grantedBy: root.id,
    });
    const expired = await makeUser("admin", `obs2a-exp-${crypto.randomUUID()}@test`);
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: expired.id,
      permission: "ops.read",
      mode: "grant",
      reason: "На смену",
      grantedBy: root.id,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const byRole = await makeUser("admin", `obs2a-role-${crypto.randomUUID()}@test`);
    const roleId = crypto.randomUUID();
    await db.insert(roles).values({ id: roleId, code: `obs2a-${roleId.slice(0, 8)}`, title: { uk: "Черговий розробник", ru: "Дежурный разработчик" } });
    await db.insert(rolePermissions).values({ roleId, permission: "ops.read" });
    await db.insert(staffRoles).values({ userId: byRole.id, roleId });
    const patient = await makeUser("user", `obs2a-p-${crypto.randomUUID()}@test`);

    const people: [string, User["role"], boolean][] = [
      [root.id, "superadmin", true],
      [withGrant.id, "admin", true],
      [revoked.id, "admin", false],
      [expired.id, "admin", false],
      [byRole.id, "admin", true],
      [adminA.id, "admin", false],
      [patient.id, "user", false],
    ];
    for (const [id, role, expected] of people) {
      const inCode = (await permissionsOf({ id, role } as User)).has("ops.read");
      const inSql = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.role', ${role}, true), set_config('app.user_id', ${id}, true)`);
        const [row] = await tx.execute<{ ok: boolean }>(sql`select rls_has_permission('ops.read') as ok`);
        return Boolean(row?.ok);
      });
      expect(inCode, `${role} ${id}: код`).toBe(expected);
      expect(inSql, `${role} ${id}: SQL`).toBe(expected);
    }
  });

  describe("политики строк под ролью без прав владельца", () => {
    let rls: ReturnType<typeof postgres>;
    let dev: { id: string };

    beforeAll(async () => {
      rls = postgres(await rlsRoleUrl(), { max: 2 });
      dev = await makeDeveloper("rls");
      log.info("obs2a.rls.line", { n: 1 });
      recordError({ error: new Error("obs2a rls boom"), method: "GET", route: "/api/rls", requestId: "rls-1" });
      recordRequest({ method: "GET", route: "/api/rls", code: 200, ms: 5, role: null, requestId: "rls-1" });
      const out = await flushOpsStore();
      expect(out.error).toBeNull();
    });

    afterAll(async () => {
      await rls?.end({ timeout: 3 }).catch(() => {});
    });

    const as = (role: string, uid: string, query: string) =>
      rls.begin(async (tx) => {
        if (role) await tx.unsafe(`select set_config('app.role', $1, true), set_config('app.user_id', $2, true)`, [role, uid]);
        return Number((await tx.unsafe(query))[0]!.n);
      });

    const TABLES = ["ops_log_lines", "ops_error_groups", "ops_error_hours", "ops_request_aggs"];

    test("читают система, суперадмин и держатель ops.read; остальные — ничего", async () => {
      for (const t of TABLES) {
        const q = `select count(*)::int as n from ${t}`;
        expect(await as("", "", q), `${t}: без контекста`).toBe(0);
        expect(await as("system", "", q), `${t}: система`).toBeGreaterThan(0);
        expect(await as("superadmin", root.id, q), `${t}: суперадмин`).toBeGreaterThan(0);
        expect(await as("admin", dev.id, q), `${t}: разработчик`).toBeGreaterThan(0);
        expect(await as("admin", adminA.id, q), `${t}: клинический администратор`).toBe(0);
        expect(await as("user", root.id, q), `${t}: пациент с чужим id`).toBe(0);
      }
    });

    test("писать и удалять — только система: держатель ops.read историю не правит", async () => {
      await expect(
        rls.begin(async (tx) => {
          await tx.unsafe(`select set_config('app.role', 'admin', true), set_config('app.user_id', $1, true)`, [dev.id]);
          await tx.unsafe(
            `insert into ops_log_lines (instance, seq, at, level, message) values ('forged', 1, now(), 'info', 'подложено')`,
          );
        }),
      ).rejects.toThrow(/row-level security/);
      const deleted = await rls.begin(async (tx) => {
        await tx.unsafe(`select set_config('app.role', 'admin', true), set_config('app.user_id', $1, true)`, [dev.id]);
        return (await tx.unsafe(`delete from ops_log_lines returning 1`)).length;
      });
      expect(deleted).toBe(0);
    });

    test("вкладка ошибок под боевой ролью: разработчик видит сохранённую группу", async () => {
      const token = await issueToken({ id: dev.id, role: "admin" });
      const out = await underAppRole<{ status: number; body: OpsErrors }>(`
        const r = await app.request("/api/ops/errors?window=24h", { headers: { Authorization: "Bearer ${token}" } });
        out.status = r.status;
        out.body = await r.json();
      `);
      expect(out.error, out.error).toBeUndefined();
      expect(out.rlsActive).toBe(true);
      expect(out.status).toBe(200);
      expect(out.body!.historyUnavailable).toBe(false);
      expect(out.body!.items.some((g) => g.message === "obs2a rls boom")).toBe(true);
    });
  });
});

/* ─────────────────────────── запись и ротация ─────────────────────────── */

describe("запись пачками", () => {
  test("очередь уходит одной пачкой, повторный такт ничего не дублирует", async () => {
    const inst = instanceId();
    for (let i = 0; i < 25; i++) log.info("obs2a.batch", { i });
    expect(storeState().pendingLogs).toBe(25);
    const first = await flushOpsStore();
    expect(first).toMatchObject({ logs: 25, error: null });
    expect(storeState().pendingLogs).toBe(0);
    const second = await flushOpsStore();
    expect(second.logs).toBe(0);
    const rows = await storedLines(inst);
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect((rows[3]!.fields as { i: number }).i).toBe(3);
  });

  test("в историю идёт вычищенное: ни почты, ни имён, ни телефонов", async () => {
    const inst = instanceId();
    log.info("obs2a.pii", { email: "olena.teliha@example.com", firstName: "Олена", note: "дзвонити +380501234567" });
    await flushOpsStore();
    const text = JSON.stringify(await storedLines(inst));
    for (const leak of ["olena.teliha@example.com", "Олена", "+380501234567"]) expect(text).not.toContain(leak);
    expect(text).toContain("[hidden]");
    expect(text).toContain("[phone]");
  });

  test("база недоступна: процесс не падает, строки ждут и уходят следующим тактом", async () => {
    const inst = instanceId();
    log.info("obs2a.outage", { n: 1 });
    /*
     * «Недоступна» — таблицы нет: запрос падает не ошибкой данных, а
     * ошибкой места, и такую пачку положено повторять, а не выбрасывать.
     */
    await db.execute(sql`alter table ops_log_lines rename to ops_log_lines_away`);
    let out;
    try {
      out = await flushOpsStore();
    } finally {
      await db.execute(sql`alter table ops_log_lines_away rename to ops_log_lines`);
    }
    expect(out.error).toContain("logs");
    const state = storeState();
    expect(state.pendingLogs).toBeGreaterThanOrEqual(1);
    expect(state.lastError).not.toBeNull();
    expect(state.droppedLogs).toBe(0);

    const retry = await flushOpsStore();
    expect(retry.error).toBeNull();
    const messages = (await storedLines(inst)).map((r) => r.message);
    expect(messages).toContain("obs2a.outage");
    // отказ записан в лог предупреждением — и сам дошёл до истории следующей пачкой
    expect(messages).toContain("ops.store.flush_failed");
  });

  test("ошибка данных не повторяется вечно: отброшена одна строка, соседи по пачке записаны", async () => {
    const inst = instanceId();
    log.info("obs2a.good-1");
    // уровень вне перечня — CHECK отвергнет строку
    captureLog("loud" as never, "obs2a.bad", {}, null);
    log.info("obs2a.good-2");
    const out = await flushOpsStore();
    expect(out.error).toContain("logs");
    expect(out.logs).toBe(2);
    expect(storeState().droppedLogs).toBe(1);
    // следующий такт уже чистый: плохая строка не вернулась в очередь
    log.info("obs2a.after-bad");
    expect((await flushOpsStore()).error).toBeNull();
    const messages = (await storedLines(inst)).map((r) => r.message);
    expect(messages).toEqual(expect.arrayContaining(["obs2a.good-1", "obs2a.good-2", "obs2a.after-bad", "ops.store.dropped"]));
    expect(messages).not.toContain("obs2a.bad");
  });

  test("знак NUL в строке не валит пачку: jsonb его не принимает, он вычищается на входе", async () => {
    const inst = instanceId();
    log.info("obs2a.nul", { note: "до\u0000після" });
    expect((await flushOpsStore()).error).toBeNull();
    const [row] = await storedLines(inst);
    expect((row!.fields as { note: string }).note).toBe("допісля");
  });

  test("очередь ограничена: при долгом отказе старое отбрасывается и считается", () => {
    for (let i = 0; i < PENDING_LOG_CAP + 7; i++) captureLog("debug", `obs2a.cap-${i}`, {}, null);
    expect(storeState().pendingLogs).toBe(PENDING_LOG_CAP);
    expect(storeState().droppedLogs).toBe(7);
  });

  test("суммы запросов: минута и час, прибавлением, с поэлементной суммой корзин", async () => {
    const saved = process.env.QUIZZY_VERSION;
    process.env.QUIZZY_VERSION = `obs2a-agg-${crypto.randomUUID().slice(0, 6)}`;
    try {
      const version = releaseTag();
      const at = Date.UTC(2026, 8, 20, 10, 15, 30);
      const base = { method: "GET", route: "/api/obs2a/agg", role: null, requestId: "a" } as const;
      recordRequest({ ...base, code: 200, ms: 3, at });
      recordRequest({ ...base, code: 500, ms: 700, at: at + 60_000 });
      await flushOpsStore();
      recordRequest({ ...base, code: 404, ms: 3, at });
      await flushOpsStore();

      const rows = [
        ...(await db.execute(sql`
          select grain, bucket, count, c4, c5, max_ms, hist from ops_request_aggs
          where version = ${version} order by grain desc, bucket`)),
      ];
      const minute = rows.filter((r) => r.grain === "minute");
      const hour = rows.filter((r) => r.grain === "hour");
      expect(minute).toHaveLength(2);
      expect(Number(minute[0]!.count)).toBe(2);
      expect(Number(minute[0]!.c4)).toBe(1);
      expect(hour).toHaveLength(1);
      expect(Number(hour[0]!.count)).toBe(3);
      expect(Number(hour[0]!.c5)).toBe(1);
      expect(Number(hour[0]!.max_ms)).toBe(700);
      // корзины: два запроса до 5 мс и один в 500–1000
      expect((hour[0]!.hist as number[])[0]).toBe(2);
      expect((hour[0]!.hist as number[])[7]).toBe(1);
      expect(new Date(hour[0]!.bucket as string).toISOString()).toBe(new Date(Date.UTC(2026, 8, 20, 10)).toISOString());
    } finally {
      if (saved === undefined) delete process.env.QUIZZY_VERSION;
      else process.env.QUIZZY_VERSION = saved;
    }
  });

  test("часовая строка — сумма минутных одной пачки", () => {
    const row = (minute: number, count: number) => ({
      minute,
      version: "v",
      method: "GET",
      route: "/r",
      count,
      c4: 0,
      c5: 0,
      sum: count,
      max: 1,
      hist: [count, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    const rows = aggUpsertRows([row(600, 2), row(601, 3), row(660, 4)]);
    const hours = rows.filter((r) => r.grain === "hour");
    expect(hours.map((h) => h.count).sort()).toEqual([4, 5]);
    expect(rows.filter((r) => r.grain === "minute")).toHaveLength(3);
  });
});

describe("ротация по сроку", () => {
  test("старше срока — удалено, моложе — на месте; группа уходит, только не повторяясь весь срок", async () => {
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const tag = crypto.randomUUID().slice(0, 8);
    await db.execute(sql`
      insert into ops_log_lines (instance, seq, at, level, message) values
        (${`rot${tag}`}, 1, ${ago(LOG_RETENTION_DAYS + 1)}, 'info', 'old'),
        (${`rot${tag}`}, 2, ${ago(LOG_RETENTION_DAYS - 1)}, 'info', 'fresh')`);
    await db.execute(sql`
      insert into ops_error_groups (fingerprint, origin, name, message, count, first_at, last_at) values
        (${`old-${tag}`}, 'log', 'x', 'm', 1, ${ago(ERROR_RETENTION_DAYS + 5)}, ${ago(ERROR_RETENTION_DAYS + 1)}),
        (${`live-${tag}`}, 'log', 'x', 'm', 2, ${ago(ERROR_RETENTION_DAYS + 5)}, ${ago(1)})`);
    await db.execute(sql`
      insert into ops_error_hours (fingerprint, hour, count) values
        (${`old-${tag}`}, ${ago(ERROR_RETENTION_DAYS + 1)}, 1),
        (${`live-${tag}`}, ${ago(ERROR_RETENTION_DAYS + 5)}, 1),
        (${`live-${tag}`}, ${ago(1)}, 1)`);
    const agg = (grain: string, bucket: string) =>
      sql`(${grain}, ${bucket}, ${`rot-${tag}`}, 'GET', '/r', 1, 0, 0, 1, 1, '{1,0,0,0,0,0,0,0,0,0,0}')`;
    await db.execute(sql`
      insert into ops_request_aggs (grain, bucket, version, method, route, count, c4, c5, sum_ms, max_ms, hist) values
        ${agg("minute", ago(MINUTE_RETENTION_DAYS + 1))}, ${agg("minute", ago(MINUTE_RETENTION_DAYS - 1))},
        ${agg("hour", ago(HOUR_RETENTION_DAYS + 1))}, ${agg("hour", ago(HOUR_RETENTION_DAYS - 1))}`);

    const out = await rotateOpsStore(now);
    expect(out.logs).toBeGreaterThanOrEqual(1);

    const left = async (q: ReturnType<typeof sql>) => [...(await db.execute(q))].map((r) => String(Object.values(r)[0]));
    expect(await left(sql`select message from ops_log_lines where instance = ${`rot${tag}`}`)).toEqual(["fresh"]);
    expect(await left(sql`select fingerprint from ops_error_groups where fingerprint like ${`%-${tag}`}`)).toEqual([`live-${tag}`]);
    // у живой группы старый час ушёл, свежий остался; у ушедшей — ушли все
    expect(await left(sql`select fingerprint from ops_error_hours where fingerprint like ${`%-${tag}`}`)).toEqual([`live-${tag}`]);
    expect((await left(sql`select grain from ops_request_aggs where version = ${`rot-${tag}`} order by grain`)).sort()).toEqual([
      "hour",
      "minute",
    ]);
  });
});

/* ─────────────────────────── переживание перезапуска ─────────────────────────── */

describe("история переживает перезапуск", () => {
  test("логи: после сброса памяти ленту отдаёт база; без периода — как прежде, только память", async () => {
    const marker = `obs2a-restart-${crypto.randomUUID().slice(0, 8)}`;
    log.warn(marker, { n: 1 });
    log.info(marker, { n: 2 });
    await flushOpsStore();
    resetOpsBuffers();

    const live = await api<OpsLogs>(`/api/ops/logs?q=${marker}`, root.token);
    expect(live.body.items).toEqual([]);

    const hist = await api<OpsLogs>(`/api/ops/logs?q=${marker}&window=24h`, root.token);
    expect(hist.status).toBe(200);
    expect(hist.body.items.map((l) => (l.fields as { n: number }).n)).toEqual([1, 2]);
    expect(hist.body.retentionDays).toBe(LOG_RETENTION_DAYS);
    expect(hist.body.historyUnavailable).toBe(false);
    expect(Date.parse(hist.body.from!)).toBeLessThan(Date.now() - 23 * 3_600_000);

    const warn = await api<OpsLogs>(`/api/ops/logs?q=${marker}&window=24h&level=warn`, root.token);
    expect(warn.body.items.map((l) => l.level)).toEqual(["warn"]);
  });

  test("живой хвост и история склеиваются без дублей", async () => {
    const marker = `obs2a-dup-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) log.info(marker, { i });
    await flushOpsStore(); // эти три — и в базе, и ещё в памяти
    log.info(marker, { i: 3 }); // эта — только в памяти
    const res = await api<OpsLogs>(`/api/ops/logs?q=${marker}&window=1h`, root.token);
    expect(res.body.items.map((l) => (l.fields as { i: number }).i)).toEqual([0, 1, 2, 3]);
    // курсор живого хвоста — номер буфера: следующий опрос берёт только новое
    log.info(marker, { i: 4 });
    const next = await api<OpsLogs>(`/api/ops/logs?q=${marker}&after=${res.body.cursor}`, root.token);
    expect(next.body.items.map((l) => (l.fields as { i: number }).i)).toEqual([4]);
  });

  test("старшие страницы: по курсору, без пропусков и повторов, в том числе через два экземпляра", async () => {
    const marker = `obs2a-page-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) log.info(marker, { i });
    await flushOpsStore();
    resetOpsBuffers(); // другой экземпляр
    for (let i = 3; i < 5; i++) log.info(marker, { i });
    await flushOpsStore();

    const seen: number[] = [];
    let before: string | null | undefined;
    for (let guard = 0; guard < 5; guard++) {
      const page = await api<OpsLogs>(
        `/api/ops/logs?q=${marker}&window=1h&limit=2${before ? `&before=${before}` : ""}`,
        root.token,
      );
      seen.unshift(...page.body.items.map((l) => (l.fields as { i: number }).i));
      before = page.body.older;
      if (!before) break;
    }
    // все пять ровно по разу; порядок между экземплярами — по времени строки
    expect(seen.slice().sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test("ошибки: сохранённые группы сливаются с несохранённым приращением, счёт не двоится", async () => {
    const boom = () => recordError({ error: new Error("obs2a merge boom"), method: "POST", route: "/api/obs2a/merge", requestId: "m" });
    boom();
    boom();
    await flushOpsStore();
    boom(); // ещё в очереди

    const find = async () => {
      const res = await api<OpsErrors>("/api/ops/errors?window=24h", root.token);
      expect(res.status).toBe(200);
      return res.body.items.find((g) => g.message === "obs2a merge boom")!;
    };
    expect((await find()).count).toBe(3);
    await flushOpsStore();
    const flushed = await find();
    expect(flushed.count).toBe(3);
    expect(flushed.totalCount).toBe(3);

    resetOpsBuffers(); // перезапуск: в памяти группы нет
    const live = await api<OpsErrors>("/api/ops/errors", root.token);
    expect(live.body.items.some((g) => g.message === "obs2a merge boom")).toBe(false);
    boom();
    const after = await find();
    expect(after.count).toBe(4);
    expect(after.firstAt).toBe(flushed.firstAt);
  });

  test("период ошибок: давнее не входит в сутки, но входит в 90 дней", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const at = new Date(Date.now() - 20 * DAY).toISOString();
    await db.execute(sql`
      insert into ops_error_groups (fingerprint, origin, name, message, count, first_at, last_at)
      values (${`period-${tag}`}, 'log', 'obs2a.period', ${`period ${tag}`}, 5, ${at}, ${at})`);
    await db.execute(sql`insert into ops_error_hours (fingerprint, hour, count) values (${`period-${tag}`}, ${at}, 5)`);
    const day = await api<OpsErrors>("/api/ops/errors?window=24h", root.token);
    expect(day.body.items.some((g) => g.fingerprint === `period-${tag}`)).toBe(false);
    const quarter = await api<OpsErrors>("/api/ops/errors?window=90d", root.token);
    expect(quarter.body.items.find((g) => g.fingerprint === `period-${tag}`)?.count).toBe(5);
  });

  test("слияние истории — чистая функция: повтор по «экземпляр + номер», порядок новые первыми", () => {
    const l = (instance: string, seq: number, at: string) => ({
      seq,
      at,
      level: "info" as const,
      message: "m",
      requestId: null,
      fields: {},
      instance,
    });
    const stored = [l("a", 2, "2026-09-26T10:00:02.000Z"), l("a", 1, "2026-09-26T10:00:01.000Z")];
    const memory = [l("a", 2, "2026-09-26T10:00:02.000Z"), l("b", 1, "2026-09-26T10:00:03.000Z")];
    const { items, more } = mergeHistory(stored, memory, 10, false);
    expect(items.map((x) => `${x.instance}${x.seq}`)).toEqual(["b1", "a2", "a1"]);
    expect(more).toBe(false);
    expect(mergeHistory(stored, memory, 2, false).more).toBe(true);
    const key = { at: "2026-09-26T10:00:02.000Z", instance: "a", seq: 2 };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
    expect(decodeCursor("junk")).toBeNull();
    expect(compareDesc(key, { ...key, seq: 3 })).toBeGreaterThan(0);
  });

  test("группы ошибок: приращение без сохранённой группы — новая группа за период", () => {
    const g = {
      fingerprint: "f",
      origin: "log" as const,
      name: "n",
      message: "m",
      method: null,
      route: null,
      code: null,
      count: 2,
      firstAt: "2026-09-26T10:00:00.000Z",
      lastAt: "2026-09-26T10:30:00.000Z",
      lastRequestId: "r1",
      frames: [],
    };
    const hour = Date.UTC(2026, 8, 26, 11);
    const pending = [{ ...g, count: 1, firstAt: "2026-09-26T11:05:00.000Z", lastAt: "2026-09-26T11:05:00.000Z", lastRequestId: "r2", hours: [[hour, 1]] as [number, number][] }];
    const merged = mergeErrorGroups([{ ...g, totalCount: 9 }], pending, Date.UTC(2026, 8, 26, 0));
    expect(merged[0]).toMatchObject({ count: 3, totalCount: 10, lastRequestId: "r2", firstAt: g.firstAt });
    // приращение вне периода и без сохранённой группы — не показывается
    expect(mergeErrorGroups([], pending, hour + 3_600_000)).toEqual([]);
  });
});

/* ─────────────────────────── трасса ─────────────────────────── */

describe("трасса запроса", () => {
  test("собирает лог, итог, журнал и SQL одного запроса — и не собирает чужого", async () => {
    const ridA = `trace-a-${crypto.randomUUID()}`;
    const ridB = `trace-b-${crypto.randomUUID()}`;
    const a = await api("/api/users", root.token, { headers: { "x-request-id": ridA } });
    expect(a.status).toBe(200);
    await api("/api/users", root.token, { headers: { "x-request-id": ridB } });
    withRequestId(ridA, () => log.info("obs2a.trace.note", { step: "a" }));

    const res = await api<OpsTrace>(`/api/ops/trace/${ridA}`, root.token);
    expect(res.status).toBe(200);
    const t = res.body;
    expect(t.requestId).toBe(ridA);
    expect(t.lines.every((l) => l.requestId === ridA)).toBe(true);
    expect(t.lines.map((l) => l.message)).toEqual(["request", "obs2a.trace.note"]);
    expect(t.summary).toMatchObject({ method: "GET", route: "/api/users", status: 200, role: "superadmin" });
    expect(t.summary!.sqlCount).toBeGreaterThan(0);

    // журнал: запись этого запроса есть, чужого — нет, и без людей
    expect(t.audit!.map((r) => r.action)).toEqual(["user.list"]);
    expect(Object.keys(t.audit![0]!).sort()).toEqual(["action", "actorRole", "at", "outcome", "resourceType"]);

    // SQL: число совпадает с итогом, тексты — параметрами, без значений
    expect(t.sql!.source).toBe("memory");
    expect(t.sql!.count).toBe(t.summary!.sqlCount!);
    expect(t.sql!.top.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.sql)).not.toContain(root.id);
    expect(JSON.stringify(t)).not.toContain("root@test");
    expect(JSON.stringify(t)).not.toContain(ridB);

    // чтение трассы — в журнал, с номером разбираемого запроса в traced
    const reads = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, root.id), eq(auditLog.action, "ops.trace.read")));
    expect(reads.some((r) => (r.details as { traced?: string }).traced === ridA)).toBe(true);
  });

  test("ошибка запроса — группой; после перезапуска трасса собирается из базы", async () => {
    const rid = `trace-err-${crypto.randomUUID()}`;
    withRequestId(rid, () => {
      const fingerprint = recordError({ error: new TypeError("obs2a trace boom"), method: "POST", route: "/api/obs2a/t", code: 500, requestId: rid });
      log.error("unhandled", { method: "POST", name: "TypeError", fingerprint });
    });
    /*
     * Строка «request» упавшего запроса — как её пишет промежуточный слой:
     * с числом SQL; разбивка SQL у пятисотки сохраняется вместе со строкой.
     */
    rememberRequestSql(rid, { count: 2, totalMs: 3.5, distinct: 1, top: [{ query: "select * from t where x = 'secret'", calls: 2, totalMs: 3.5, maxMs: 2 }] });
    withRequestId(rid, () => log.error("request", { method: "POST", path: "/api/obs2a/t", status: 500, ms: 12, role: "admin", sql: 2, sqlMs: 3.5 }));
    await flushOpsStore();
    resetOpsBuffers();
    resetRequestSql();

    const res = await api<OpsTrace>(`/api/ops/trace/${rid}`, root.token);
    const t = res.body;
    expect(t.lines.map((l) => l.message)).toEqual(["unhandled", "request"]);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toMatchObject({ name: "TypeError", message: "obs2a trace boom", route: "/api/obs2a/t" });
    expect(t.summary).toMatchObject({ status: 500, role: "admin", sqlCount: 2 });
    expect(t.sql).toMatchObject({ source: "stored", count: 2 });
    expect(t.sql!.top[0]!.query).toBe("select * from t where x = ?");
  });

  test("номер началом: однозначный — находится, неоднозначный — список, нет такого — пусто", async () => {
    const stem = `pfx${crypto.randomUUID().slice(0, 8)}`;
    withRequestId(`${stem}-one`, () => log.info("obs2a.prefix"));
    const one = await api<OpsTrace>(`/api/ops/trace/${stem}-o`, root.token);
    expect(one.body.requestId).toBe(`${stem}-one`);
    expect(one.body.lines).toHaveLength(1);

    withRequestId(`${stem}-two`, () => log.info("obs2a.prefix"));
    const many = await api<OpsTrace>(`/api/ops/trace/${stem}`, root.token);
    expect(many.body.lines).toEqual([]);
    expect(many.body.candidates).toEqual([`${stem}-one`, `${stem}-two`]);

    const none = await api<OpsTrace>(`/api/ops/trace/nothing-${crypto.randomUUID()}`, root.token);
    expect(none.body.lines).toEqual([]);
    expect(none.body.summary).toBeNull();
    expect(none.body.audit).toEqual([]);

    expect((await api("/api/ops/trace/bad%20id%3B", root.token)).status).toBe(400);
  });
});

/* ─────────────────────────── выкатки ─────────────────────────── */

describe("сравнение выкаток", () => {
  test("сдвиг: пороги, малые выборки — «замало», а не проценты", () => {
    const s = (requests: number, p95: number | null, errors5xx = 0) => ({
      requests,
      errors5xx,
      share5xx: requests ? errors5xx / requests : null,
      p50: p95,
      p95,
    });
    expect(latencyShift(s(100, 100), s(100, 200))).toBe("worse");
    expect(latencyShift(s(100, 200), s(100, 100))).toBe("better");
    // +50 % на быстром маршруте — не заметно: меньше 50 мс
    expect(latencyShift(s(100, 4), s(100, 6))).toBe("same");
    // +60 мс на медленном — не заметно: меньше четверти
    expect(latencyShift(s(100, 2000), s(100, 2060))).toBe("same");
    expect(latencyShift(s(MIN_SAMPLE - 1, 100), s(100, 900))).toBe("few");
    expect(latencyShift(null, s(100, 100))).toBe("few");

    expect(errorShift(s(100, 10, 0), s(100, 10, ERROR_MIN))).toBe("worse");
    // три запроса, одна пятисотка — 33 %, но это не вывод
    expect(errorShift(s(3, 10, 0), s(3, 10, 1))).toBe("few");
    // доля выросла, но пятисоток меньше порога — тоже нет
    expect(errorShift(s(100, 10, 0), s(100, 10, ERROR_MIN - 1))).toBe("same");
    expect(errorShift(s(100, 10, 5), s(100, 10, 0))).toBe("better");
  });

  test("час до и час после: по минутам, с меткой версии, ухудшения первыми", async () => {
    const saved = process.env.QUIZZY_VERSION;
    const tag = crypto.randomUUID().slice(0, 6);
    const v1 = `obs2a-${tag}-1`;
    const v2 = `obs2a-${tag}-2`;
    const t0 = Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000;
    const req = (route: string, code: number, ms: number, at: number) =>
      recordRequest({ method: "GET", route, code, ms, role: null, requestId: "c", at });
    try {
      process.env.QUIZZY_VERSION = v1;
      for (let i = 0; i < 60; i++) {
        req("/api/obs2a/slow", 200, 20, t0 - (i + 1) * 60_000);
        req("/api/obs2a/err", 200, 20, t0 - (i + 1) * 60_000);
      }
      // за пределами часа до выкатки: в окно «до» не входит
      req("/api/obs2a/slow", 200, 5000, t0 - 90 * 60_000);
      req("/api/obs2a/rare", 200, 10, t0 - 5 * 60_000);
      await flushOpsStore();

      process.env.QUIZZY_VERSION = v2;
      for (let i = 0; i < 60; i++) {
        req("/api/obs2a/slow", 200, 400, t0 + i * 60_000);
        req("/api/obs2a/err", i % 10 === 0 ? 500 : 200, 20, t0 + i * 60_000);
      }
      req("/api/obs2a/rare", 200, 900, t0 + 5 * 60_000);
      // за пределами часа после: не входит
      req("/api/obs2a/err", 500, 20, t0 + 70 * 60_000);
      await flushOpsStore();
    } finally {
      if (saved === undefined) delete process.env.QUIZZY_VERSION;
      else process.env.QUIZZY_VERSION = saved;
    }

    const list = await api<OpsReleases>("/api/ops/releases", root.token);
    const versions = list.body.items.map((r) => r.version);
    expect(versions.indexOf(v2)).toBeLessThan(versions.indexOf(v1));
    expect(list.body.items.find((r) => r.version === v2)!.firstAt).toBe(new Date(t0).toISOString());

    const res = await api<OpsReleaseCompare>(`/api/ops/releases/compare?before=${v1}&after=${v2}`, root.token);
    expect(res.status).toBe(200);
    const c = res.body;
    expect(c.grain).toBe("minute");
    expect(c.windowMin).toBe(COMPARE_WINDOW_MIN);
    expect(c.before).toMatchObject({ version: v1, from: new Date(t0 - 3_600_000).toISOString(), to: new Date(t0).toISOString() });
    expect(c.after).toMatchObject({ version: v2, from: new Date(t0).toISOString() });
    const by = Object.fromEntries(c.items.map((i) => [i.route, i]));
    expect(by["/api/obs2a/slow"]!.before!.requests).toBe(60);
    expect(by["/api/obs2a/slow"]!.latency).toBe("worse");
    expect(by["/api/obs2a/err"]!.errors).toBe("worse");
    expect(by["/api/obs2a/err"]!.after!.errors5xx).toBe(6);
    expect(by["/api/obs2a/err"]!.latency).toBe("same");
    expect(by["/api/obs2a/rare"]!.latency).toBe("few");
    expect(by["/api/obs2a/rare"]!.errors).toBe("few");
    // ухудшения — первыми
    expect(["/api/obs2a/slow", "/api/obs2a/err"]).toContain(c.items[0]!.route);
    expect(c.thresholds.minSample).toBe(MIN_SAMPLE);
  });

  test("старая выкатка без минутных сумм — по часам, и ответ говорит об этом", async () => {
    const tag = crypto.randomUUID().slice(0, 6);
    const h0 = Math.floor((Date.now() - 30 * DAY) / 3_600_000) * 3_600_000;
    const row = (version: string, bucket: number, count: number, p: number) =>
      sql`('hour', ${new Date(bucket).toISOString()}, ${version}, 'GET', '/api/obs2a/h', ${count}, 0, 0, ${count * 10}, ${p},
           ${`{${[0, 0, 0, count, 0, 0, 0, 0, 0, 0, 0].join(",")}}`}::int[])`;
    await db.execute(sql`
      insert into ops_request_aggs (grain, bucket, version, method, route, count, c4, c5, sum_ms, max_ms, hist) values
        ${row(`old-${tag}-1`, h0 - 2 * 3_600_000, 50, 40)},
        ${row(`old-${tag}-1`, h0 - 3_600_000, 50, 40)},
        ${row(`old-${tag}-2`, h0, 50, 40)}`);
    const c = await compareReleases({ before: `old-${tag}-1`, after: `old-${tag}-2` });
    expect(c.grain).toBe("hour");
    expect(c.before).toMatchObject({ from: new Date(h0 - 3_600_000).toISOString(), to: new Date(h0).toISOString(), requests: 50 });
    expect(c.items[0]).toMatchObject({ route: "/api/obs2a/h", latency: "same" });
  });

  test("без данных — пустое сравнение, а не ошибка", async () => {
    const empty: Probe = async () => [];
    const c = await compareReleases({}, empty);
    expect(c.items).toEqual([]);
    expect(c.failed).toBe(false);
    const l = await listReleases(empty);
    expect(l.items).toEqual([]);
  });
});

/* ─────────────────────────── pg_stat_statements ─────────────────────────── */

describe("медленные SQL", () => {
  const fail = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

  test("живая база: раздел отвечает состоянием, а не пятисоткой", async () => {
    const res = await api<OpsStatements>("/api/ops/statements?sort=calls", root.token);
    expect(res.status).toBe(200);
    expect(["ok", "notInstalled", "notLoaded", "denied"]).toContain(res.body.state);
    expect(res.body.sort).toBe("calls");
    if (res.body.state !== "ok") expect(res.body.items).toEqual([]);
    expect((await api("/api/ops/statements?sort=loud", root.token)).status).toBe(400);
  });

  test("расширения нет, не загружено, нет прав — каждое своим состоянием", async () => {
    const notInstalled: Probe = async () => [];
    expect((await collectStatements("total", notInstalled)).state).toBe("notInstalled");

    const notLoaded: Probe = async (q) => {
      const text = textOf(q);
      if (text.includes("pg_extension")) return [{ extversion: "1.10" }];
      throw fail("55000");
    };
    expect((await collectStatements("total", notLoaded)).state).toBe("notLoaded");

    const denied: Probe = async (q) => {
      if (textOf(q).includes("pg_extension")) return [{ extversion: "1.10" }];
      throw fail("42501");
    };
    const d = await collectStatements("mean", denied);
    expect(d).toMatchObject({ state: "denied", sort: "mean", items: [] });
  });

  test("есть данные: доля от общего времени, скрытые чужие, литералы вычищены", async () => {
    const probe: Probe = async (q) => {
      const text = textOf(q);
      if (text.includes("pg_extension")) return [{ extversion: "1.10" }];
      if (text.includes("filter")) return [{ hidden: 4, total: 1000 }];
      if (text.includes("pg_stat_statements_info")) return [{ stats_reset: "2026-09-01T00:00:00Z" }];
      return [
        { id: "-42", calls: "10", total_exec_time: 600, mean_exec_time: 60, rows: "10", query: "select * from users where email = $1" },
        { id: "7", calls: "1", total_exec_time: 400, mean_exec_time: 400, rows: "0", query: "alter role x password 'hunter2'" },
      ];
    };
    const out = await collectStatements("total", probe);
    expect(out.state).toBe("ok");
    expect(out.hidden).toBe(4);
    expect(out.statsSince).toBe("2026-09-01T00:00:00.000Z");
    expect(out.items[0]).toMatchObject({ id: "-42", calls: 10, totalMs: 600, share: 0.6 });
    expect(out.items[1]!.query).toBe("alter role x password ?");
  });

  test("план: без ANALYZE, общий для $1, ничего не выполняет", async () => {
    const lookup =
      (query: string): Probe =>
      async (q) => {
        if (textOf(q).includes("server_version_num")) return (await liveProbe(q)) as never;
        return [{ query }];
      };
    const plan = await explainStatement("123", lookup("select id from users where email = $1"));
    expect(plan.state).toBe("ok");
    expect(plan.generic).toBe(true);
    expect(plan.plan!.join("\n")).toMatch(/users/);

    // вставка объясняется, но не выполняется
    const groups = async () => Number([...(await db.execute(sql`select count(*)::int as n from ops_error_groups`))][0]?.n);
    const before = await groups();
    const ins = await explainStatement(
      "124",
      lookup("insert into ops_error_groups (fingerprint, origin, name, message, first_at, last_at) values ($1, $2, $3, $4, now(), now())"),
    );
    expect(ins.state).toBe("ok");
    expect(await groups()).toBe(before);

    // второй оператор, служебная команда, комментарий в начале — отказ
    expect((await explainStatement("1", lookup("select 1; delete from users"))).state).toBe("refused");
    expect((await explainStatement("1", lookup("vacuum full users"))).state).toBe("refused");
    expect(explainable("/* x */ select 1")).toBeNull();
    expect(explainable("select 1;")).toBe("select 1");
    expect((await explainStatement("not-a-number", lookup("select 1"))).state).toBe("notFound");
    expect((await explainStatement("1", async () => [])).state).toBe("notFound");

    // сам выполнитель — в транзакции только для чтения
    await expect(liveExplainer("select 1", false)).resolves.toBeArray();
  });

  test("план через маршрут: без загруженного расширения — «недоступно», и в журнал", async () => {
    const dev = await makeDeveloper("plan");
    const res = await api<OpsStatementPlan>("/api/ops/statements/42/plan", dev.token);
    expect(res.status).toBe(200);
    expect(["unavailable", "notFound", "denied"]).toContain(res.body.state);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, dev.id), eq(auditLog.action, "ops.statements.explain")));
    expect(rows).toHaveLength(1);
  });
});
