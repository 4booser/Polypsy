import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ALL_PERMISSIONS } from "@quizzy/shared";
import { db } from "../src/db";
import { permissionExceptions, roles, staffRoles } from "../src/db/schema";
import { adminA, api, makeUser, root } from "./fixtures";

/**
 * Управление правами через API.
 *
 * Экран прав бесполезен, если через него нельзя ни посмотреть, ни изменить.
 * Но раздача прав — это и есть тот механизм, которым можно тихо расширить
 * себе доступ, поэтому первое, что здесь проверяется, — что чужой сюда не
 * попадёт.
 */

describe("кто сюда допущен", () => {
  test("администратор группы не видит управление правами", async () => {
    for (const path of ["/api/permissions/roles", "/api/permissions/catalogue", "/api/permissions/exceptions"]) {
      const res = await api(path, adminA.token);
      expect(res.status).toBe(403);
    }
  });

  test("пациент не видит управление правами", async () => {
    const patient = await makeUser("user", `pr-${crypto.randomUUID()}@test`);
    const res = await api("/api/permissions/roles", patient.token);
    expect(res.status).toBe(403);
  });

  test("администратор группы не может выдать себе право", async () => {
    /*
     * Самая опасная дыра такого экрана: сотрудник расширяет себе доступ и
     * никто этого не замечает, потому что формально он «просто зашёл в
     * настройки».
     */
    const res = await api(`/api/permissions/users/${adminA.id}/exceptions`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ permission: "users.manage", mode: "grant", reason: "хочу больше прав" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("справочник и роли", () => {
  test("справочник отдаёт все права с пояснениями", async () => {
    const res = await api("/api/permissions/catalogue", root.token);
    expect(res.status).toBe(200);
    const perms = res.body.groups.flatMap(
      (g: { permissions: { code: string; effect?: { kind: string; opens: { uk: string; ru: string } } }[] }) =>
        g.permissions,
    );
    expect(perms.map((p: { code: string }) => p.code).sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(res.body.exceptionable.length).toBeGreaterThan(0);

    /*
     * Экран собирает роль по последствиям, и берёт он их отсюда. Отдай
     * справочник одни коды — конструктор молча вернулся бы к списку
     * «console.use», причём выглядел бы рабочим.
     */
    const silent = perms.filter(
      (p: { effect?: { kind: string; opens: { ru: string } } }) => !p.effect?.opens?.ru?.trim(),
    );
    expect(silent).toEqual([]);
    expect(new Set(perms.map((p: { effect: { kind: string } }) => p.effect.kind))).toEqual(
      new Set(["screen", "analysis", "action"]),
    );
  });

  test("встроенная роль видна и помечена", async () => {
    const res = await api("/api/permissions/roles", root.token);
    const builtin = res.body.items.find((r: { code: string }) => r.code === "psychologist");
    expect(builtin.isBuiltin).toBe(true);
    expect(builtin.people).toBeGreaterThan(0);
  });

  test("набор встроенной роли вручную не меняется", async () => {
    /*
     * Ручная правка молча откатилась бы при следующем перезапуске — набор
     * задаётся справочником. Хуже отказа только отказ, о котором не сказали.
     */
    const list = await api("/api/permissions/roles", root.token);
    const builtin = list.body.items.find((r: { code: string }) => r.code === "psychologist");
    const res = await api(`/api/permissions/roles/${builtin.id}/permissions`, root.token, {
      method: "PUT",
      body: JSON.stringify({ permissions: ["patients.read"] }),
    });
    expect(res.status).toBe(400);
  });

  test("несуществующее право не принимается", async () => {
    const res = await api("/api/permissions/roles", root.token, {
      method: "POST",
      body: JSON.stringify({
        code: `r-${crypto.randomUUID()}`,
        title: { uk: "Тест", ru: "Тест" },
        permissions: ["patients.read", "выдумано.всё"],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("выдумано.всё");
  });

  test("роль заводится и выдаётся человеку", async () => {
    const person = await makeUser("admin", `pr-${crypto.randomUUID()}@test`);
    const code = `r-${crypto.randomUUID()}`;
    const made = await api("/api/permissions/roles", root.token, {
      method: "POST",
      body: JSON.stringify({
        code,
        title: { uk: "Вузька", ru: "Узкая" },
        permissions: ["patients.read", "notes.write"],
      }),
    });
    expect(made.status).toBe(201);

    const assigned = await api(`/api/permissions/users/${person.id}/roles`, root.token, {
      method: "PUT",
      body: JSON.stringify({ roleIds: [made.body.id] }),
    });
    expect(assigned.status).toBe(200);

    const card = await api(`/api/permissions/users/${person.id}`, root.token);
    expect(card.body.roles.map((r: { code: string }) => r.code)).toEqual([code]);
    expect(card.body.effective.sort()).toEqual(["notes.write", "patients.read"]);
  });
});

describe("личные исключения", () => {
  test("причина обязательна и не бывает короткой", async () => {
    /*
     * Не выпадающий список: список превращается в «выбрать первое», а
     * написанное словами читают через год, когда разбираются, было ли
     * исключение осмысленным.
     */
    const person = await makeUser("admin", `pr-${crypto.randomUUID()}@test`);
    const res = await api(`/api/permissions/users/${person.id}/exceptions`, root.token, {
      method: "POST",
      body: JSON.stringify({ permission: "conclusions.sign", mode: "grant", reason: "надо" }),
    });
    expect(res.status).toBe(400);
  });

  test("исключение со сроком видно в списке действующих и отзывается", async () => {
    const person = await makeUser("admin", `pr-${crypto.randomUUID()}@test`);
    await db.delete(staffRoles).where(eq(staffRoles.userId, person.id));

    const made = await api(`/api/permissions/users/${person.id}/exceptions`, root.token, {
      method: "POST",
      body: JSON.stringify({
        permission: "conclusions.sign",
        mode: "grant",
        reason: "Замещает наставника на время отпуска",
        days: 14,
      }),
    });
    expect(made.status).toBe(201);

    const card = await api(`/api/permissions/users/${person.id}`, root.token);
    expect(card.body.effective).toContain("conclusions.sign");
    expect(card.body.exceptions[0].expiresAt).toBeTruthy();

    const active = await api("/api/permissions/exceptions", root.token);
    expect(active.body.items.some((i: { id: string }) => i.id === made.body.id)).toBe(true);

    const off = await api(`/api/permissions/exceptions/${made.body.id}/revoke`, root.token, { method: "POST" });
    expect(off.status).toBe(200);

    const after = await api(`/api/permissions/users/${person.id}`, root.token);
    expect(after.body.effective).not.toContain("conclusions.sign");
  });

  test("повторный отзыв отклоняется", async () => {
    const person = await makeUser("admin", `pr-${crypto.randomUUID()}@test`);
    const made = await api(`/api/permissions/users/${person.id}/exceptions`, root.token, {
      method: "POST",
      body: JSON.stringify({ permission: "surveys.edit", mode: "revoke", reason: "Ключи правит наставник" }),
    });
    await api(`/api/permissions/exceptions/${made.body.id}/revoke`, root.token, { method: "POST" });
    const again = await api(`/api/permissions/exceptions/${made.body.id}/revoke`, root.token, { method: "POST" });
    expect(again.status).toBe(400);
  });

  test("выдача права попадает в журнал с причиной", async () => {
    /*
     * Право, выданное тихо, ничем не отличается от дыры. В журнале должно
     * остаться и что выдали, и зачем.
     */
    const person = await makeUser("admin", `pr-${crypto.randomUUID()}@test`);
    const reason = `Проверка журнала ${crypto.randomUUID()}`;
    await api(`/api/permissions/users/${person.id}/exceptions`, root.token, {
      method: "POST",
      body: JSON.stringify({ permission: "conclusions.sign", mode: "grant", reason }),
    });

    const log = await api("/api/audit?action=permission.exception&limit=20", root.token);
    const entry = log.body.entries.find(
      (e: { subjectUserId: string | null }) => e.subjectUserId === person.id,
    );
    expect(entry).toBeTruthy();
    expect((entry.details as { reason: string }).reason).toBe(reason);
  });
});
