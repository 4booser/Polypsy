import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ALL_PERMISSIONS } from "@quizzy/shared";
import { db } from "./fixtures";
import { rolePermissions, roles } from "../src/db/schema";

/**
 * Четыре уровня персонала.
 *
 * Проверяется не «роли завелись» — это видно и так, — а три вещи, каждая из
 * которых ломается тихо: право в роли должно существовать в справочнике,
 * уровни должны отличаться друг от друга, и учётные записи с журналом не
 * должны попадать к тому, кто отвечает за медицину.
 */

const CODES = ["specialist", "head", "chief"] as const;

async function permissionsOf(code: string): Promise<Set<string>> {
  const [role] = await db.select().from(roles).where(eq(roles.code, code));
  if (!role) return new Set();
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, role.id));
  return new Set(rows.map((r) => r.permission));
}

describe("роли персонала", () => {
  test("все три роли заведены", async () => {
    const rows = await db.select().from(roles).where(inArray(roles.code, [...CODES]));
    expect(rows.length).toBe(3);
  });

  test("каждое право роли есть в справочнике", async () => {
    /*
     * Права выданы строками в миграции, а справочник живёт в коде. Опечатка
     * или переименование права оставили бы роль без него — и заметить это
     * можно было бы только по жалобе «мне не даёт», причём через месяцы.
     */
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const code of CODES) {
      for (const p of await permissionsOf(code)) {
        expect(known.has(p), `роль «${code}»: право «${p}» не значится в справочнике`).toBe(true);
      }
    }
  });

  test("уровни различаются, а не повторяют друг друга", async () => {
    /*
     * Три роли с одинаковым набором — это одна роль под тремя названиями, и
     * она хуже одной: разбирающий будет считать, что ограничил человека,
     * тогда как не ограничил ничем.
     */
    const specialist = await permissionsOf("specialist");
    const head = await permissionsOf("head");
    const chief = await permissionsOf("chief");

    expect(specialist.size).toBeGreaterThan(0);
    expect(head.size).toBeGreaterThan(specialist.size);
    expect(chief.size).toBeGreaterThan(head.size);

    // каждый следующий уровень включает предыдущий: иначе повышение отнимало
    // бы возможности, и человек терял бы то, что делал вчера
    for (const p of specialist) {
      expect(head.has(p), `заведующий потерял право специалиста «${p}»`).toBe(true);
    }
    for (const p of head) {
      expect(chief.has(p), `главный врач потерял право заведующего «${p}»`).toBe(true);
    }
  });

  test("учётные записи, права и журнал не входят ни в одну клиническую роль", async () => {
    /*
     * Работа технического администратора. Смешать её с медицинской значило
     * бы, что человек, отвечающий за лечение, может незаметно раздать себе
     * всё остальное — и разбирать потом будет нечего: журнал доступа
     * правится тем же, кто в нём числится.
     */
    for (const code of CODES) {
      const have = await permissionsOf(code);
      for (const forbidden of ["users.manage", "groups.manage", "audit.read", "console.use"]) {
        expect(have.has(forbidden), `роль «${code}» получила «${forbidden}»`).toBe(false);
      }
    }
  });
});
