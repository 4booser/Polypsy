import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { createUserSchema, type User } from "@quizzy/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { audit } from "../lib/audit";
import { encryptPersonFields } from "../lib/crypto";
import { revokeAllFor } from "../lib/refresh";
import { hashPassword, toPublicUser } from "../lib/auth";
import { conflict, forbidden, notFound, parseBody } from "../lib/http";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { ensureBuiltinRole } from "../lib/permissions";

export const userRoutes = new Hono<AppEnv>();

// учётные записи и роли — зона ответственности суперадмина
/*
 * requireSuperadmin заменён правом, а не дополнен им.
 *
 * Дополнить значило бы оставить право декоративным: маршрут всё равно
 * пускал бы одного суперадмина, и выдать users.manage кому-то ещё было бы
 * нельзя. Поведение сегодня прежнее — users.manage не входит во встроенную
 * роль, а суперадмин обходит справочник, — но право стало настоящим.
 */
userRoutes.use("*", requireAuth, requireStaff, requirePermission("users.manage"));

userRoutes.get("/", async (c) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  await audit(c, { action: "user.list", details: { count: rows.length } });
  return c.json({ items: rows.map(toPublicUser) satisfies User[] });
});

/** Единственный способ завести администратора или специалиста */
userRoutes.post("/", async (c) => {
  const input = await parseBody(c.req.raw, createUserSchema);
  const email = input.email.toLowerCase();

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) conflict("err.emailExists");

  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      ...encryptPersonFields({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
      }),
      passwordHash: await hashPassword(input.password),
      role: input.role,
    })
    .returning();
  // администратор получает встроенную роль сразу: иначе он остался бы без
  // прав до следующего перезапуска приложения
  if (row!.role === "admin") await ensureBuiltinRole(row!.id);


  await audit(c, {
    action: "user.create",
    resourceType: "user",
    resourceId: row!.id,
    subjectUserId: row!.id,
    details: { role: row!.role, email },
  });

  return c.json(toPublicUser(row!), 201);
});

userRoutes.patch("/:id/role", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  if (id === actor.id) forbidden("err.cannotChangeOwnRole");

  const body = await c.req.json().catch(() => ({}));
  const role = body?.role;
  if (!["superadmin", "admin", "user"].includes(role)) forbidden("err.invalidRole");

  const [row] = await db.update(users).set({ role }).where(eq(users.id, id)).returning();
  // повышение до администратора — тот же случай, что и создание
  if (role === "admin") await ensureBuiltinRole(id);
  if (!row) notFound("err.userNotFound");

  // старые сессии несут старую роль в токене — обрываем их
  await revokeAllFor(row.id);

  await audit(c, {
    action: "user.role_change",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    details: { newRole: role, changedBy: actor.email },
  });

  return c.json(toPublicUser(row));
});
