import { describe, expect, test } from "bun:test";
import { CHARTS, PALETTES, SEVERITIES, chartDark, chartNight, dark, light, night } from "../src/palettes";
import { FONT, font, setFontsLoaded, weightOf } from "../src/fonts";

/**
 * Палитры приложения — «Виразна» в трёх темах.
 *
 * Контраст проверяется числом, а не глазами: телефон читают в казарме после
 * отбоя и в кабинете без окна, и палитра, ушедшая ниже порога, превращает
 * заботу о глазах в испорченный протокол.
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

/** Пары «текст × поверхность», ниже порога; пустой список — всё читается */
function below(fg: string, bgs: string[], min: number): string[] {
  return bgs.filter((bg) => contrast(fg, bg) < min).map((bg) => `${fg} на ${bg}: ${contrast(fg, bg).toFixed(2)}`);
}

describe("контраст палитр", () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    const surfaces = [p.ground, p.panel, p.panel2, p.sunk, p.sunk2, p.band, p.bcard, p.vtint];

    test(`${name}: основной и второй текст читаются на любой поверхности`, () => {
      // 4.5:1 — граница WCAG AA для обычного текста
      expect(below(p.text, surfaces, 4.5)).toEqual([]);
      expect(below(p.text2, surfaces, 4.5)).toEqual([]);
    });

    test(`${name}: приглушённый текст не ниже 5:1 — правило консоли`, () => {
      /*
       * Приглушённым набраны подписи строк и подсказки под полями — на
       * телефоне это 14 px, и 4.5 для них мало в плохом свете.
       */
      expect(below(p.muted, surfaces, 5)).toEqual([]);
    });

    test(`${name}: фиолетовый текст и текст на заливках`, () => {
      expect(below(p.vink, [p.ground, p.panel, p.band, p.bcard, p.vtint, p.vtint2], 4.5)).toEqual([]);
      // белый на фиолетовой и красной заливке — основная кнопка, звонок 103
      expect(contrast(p.onfill, p.v)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.onfill, p.risk)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.primaryText, p.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.tipink, p.tipbg)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${name}: статусы читаются на своей подложке и на листе`, () => {
      const pairs: [string, string][] = [
        [p.riskink, p.risktint],
        [p.riskink, p.risktint2],
        [p.warn, p.warntint],
        [p.warn, p.warntint2],
        [p.good, p.goodtint],
        [p.info, p.infotint],
      ];
      const failed = pairs
        .filter(([fg, bg]) => contrast(fg, bg) < 4.5)
        .map(([fg, bg]) => `${fg} на ${bg}: ${contrast(fg, bg).toFixed(2)}`);
      expect(failed).toEqual([]);
      expect(below(p.riskink, [p.panel, p.ground], 4.5)).toEqual([]);
      expect(below(p.danger, [p.bg, p.card], 4.5)).toEqual([]);
    });

    test(`${name}: рамка поля видна — 3:1 к листу и к земле`, () => {
      // поле, которое теряется в плохом свете, человек не находит и не заполняет
      expect(below(p.field, [p.panel, p.ground, p.bcard], 3)).toEqual([]);
    });
  }

  test("ступени выраженности читаются на своих подложках во всех темах", () => {
    const failed: string[] = [];
    for (const [name, s] of Object.entries(SEVERITIES)) {
      s.steps.forEach((color, i) => {
        const bg = s.stepTints[i]!;
        if (contrast(color, bg) < 4.5) failed.push(`${name} s${i}: ${contrast(color, bg).toFixed(2)}`);
      });
    }
    expect(failed).toEqual([]);
  });

  test("прежние имена ведут на набор", () => {
    // экраны, ещё не переписанные, уже стоят в новой палитре
    for (const p of [light, dark, night]) {
      expect(p.bg).toBe(p.ground);
      expect(p.card).toBe(p.panel);
      expect(p.cardAlt).toBe(p.sunk);
      expect(p.accent).toBe(p.warn);
      expect(p.danger).toBe(p.riskink);
    }
    expect(light.primary).toBe(light.v);
    // в тёмных темах основной — светлая ступень: он и текст, и мелкая заливка
    expect(dark.primary).toBe(dark.vink);
    expect(night.primary).toBe(night.vink);
  });
});

describe("ночная тема", () => {
  test("тусклее тёмной: земля темнее, текст тусклее, контраст ниже", () => {
    // иначе это просто ещё одна тёмная тема, и смысла в ней нет
    expect(luminance(night.ground)).toBeLessThan(luminance(dark.ground));
    expect(luminance(night.panel)).toBeLessThan(luminance(dark.panel));
    expect(luminance(night.text)).toBeLessThan(luminance(dark.text));
    expect(luminance(night.vink)).toBeLessThan(luminance(dark.vink));
    expect(contrast(night.text, night.panel)).toBeLessThan(contrast(dark.text, dark.panel));
  });

  test("ряды графиков те же и в том же порядке, что днём", () => {
    // серия «первая» обязана оставаться первой: иначе один график днём и ночью красил бы разные ряды одним цветом
    expect(chartNight.series).toEqual(chartDark.series);
    for (const c of Object.values(CHARTS)) expect(c.series).toHaveLength(5);
  });

  test("выраженность ночью не приглушается", () => {
    // риск не становится меньше оттого, что отбой
    expect(SEVERITIES.night).toBe(SEVERITIES.dark);
  });
});

describe("шрифт", () => {
  test("до загрузки — системный шрифт с весом, после — файл начертания без веса", () => {
    setFontsLoaded(false);
    expect(font(700)).toEqual({ fontWeight: "700" });
    setFontsLoaded(true);
    /*
     * Вес рядом с именем файла Android и браузер понимают как «дорисуй
     * жирность» — поверх уже жирного начертания выходит размазанный текст.
     */
    expect(font(700)).toEqual({ fontFamily: "Manrope-Bold" });
    expect(Object.keys(font(800))).toEqual(["fontFamily"]);
    setFontsLoaded(false);
  });

  test("вес из прежней разметки сводится к начертанию набора", () => {
    expect(weightOf("bold")).toBe(700);
    expect(weightOf("600")).toBe(600);
    expect(weightOf(650)).toBe(700);
    expect(weightOf("normal")).toBe(400);
    expect(weightOf(undefined)).toBe(400);
    expect(weightOf(900)).toBe(800);
    expect(weightOf(300)).toBe(400);
  });

  test("у каждого начертания свой файл", () => {
    expect(new Set(Object.values(FONT)).size).toBe(5);
  });
});
