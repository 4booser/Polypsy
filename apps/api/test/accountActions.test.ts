import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import type { Permission } from "@quizzy/shared";
import { db } from "../src/db";
import { auditLog, departments, permissionExceptions, refreshTokens, roles, staffRoles, users } from "../src/db/schema";
import { issuePair } from "../src/lib/refresh";
import { api, app, json, makeUser, root, type Person } from "./fixtures";

/**
 * Заведующий против главного врача — в каждом действии над чужой учётной
 * записью (решение заказчика 2026-09-28, продолжение п. 1 внешнего разбора).
 *
 * Было: сброс пароля, выключение, обрыв сессий, массовые действия и прочее
 * проверяли только «над суперадмином — только суперадмин». Заведующий с
 * делегированным users.manage сбрасывал пароль главному врачу, получал
 * временный пароль в ответе и входил главным врачом — тот же захват учётки
 * выше себя, что и `user role <своя почта> superadmin`.
 *
 * Стало: одно правило (lib/accountRule.ts) через одну функцию
 * (lib/accountClass.ts, guardAccountAction) — право действия, не себе,
 * суперадмина трогает только суперадмин, цель строго ниже своего положения.
 * Каждое место ниже проверяется парой: старшего — нельзя (и ничего не
 * меняется), младшего — можно (правило не выродилось в запрет всего).
 *
 * Под ролью приложения (test:app-role): чтения и записи — под политиками строк.
 */

const tag = () => crypto.randomUUID().slice(0, 8);

async function person(ladder: "specialist" | "head" | "chief", perms: Permission[] = []): Promise<Person & { email: string }> {
  const email = `aa-${ladder}-${tag()}@test.dev`;
  const who = await makeUser("admin", email);
  const [role] = await db.select().from(roles).where(eq(roles.code, ladder));
  await db.insert(staffRoles).values({ userId: who.id, roleId: role!.id, grantedBy: root.id });
  for (const permission of perms) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: who.id,
      permission,
      mode: "grant",
      reason: "Ведёт учётные записи отделения",
      grantedBy: root.id,
    });
  }
  return { ...who, email };
}

/** Заведующий отделением с делегированными users.manage и console.use — тот, кого описал разбор */
const head = () => person("head", ["users.manage", "console.use"]);

const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { "Accept-Language": "ru" } });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "Accept-Language": "ru" } });

async function rowOf(id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row!;
}

const ABOVE = "вашей ступени или выше";

const made: string[] = [];
afterAll(async () => {
  // выключенных и запертых не оставляем: соседние файлы могут искать по реестру
  if (made.length) await db.update(users).set({ disabledAt: null, disabledReason: null, disabledBy: null }).where(inArray(users.id, made));
});

describe("сброс пароля", () => {
  test("главному врачу — нет, специалисту — да", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];
    const before = (await rowOf(chief.id)).passwordHash;

    const denied = await api(`/api/ops/users/${chief.id}/reset-password`, h.token, post());
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain(ABOVE);
    expect(denied.body.password).toBeUndefined();
    expect((await rowOf(chief.id)).passwordHash, "пароль главного врача сменён руками заведующего").toBe(before);
    // главный врач работает дальше своим токеном
    expect((await api("/api/auth/me", chief.token)).status).toBe(200);

    const ok = await api(`/api/ops/users/${spec.id}/reset-password`, h.token, post());
    expect(ok.status).toBe(200);
    expect(typeof ok.body.password).toBe("string");

    // попытка видна в журнале
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.password_reset"), eq(auditLog.subjectUserId, chief.id)));
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
  });
});

