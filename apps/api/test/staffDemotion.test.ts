import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { Permission } from "@quizzy/shared";
import { appApi, db, groupA, issueToken, makeUser, root, type Person } from "./fixtures";
import { auditLog, groupAdmins, permissionExceptions, roles, staffRoles } from "../src/db/schema";
import { permissionsOf } from "../src/lib/permissions";

/**
 * Понижение сотрудника до пациента (#142).
 *
 * Было: права считались для любого класса учётки — пациент с оставшимися
 * от службы ролями и выдачами ops.* проходил маршруты, закрытые только
 * правом. /api/ops/maint стоял без requireStaff (общий заслон /api/ops до
 * него не доходит): история выкаток, флаги, аудитория флагов и откат
 * выкатки — пациенту. Смена класса на user роли и исключения оставляла.
 *
 * Стало: permissionsOf для пациента пуст (как SQL-двойник
 * rls_has_permission), /api/ops/maint требует сотрудника, понижение до
 * пациента снимает роли, исключения и администрирование групп.
 *
 * Все запросы — под ролью приложения: снятие идёт в транзакции запроса
 * заведующего, а group_admins политика пишет только суперадмину.
 */

const uid = () => crypto.randomUUID().slice(0, 8);
const json = (body: unknown) => ({ body: JSON.stringify(body) });

async function grant(person: Person, ...perms: Permission[]) {
  for (const permission of perms) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission,
      mode: "grant",
      reason: "Дежурство по серверу",
      grantedBy: root.id,
    });
  }
}

async function roleId(code: string): Promise<string> {
  const [row] = await db.select().from(roles).where(eq(roles.code, code));
  return row!.id;
}

/** Все входы /api/ops/maint: чтение, запись и откат выкатки */
const MAINT: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/api/ops/maint/status" },
  { method: "POST", path: "/api/ops/maint/status", body: { status: "ok" } },
  { method: "GET", path: "/api/ops/maint/flags" },
  { method: "GET", path: "/api/ops/maint/flags/changes" },
  { method: "GET", path: "/api/ops/maint/flags/audience" },
  { method: "PUT", path: "/api/ops/maint/flags/whatever", body: { enabled: false } },
  { method: "GET", path: "/api/ops/maint/releases" },
  { method: "POST", path: "/api/ops/maint/releases/rollback", body: { version: "v0.0.0" } },
];

async function maintStatuses(token: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of MAINT) {
    const res = await appApi(r.path, token, { method: r.method, ...(r.body ? json(r.body) : {}) });
    out[`${r.method} ${r.path}`] = res.status;
  }
  return out;
}

describe("пациент с правами сотрудника (#142)", () => {
  test(
    "учётка класса user с ролью и выдачами ops.* — 403 на всех /api/ops/maint/*; сотрудник с теми же — проходит",
    async () => {
      // пациент, у которого с прежней службы остались роль и выдачи
      const former = await makeUser("user", `dm-former-${uid()}@test`);
      await db.insert(staffRoles).values({ userId: former.id, roleId: await roleId("psychologist"), grantedBy: root.id });
      await grant(former, "ops.read", "ops.manage");

      expect([...(await permissionsOf({ id: former.id, role: "user" } as never))], "пациенту насчитаны права").toEqual([]);
      const statuses = await maintStatuses(former.token);
      for (const [route, status] of Object.entries(statuses)) expect(status, route).toBe(403);

      // контроль: сотрудник с теми же выдачами читает техпанель
      const staff = await makeUser("admin", `dm-staff-${uid()}@test`);
      await grant(staff, "ops.read", "ops.manage");
      expect((await permissionsOf({ id: staff.id, role: "admin" } as never)).has("ops.manage")).toBe(true);
      expect((await appApi("/api/ops/maint/status", staff.token)).status).toBe(200);
      expect((await appApi("/api/ops/maint/releases", staff.token)).status).toBe(200);
      expect((await appApi("/api/ops/maint/flags/audience", staff.token)).status).toBe(200);
    },
    20_000,
  );

  test(
    "заведующий понижает специалиста до пациента: роли, исключения и группы сняты, сессии оборваны",
    async () => {
      const head = await makeUser("admin", `dm-head-${uid()}@test`);
      await db.insert(staffRoles).values({ userId: head.id, roleId: await roleId("head"), grantedBy: root.id });
      await grant(head, "users.manage");

      const spec = await makeUser("admin", `dm-spec-${uid()}@test`);
      await db.insert(staffRoles).values({ userId: spec.id, roleId: await roleId("specialist"), grantedBy: root.id });
      await grant(spec, "ops.read", "ops.manage");
      await db.insert(groupAdmins).values({ groupId: groupA, userId: spec.id, addedBy: root.id });
      // до понижения техпанель ему открыта — иначе проверка ниже ничего не доказывает
      expect((await appApi("/api/ops/maint/status", spec.token)).status).toBe(200);

      const res = await appApi(`/api/users/${spec.id}/role`, head.token, { method: "PATCH", ...json({ role: "user" }) });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("user");

      // прежний токен не принимается
      expect((await appApi("/api/auth/me", spec.token)).status).toBe(401);

      expect(await db.select().from(staffRoles).where(eq(staffRoles.userId, spec.id)), "роли остались").toEqual([]);
      const active = await db
        .select()
        .from(permissionExceptions)
        .where(and(eq(permissionExceptions.userId, spec.id), isNull(permissionExceptions.revokedAt)));
      expect(active, "исключения остались действующими").toEqual([]);
      // погашены, а не стёрты: кто выдавал, видно
      expect((await db.select().from(permissionExceptions).where(eq(permissionExceptions.userId, spec.id))).length).toBe(2);
      expect(
        await db.select().from(groupAdmins).where(eq(groupAdmins.userId, spec.id)),
        "администрирование группы осталось — под ролью заведующего политика не дала его снять",
      ).toEqual([]);

      // новым входом — пациент: техпанель закрыта целиком
      const fresh = await issueToken({ id: spec.id, role: "user" });
      for (const [route, status] of Object.entries(await maintStatuses(fresh))) expect(status, route).toBe(403);

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "user.role_change"), eq(auditLog.subjectUserId, spec.id)));
      expect(entry!.details).toMatchObject({ newRole: "user", rolesRemoved: 2, exceptionsRevoked: 2, groupsLeft: 1 });
    },
    20_000,
  );

  test(
    "повышение обратно — только встроенная роль: прежние выдачи ops.* не оживают",
    async () => {
      const spec = await makeUser("admin", `dm-back-${uid()}@test`);
      await grant(spec, "ops.read");
      expect((await appApi(`/api/users/${spec.id}/role`, root.token, { method: "PATCH", ...json({ role: "user" }) })).status).toBe(200);
      expect((await appApi(`/api/users/${spec.id}/role`, root.token, { method: "PATCH", ...json({ role: "admin" }) })).status).toBe(200);

      const perms = await permissionsOf({ id: spec.id, role: "admin" } as never);
      expect(perms.has("ops.read"), "выдача ops.read пережила понижение").toBe(false);
      expect(perms.has("alerts.review"), "встроенная роль не выдана").toBe(true);
    },
    20_000,
  );
});
