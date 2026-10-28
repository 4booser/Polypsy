import { describe, expect, test } from "bun:test";
import { and, inArray, sql } from "drizzle-orm";
import { t } from "@quizzy/shared";
import { adminA, api, appApi, batteries, batteryAssignments, batteryItems, db, eq, makeUser, root, surveyInA, surveys } from "./fixtures";
import { auditLog, surveyAccess, users } from "../src/db/schema";
import { CATALOG_BATTERIES, CATALOG_BATTERY_LANG, type CatalogBattery } from "../src/instruments/catalogBatteries";
import { CATALOG_GROUP_ID, installCatalog } from "../src/lib/catalogInstall";

/**
 * Наборы-заготовки каталога (instruments/catalogBatteries.ts).
 *
 * Установщик заводит каждую заготовку один раз — общим набором — и больше
 * не трогает: правка, архив и удаление отделения переживают любой выкат.
 * Проверяется то, что ломается тихо: второй выкат заводит второй набор;
 * выкат «чинит» состав, который отделение поправило; удалённый набор
 * возвращается; методика, которой нет, роняет выкат.
 *
 * База общая на процесс, и заготовки — общие: соседний файл, ставящий
 * каталог, их тоже заводит. Поэтому проверки не ждут «первой» установки, а
 * смотрят на состояние после неё; удаление — последним тестом файла и одной
 * заготовки.
 */

const SLOW = 30_000;

async function templateRow(key: string) {
  const rows = await db.select().from(batteries).where(eq(batteries.catalogKey, key));
  return rows;
}

async function itemsOf(batteryId: string) {
  return db
    .select({ surveyId: batteryItems.surveyId, position: batteryItems.position, required: batteryItems.required })
    .from(batteryItems)
    .where(eq(batteryItems.batteryId, batteryId))
    .orderBy(batteryItems.position);
}

async function surveyIdsOf(keys: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: surveys.id, key: surveys.catalogKey })
    .from(surveys)
    .where(inArray(surveys.catalogKey, keys));
  const byKey = new Map(rows.map((r) => [r.key, r.id]));
  return keys.map((k) => byKey.get(k)!);
}