describe("выключение и включение", () => {
  test("главного врача не выключить и не включить, специалиста — можно", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];
    made.push(chief.id, spec.id);

    const off = await api(`/api/ops/users/${chief.id}/disable`, h.token, post({ reason: "Проверка правила" }));
    expect(off.status).toBe(403);
    expect(off.body.error).toContain(ABOVE);
    expect((await rowOf(chief.id)).disabledAt).toBeNull();

    // выключил суперадмин — включить обратно заведующий тоже не вправе
    expect((await api(`/api/ops/users/${chief.id}/disable`, root.token, post({ reason: "Проверка правила" }))).status).toBe(200);
    const on = await api(`/api/ops/users/${chief.id}/enable`, h.token, post());
    expect(on.status).toBe(403);
    expect((await rowOf(chief.id)).disabledAt).not.toBeNull();
    expect((await api(`/api/ops/users/${chief.id}/enable`, root.token, post())).status).toBe(200);

    expect((await api(`/api/ops/users/${spec.id}/disable`, h.token, post({ reason: "Проверка правила" }))).status).toBe(200);
    expect((await api(`/api/ops/users/${spec.id}/enable`, h.token, post())).status).toBe(200);
  });
});

describe("обрыв сессий", () => {
  test("все сессии главного врача — нет; свои — можно (это выход на всех устройствах)", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];

    const denied = await api(`/api/ops/users/${chief.id}/revoke-sessions`, h.token, post());
    expect(denied.status).toBe(403);
    expect((await api("/api/auth/me", chief.token)).status, "главного врача выкинуло из консоли").toBe(200);

    expect((await api(`/api/ops/users/${spec.id}/revoke-sessions`, h.token, post())).status).toBe(200);
    expect((await api("/api/auth/me", spec.token)).status).toBe(401);

    // себе — законно и не через другую дверь: выход гасит одну семью, а тут все
    const own = await head();
    expect((await api(`/api/ops/users/${own.id}/revoke-sessions`, own.token, post())).status).toBe(200);
  });

  test("одну сессию главного врача — тоже нет", async () => {
    const [h, chief] = [await head(), await person("chief")];
    await issuePair({ id: chief.id, role: "admin" });
    const [family] = await db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, chief.id));

    const res = await api(`/api/ops/sessions/${family!.familyId}/revoke`, h.token, post());
    expect(res.status).toBe(403);
    const [still] = await db.select().from(refreshTokens).where(eq(refreshTokens.familyId, family!.familyId));
    expect(still!.revokedAt).toBeNull();
  });
});

describe("удаление, второй фактор, вход «от имени»", () => {
  test("над главным врачом — ни одно из трёх: они и так только суперадмину", async () => {
    const [h, chief] = [await head(), await person("chief")];
    expect((await api(`/api/ops/users/${chief.id}`, h.token, { method: "DELETE" })).status).toBe(403);
    expect((await api(`/api/ops/people/users/${chief.id}/mfa-reset`, h.token, post())).status).toBe(403);
    const imp = await api(`/api/ops/people/impersonate/${chief.id}`, h.token, post({ reason: "Проверка правила действий" }));
    expect(imp.status).toBe(403);
    expect(await rowOf(chief.id)).toBeDefined();
  });

  test("суперадмин — над кем угодно, кроме себя: себе второй фактор так не сбрасывают", async () => {
    const res = await api(`/api/ops/people/users/${root.id}/mfa-reset`, root.token, post());
    expect(res.status).toBe(403);
  });
});

describe("роли и личные исключения", () => {
  test("главному врачу роль не добавить даже ниже своей; специалисту — можно", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];
    const [specialist] = await db.select().from(roles).where(eq(roles.code, "specialist"));
    const codes = async (id: string) =>
      (
        await db
          .select({ code: roles.code })
          .from(staffRoles)
          .innerJoin(roles, eq(roles.id, staffRoles.roleId))
          .where(eq(staffRoles.userId, id))
      )
        .map((r) => r.code)
        .sort();
    const current = async (id: string) =>
      (await db.select({ roleId: staffRoles.roleId }).from(staffRoles).where(eq(staffRoles.userId, id))).map((r) => r.roleId);

    const before = await codes(chief.id);
    const denied = await api(`/api/permissions/users/${chief.id}/roles`, h.token, put({ roleIds: [...(await current(chief.id)), specialist!.id] }));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain(ABOVE);
    expect(await codes(chief.id)).toEqual(before);

    // специалисту — снять встроенную роль и оставить должность: ниже заведующего, можно
    const ok = await api(`/api/permissions/users/${spec.id}/roles`, h.token, put({ roleIds: [specialist!.id] }));
    expect(ok.status).toBe(200);
    expect(await codes(spec.id)).toEqual(["specialist"]);
  });

  test("личное исключение суперадмин себе не выдаёт: оно ему ничего не даёт, а правило одно", async () => {
    const res = await api(`/api/permissions/users/${root.id}/exceptions`, root.token, post({
      permission: "users.manage",
      mode: "grant",
      reason: "Проверка правила действий над учёткой",
    }));
    expect(res.status).toBe(403);
  });
});

