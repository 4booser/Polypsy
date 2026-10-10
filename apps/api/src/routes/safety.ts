import { Hono, type Context } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Permission, SafetyPlanContent } from "@quizzy/shared";
import { db } from "../db";
import { safetyPlans, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { namesOf } from "../lib/names";
import { decryptField, encryptField } from "../lib/crypto";
import { conflict, forbidden, isUniqueViolation, notFound, parseBody } from "../lib/http";
import { patientsInScope } from "../lib/scope";
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

/**
 * Сохранение — содержимое плана и редакция, поверх которой его правили.
 *
 * `baseVersion` — номер версии, которую показывал редактор (0 — плана ещё
 * не было). Пары «версия + ревизия», как у заключения, здесь не нужно:
 * план не правится на месте, каждое сохранение — новая версия, и номер
 * версии и есть редакция. Необязателен, как baseVersion у заключения:
 * внешний вызов без него теряет сверку, но не согласованность.
 *
 * В базу уходит только содержимое: номер редакции — вопрос к серверу, а не
 * часть плана, и в расшифрованном плане у пациента ему делать нечего.
 */
const saveSchema = contentSchema.extend({
  baseVersion: z.number().int().min(0).optional(),
});

/**
 * Очередь сохранений одного плана — до конца транзакции запроса.
 *
 * Консультативная блокировка, а не `select … for update`: у первой версии
 * строки ещё нет, а заводят её наперегонки так же, как следующие. Ключ —
 * по пациенту: план у человека один, и сохранения чужих планов друг друга
 * не ждут. Приём тот же, что у заключений (routes/conclusions.ts,
 * lockConclusion).
 */
async function lockPlan(userId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`safety:${userId}`}))`);
}

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
  const [plan] = await db
    .select()
    .from(safetyPlans)
    .where(eq(safetyPlans.userId, user.id))
    .orderBy(desc(safetyPlans.version))
    .limit(1);

  if (!plan) return c.json({ plan: null });
  /*
   * Автор — отдельной выборкой системной ролью (lib/names.ts), а не левым
   * соединением с users: строку специалиста пациенту политика не показывает,
   * и под ролью приложения вместо автора плана стояло «—» (волна 13).
   */
  const author = plan.createdBy ? (await namesOf([plan.createdBy])).get(plan.createdBy) : undefined;
  return c.json({ plan: readPlan(plan, author ?? "—") });
});

safetyRoutes.get("/patients/:userId", async (c) => {
  const staff = c.get("user");
  await assertSafetyStaff(c, "patients.read");
  const userId = c.req.param("userId");

  const allowed = await patientsInScope(staff, [userId]);
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

  const allowed = await patientsInScope(staff, [userId]);
  if (allowed && !allowed.has(userId)) notFound("err.safetyPlanNotFound");

  const { baseVersion, ...content } = await parseBody(c.req.raw, saveSchema);

  /*
   * Сначала очередь, потом чтение последней версии (внешний разбор
   * 2026-09-27, п. 9). Прежде последняя версия читалась без очереди, и
   * четыре одновременных сохранения прочитали одну и ту же, посчитали
   * следующей одну и ту же — уникальный индекс пропустил одно, три ушли
   * пятисоткой «внутренняя ошибка». Под блокировкой второе сохранение читает
   * уже то, что записало первое.
   */
  await lockPlan(userId);
  const [latest] = await db
    .select()
    .from(safetyPlans)
    .where(eq(safetyPlans.userId, userId))
    .orderBy(desc(safetyPlans.version))
    .limit(1);
  const current = latest?.version ?? 0;

  /*
   * Правку сверяем с тем, что редактор показывал. Двое, открывших план
   * одновременно, иначе молча затёрли бы друг друга: действующей стала бы
   * версия того, кто нажал вторым, а первый не узнал бы, что его разделы
   * «кому звонить» больше не действуют. Отказ — 409 с обоими номерами.
   */
  if (baseVersion !== undefined && baseVersion !== current) {
    conflict("err.safetyPlanChanged", { current, base: baseVersion });
  }

  /*
   * Каждое сохранение — новая версия, а не правка на месте. План безопасности
   * пересматривают вместе с человеком, и «как было в марте» — клинически
   * значимый вопрос: по нему видно, что изменилось в жизни и что перестало
   * работать.
   */
  const id = crypto.randomUUID();
  const version = current + 1;
  try {
    await db.transaction(async (tx) => {
      if (latest) {
        await tx.update(safetyPlans).set({ active: false }).where(eq(safetyPlans.userId, userId));
      }
      await tx.insert(safetyPlans).values({
        id,
        userId,
        version,
        content: encryptField(JSON.stringify(content))!,
        active: true,
        createdBy: staff.id,
        reviewedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    /*
     * Вторая линия — если блокировка не сработала (маршрут позвали вне
     * транзакции запроса, и консультативная блокировка отпустилась сразу).
     * Уникальный индекс по номеру версии тогда последний сторож, и его отказ
     * — «план изменился», а не внутренняя ошибка.
     */
    if (isUniqueViolation(err)) conflict("err.safetyPlanChanged", { current: version, base: current });
    throw err;
  }

  await audit(c, {
    action: "safety.save",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { version },
  });

  return c.json({ id, version }, 201);
});
