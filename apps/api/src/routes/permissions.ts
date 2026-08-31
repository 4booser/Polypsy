import { Hono } from "hono";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ALL_PERMISSIONS,
  EXCEPTION_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_TITLES,
  type Permission,
} from "@quizzy/shared";
import { db } from "../db";
import { permissionExceptions, rolePermissions, roles, staffRoles, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { permissionsOf } from "../lib/permissions";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

/**
 * Управление правами.
 *
 * Закрыто суперадмином целиком, включая чтение: список того, кто что может, —
 * это карта доступа к клиническим данным, и раздавать её всему персоналу
 * незачем.
 *
 * Экран прав отвечает на два вопроса: «что этот человек может» и «почему».
 * Поэтому здесь отдаются не только итоговые права, но и то, из чего они
 * сложились: роли и личные исключения с причиной и сроком. Итог без
 * происхождения бесполезен — по нему нельзя решить, что менять.
 */
export const permissionRoutes = new Hono<AppEnv>();

permissionRoutes.use("*", requireAuth, requireSuperadmin);

/** Справочник: что вообще бывает. Отдаётся клиенту, чтобы экран не дублировал список. */
permissionRoutes.get("/catalogue", (c) =>
  c.json({
    groups: PERMISSION_GROUPS.map((g) => ({
      code: g.code,
      title: g.title,
      permissions: g.permissions.map((p) => ({ code: p, title: PERMISSION_TITLES[p] })),
    })),
    /* какие права осмысленно выдавать поштучно — экран показывает их быстрыми кнопками */
    exceptionable: EXCEPTION_PERMISSIONS,
  }),
);

permissionRoutes.get("/roles", async (c) => {
  const list = await db.select().from(roles).orderBy(roles.code);
  const perms = await db.select().from(rolePermissions);
  const counts = await db
    .select({ roleId: staffRoles.roleId, people: sql<number>`count(*)` })
    .from(staffRoles)
    .groupBy(staffRoles.roleId);
  const byRole = new Map(counts.map((r) => [r.roleId, Number(r.people)]));

  return c.json({
    items: list.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      isBuiltin: r.isBuiltin,
      permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
      people: byRole.get(r.id) ?? 0,
    })),
  });
});

const roleSchema = z.object({
  code: z.string().min(2).max(40),
  title: z.object({ uk: z.string().min(1), ru: z.string().min(1) }),
  permissions: z.array(z.string()),
});

permissionRoutes.post("/roles", async (c) => {
  const input = await parseBody(c.req.raw, roleSchema);
  const unknown = input.permissions.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (unknown.length) badRequest("err.unknownPermission", { permission: unknown.join(", ") });

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(roles).values({ id, code: input.code, title: input.title });
    if (input.permissions.length) {
      await tx
        .insert(rolePermissions)
        .values(input.permissions.map((permission) => ({ roleId: id, permission })));
    }
  });
  await audit(c, { action: "role.create", resourceType: "role", resourceId: id, details: { code: input.code } });
  return c.json({ id }, 201);
});

permissionRoutes.put("/roles/:id/permissions", async (c) => {
  const id = c.req.param("id");
  const [role] = await db.select().from(roles).where(eq(roles.id, id));
  if (!role) notFound("err.roleNotFound");
  /*
   * Встроенная роль не правится вручную: её набор задан справочником и
   * приводится к нему при каждом старте. Ручная правка молча откатилась бы
   * при следующем перезапуске — а человек считал бы, что права выданы.
   */
  if (role.isBuiltin) badRequest("err.builtinRoleReadOnly");

  const input = await parseBody(c.req.raw, z.object({ permissions: z.array(z.string()) }));
  const unknown = input.permissions.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (unknown.length) badRequest("err.unknownPermission", { permission: unknown.join(", ") });

  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    if (input.permissions.length) {
      await tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ roleId: id, permission })));
    }
  });
  await audit(c, {
    action: "role.update",
    resourceType: "role",
    resourceId: id,
    details: { permissions: input.permissions },
  });
  return c.json({ ok: true });
});