describe("отделение и приём сотрудника", () => {
  test("главного врача в другое отделение заведующий не переводит; специалиста — расставляет", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];
    const departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення", ru: "Отделение" }, timezone: "Europe/Kyiv" });
    const body = { departmentId, room: "12", defaultSlotMinutes: 50, acceptsBookings: false };

    const denied = await api(`/api/clinic/specialists/${chief.id}`, h.token, put(body));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain(ABOVE);

    expect((await api(`/api/clinic/specialists/${spec.id}`, h.token, put(body))).status).toBe(200);
  });
});

describe("массовые действия и импорт", () => {
  test("пачкой главный врач пропускается с причиной, остальные — делаются", async () => {
    const [h, chief, spec] = [await head(), await person("chief"), await person("specialist")];
    made.push(chief.id, spec.id);

    const off = await api("/api/ops/people/users/bulk", h.token, post({ action: "disable", reason: "Проверка пачки", ids: [chief.id, spec.id] }));
    expect(off.status).toBe(200);
    expect(off.body.done.map((d: { id: string }) => d.id)).toEqual([spec.id]);
    expect(off.body.skipped).toEqual([{ id: chief.id, email: chief.email, reason: "aboveYours" }]);
    expect((await rowOf(chief.id)).disabledAt).toBeNull();

    const sessions = await api("/api/ops/people/users/bulk", h.token, post({ action: "revoke-sessions", ids: [chief.id] }));
    expect(sessions.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(["aboveYours"]);
    const role = await api("/api/ops/people/users/bulk", h.token, post({ action: "assign-role", roleId: "role-specialist", ids: [chief.id] }));
    expect(role.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(["aboveYours"]);
  });

  test("импорт сотрудников — только тем, кто выше сотрудника", async () => {
    const csv = `last_name,first_name,email\nКоваленко,Олена,aa-imp-${tag()}@test.dev`;
    // сотрудник вне лестницы с делегированным users.manage: сотрудник — его ровня
    const plain = await makeUser("admin", `aa-plain-${tag()}@test.dev`);
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: plain.id,
      permission: "users.manage",
      mode: "grant",
      reason: "Ведёт учётные записи отделения",
      grantedBy: root.id,
    });
    const flat = await api("/api/ops/people/users/import/preview", plain.token, post({ csv }));
    expect(flat.body.rows[0].errors).toEqual(["roleNotAllowed"]);

    const h = await head();
    const ok = await api("/api/ops/people/users/import/preview", h.token, post({ csv }));
    expect(ok.body.rows[0].errors).toEqual([]);
  });
});

describe("стирание устройства", () => {
  test("устройство главного врача заведующий не стирает: маршрут только суперадмину", async () => {
    const [h, chief] = [await head(), await person("chief")];
    const checkin = await api("/api/devices/checkin", chief.token, post({ deviceId: `aa-dev-${crypto.randomUUID()}` }));
    expect(checkin.status).toBe(200);
    const list = await api("/api/devices", chief.token);
    const device = list.body.items[0] as { id: string; wipeRequestedAt: string | null };

    expect((await api(`/api/devices/${device.id}/wipe`, h.token, post())).status).toBe(403);
    const after = await api("/api/devices", chief.token);
    expect(after.body.items[0].wipeRequestedAt).toBeNull();
  });
});

describe("вход без токена ничего из этого не открывает", () => {
  test("сброс пароля без входа — 401", async () => {
    const chief = await person("chief");
    const res = await app.request(`/api/ops/users/${chief.id}/reset-password`, { method: "POST" });
    expect(res.status).toBe(401);
    expect((await json(res)).password).toBeUndefined();
  });
});
