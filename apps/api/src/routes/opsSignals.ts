import { Hono, type Context } from "hono";
import { z } from "zod";
import type {
  OpsAlertHistory,
  OpsAlertRuleKey,
  OpsAlerts,
  OpsClientErrors,
  OpsRecordings,
  OpsVitals,
} from "@quizzy/shared";
import { baseDb } from "../db";
import { asSystem, dbContext, systemContext } from "../db/context";
import { audit } from "../lib/audit";
import { readToken } from "../lib/auth";
import { badRequestDetail, conflict, notFound, parseBody } from "../lib/http";
import { log } from "../lib/log";
import {
  ALERT_RULE_KEYS,
  alertCheckerInfo,
  alertHistory,
  channelsInfo,
  listRules,
  sendTestAlert,
  updateRule,
  validateRuleInput,
} from "../lib/opsAlerts";
import {
  LIMITS,
  clientErrorBatchSchema,
  clientErrorsReport,
  recordClientErrors,
  recordVitals,
  vitalBatchSchema,
  vitalsReport,
} from "../lib/opsClient";
import { isRunnable, startManual } from "../lib/opsJobs";
import { registerManualJobs } from "../lib/opsManual";
import { recordingsReport, retryRecording } from "../lib/opsRecordings";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Техпанель, участок obs2b: сигналы и клиент.
 *
 *   — «Сповіщення»: правила оповещений, каналы, история (lib/opsAlerts.ts);
 *   — «Помилки клієнта» и «Швидкість екранів»: приём с клиента и сводки
 *     (lib/opsClient.ts);
 *   — «Записи прийомів»: хранилище и очередь расшифровки (lib/opsRecordings.ts);
 *   — «Запустити зараз» у фоновых задач (lib/opsManual.ts, реестр opsJobs).
 *
 * Два набора маршрутов, и порядок их подключения в app.ts важен.
 *
 * Приём телеметрии (opsIntakeRoutes) открыт без проверки сотрудника:
 * ошибки шлёт и кабинет пациента, и экран входа, у которого учётки нет
 * вовсе. Остальная техпанель под /api/ops закрыта промежуточным слоем
 * `use("*")` (routes/ops.ts), и он встал бы перед приёмом, если бы приём был
 * подключён позже. Поэтому приём подключается ПЕРВЫМ под /api/ops: его
 * обработчик отвечает сам и дальше по цепочке запрос не пускает.
 *
 * Читающие и управляющие маршруты (opsSignalRoutes) несут свои заслоны
 * каждый — requireAuth, requireStaff, ops.read и, где меняют систему,
 * ops.manage, — а не общий `use("*")`: общий слой на /api/ops лёг бы и на
 * чужие маршруты техпанели, и каждый запрос проходил бы проверку входа
 * дважды.
 */

registerManualJobs();

/* ─────────── приём с клиента ─────────── */

export const opsIntakeRoutes = new Hono<AppEnv>();

/**
 * Адрес отправителя для ограничения частоты.
 *
 * Последний адрес X-Forwarded-For, а не первый: первый присылает сам
 * клиент (и подделывает, чтобы обойти лимит), последний дописал наш прокси
 * (Caddy). Без прокси — адрес соединения от Bun; в тестах нет ни того, ни
 * другого, и все анонимы делят одно окно — то, что тесту и нужно.
 */
function senderIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",").at(-1)!.trim();
  const real = c.req.header("X-Real-IP");
  if (real) return real.trim();
  const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

/**
 * Кто прислал: подпись токена, без похода в базу.
 *
 * Учётка здесь нужна только для лимита «на человека», а не для прав: права
 * на приём не нужны никому. Полная проверка входа (requireAuth) сходила бы
 * в базу на каждую пачку и вдобавок отказывала бы учётке «только
 * просмотр» — с записью в журнал о каждом отказе: демонстрационная учётка
 * засыпала бы журнал строками «доступ запрещён» раз в десять секунд.
 */
