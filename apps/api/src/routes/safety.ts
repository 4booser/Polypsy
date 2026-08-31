import { Hono, type Context } from "hono";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Permission, SafetyPlanContent } from "@quizzy/shared";
import { db } from "../db";
import { safetyPlans, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { forbidden, notFound, parseBody } from "../lib/http";
import { accessiblePatientIds } from "../lib/scope";
import { requireAuth, type AppEnv } from "../middleware/auth";
import { hasPermission } from "../lib/permissions";
import { isStaff } from "../lib/scope";

export const safetyRoutes = new Hono<AppEnv>();
safetyRoutes.use("*", requireAuth);

/**
 * Личный план безопасности.
 *
 * Отличается от `safetyPlan` методики принципиально: там инструкция
 * инструмента, одинаковая для всех, здесь — план конкретного человека, его
 * словами и с его телефонами. Инструкция говорит, что делать персоналу;
 * план — что делать самому человеку, когда рядом никого нет.
 *
 * Поэтому доступ шире обычного клинического: пациент читает свой план сам.
 * Он и должен быть у него под рукой, в том числе офлайн.
 */

const contentSchema = z.object({
  warningSigns: z.array(z.string().max(300)).max(12),
  copingStrategies: z.array(z.string().max(300)).max(12),
  distractions: z.array(z.string().max(300)).max(12),
  people: z.array(z.object({ name: z.string().max(120), contact: z.string().max(120) })).max(10),
  professionals: z.array(z.object({ name: z.string().max(120), contact: z.string().max(120) })).max(10),
  meansRestriction: z.string().max(1000),
  reasonsToLive: z.array(z.string().max(300)).max(12),
});

function readPlan(row: typeof safetyPlans.$inferSelect, authorName: string) {
  const raw = decryptField(row.content) ?? "{}";
  return {
    id: row.id,
    version: row.version,
    content: JSON.parse(raw) as SafetyPlanContent,
    active: row.active,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    authorName,
  };
}

/*
 * Права здесь проверяются внутри обработчика, а не строкой middleware, и
 * порядок двух проверок — часть защиты, а не деталь оформления.
 *
 * Первым отвечает isStaff, и отвечает «не найдено». Пациенту нельзя узнать
 * по коду отказа, что план у него заведён: 403 означал бы «есть, но не
 * покажем», а 404 не означает ничего. Middleware ответило бы 403 раньше, чем
 * очередь дойдёт до isStaff, — так и вышло с первой редакцией, и это поймал
 * тест «чужой план пациенту не отдаётся».
 *
 * Вторым — право, и уже честным 403: сотруднику скрывать нечего, ему надо
 * знать, чего не хватает.
 */
async function assertSafetyStaff(c: Context<AppEnv>, permission: Permission) {
  if (!isStaff(c.get("user"))) notFound("err.safetyPlanNotFound");
  if (!(await hasPermission(c.get("user"), permission))) {
    forbidden("err.permissionRequired", { permission });
  }
}

/** Свой план: пациент открывает его сам, в том числе с телефона */
safetyRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const [row] = await db
    .select({ plan: safetyPlans, author: users })
    .from(safetyPlans)
    .leftJoin(users, eq(users.id, safetyPlans.createdBy))
    .where(eq(safetyPlans.userId, user.id))
    .orderBy(desc(safetyPlans.version))
    .limit(1);

  if (!row) return c.json({ plan: null });
  return c.json({ plan: readPlan(row.plan, row.author ? fullNameOf(row.author) : "—") });
});

safetyRoutes.get("/patients/:userId", async (c) => {
  const staff = c.get("user");
  await assertSafetyStaff(c, "patients.read");
  const userId = c.req.param("userId");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.safetyPlanNotFound");

  const rows = await db
    .select({ plan: safetyPlans, author: users })
    .from(safetyPlans)
    .leftJoin(users, eq(users.id, safetyPlans.createdBy))
    .where(eq(safetyPlans.userId, userId))
    .orderBy(desc(safetyPlans.version));

  await audit(c, {
    action: "response.read",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "safety_plan" },
  });

  return c.json({
    versions: rows.map((r) => readPlan(r.plan, r.author ? fullNameOf(r.author) : "—")),
  });
});

safetyRoutes.put("/patients/:userId", async (c) => {
  const staff = c.get("user");
  await assertSafetyStaff(c, "safety.manage");
  const userId = c.req.param("userId");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.safetyPlanNotFound");

  const content = await parseBody(c.req.raw, contentSchema);

  const [latest] = await db
    .select()
    .from(safetyPlans)
    .where(eq(safetyPlans.userId, userId))
    .orderBy(desc(safetyPlans.version))
    .limit(1);

  /*
   * Каждое сохранение — новая версия, а не правка на месте. План безопасности
   * пересматривают вместе с человеком, и «как было в марте» — клинически
   * значимый вопрос: по нему видно, что изменилось в жизни и что перестало
   * работать.
   */
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    if (latest) {
      await tx.update(safetyPlans).set({ active: false }).where(eq(safetyPlans.userId, userId));
    }
    await tx.insert(safetyPlans).values({
      id,
      userId,
      version: (latest?.version ?? 0) + 1,
      content: encryptField(JSON.stringify(content))!,
      active: true,
      createdBy: staff.id,
      reviewedAt: new Date().toISOString(),
    });
  });

  await audit(c, {
    action: "safety.save",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { version: (latest?.version ?? 0) + 1 },
  });

  return c.json({ id, version: (latest?.version ?? 0) + 1 }, 201);
});
