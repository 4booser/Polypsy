import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  ALL_PERMISSIONS,
  EXCEPTION_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_TITLES,
  PSYCHOLOGIST_PERMISSIONS,
  type Permission,
} from "@quizzy/shared";
import { eq as eqUser } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { toPublicUser } from "../src/lib/auth";
import { permissionExceptions, rolePermissions, roles, staffRoles } from "../src/db/schema";
import { hasPermission, permissionsOf, syncBuiltinRole } from "../src/lib/permissions";
import { ROUTE_DOCS } from "../src/lib/openapi";
import { adminA, api, makeUser, root } from "./fixtures";

/**
 * Каркас прав.
 *
 * Главное, что здесь проверяется, — не то, что права работают, а то, что их
 * появление ничего не сломало. Переход на права начинается с бэкфилла, и если
 * он изменит поведение хоть одной действующей учётной записи, у людей молча
 * пропадут возможности, которыми они пользовались вчера.
 */

beforeAll(async () => {
  await syncBuiltinRole();
});

/**
 * Пользователь в том же виде, в каком его получает middleware.
 *
 * Фикстуры отдают только идентификатор и токен, а проверка прав смотрит и на
 * роль: суперадмин обходит справочник целиком. Передать сюда «почти
 * пользователя» — верный способ проверить не то, что работает в бою.
 */
async function userOf(id: string) {
  const [row] = await db.select().from(users).where(eqUser(users.id, id));
  return toPublicUser(row!);
}

describe("справочник", () => {
  test("у каждого права есть пояснение на обоих языках", () => {
    /*
     * Экран прав объясняет, а не перечисляет: «conclusions.sign» ничего не
     * говорит тому, кто раздаёт права, а «подписывать заключения» говорит.
     */
    const missing = ALL_PERMISSIONS.filter(
      (p) => !PERMISSION_TITLES[p]?.uk?.trim() || !PERMISSION_TITLES[p]?.ru?.trim(),
    );
    expect(missing).toEqual([]);
  });

  test("коды прав не повторяются между группами", () => {
    // повтор означал бы, что право показывается на экране дважды и снимается
    // в одном месте, оставаясь отмеченным в другом
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const g of PERMISSION_GROUPS) {
      for (const p of g.permissions) {
        if (seen.has(p)) dup.push(p);
        seen.add(p);
      }
    }
    expect(dup).toEqual([]);
  });

  test("поштучные права входят в справочник", () => {
    const stray = EXCEPTION_PERMISSIONS.filter((p) => !ALL_PERMISSIONS.includes(p));
    expect(stray).toEqual([]);
  });
});

