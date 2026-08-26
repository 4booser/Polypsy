import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { createUserSchema, type User } from "@quizzy/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { audit } from "../lib/audit";
import { hashPassword, toPublicUser } from "../lib/auth";
import { conflict, forbidden, notFound, parseBody } from "../lib/http";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

export const userRoutes = new Hono<AppEnv>();

// учётные записи и роли — зона ответственности суперадмина
userRoutes.use("*", requireAuth, requireSuperadmin);

userRoutes.get("/", async (c) => {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  await audit(c, { action: "user.list", details: { count: rows.length } });
  return c.json(rows.map(toPublicUser) satisfies User[]);
});

/** Единственный способ завести администратора или специалиста */
userRoutes.post("/", async (c) => {
  const input = await parseBody(c.req.raw, createUserSchema);
  const email = input.email.toLowerCase();

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) conflict("Пользователь с таким email уже существует");

  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName ?? null,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    })
    .returning();

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
  if (id === actor.id) forbidden("Нельзя изменить собственную роль");

  const body = await c.req.json().catch(() => ({}));
  const role = body?.role;
  if (!["superadmin", "admin", "user"].includes(role)) forbidden("Допустимые роли: superadmin, admin, user");

  const [row] = await db.update(users).set({ role }).where(eq(users.id, id)).returning();
  if (!row) notFound("Пользователь не найден");

  await audit(c, {
    action: "user.role_change",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    details: { newRole: role, changedBy: actor.email },
  });

  return c.json(toPublicUser(row));
});
