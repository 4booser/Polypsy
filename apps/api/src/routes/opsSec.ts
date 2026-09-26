import { Hono } from "hono";
import { z } from "zod";
import type { OpsKeysReport, OpsSqlInfo, OpsSqlResult } from "@quizzy/shared";
import { asSystem } from "../db/context";
import { audit } from "../lib/audit";
import { parseBody } from "../lib/http";
import { auditChainReport, integrityState, recordCheck, reportChainBroken, rlsReport } from "../lib/integrity";
import { keyInventory } from "../lib/keyInventory";
import { latestReencrypt, startReencrypt } from "../lib/keyRotation";
import { runPhoneReindex } from "../lib/phoneReindex";
import { checkRls } from "../lib/rlsGuard";
import { observeSecrets, secretStatuses } from "../lib/secretMarks";
import { runReadOnly, screenQuery, SQL_MAX_ROWS, SQL_TIMEOUT_MS } from "../lib/sqlConsole";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

/**
 * Техпанель, участок безопасности: «Ключі й секрети», «Цілісність»,
 * «SQL (читання)».
 *
 * Все три раздела — только суперадмину, и проверка здесь, на сервере, а не
 * скрытием пункта на экране. Решение заказчика 2026-09-26: самое опасное в
 * панели (SQL-консоль, ротация ключей) не выдаётся НИКАКИМ правом — ни
 * ops.read, ни ops.manage, ни исключением. Право однажды выдают «на
 * неделю, для разбора» и забывают снять; роль суперадмина так не раздают.
 * «Цілісність» закрыта так же: её отчёт — карта того, где в базе нет
 * защиты, то есть готовый план для того, кто ищет, куда идти.
 *
 * Отказ пишется в журнал самим requireSuperadmin (access.denied).
 */
export const opsSecRoutes = new Hono<AppEnv>();

opsSecRoutes.use("*", requireAuth, requireSuperadmin);

/* ═══════════ Ключі й секрети ═══════════ */

/**
 * Опись ключей и секретов. Считается системной ролью (asSystem): записи
 * приёма по политике видны только двоим участникам, и опись от имени
 * суперадмина недосчитала бы именно их.
 */
opsSecRoutes.get("/keys", async (c) => {
  const report = await asSystem(async (): Promise<OpsKeysReport> => {
    // отметить смену секрета, если планировщик её ещё не видел (dev без планировщика)
    await observeSecrets();
    const inventory = await keyInventory();
    return {
      ...inventory,
      job: await latestReencrypt(),
      secrets: await secretStatuses(),
      countedAt: new Date().toISOString(),
    };
  });
  return c.json(report);
});

/** Ход последней перешифровки — экран опрашивает его, пока проход идёт */
opsSecRoutes.get("/keys/job", async (c) => {
  return c.json({ job: await latestReencrypt() });
});

/**
 * Перешифровать на основной ключ: всё открытое и всё на других ключах.
 * Отвечает сразу; проход идёт в фоне порциями.
 */
opsSecRoutes.post("/keys/reencrypt", async (c) => {
  const user = c.get("user");
  const outcome = await startReencrypt({ id: user.id, email: user.email });
  /*
   * Отказы — 409 с признаком, а не текстом: экран до них и не доводит (кнопка
   * погашена без ключа и во время прохода), а назвать причину своими словами
   * он умеет по признаку.
   */
  if (!outcome.started) {
    return c.json({ job: outcome.reason === "running" ? outcome.job : null, outcome: outcome.reason }, 409);
  }
  await audit(c, {
    action: "sec.reencrypt_start",
    resourceType: "security_job",
    resourceId: outcome.job.id,
    details: { targetKey: outcome.job.targetKey, total: outcome.job.total },
  });
  return c.json({ job: outcome.job, outcome: "started" }, 202);
});

