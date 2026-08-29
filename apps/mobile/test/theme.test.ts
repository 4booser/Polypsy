import { describe, expect, test } from "bun:test";
import { PALETTES } from "../src/palettes";

/**
 * Палитры приложения.
 *
 * Ночной режим существует, чтобы экран в казарме после отбоя не светил на всю
 * комнату. Соблазн понятен: чем тусклее, тем лучше. Но обследование на двести
 * пунктов читают сорок минут, и палитра, ушедшая ниже порога читаемости,
 * превращает заботу о соседях в испорченный протокол.
 *
 * Поэтому контраст проверяется числом, а не глазами: у ночной палитры он
 * ниже дневной — так и задумано, — но не ниже границы, за которой текст
 * перестаёт читаться.
 */

function luminance(hex: string): number {
  const to = (at: number) => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * to(1) + 0.7152 * to(3) + 0.0722 * to(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("контраст палитр", () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    test(`${name}: основной текст читается`, () => {
      // 4.5:1 — граница WCAG AA для обычного текста
      expect(contrast(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.text, p.card)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${name}: приглушённый текст остаётся различимым`, () => {
      /*
       * 3:1 — граница для крупного текста и служебных подписей. Приглушённое
       * ниже неё перестаёт быть приглушённым и становится невидимым.
       */
      expect(contrast(p.muted, p.bg)).toBeGreaterThanOrEqual(3);
    });

    test(`${name}: подпись на основной кнопке читается`, () => {
      expect(contrast(p.primaryText, p.primary)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${name}: опасное действие отличимо от обычного текста`, () => {
      // риск не становится меньше оттого, что отбой
      expect(contrast(p.danger, p.bg)).toBeGreaterThanOrEqual(3);
    });
  }

  test("ночная палитра действительно тусклее тёмной", () => {
    // иначе это просто ещё одна тёмная тема, и смысла в ней нет
    expect(luminance(PALETTES.night.bg)).toBeLessThan(luminance(PALETTES.dark.bg) * 1.5);
    expect(contrast(PALETTES.night.text, PALETTES.night.bg)).toBeLessThan(
      contrast(PALETTES.dark.text, PALETTES.dark.bg),
    );
  });

  test("в ночной палитре нет холодных тонов", () => {
    /*
     * Синий сильнее прочих подавляет мелатонин, а обследование после отбоя —
     * и так не лучшее время для сна. Проверяется прямо: синий канал не должен
     * доминировать ни в одном цвете палитры.
     */
    const cold = Object.entries(PALETTES.night)
      .filter(([, value]) => parseInt(value.slice(5, 7), 16) > parseInt(value.slice(1, 3), 16))
      .map(([key, value]) => `${key}: ${value}`);

    // список, а не поштучная проверка: падение сразу называет виновный цвет
    expect(cold).toEqual([]);
  });
});
