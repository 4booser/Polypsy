import { describe, expect, test } from "bun:test";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { adminB, api, appApi, db, groupA, root, surveyGroups, surveys } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { systemContext } from "../src/db/context";
import { auditLog } from "../src/db/schema";
import { CATALOG } from "../src/instruments/catalog";
import { CATALOG_GROUP_ID, installCatalog } from "../src/lib/catalogInstall";

/**
 * Группа каталога (CATALOG_GROUP_ID в lib/scope.ts).
 *
 * Методики каталога стояли без группы, а без группы методику видят только
 * суперадмин и автор, то есть установщик. Врач их не видел и не назначал, а
 * тревоги по ним доставались одному суперадмину. Теперь они в своей группе,
 * и эта группа — библиотека: врач видит её методики без назначения в группу,
 * а правят их суперадмин и администраторы группы, — владельцем базы и ролью
 * приложения одинаково. Результаты и правка — test/catalogLibrary.test.ts.
 */

const SLOW = 30_000;

const idsOf = (body: { items: { id: string }[] }) => body.items.map((s) => s.id);

async function catalogId(key: string): Promise<string> {
  const [row] = await db.select({ id: surveys.id }).from(surveys).where(eq(surveys.catalogKey, key));
  return row!.id;
}

describe("группа каталога", () => {
  test(
    "заведение группы забирает методики каталога без группы — один раз",
    async () => {
      /*
       * Экземпляр до группы каталога (прод до 2.1): методики стоят без
       * группы, группы нет. Группы других методик каталога, если тесты их
       * разнесли, возвращаются как были. Установщик — как на выкате: ролью
       * приложения в системном контексте (installCatalog.ts).
       * Мутация: убрать перенос в ensureCatalogGroup — методики остаются без группы.
       */
      await installCatalog();
      const before = await db
        .select({ id: surveys.id, groupId: surveys.groupId })
        .from(surveys)
        .where(isNotNull(surveys.catalogKey));
      try {
        await db.update(surveys).set({ groupId: null }).where(eq(surveys.groupId, CATALOG_GROUP_ID));
        await db.update(surveys).set({ groupId: null }).where(isNotNull(surveys.catalogKey));
        await db.delete(surveyGroups).where(eq(surveyGroups.id, CATALOG_GROUP_ID));

        const first = await asAppRole(() => systemContext(baseDb, () => installCatalog()));
        expect(first.groupCreated).toBe(true);
        // в конце списка групп: конструктор берёт новой методике первую группу списка
        const groups = await api<{ items: { id: string; archivedAt: string | null }[] }>("/api/groups", root.token);
        expect(groups.body.items.filter((g) => !g.archivedAt).at(-1)?.id).toBe(CATALOG_GROUP_ID);
        expect(first.grouped).toEqual(expect.arrayContaining(CATALOG.map((e) => e.key)));
        const rows = await db
          .select({ key: surveys.catalogKey, groupId: surveys.groupId })
          .from(surveys)
          .where(isNotNull(surveys.catalogKey));
        for (const r of rows) expect(r.groupId, `«${r.key}» не в группе каталога`).toBe(CATALOG_GROUP_ID);

        const [moved] = await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "survey.update"),
              eq(auditLog.resourceId, await catalogId("who5")),
              sql`${auditLog.details}->>'by' = 'catalog-install'`,
            ),
          )
          .limit(1);
        expect(moved, "перенос не записан в журнал").toBeDefined();

        const second = await installCatalog();
        expect(second.groupCreated).toBe(false);
        expect(second.grouped).toEqual([]);
      } finally {
        for (const r of before) {
          if (r.groupId && r.groupId !== CATALOG_GROUP_ID) {
            await db.update(surveys).set({ groupId: r.groupId }).where(eq(surveys.id, r.id));
          }
        }
      }
    },
    SLOW,
  );

  test(
    "новая методика каталога ставится сразу в группу",
    async () => {
      await installCatalog();
      const who5 = CATALOG.find((e) => e.key === "who5")!;
      const key = `group-probe-${crypto.randomUUID().slice(0, 8)}`;
      CATALOG.push({ ...who5, key });
      try {
        const report = await installCatalog();
        expect(report.installed).toEqual([key]);
        const [row] = await db.select({ groupId: surveys.groupId }).from(surveys).where(eq(surveys.catalogKey, key));
        expect(row?.groupId).toBe(CATALOG_GROUP_ID);
      } finally {
        CATALOG.splice(CATALOG.findIndex((e) => e.key === key), 1);
        await db.delete(surveys).where(eq(surveys.catalogKey, key));
      }
    },
    SLOW,
  );

  test(
    "методику, которую учреждение унесло из группы каталога, установщик не возвращает",
    async () => {
      await installCatalog();
      const id = await catalogId("who5");
      try {
        await db.update(surveys).set({ groupId: groupA }).where(eq(surveys.id, id));
        const report = await installCatalog();
        expect(report.grouped).toEqual([]);
        const [row] = await db.select({ groupId: surveys.groupId }).from(surveys).where(eq(surveys.id, id));
        expect(row?.groupId).toBe(groupA);
      } finally {
        await db.update(surveys).set({ groupId: CATALOG_GROUP_ID }).where(eq(surveys.id, id));
      }
    },
    SLOW,
  );

  test(
    "врач видит методики каталога без назначения в группу каталога; править их — администратору группы",
    async () => {
      /*
       * adminB — администратор только группы Б, в группу каталога его не
       * назначали. Методики каталога ему видны все — и ролью приложения
       * (политика surveys_read), — а править их нельзя. Назначение в группу
       * каталога добавляет ровно правку.
       * Мутация: вернуть surveyUseFilter без библиотеки — список пуст.
       */
      await installCatalog();
      const keys = CATALOG.map((e) => e.key);
      const catalogIds = (
        await db
          .select({ id: surveys.id })
          .from(surveys)
          .where(and(inArray(surveys.catalogKey, keys), eq(surveys.groupId, CATALOG_GROUP_ID)))
      ).map((r) => r.id);
      expect(catalogIds.length).toBe(keys.length);

      const path = `/api/surveys?groupId=${CATALOG_GROUP_ID}`;
      for (const call of [api, appApi]) {
        const listed = await call(path, adminB.token);
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect(idsOf(listed.body)).toEqual(expect.arrayContaining(catalogIds));
        expect(listed.body.items.every((s: { editable?: boolean }) => s.editable === false)).toBe(true);
      }
      // значение — как у каталога (WHO-5 показывает результаты пациенту): правка без следа в настройках учреждения
      const who5 = await catalogId("who5");
      const refused = await appApi(`/api/surveys/${who5}`, adminB.token, {
        method: "PATCH",
        body: JSON.stringify({ showResultsToPatient: true }),
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);

      const assign = await api(`/api/groups/${CATALOG_GROUP_ID}/admins`, root.token, {
        method: "POST",
        body: JSON.stringify({ userId: adminB.id }),
      });
      expect(assign.status, JSON.stringify(assign.body)).toBe(201);
      try {
        const asApp = await appApi(path, adminB.token);
        expect(asApp.status, JSON.stringify(asApp.body)).toBe(200);
        expect(idsOf(asApp.body)).toEqual(expect.arrayContaining(catalogIds));
        expect(asApp.body.items.find((s: { id: string }) => s.id === who5)?.editable).toBe(true);
        const edited = await appApi(`/api/surveys/${who5}`, adminB.token, {
          method: "PATCH",
          body: JSON.stringify({ showResultsToPatient: true }),
        });
        expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      } finally {
        const revoke = await api(`/api/groups/${CATALOG_GROUP_ID}/admins/${adminB.id}`, root.token, { method: "DELETE" });
        expect(revoke.status).toBeLessThan(300);
      }
    },
    SLOW,
  );
});
