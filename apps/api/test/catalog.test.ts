import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createSurveySchema, db } from "./fixtures";
import { surveys } from "../src/db/schema";
import { CATALOG } from "../src/instruments/catalog";
import { installCatalog } from "../src/lib/catalogInstall";

/**
 * Общий каталог методик.
 *
 * Проверяется не «методики красивые», а три вещи, каждая из которых ломается
 * тихо и дорого: методика невалидна и её нельзя пройти; повторный выкат
 * заводит дубликат; ключ шкалы указывает на пункты, которых нет.
 */

describe("содержимое каталога", () => {
  test("каждая методика проходит ту же проверку, что и созданная в редакторе", () => {
    /*
     * Методика каталога попадает в базу не через API, а прямой вставкой —
     * значит схема её не проверит по дороге. Невалидная методика вставилась
     * бы и упала бы только у человека, который её открыл.
     */
    for (const entry of CATALOG) {
      const parsed = createSurveySchema.safeParse(entry.draft);
      expect(parsed.success, `«${entry.key}» не проходит схему: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(
        true,
      );
    }
  });

  test("ключ шкалы указывает на существующие пункты", () => {
    /*
     * Номера в ключе — позиции в массиве вопросов, считая с единицы. Номер
     * за пределами массива не ломает ничего при вставке: движок просто не
     * найдёт пункт и посчитает шкалу по остальным. Балл выйдет ниже
     * настоящего, полоса — мягче, и человек с выраженной тревогой получит
     * «легка тривога». Ошибка не проявится нигде, кроме самих результатов.
     */
    for (const entry of CATALOG) {
      const total = entry.draft.questions?.length ?? 0;
      for (const scale of entry.draft.scales ?? []) {
        for (const k of scale.key ?? []) {
          expect(
            k.item >= 1 && k.item <= total,
            `«${entry.key}», шкала «${scale.code}»: пункт ${k.item} при ${total} пунктах`,
          ).toBe(true);
        }
      }
    }
  });

  test("каждый пункт входит хотя бы в одну шкалу", () => {
    /*
     * Пункт, не попавший ни в один ключ, — вопрос, который человек
     * заполняет впустую. У опросников каталога таких быть не должно: все
     * восемь суммируют все свои пункты.
     */
    for (const entry of CATALOG) {
      const used = new Set((entry.draft.scales ?? []).flatMap((s) => (s.key ?? []).map((k) => k.item)));
      const total = entry.draft.questions?.length ?? 0;
      for (let i = 1; i <= total; i++) {
        expect(used.has(i), `«${entry.key}»: пункт ${i} не входит ни в одну шкалу`).toBe(true);
      }
    }
  });

  test("ключи каталога уникальны", () => {
    const keys = CATALOG.map((e) => e.key);
    expect(new Set(keys).size, "два разных опросника делят один ключ каталога").toBe(keys.length);
  });
});

describe("установка", () => {
  test("повторный прогон не заводит вторую копию", async () => {
    /*
     * Установщик пойдёт на каждом выкате. Вторая копия методики означает
     * разошедшуюся динамику: половина замеров человека у одной копии,
     * половина у другой, и график разваливается ровно там, где он нужен.
     */
    const first = await installCatalog();
    const second = await installCatalog();

    expect(second.installed, "второй прогон снова что-то поставил").toEqual([]);
    expect(second.skipped.length).toBe(CATALOG.length);
    expect(second.departmentCreated, "второй прогон завёл второе отделение").toBe(false);
    expect(second.departmentId).toBe(first.departmentId);

    const keys = CATALOG.map((e) => e.key);
    const rows = await db.select().from(surveys).where(inArray(surveys.catalogKey, keys));
    expect(rows.length, "методик каталога в базе больше, чем ключей").toBe(keys.length);
  });

  test("общедоступные методики опубликованы и доступны без назначения", async () => {
    await installCatalog();
    const rows = await db.select().from(surveys).where(eq(surveys.visibility, "public"));
    const fromCatalog = rows.filter((r) => r.catalogKey);
    expect(fromCatalog.length).toBeGreaterThan(0);
    for (const row of fromCatalog) {
      expect(row.status, `«${row.catalogKey}» не опубликована — пройти её нельзя`).toBe("published");
      expect(row.scoringEnabled, `«${row.catalogKey}» без подсчёта — полосы не назначатся`).toBe(true);
    }
  });
});
