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

describe("палитра одна на все приложения", () => {
  test("у каждой степени есть заливка и текст в обеих темах", async () => {
    const { SEVERITY_FILL, SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT, SEVERITY_KEY } = await import("./palette");
    for (const sev of ["none", "mild", "moderate", "severe"] as const) {
      for (const set of [SEVERITY_FILL, SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT]) {
        expect(set[sev]).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(SEVERITY_KEY[sev] in UI).toBe(true);
    }
  });

  test("цвет текста проходит порог контраста на своей подложке", async () => {
    /*
     * Считаем, а не доверяем глазу. Порог 4.5:1 — тот же, что проверяет
     * смоук доступности; здесь он закреплён на уровне палитры, чтобы
     * подобранный «на глаз» оттенок не проехал в мобильное приложение,
     * где axe не работает.
     */
    const { SEVERITY_TEXT_DARK, SEVERITY_TEXT_LIGHT } = await import("./palette");
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    for (const sev of ["none", "mild", "moderate", "severe"] as const) {
      expect(ratio(SEVERITY_TEXT_DARK[sev], "#16191f")).toBeGreaterThanOrEqual(4.5);
      expect(ratio(SEVERITY_TEXT_LIGHT[sev], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });
});