describe("наборы-заготовки каталога", () => {
  test(
    "каждая заготовка заведена одна — общим набором, в порядке и с порядком прохождения из каталога",
    async () => {
      await installCatalog();
      for (const tpl of CATALOG_BATTERIES) {
        const rows = await templateRow(tpl.key);
        expect(rows.length, `«${tpl.key}»: наборов с ключом`).toBe(1);
        const row = rows[0]!;
        expect(row.groupId, `«${tpl.key}» заведён не общим`).toBeNull();
        expect(row.title).toBe(t(tpl.title, CATALOG_BATTERY_LANG));
        expect(row.description).toBe(t(tpl.description, CATALOG_BATTERY_LANG));
        expect(row.strictOrder).toBe(tpl.strictOrder);
        expect(row.archived).toBe(false);
        // записан на того же, на кого методики каталога: на суперадминистратора или администратора
        const [owner] = await db.select({ role: users.role }).from(users).where(eq(users.id, row.createdBy));
        expect(["superadmin", "admin"]).toContain(owner!.role);

        const items = await itemsOf(row.id);
        expect(items.map((i) => i.surveyId), `«${tpl.key}»: состав или порядок`).toEqual(
          await surveyIdsOf(tpl.items.map((i) => i.key)),
        );
        expect(items.map((i) => i.position)).toEqual(tpl.items.map((_, n) => n));
        expect(items.every((i) => i.required)).toBe(true);
      }

      // журнал — с ключом заготовки, как у методик каталога — с источником
      const trail = await db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, "battery.create"), sql`${auditLog.details}->>'by' = 'catalog-install'`));
      const logged = new Set(trail.map((r) => (r.details as { catalogKey?: string }).catalogKey));
      for (const tpl of CATALOG_BATTERIES) expect(logged.has(tpl.key), `«${tpl.key}» не записан в журнал`).toBe(true);
    },
    SLOW,
  );

  /**
   * Мутация: искать заготовку по названию, а не по catalog_key, — после
   * переименования отделением следующий выкат заводит вторую, и первое же
   * ожидание числа строк падает.
   */
  test(
    "повторный выкат ничего не заводит и не меняет",
    async () => {
      const before = await db.select().from(batteries).where(inArray(batteries.catalogKey, CATALOG_BATTERIES.map((b) => b.key)));
      const report = await installCatalog();
      expect(report.batteries.installed).toEqual([]);
      expect(report.batteries.kept.sort()).toEqual(CATALOG_BATTERIES.map((b) => b.key).sort());
      const after = await db.select().from(batteries).where(inArray(batteries.catalogKey, CATALOG_BATTERIES.map((b) => b.key)));
      expect(after).toEqual(before);
    },
    SLOW,
  );

  /**
   * Мутация: в installBattery дописывать состав заведённой заготовки до
   * каталожного — правка отделения пропадает, проверка состава падает.
   */
  test(
    "правку и архив отделения выкат не откатывает",
    async () => {
      const [row] = await templateRow("resources");
      const [who5] = await surveyIdsOf(["who5"]);
      const put = await api(`/api/batteries/${row!.id}`, root.token, {
        method: "PUT",
        body: JSON.stringify({
          title: "Ресурси (наш варіант)",
          description: "Скорочено відділенням",
          strictOrder: true,
          archived: true,
          items: [{ surveyId: who5, required: false }],
        }),
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);

      const report = await installCatalog();
      expect(report.batteries.kept).toContain("resources");
      const rows = await templateRow("resources");
      expect(rows.length, "выкат завёл заготовку заново").toBe(1);
      expect(rows[0]!.title).toBe("Ресурси (наш варіант)");
      expect(rows[0]!.archived, "выкат вернул набор из архива").toBe(true);
      expect(rows[0]!.strictOrder).toBe(true);
      expect(await itemsOf(row!.id)).toEqual([{ surveyId: who5!, position: 0, required: false }]);
    },
    SLOW,
  );

  /**
   * Установщик терпит отсутствующее: методику, которой нет в базе или
   * которая снята, пропускает, набор заводит без неё; набор без единой
   * методики не заводит, но и не помечает — следующий выкат попробует снова.
   * Заготовки здесь — свои, в памяти процесса (файл каталога не трогается).
   */
  test(
    "пропущенная методика не роняет выкат: набор заводится без неё, пустой — ждёт",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const partial: CatalogBattery = {
        key: `test-partial-${suffix}`,
        title: { uk: "Частковий набір", ru: "Частичный набор" },
        description: { uk: "Перевірка пропуску", ru: "Проверка пропуска" },
        strictOrder: true,
        items: [{ key: "no-such-instrument" }, { key: "rses" }, { key: "sbqr" }],
      };
      const empty: CatalogBattery = {
        key: `test-empty-${suffix}`,
        title: { uk: "Порожній набір", ru: "Пустой набор" },
        description: { uk: "Жодної методики", ru: "Ни одной методики" },
        strictOrder: false,
        items: [{ key: "no-such-instrument" }],
      };
      // снятая методика тоже пропускается: в наборе она была бы шагом «знято з використання»
      const [sbqr] = await surveyIdsOf(["sbqr"]);
      await db.update(surveys).set({ archivedAt: new Date().toISOString() }).where(eq(surveys.id, sbqr!));
      CATALOG_BATTERIES.push(partial, empty);
      try {
        const report = await installCatalog();
        expect(report.batteries.installed).toContain(partial.key);
        expect(report.batteries.missingItems[partial.key]).toEqual(["no-such-instrument", "sbqr"]);
        expect(report.batteries.pending).toContain(empty.key);
        const [made] = await templateRow(partial.key);
        expect((await itemsOf(made!.id)).map((i) => i.surveyId)).toEqual(await surveyIdsOf(["rses"]));
        expect(await templateRow(empty.key)).toEqual([]);

        const again = await installCatalog();
        expect(again.batteries.pending, "пустая заготовка перестала ждать методик").toContain(empty.key);
        expect(again.batteries.kept).toContain(partial.key);
      } finally {
        CATALOG_BATTERIES.splice(CATALOG_BATTERIES.indexOf(partial), 1);
        CATALOG_BATTERIES.splice(CATALOG_BATTERIES.indexOf(empty), 1);
        await db.update(surveys).set({ archivedAt: null }).where(eq(surveys.id, sbqr!));
      }
    },
    SLOW,
  );

  /**
   * Общий набор (groupId null) виден всему персоналу (routes/batteries.ts).
   * Под ролью приложения суперадминистратор видит заготовку с составом, как
   * и владелец базы. Шаги — методики каталога, а каталог — библиотека
   * (lib/scope.ts, CATALOG_GROUP_ID): их видит каждый сотрудник.
   */
  test(
    "заготовка — в списке наборов сотрудника, и под ролью приложения тоже",
    async () => {
      const [row] = await templateRow("primary-screening");
      const owner = await api("/api/batteries", root.token);
      expect(owner.status).toBe(200);
      const mine = owner.body.items.find((b: { id: string }) => b.id === row!.id);
      const tpl = CATALOG_BATTERIES.find((b) => b.key === "primary-screening")!;
      expect(mine?.title).toBe(t(tpl.title, CATALOG_BATTERY_LANG));
      expect(mine?.items.length).toBe(tpl.items.length);

      const asApp = await appApi("/api/batteries", root.token);
      expect(asApp.status, JSON.stringify(asApp.body)).toBe(200);
      const appRow = asApp.body.items.find((b: { id: string }) => b.id === row!.id);
      expect(appRow?.groupId).toBeNull();
      expect(appRow?.items.map((i: { surveyId: string }) => i.surveyId)).toEqual(
        mine.items.map((i: { surveyId: string }) => i.surveyId),
      );

      // администратор группы видит общий набор в своём списке
      const admin = await api("/api/batteries", adminA.token);
      expect(admin.body.items.some((b: { id: string }) => b.id === row!.id)).toBe(true);
    },
    SLOW,
  );

  /** Человек в зоне adminA — выдачей методики его группы А, тем путём, что вводит в зону */
  async function personOfA(label: string) {
    const person = await makeUser("user", `catalog-battery-${label}-${crypto.randomUUID().slice(0, 8)}@test`);
    await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
    return person;
  }

  /**
   * Методики каталога — библиотека: шаги заготовки видны любому сотруднику,
   * одинаково владельцем базы и ролью приложения. Общий набор в зону никого
   * не вводит (lib/scope.ts, batteryWidensZone): выдают его человеку своей
   * зоны, а чужому — «не найдено», иначе назначивший не увидел бы потом ни
   * назначения, ни результатов. Суперадминистратору зона не нужна.
   * Мутация: убрать отказ общего набора в POST /:id/assign — выдача чужому
   * проходит владельцем базы и падает пятисоткой ролью приложения.
   */
  test(
    "сотрудник видит шаги заготовки и выдаёт её человеку своей зоны; чужому — нет; суперадминистратор выдаёт любому",
    async () => {
      const [row] = await templateRow("trauma-deep");
      const tpl = CATALOG_BATTERIES.find((b) => b.key === "trauma-deep")!;
      for (const call of [api, appApi]) {
        const list = await call("/api/batteries", adminA.token);
        const seen = list.body.items.find((b: { id: string }) => b.id === row!.id);
        expect(seen, "общий набор пропал из списка сотрудника").toBeDefined();
        expect(seen.items.length, "сотруднику не видны шаги заготовки каталога").toBe(tpl.items.length);
      }

      const stranger = await makeUser("user", `catalog-battery-${crypto.randomUUID().slice(0, 8)}@test`);
      for (const call of [api, appApi]) {
        const refused = await call(`/api/batteries/${row!.id}/assign`, adminA.token, {
          method: "POST",
          body: JSON.stringify({ userId: stranger.id }),
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(404);
      }
      expect(await db.select().from(batteryAssignments).where(eq(batteryAssignments.userId, stranger.id))).toEqual([]);

      const own = await personOfA("own");
      const mine = await appApi(`/api/batteries/${row!.id}/assign`, adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: own.id }),
      });
      expect(mine.status, JSON.stringify(mine.body)).toBe(201);
      // назначение не оставляется открытым: очередь общая на процесс
      expect((await api(`/api/batteries/assignments/${mine.body.id}/cancel`, root.token, { method: "POST" })).status).toBe(200);

      const given = await api(`/api/batteries/${row!.id}/assign`, root.token, {
        method: "POST",
        body: JSON.stringify({ userId: stranger.id }),
      });
      expect(given.status, JSON.stringify(given.body)).toBe(201);
      const cancel = await api(`/api/batteries/assignments/${given.body.id}/cancel`, root.token, { method: "POST" });
      expect(cancel.status).toBe(200);
    },
    SLOW,
  );

  /**
   * Администратор группы каталога правит методики каталога, но людей ему
   * группа не даёт: выдаёт он заготовку по тому же правилу, что любой
   * сотрудник, — прежде назначение в группу каталога открывало выдачу кому
   * угодно, а с ней и карту человека.
   */
  test(
    "администратор группы каталога выдаёт заготовку по тому же правилу: человеку вне своей зоны — нет",
    async () => {
      const [row] = await templateRow("trauma-deep");
      const assign = await api(`/api/groups/${CATALOG_GROUP_ID}/admins`, root.token, {
        method: "POST",
        body: JSON.stringify({ userId: adminA.id }),
      });
      expect(assign.status, JSON.stringify(assign.body)).toBe(201);
      try {
        const stranger = await makeUser("user", `catalog-group-battery-${crypto.randomUUID().slice(0, 8)}@test`);
        const refused = await appApi(`/api/batteries/${row!.id}/assign`, adminA.token, {
          method: "POST",
          body: JSON.stringify({ userId: stranger.id }),
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(404);

        const own = await personOfA("catalog-admin");
        const given = await appApi(`/api/batteries/${row!.id}/assign`, adminA.token, {
          method: "POST",
          body: JSON.stringify({ userId: own.id }),
        });
        expect(given.status, JSON.stringify(given.body)).toBe(201);
        const cancel = await api(`/api/batteries/assignments/${given.body.id}/cancel`, root.token, { method: "POST" });
        expect(cancel.status).toBe(200);
      } finally {
        await api(`/api/groups/${CATALOG_GROUP_ID}/admins/${adminA.id}`, root.token, { method: "DELETE" });
      }
    },
    SLOW,
  );

  /**
   * Мутация: убрать проверку журнала (installedBefore) — удалённая отделением
   * заготовка возвращается следующим выкатом, и падает ожидание пустоты.
   */
  test(
    "удалённую отделением заготовку выкат не возвращает",
    async () => {
      const [row] = await templateRow("staff-burnout");
      const del = await api(`/api/batteries/${row!.id}`, root.token, { method: "DELETE" });
      expect(del.status, JSON.stringify(del.body)).toBe(204);

      const report = await installCatalog();
      expect(report.batteries.removed).toContain("staff-burnout");
      expect(report.batteries.installed).not.toContain("staff-burnout");
      expect(await templateRow("staff-burnout"), "выкат вернул удалённый набор").toEqual([]);
    },
    SLOW,
  );
});