async function sender(c: Context): Promise<string | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const claims = await readToken(header.slice("Bearer ".length).trim());
  return claims?.sub ?? null;
}

function tooMany(c: Context, retryAfter: number) {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: "too many reports", retryAfterSec: retryAfter }, 429);
}

opsIntakeRoutes.post("/client-errors", async (c) => {
  const who = await sender(c);
  const { items } = await parseBody(c.req.raw, clientErrorBatchSchema);
  const key = who ? `u:${who}` : `ip:${senderIp(c)}`;
  const limiter = who ? LIMITS.user : LIMITS.anon;
  if (items.length > (who ? LIMITS.userBatch : LIMITS.anonBatch)) {
    badRequestDetail(`items: не больше ${who ? LIMITS.userBatch : LIMITS.anonBatch} в пачке`);
  }
  if (!limiter.take(key, items.length)) return tooMany(c, limiter.retryAfterSec(key));
  if (!LIMITS.global.take("all", items.length)) return tooMany(c, LIMITS.global.retryAfterSec("all"));

  const result = await systemContext(baseDb, () => recordClientErrors(items));
  if (result.rejected) log.warn("ops.client_errors.rejected", { rejected: result.rejected, signedIn: Boolean(who) });
  return c.json(result, 202);
});

opsIntakeRoutes.post("/vitals", async (c) => {
  const who = await sender(c);
  if (!who) return c.json({ error: "sign in required" }, 401);
  const { items } = await parseBody(c.req.raw, vitalBatchSchema);
  const key = `u:${who}`;
  if (!LIMITS.vitals.take(key, items.length)) return tooMany(c, LIMITS.vitals.retryAfterSec(key));
  const result = await systemContext(baseDb, () => recordVitals(items));
  return c.json(result, 202);
});

/* ─────────── техпанель ─────────── */

export const opsSignalRoutes = new Hono<AppEnv>();

const canRead = requirePermission("ops.read");
const canManage = requirePermission("ops.manage");

/**
 * Чтение групп ошибок клиента — в журнал, как ошибки сервера
 * (routes/ops.ts, ops.errors.read), и с той же склейкой: одна запись на
 * человека в пять минут, иначе опрос вкладки топил бы журнал.
 */
const READ_COALESCE_MS = 5 * 60_000;
const lastRead = new Map<string, number>();

async function auditClientErrorsRead(c: Context<AppEnv>, returned: number): Promise<void> {
  const key = c.get("user").id;
  const now = Date.now();
  const prev = lastRead.get(key);
  if (prev !== undefined && now - prev < READ_COALESCE_MS) return;
  lastRead.set(key, now);
  if (lastRead.size > 2000) for (const [k, at] of lastRead) if (now - at >= READ_COALESCE_MS) lastRead.delete(k);
  await audit(c, { action: "ops.client_errors.read", details: { returned, coalesceSec: READ_COALESCE_MS / 1000 } });
}

/** Только для тестов */
export function resetClientErrorsReadCoalescing(): void {
  lastRead.clear();
}

/* ── сповіщення ── */

opsSignalRoutes.get("/alerts", requireAuth, requireStaff, canRead, async (c) => {
  const body: OpsAlerts = await asSystem(async () => ({
    rules: await listRules(),
    channels: await channelsInfo(),
    checker: alertCheckerInfo(),
    diskOf: "RECORDINGS_DIR",
  }));
  return c.json(body);
});

opsSignalRoutes.get("/alerts/history", requireAuth, requireStaff, canRead, async (c) => {
  const body: OpsAlertHistory = { items: await asSystem(() => alertHistory(100)) };
  return c.json(body);
});

const ruleInput = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().finite().nullable().optional(),
    windowMin: z.number().int().nullable().optional(),
    repeatMin: z.number().int().optional(),
    channels: z.array(z.enum(["telegram", "email"])).max(2).optional(),
  })
  .strict();