describe("бэкфилл", () => {
  test("встроенная роль заведена и не удаляется", async () => {
    const [role] = await db.select().from(roles).where(eq(roles.code, "psychologist"));
    expect(role).toBeTruthy();
    expect(role!.isBuiltin).toBe(true);
  });

  test("набор роли совпадает со справочником", async () => {
    /*
     * Список прав живёт в коде, а роль — в базе. Расхождение означало бы, что
     * в базе лежит код, который никто не проверяет: выглядит как выданное
     * право, а не действует.
     */
    const [role] = await db.select().from(roles).where(eq(roles.code, "psychologist"));
    const rows = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role!.id));
    expect(rows.map((r) => r.permission).sort()).toEqual([...PSYCHOLOGIST_PERMISSIONS].sort());
  });

  test("администратор, заведённый после миграции, тоже получает роль", async () => {
    /*
     * Бэкфилл в миграции покрывает только тех, кто существовал на момент её
     * применения. Без этого администратор, заведённый завтра, в день
     * перевода маршрутов потерял бы всё сразу — и молча.
     */
    const fresh = await makeUser("admin", `perm-fresh-${crypto.randomUUID()}@test`);
    await syncBuiltinRole();
    const got = await permissionsOf(await userOf(fresh.id));
    expect([...got].sort()).toEqual([...PSYCHOLOGIST_PERMISSIONS].sort());
  });

  test("действующий администратор группы ничего не потерял", async () => {
    /*
     * Условие перехода, а не пожелание: сегодня «админ группы» означает «всё,
     * кроме суперадминских вещей», и роль обязана означать то же самое.
     */
    await syncBuiltinRole();
    const got = await permissionsOf(await userOf(adminA.id));
    expect([...got].sort()).toEqual([...PSYCHOLOGIST_PERMISSIONS].sort());
  });

  test("суперадмину доступно всё, включая администрирование", async () => {
    /*
     * Не «ему всё можно», а «иначе систему нельзя починить»: суперадмин,
     * отнявший у себя users.manage, не смог бы вернуть его обратно.
     */
    const got = await permissionsOf(await userOf(root.id));
    expect([...got].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  test("у пациента прав нет", async () => {
    const patient = await makeUser("user", `perm-patient-${crypto.randomUUID()}@test`);
    expect([...(await permissionsOf(await userOf(patient.id)))]).toEqual([]);
  });

  test("повторная синхронизация ничего не меняет", async () => {
    const before = await db.select().from(rolePermissions);
    await syncBuiltinRole();
    const after = await db.select().from(rolePermissions);
    expect(after.length).toBe(before.length);
  });
});

describe("личные исключения", () => {
  const perm: Permission = "conclusions.sign";

  /**
   * Сотрудник с узкой ролью — как стажёр.
   *
   * Встроенная роль снимается явно: администратор получает её при создании, и
   * это правильное умолчание. Ограничить человека означает дать ему более
   * узкую роль вместо встроенной, а не оставить с пустым набором — пустой
   * набор система трактует как «ещё не выдали».
   */
  async function staffWithoutSigning() {
    const person = await makeUser("admin", `perm-${crypto.randomUUID()}@test`);
    await db.delete(staffRoles).where(eq(staffRoles.userId, person.id));
    const id = `role-${crypto.randomUUID()}`;
    await db.insert(roles).values({ id, code: id, title: { uk: "Стажер", ru: "Стажёр" } });
    await db
      .insert(rolePermissions)
      .values([{ roleId: id, permission: "notes.write" }, { roleId: id, permission: "patients.read" }]);
    await db.insert(staffRoles).values({ userId: person.id, roleId: id });
    return person;
  }

  test("выданное исключение добавляет право", async () => {
    const person = await staffWithoutSigning();
    expect(await hasPermission(await userOf(person.id), perm)).toBe(false);

    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission: perm,
      mode: "grant",
      reason: "Замещает наставника на время отпуска",
      grantedBy: root.id,
    });
    expect(await hasPermission(await userOf(person.id), perm)).toBe(true);
  });

  test("истёкшее исключение не действует", async () => {
    const person = await staffWithoutSigning();
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission: perm,
      mode: "grant",
      reason: "На одну смену",
      grantedBy: root.id,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await hasPermission(await userOf(person.id), perm)).toBe(false);
  });

  test("отозванное исключение не действует", async () => {
    const person = await staffWithoutSigning();
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission: perm,
      mode: "grant",
      reason: "Ошибочно выдано",
      grantedBy: root.id,
      revokedAt: new Date().toISOString(),
    });
    expect(await hasPermission(await userOf(person.id), perm)).toBe(false);
  });

  test("отнятое побеждает добавленное", async () => {
    /*
     * Порядок строк не должен решать. При ошибке безопаснее отнять лишнее,
     * чем оставить лишнее: второе — это доступ, о котором никто не знает.
     */
    const person = await makeUser("admin", `perm-${crypto.randomUUID()}@test`);
    for (const mode of ["revoke", "grant"] as const) {
      await db.insert(permissionExceptions).values({
        id: crypto.randomUUID(),
        userId: person.id,
        permission: perm,
        mode,
        reason: `проверка порядка: ${mode}`,
        grantedBy: root.id,
      });
    }
    expect(await hasPermission(await userOf(person.id), perm)).toBe(false);
  });

  test("исключение не действует на чужую учётную запись", async () => {
    const person = await staffWithoutSigning();
    const other = await staffWithoutSigning();
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission: perm,
      mode: "grant",
      reason: "только этому человеку",
      grantedBy: root.id,
    });
    expect(await hasPermission(await userOf(person.id), perm)).toBe(true);
    expect(await hasPermission(await userOf(other.id), perm)).toBe(false);
  });

  test("отнятое у суперадмина не действует", async () => {
    /*
     * Иначе появляется состояние, из которого систему нельзя починить.
     * Проверяется явно, потому что «отнятое побеждает добавленное» — правило
     * общее, и легко решить, что оно сильнее и здесь.
     */
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: root.id,
      permission: "users.manage",
      mode: "revoke",
      reason: "попытка отнять у суперадмина",
      grantedBy: root.id,
    });
    expect(await hasPermission(await userOf(root.id), "users.manage")).toBe(true);
    await db
      .delete(permissionExceptions)
      .where(and(eq(permissionExceptions.userId, root.id), eq(permissionExceptions.permission, "users.manage")));
  });
});

