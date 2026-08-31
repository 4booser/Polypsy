import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Permission, User } from "@quizzy/shared";
import { ALL_PERMISSIONS, PSYCHOLOGIST_PERMISSIONS } from "@quizzy/shared";
import { db } from "../db";
import { permissionExceptions, rolePermissions, roles, staffRoles, users } from "../db/schema";

/**
 * Что человек может делать.
 *
 * Собирается из двух источников: набор его ролей плюс личные исключения.
 * Исключения применяются последними, и отнятое побеждает добавленное
 * независимо от порядка строк — при ошибке безопаснее отнять лишнее, чем
 * оставить лишнее.
 *
 * Права не кэшируются дольше одного запроса. requireAuth и так читает
 * учётную запись из базы на каждый запрос, так что лишнего похода нет, зато
 * отнятое у уволенного право действует со следующего запроса, а не через
 * полчаса.
 */
export async function permissionsOf(user: User): Promise<Set<Permission>> {
  /*
   * Суперадмин обходит справочник целиком.
   *
   * Не потому, что «ему всё можно», а потому, что иначе появляется состояние,
   * из которого систему нельзя починить: суперадмин, случайно отнявший у себя
   * users.manage, не сможет вернуть его обратно. Роль суперадмина — это ключ
   * от замка, а не набор ключей от комнат.
   */
  if (user.role === "superadmin") return new Set(ALL_PERMISSIONS);

  const granted = new Set<Permission>();

  const fromRoles = await db
    .select({ permission: rolePermissions.permission })
    .from(staffRoles)
    .innerJoin(roles, eq(roles.id, staffRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .where(eq(staffRoles.userId, user.id));
  for (const r of fromRoles) granted.add(r.permission as Permission);

  /*
   * Действующие исключения: не отозванные и не истёкшие. Срок сравнивается в
   * базе, а не в приложении: часы приложения и базы расходятся, и «истекло
   * минуту назад» не должно зависеть от того, чьи часы спросили.
   */
  const exceptions = await db
    .select({ permission: permissionExceptions.permission, mode: permissionExceptions.mode })
    .from(permissionExceptions)
    .where(
      and(
        eq(permissionExceptions.userId, user.id),
        isNull(permissionExceptions.revokedAt),
        or(
          isNull(permissionExceptions.expiresAt),
          sql`${permissionExceptions.expiresAt} > now()`,
        ),
      ),
    );

  for (const e of exceptions) if (e.mode === "grant") granted.add(e.permission as Permission);
  for (const e of exceptions) if (e.mode === "revoke") granted.delete(e.permission as Permission);

  return granted;
}

export async function hasPermission(user: User, permission: Permission): Promise<boolean> {
  return (await permissionsOf(user)).has(permission);
}

/**
 * Приведение прав к справочнику при старте.
 *
 * Делает две вещи, и вторая важнее первой.
 *
 * 1. Набор встроенной роли приводится к списку из справочника. Список живёт
 *    в коде, а не в SQL миграции: иначе он разъехался бы с тем, что код умеет
 *    проверять, и разъезд был бы не виден.
 *
 * 2. Встроенная роль выдаётся каждому администратору, у которого нет ни одной
 *    роли. Бэкфилл в миграции покрывает только тех, кто существовал в момент
 *    её применения, — а администратор, заведённый завтра, остался бы без прав
 *    вовсе. Пока маршруты не переведены, это ничего не значит; в день
 *    перевода он потерял бы всё сразу.
 *
 *    «Администратор без единой роли» — не осмысленное состояние: чтобы
 *    ограничить человека, ему дают более узкую роль или отнимают право
 *    исключением, а не оставляют с пустым набором. Поэтому пустой набор
 *    трактуется как «ещё не выдали», а не как «отняли намеренно».
 */
export async function syncBuiltinRole(): Promise<void> {
  const [role] = await db.select().from(roles).where(eq(roles.code, "psychologist"));
  if (!role) return;

  const current = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, role.id));
  const have = new Set(current.map((r) => r.permission));

  const missing = PSYCHOLOGIST_PERMISSIONS.filter((p) => !have.has(p));
  if (missing.length) {
    await db
      .insert(rolePermissions)
      .values(missing.map((permission) => ({ roleId: role.id, permission })))
      .onConflictDoNothing();
  }

  /*
   * Лишнее из встроенной роли убирается тоже: если право исчезло из
   * справочника, оно должно исчезнуть и у роли, иначе в базе останется код,
   * который никто не проверяет, — и он будет выглядеть как выданное право.
   */
  const extra = current.filter((r) => !PSYCHOLOGIST_PERMISSIONS.includes(r.permission as Permission));
  for (const r of extra) {
    await db
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permission, r.permission)));
  }

  await grantBuiltinToRolelessAdmins(role.id);
}

/**
 * Выдать встроенную роль конкретному человеку.
 *
 * Зовётся в момент, когда человек становится администратором, а не только при
 * старте приложения. Сверка на старте покрывает уже заведённых; заведённый
 * после неё оставался бы без прав до следующего перезапуска — то есть до
 * ночи, а работать ему нужно сегодня.
 *
 * Молчит, если роль уже есть или если встроенной роли ещё нет в базе:
 * назначение прав не должно ронять создание учётной записи.
 */
export async function ensureBuiltinRole(userId: string): Promise<void> {
  const [role] = await db.select().from(roles).where(eq(roles.code, "psychologist"));
  if (!role) return;
  await db.insert(staffRoles).values({ userId, roleId: role.id }).onConflictDoNothing();
}

/** Администраторы без единой роли получают встроенную. См. пояснение выше. */
async function grantBuiltinToRolelessAdmins(roleId: string): Promise<void> {
  const roleless = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        sql`not exists (select 1 from staff_roles sr where sr.user_id = ${users.id})`,
      ),
    );
  if (!roleless.length) return;
  await db
    .insert(staffRoles)
    .values(roleless.map((u) => ({ userId: u.id, roleId })))
    .onConflictDoNothing();
}
