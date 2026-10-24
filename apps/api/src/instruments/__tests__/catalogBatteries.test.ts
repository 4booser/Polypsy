import { describe, expect, test } from "bun:test";
import { batteryInputSchema, CONTENT_LANGS, t } from "@quizzy/shared";
import { CATALOG } from "../catalog";
import { CATALOG_BATTERIES, CATALOG_BATTERY_LANG } from "../catalogBatteries";

/**
 * Наборы-заготовки каталога (catalogBatteries.ts) — без базы.
 *
 * Установщик терпит методику, которой нет: пропускает её с записью в лог и
 * заводит набор без неё (lib/catalogInstall.ts). Здесь — строже: заготовка в
 * репозитории ссылается только на существующие ключи. Иначе опечатка или
 * переименование ключа доехали бы до базы набором без шага, и дополнить его
 * установщик уже не вправе — набор с первой установки принадлежит отделению.
 */
describe("наборы-заготовки каталога", () => {
  const catalogKeys = new Set(CATALOG.map((e) => e.key));

  test("ключи заготовок уникальны", () => {
    const keys = CATALOG_BATTERIES.map((b) => b.key);
    expect(new Set(keys).size, "две заготовки делят один batteries.catalog_key").toBe(keys.length);
  });

  test("состав — существующие ключи каталога, без повторов", () => {
    for (const b of CATALOG_BATTERIES) {
      const items = b.items.map((i) => i.key);
      expect(items.filter((k) => !catalogKeys.has(k)), `«${b.key}»: нет в CATALOG`).toEqual([]);
      // повтор упёрся бы в первичный ключ battery_items (набор, методика) и уронил бы выкат
      expect(new Set(items).size, `«${b.key}»: методика дважды`).toBe(items.length);
      expect(items.length, `«${b.key}»: пустой набор не назначить`).toBeGreaterThan(0);
    }
  });

  test("название и описание — на обоих языках содержимого, украинский без русских букв", () => {
    for (const b of CATALOG_BATTERIES) {
      for (const lang of CONTENT_LANGS) {
        expect(b.title[lang]?.trim(), `«${b.key}»: нет названия (${lang})`).toBeTruthy();
        expect(b.description[lang]?.trim(), `«${b.key}»: нет описания (${lang})`).toBeTruthy();
      }
      const uk = `${b.title.uk} ${b.description.uk}`;
      expect([...uk].filter((ch) => "ыъэёЫЪЭЁ".includes(ch)), `«${b.key}»: русские буквы в украинском`).toEqual([]);
    }
  });

  test("отделение сохранит заготовку в редакторе наборов без правок", () => {
    /*
     * Строка набора, которую пишет установщик, должна проходить ту же схему,
     * что правка набора (PUT /api/batteries/:id): иначе первое же сохранение в
     * редакторе упёрлось бы в отказ по длине названия или описания.
     */
    for (const b of CATALOG_BATTERIES) {
      const parsed = batteryInputSchema.safeParse({
        title: t(b.title, CATALOG_BATTERY_LANG),
        description: t(b.description, CATALOG_BATTERY_LANG),
        strictOrder: b.strictOrder,
        items: b.items.map((i) => ({ surveyId: i.key, required: i.required ?? true })),
      });
      expect(parsed.success, `«${b.key}»: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(true);
    }
  });
});