/**
 * Пересчитать слепой индекс телефонов под текущий PHONE_INDEX_SECRET —
 * обязательный шаг после его ротации. Синхронно: это один проход по
 * учётным записям, минуты не займёт.
 */
opsSecRoutes.post("/keys/reindex-phones", async (c) => {
  const report = await asSystem(() => runPhoneReindex());
  await audit(c, {
    action: "sec.phone_reindex",
    resourceType: "users",
    outcome: report.unreadable ? "error" : "success",
    details: { ...report },
  });
  return c.json(report);
});

/* ═══════════ Цілісність ═══════════ */

opsSecRoutes.get("/integrity", async (c) => {
  return c.json(await integrityState());
});

opsSecRoutes.post("/integrity/rls", async (c) => {
  const user = c.get("user");
  const report = await rlsReport();
  await recordCheck("rls", "manual", report.ok, report, user.id);
  await audit(c, {
    action: "sec.rls_check",
    resourceType: "database",
    outcome: report.ok ? "success" : "error",
    details: {
      ok: report.ok,
      role: report.role,
      bypasses: report.bypasses,
      policiesWithoutRls: report.policiesWithoutRls.length,
      personTablesWithoutRls: report.personTablesWithoutRls.length,
    },
  });
  return c.json(report);
});

opsSecRoutes.post("/integrity/audit", async (c) => {
  const user = c.get("user");
  const report = await auditChainReport();
  await recordCheck("audit_chain", "manual", report.ok, report, user.id);
  if (report.ok) {
    await audit(c, {
      action: "sec.audit_check",
      resourceType: "audit_log",
      details: { trigger: "manual", ok: true, checked: report.checked, headSeq: report.headSeq },
    });
  } else {
    await reportChainBroken(report, "manual");
  }
  return c.json(report);
});

/* ═══════════ SQL (читання) ═══════════ */

/**
 * Под какой ролью пойдёт запрос — экран говорит это прямо, до первого
 * запроса. Роль — та же, что у приложения, и именно её проверяет сторож
 * политик: если приложение ходит владельцем, консоль видит все строки.
 */
opsSecRoutes.get("/sql", async (c) => {
  const status = await checkRls();
  const info: OpsSqlInfo = {
    role: status.role,
    bypassesRls: status.bypasses,
    rlsReason: status.reason,
    maxRows: SQL_MAX_ROWS,
    timeoutMs: SQL_TIMEOUT_MS,
  };
  return c.json(info);
});

const sqlQuerySchema = z.object({
  query: z.string().max(40_000),
  /**
   * Причина обязательна и пишется словами — как у исключения в правах.
   * Запрос без причины в журнале через год читается как «кто-то зачем-то
   * смотрел базу», и отличить разбор инцидента от любопытства будет нечем.
   */
  reason: z.string().trim().min(3).max(500),
});

/**
 * Выполнить запрос на чтение. Каждый — строка журнала: текст, причина,
 * число строк, исход. Отказ разбора и ошибка базы — тоже строка журнала:
 * попытка записать через консоль интереснее удачного чтения.
 */
opsSecRoutes.post("/sql", async (c) => {
  const user = c.get("user");
  const { query, reason } = await parseBody(c.req.raw, sqlQuerySchema);

  const screened = screenQuery(query);
  const result: OpsSqlResult = screened.ok
    ? await runReadOnly(screened.text, { userId: user.id })
    : { status: "refused", code: screened.code, detail: screened.detail };

  await audit(c, {
    action: "sec.sql_query",
    resourceType: "database",
    outcome: result.status === "ok" ? "success" : result.status === "refused" ? "denied" : "error",
    details: {
      reason,
      query: query.slice(0, 10_000),
      ...(result.status === "ok"
        ? { rows: result.rowCount, truncated: result.truncated, ms: result.ms }
        : result.status === "refused"
          ? { refused: result.code }
          : { error: result.code, ms: result.ms }),
    },
  });
  return c.json(result);
});