/** Что может конкретный человек и из чего это сложилось */
permissionRoutes.get("/users/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) notFound("err.userNotFound");

  const mine = await db
    .select({ roleId: staffRoles.roleId, code: roles.code, title: roles.title, isBuiltin: roles.isBuiltin })
    .from(staffRoles)
    .innerJoin(roles, eq(roles.id, staffRoles.roleId))
    .where(eq(staffRoles.userId, id));

  const exceptions = await db
    .select()
    .from(permissionExceptions)
    .where(eq(permissionExceptions.userId, id))
    .orderBy(permissionExceptions.grantedAt);

  return c.json({
    userId: id,
    fullName: fullNameOf(row),
    role: row.role,
    readOnly: row.readOnly,
    roles: mine,
    exceptions,
    /* итог — то, что реально проверяется на маршрутах */
    effective: [...(await permissionsOf({ id, role: row.role } as never))],
  });
});

permissionRoutes.put("/users/:id/roles", async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, z.object({ roleIds: z.array(z.string()) }));

  await db.transaction(async (tx) => {
    await tx.delete(staffRoles).where(eq(staffRoles.userId, id));
    if (input.roleIds.length) {
      await tx
        .insert(staffRoles)
        .values(input.roleIds.map((roleId) => ({ userId: id, roleId, grantedBy: c.get("user").id })));
    }
  });
  await audit(c, {
    action: "user.roles_change",
    resourceType: "user",
    resourceId: id,
    subjectUserId: id,
    details: { roleIds: input.roleIds },
  });
  return c.json({ ok: true });
});

const exceptionSchema = z.object({
  permission: z.string(),
  mode: z.enum(["grant", "revoke"]),
  /*
   * Причина словами, не выбором из списка: список превращается в «выбрать
   * первое», а написанное читают. Через год именно по причине понятно, было
   * ли исключение осмысленным.
   */
  reason: z.string().min(10),
  /** Срок в днях; без него исключение бессрочное и видно в списке как бессрочное */
  days: z.number().int().positive().max(365).optional(),
});

permissionRoutes.post("/users/:id/exceptions", async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, exceptionSchema);
  if (!ALL_PERMISSIONS.includes(input.permission as Permission)) {
    badRequest("err.unknownPermission", { permission: input.permission });
  }

  const exceptionId = crypto.randomUUID();
  await db.insert(permissionExceptions).values({
    id: exceptionId,
    userId: id,
    permission: input.permission,
    mode: input.mode,
    reason: input.reason.trim(),
    grantedBy: c.get("user").id,
    expiresAt: input.days
      ? new Date(Date.now() + input.days * 86_400_000).toISOString()
      : null,
  });
  await audit(c, {
    action: "permission.exception",
    resourceType: "user",
    resourceId: id,
    subjectUserId: id,
    details: { permission: input.permission, mode: input.mode, reason: input.reason, days: input.days ?? null },
  });
  return c.json({ id: exceptionId }, 201);
});

permissionRoutes.post("/exceptions/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(permissionExceptions).where(eq(permissionExceptions.id, id));
  if (!row) notFound("err.exceptionNotFound");
  if (row.revokedAt) badRequest("err.exceptionAlreadyRevoked");

  await db
    .update(permissionExceptions)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(permissionExceptions.id, id));
  await audit(c, {
    action: "permission.exception_revoke",
    resourceType: "user",
    resourceId: row.userId,
    subjectUserId: row.userId,
    details: { permission: row.permission, mode: row.mode },
  });
  return c.json({ ok: true });
});

/** Действующие исключения по всем — их разбирают, значит их надо видеть списком */
permissionRoutes.get("/exceptions", async (c) => {
  const rows = await db
    .select({
      exception: permissionExceptions,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(permissionExceptions)
    .innerJoin(users, eq(users.id, permissionExceptions.userId))
    .where(
      and(
        isNull(permissionExceptions.revokedAt),
        or(isNull(permissionExceptions.expiresAt), sql`${permissionExceptions.expiresAt} > now()`),
      ),
    )
    .orderBy(permissionExceptions.grantedAt);

  return c.json({
    items: rows.map((r) => ({ ...r.exception, userName: fullNameOf(r as never) })),
  });
});