opsSignalRoutes.put("/alerts/rules/:key", requireAuth, requireStaff, canRead, canManage, async (c) => {
  const key = c.req.param("key") as OpsAlertRuleKey;
  if (!ALERT_RULE_KEYS.includes(key)) notFound("err.opsRuleNotFound");
  const input = await parseBody(c.req.raw, ruleInput);
  const bad = validateRuleInput(key, input);
  if (bad) badRequestDetail(`${bad}: значение вне допустимого для правила ${key}`);
  const rule = await asSystem(() => updateRule(key, input, c.get("user").id));
  if (!rule) notFound("err.opsRuleNotFound");
  await audit(c, { action: "ops.alerts.rule_update", resourceType: "ops_alert_rule", resourceId: key, details: { ...input } });
  return c.json(rule);
});

const testInput = z.object({ channel: z.enum(["telegram", "email"]) }).strict();

opsSignalRoutes.post("/alerts/test", requireAuth, requireStaff, canRead, canManage, async (c) => {
  const { channel } = await parseBody(c.req.raw, testInput);
  const delivery = await sendTestAlert(channel);
  await audit(c, { action: "ops.alerts.test", resourceType: "ops_alert_channel", resourceId: channel, details: { outcome: delivery.outcome } });
  return c.json(delivery);
});

/* ── помилки клієнта, швидкість екранів ── */

opsSignalRoutes.get("/client-errors", requireAuth, requireStaff, canRead, async (c) => {
  const body: OpsClientErrors = await asSystem(() => clientErrorsReport());
  await auditClientErrorsRead(c, body.items.length);
  return c.json(body);
});

const vitalsQuery = z.object({ days: z.coerce.number().int().min(7).max(30).default(30) });

opsSignalRoutes.get("/vitals", requireAuth, requireStaff, canRead, async (c) => {
  const parsed = vitalsQuery.safeParse(c.req.query());
  if (!parsed.success) badRequestDetail("days: от 7 до 30");
  const body: OpsVitals = await asSystem(() => vitalsReport(new Date(), parsed.data.days));
  return c.json(body);
});

/* ── записи прийомів ── */

opsSignalRoutes.get("/recordings", requireAuth, requireStaff, canRead, async (c) => {
  const body: OpsRecordings = await asSystem(() => recordingsReport());
  return c.json(body);
});

opsSignalRoutes.post("/recordings/:id/retry", requireAuth, requireStaff, canRead, canManage, async (c) => {
  const id = c.req.param("id");
  const outcome = await asSystem(() => retryRecording(id));
  if (outcome === "notFound") notFound("err.opsRecordingNotFound");
  if (outcome === "notRetryable") conflict("err.opsRecordingNotRetryable");
  /*
   * В журнал — идентификатор записи и ничего о человеке: разработчик с
   * ops.read пациентов не видит, и его действие описывается тем, что он
   * видел, — номером задания.
   */
  await audit(c, { action: "ops.recording.retry", resourceType: "visit_recording", resourceId: id });
  return c.json({ ok: true });
});

/* ── ручной запуск фоновой задачи ── */

opsSignalRoutes.post("/jobs/:name/run", requireAuth, requireStaff, canRead, canManage, async (c) => {
  const name = c.req.param("name");
  if (!isRunnable(name)) notFound("err.opsJobNotFound");
  /*
   * Проход — фоном и вне транзакции запроса. Промис, заведённый внутри
   * обработчика, наследует контекст базы запроса (AsyncLocalStorage), а эта
   * транзакция закроется вместе с ответом: всё, что задача сделала бы
   * «в ней», упало бы на закрытом соединении. exit() отвязывает проход от
   * запроса; свою транзакцию задача открывает сама (systemContext).
   */
  const outcome = dbContext.exit(() =>
    startManual(name, (error) => log.error("ops.manual.failed", { job: name, error: String(error) })),
  );
  if (outcome === "running") conflict("err.opsJobRunning");
  await audit(c, { action: "ops.job.run", resourceType: "ops_job", resourceId: name });
  return c.json({ started: true }, 202);
});
