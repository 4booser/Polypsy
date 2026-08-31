import { Hono } from "hono";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { breakGlass, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { accessiblePatientIds, isSuperadmin } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const breakGlassRoutes = new Hono<AppEnv>();
breakGlassRoutes.use("*", requireAuth, requireStaff);

/**
 * «Разбить стекло»: доступ вне своей группы в неотложной ситуации.
 *
 * Раньше доступ либо был, либо нет. В кризисе это плохо: человек поступает
 * ночью, его карта в чужой группе, и дежурный либо ждёт до утра, либо кто-то
 * раздаёт права насовсем — и они остаются навсегда.
 *
 * Устройство намеренно неудобное ровно в одном месте: обоснование обязательно
 * и пишется словами. Всё остальное быстро — одно нажатие, доступ сразу.
 * Замедлять сам доступ значит наказывать за неотложность; замедлять отчёт о
 * нём — нет.
 *
 * Тихого варианта нет: запись в журнале с отдельным действием, доступ виден
 * всем сотрудникам, срок ограничен. Тихий обход правил — это не обход, а дыра.
 */

/**
 * Сколько живёт доступ.
 *
 * Восемь часов — смена. Меньше значило бы, что дежурный посреди разбора
 * упирается в закрытую дверь и разбивает стекло второй раз; больше — что
 * доступ переживает того, кто его брал.
 */
const WINDOW_HOURS = 8;

const openSchema = z.object({
  patientId: z.string(),
  /*
   * Не выпадающий список причин. Список превращается в «выбрать первое», а
   * написанное словами обоснование читают — и его пишет тот, кто отвечает.
   */
  reason: z.string().min(10).max(500),
});

breakGlassRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, openSchema);

  const patient = await db.query.users.findFirst({ where: eq(users.id, input.patientId) });
  if (!patient) notFound("err.patientNotFound");
  if (patient!.role !== "user") badRequest("err.breakGlassPatientOnly");

  /*
   * Если доступ и так есть — отказ. Иначе запись «разбил стекло» появлялась бы
   * там, где ничего не обходили, и в журнале стало бы невозможно отличить
   * настоящий обход от привычки нажимать кнопку.
   */
  const allowed = await accessiblePatientIds(user);
  if (!allowed || allowed.has(input.patientId)) {
    badRequest("err.alreadyHasAccess");
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + WINDOW_HOURS * 3_600_000).toISOString();
  await db.insert(breakGlass).values({
    id,
    actorId: user.id,
    patientId: input.patientId,
    reason: input.reason,
    expiresAt,
  });

  await audit(c, {
    action: "breakglass.open",
    resourceType: "user",
    resourceId: input.patientId,
    subjectUserId: input.patientId,
    details: { reason: input.reason, expiresAt },
  });

  return c.json({ id, expiresAt, windowHours: WINDOW_HOURS }, 201);
});

/** Свои открытые доступы — для обратного отсчёта на экране */
breakGlassRoutes.get("/mine", async (c) => {
  const user = c.get("user");
  const now = new Date().toISOString();

  const rows = await db
    .select({ row: breakGlass, patient: users })
    .from(breakGlass)
    .leftJoin(users, eq(users.id, breakGlass.patientId))
    .where(
      and(eq(breakGlass.actorId, user.id), isNull(breakGlass.revokedAt), gt(breakGlass.expiresAt, now)),
    )
    .orderBy(desc(breakGlass.grantedAt));

  return c.json({
    items: rows.map((r) => ({
      id: r.row.id,
      patientId: r.row.patientId,
      patientName: r.patient ? fullNameOf(r.patient) : "—",
      reason: r.row.reason,
      grantedAt: r.row.grantedAt,
      expiresAt: r.row.expiresAt,
    })),
  });
});

/**
 * Все случаи — для разбора.
 *
 * Видны всем сотрудникам, а не только суперадмину: смысл механизма в
 * громкости. Обход правил, о котором знает один человек, ничем не лучше
 * тихого.
 */
breakGlassRoutes.get("/", async (c) => {
  const rows = await db
    .select({ row: breakGlass, patient: users })
    .from(breakGlass)
    .leftJoin(users, eq(users.id, breakGlass.patientId))
    .orderBy(desc(breakGlass.grantedAt))
    .limit(200);

  const actors = await db.select().from(users);
  const nameOf = new Map(actors.map((u) => [u.id, fullNameOf(u)]));

  return c.json({
    items: rows.map((r) => ({
      id: r.row.id,
      actorId: r.row.actorId,
      actorName: nameOf.get(r.row.actorId) ?? "—",
      patientName: r.patient ? fullNameOf(r.patient) : "—",
      reason: r.row.reason,
      grantedAt: r.row.grantedAt,
      expiresAt: r.row.expiresAt,
      revokedAt: r.row.revokedAt,
    })),
  });
});

/** Закрыть доступ досрочно: свой — сам, чужой — суперадмин */
breakGlassRoutes.post("/:id/close", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const row = await db.query.breakGlass.findFirst({ where: eq(breakGlass.id, id) });
  if (!row) notFound("err.breakGlassNotFound");
  if (row!.actorId !== user.id && !isSuperadmin(user)) {
    badRequest("err.closeOthersSuperadminOnly");
  }

  await db
    .update(breakGlass)
    .set({ revokedAt: new Date().toISOString(), revokedBy: user.id })
    .where(eq(breakGlass.id, id));

  await audit(c, {
    action: "breakglass.close",
    resourceType: "user",
    resourceId: row!.patientId,
    subjectUserId: row!.patientId,
  });

  return c.json({ ok: true });
});
