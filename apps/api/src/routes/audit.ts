import { Hono } from "hono";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { auditQuery, type AuditPage } from "@quizzy/shared";
import { parseQuery } from "../lib/http";
import { db } from "../db";
import { auditLog } from "../db/schema";
import { audit } from "../lib/audit";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const auditRoutes = new Hono<AppEnv>();

// журнал доступа читает только суперадмин
/*
 * Журнал доступа — под правом, а не под ролью: читать его должен и тот, кто
 * разбирает обходы правил, не будучи суперадмином. Сегодня audit.read есть
 * только у суперадмина, и поведение не меняется.
 */
auditRoutes.use("*", requireAuth, requireStaff, requirePermission("audit.read"));

/**
 * Чтение журнала. Записи только читаются: методов правки и удаления нет
 * намеренно — журнал append-only.
 *
 * Само чтение журнала тоже журналируется.
 */
auditRoutes.get("/", async (c) => {
  const { limit, offset, action, actorId, subjectUserId, from, to } = parseQuery(c, auditQuery);

  const filters: SQL[] = [];
  if (action) filters.push(eq(auditLog.action, action));
  if (actorId) filters.push(eq(auditLog.actorId, actorId));
  if (subjectUserId) filters.push(eq(auditLog.subjectUserId, subjectUserId));
  if (from) filters.push(gte(auditLog.at, from));
  if (to) filters.push(lte(auditLog.at, to));
  const where = filters.length ? and(...filters) : undefined;

  const [entries, [{ total } = { total: 0 }]] = await Promise.all([
    db.select().from(auditLog).where(where).orderBy(desc(auditLog.at)).limit(limit).offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(auditLog).where(where),
  ]);

  await audit(c, {
    action: "audit.read",
    details: { filters: { action, actorId, subjectUserId, from, to }, returned: entries.length },
  });

  const page: AuditPage = {
    entries: entries as AuditPage["entries"],
    total: Number(total ?? 0),
    offset,
    limit,
  };
  return c.json(page);
});

/** Сводка по журналу: какие действия и кто чаще всего */
auditRoutes.get("/summary", async (c) => {
  const byAction = await db
    .select({ action: auditLog.action, count: sql<number>`count(*)` })
    .from(auditLog)
    .groupBy(auditLog.action)
    .orderBy(desc(sql`count(*)`));

  const byActor = await db
    .select({ actorEmail: auditLog.actorEmail, count: sql<number>`count(*)` })
    .from(auditLog)
    .groupBy(auditLog.actorEmail)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const [{ denied } = { denied: 0 }] = await db
    .select({ denied: sql<number>`count(*)` })
    .from(auditLog)
    .where(eq(auditLog.outcome, "denied"));

  await audit(c, { action: "audit.read", details: { view: "summary" } });

  return c.json({
    byAction: byAction.map((r) => ({ action: r.action, count: Number(r.count) })),
    byActor: byActor.map((r) => ({ actorEmail: r.actorEmail ?? "—", count: Number(r.count) })),
    deniedCount: Number(denied ?? 0),
  });
});

/**
 * Проверка цепочки журнала. Головной хэш из отчёта стоит время от времени
 * записывать вовне (распечатать, отправить) — тогда подделка даже всей
 * таблицы целиком обнаружима сверкой с внешней копией.
 */
auditRoutes.get("/verify", async (c) => {
  const { verifyChain } = await import("../lib/auditVerify");
  const report = await verifyChain();
  return c.json(report, report.ok ? 200 : 409);
});
