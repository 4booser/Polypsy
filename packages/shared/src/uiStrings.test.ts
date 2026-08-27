import { describe, expect, test } from "bun:test";
import { UI, makeUiT, detectLang, type UiKey } from "./uiStrings";

/**
 * Словарь оболочки.
 *
 * Проверяется не перевод — его качество тестом не поймать, — а полнота и
 * отсутствие подделок. Ключ с пустым или совпадающим переводом означает, что
 * человек, переключивший язык, увидит чужой: половина экрана на украинском,
 * половина на русском. Это хуже, чем один язык честно.
 */
const entries = Object.entries(UI) as [UiKey, { uk: string; ru: string }][];

describe("словарь оболочки", () => {
  test("у каждого ключа есть оба языка и оба непустые", () => {
    const broken = entries
      .filter(([, v]) => !v.uk?.trim() || !v.ru?.trim())
      .map(([k]) => k);
    expect(broken).toEqual([]);
  });

  test("нет ключей, где украинский — копия русского", () => {
    /*
     * Совпадение допустимо там, где слово одинаково в обоих языках
     * («Email», «Методики»), поэтому запрещаем только длинные фразы: их
     * совпадение почти наверняка значит «скопировал и не перевёл».
     */
    const suspicious = entries
      .filter(([, v]) => v.uk === v.ru && v.ru.length > 24)
      .map(([k, v]) => `${k}: ${v.ru}`);
    expect(suspicious).toEqual([]);
  });

  test("перевод возвращает строку для любого ключа", () => {
    for (const lang of ["uk", "ru"] as const) {
      const t = makeUiT(lang);
      for (const [key] of entries) {
        expect(typeof t(key)).toBe("string");
        expect(t(key).length).toBeGreaterThan(0);
      }
    }
  });

  test("язык определяется по настройкам браузера, украинский по умолчанию", () => {
    expect(detectLang(["uk-UA", "en"])).toBe("uk");
    expect(detectLang(["ru-RU"])).toBe("ru");
    expect(detectLang(["en-US"])).toBe("uk");
    expect(detectLang([])).toBe("uk");
  });
});