describe("маршруты под правом", () => {
  /**
   * Поведенческая проверка перехода.
   *
   * Список берётся из ROUTE_DOCS, а не пишется рядом: объявление права в
   * описании маршрута обязано что-то значить, иначе это просто комментарий,
   * который разъедется с кодом. Здесь объявление становится обязательством —
   * маршрут, помеченный правом, обязан его требовать.
   *
   * Проверяются маршруты без параметров в пути: подставлять правдоподобные
   * идентификаторы значило бы проверять заодно и то, что данные найдены, а
   * это другой вопрос. Маршруты с параметрами закрыты тем же middleware на
   * весь набор, так что покрытие набора одним маршрутом честно.
   */
  const CLOSED = Object.entries(ROUTE_DOCS)
    .filter(([key, doc]) => doc.permission && key.startsWith("GET ") && !key.includes(":"))
    .map(([key, doc]) => [key.slice("GET ".length), doc.permission!] as const);

  test("у каждого объявленного права есть проверяемый маршрут", () => {
    /*
     * Иначе пробел молчит. Набор маршрутов закрыт одним middleware, поэтому
     * достаточно одного проверяемого маршрута на право — но хотя бы один
     * быть обязан, иначе объявление снова становится комментарием.
     *
     * Если очередной набор состоит только из маршрутов с параметрами, это
     * повод завести в нём читающий маршрут без параметра, а не ослабить
     * проверку.
     */
    const declared = new Set(
      Object.values(ROUTE_DOCS).flatMap((d) => (d.permission ? [d.permission] : [])),
    );
    const covered = new Set(CLOSED.map(([, permission]) => permission));
    const uncovered = [...declared].filter((p) => !covered.has(p));
    expect(uncovered).toEqual([]);
  });

  test("объявленные права есть хотя бы у одного маршрута", () => {
    /*
     * Пустой список означал бы, что проверка проходит, ничего не проверив, —
     * и перевод маршрутов остался бы без страховки ровно тогда, когда она
     * нужнее всего.
     */
    expect(CLOSED.length).toBeGreaterThan(0);
  });

  for (const [path, permission] of CLOSED) {
    test(`${path} закрыт без права ${permission}`, async () => {
      const person = await makeUser("admin", `perm-route-${crypto.randomUUID()}@test`);
      // встроенная роль снимается: проверяем именно узкую роль без нужного права
      await db.delete(staffRoles).where(eq(staffRoles.userId, person.id));
      const id = `role-${crypto.randomUUID()}`;
      await db.insert(roles).values({ id, code: id, title: { uk: "Вузька", ru: "Узкая" } });
      await db.insert(rolePermissions).values({ roleId: id, permission: "patients.read" });
      await db.insert(staffRoles).values({ userId: person.id, roleId: id });

      const denied = await api(path, person.token);
      expect(denied.status).toBe(403);

      // а с правом — проходит: иначе тест доказывал бы только то, что
      // маршрут сломан
      await db.insert(rolePermissions).values({ roleId: id, permission });
      const allowed = await api(path, person.token);
      expect(allowed.status).not.toBe(403);
    });
  }
});
