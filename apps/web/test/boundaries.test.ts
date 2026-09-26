import { describe, expect, test } from "bun:test";
import { axisFor } from "../src/charts/scale";
import { daysLeft, duration } from "../src/format";
import { fmtAgo } from "../src/pages/ops/model";

/**
 * Граничные значения форматирования и оси (волна 12, разбор кода:
 * «форматирование принимало отрицательную длительность за корректную»,
 * «деления графика не покрывали максимум»).
 *
 * Ошибки на границах тихие: экран не падает, а пишет «60 секунд тому»,
 * «сегодня последний день» о прошедшем сроке или обрывает линию у края
 * поля. Поэтому проверяются именно края — ноль, минус, последняя доля перед
 * круглым числом, очень малые и очень большие величины.
 */

describe("длительность в консоли", () => {
  test("отрицательная и нулевая — прочерк, не число", () => {
    expect(duration(-1)).toBe("—");
    expect(duration(-60_000)).toBe("—");
    expect(duration(0)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
  });

  test("последняя доля секунды перед минутой — уже минута", () => {
    // было «60,0 с»: граница проверялась по сырому значению, а печатались десятые
    expect(duration(59_960)).not.toContain("60,0");
    expect(duration(59_960)).toContain("1 ");
  });
});

describe("«тому» и «через»", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const at = (sec: number) => new Date(now + sec * 1000).toISOString();

  test("единица выбирается по округлённому числу", () => {
    // 59,6 с — это «1 хвилину тому», а не «60 секунд тому»
    expect(fmtAgo(at(-59.6), now, "en-GB")).toBe("1 minute ago");
    // 59 мин 40 с — «1 годину тому», а не «60 хвилин тому»
    expect(fmtAgo(at(-(59 * 60 + 40)), now, "en-GB")).toBe("1 hour ago");
    // 23 ч 40 мин — «вчора», а не «24 години тому»
    expect(fmtAgo(at(-(23 * 3600 + 40 * 60)), now, "en-GB")).toBe("yesterday");
  });

  test("будущее — «через», прошлое — «тому», в обе стороны одинаково", () => {
    expect(fmtAgo(at(40 * 60), now, "en-GB")).toBe("in 40 minutes");
    expect(fmtAgo(at(-40 * 60), now, "en-GB")).toBe("40 minutes ago");
    expect(fmtAgo(at(59.6), now, "en-GB")).toBe("in 1 minute");
  });

  test("неразборчивая дата — прочерк, а не «NaN»", () => {
    expect(fmtAgo("not a date", now, "en-GB")).toBe("—");
    expect(fmtAgo(null, now, "en-GB")).toBe("—");
  });
});

describe("сколько дней до срока", () => {
  // полдень по местному времени — чтобы проверка не зависела от пояса машины
  const now = new Date(2026, 8, 26, 12, 0).getTime();

  test("прошедший срок — null, а не «сегодня последний день»", () => {
    expect(daysLeft(new Date(2026, 8, 26, 11, 0).toISOString(), now)).toBeNull();
    expect(daysLeft(new Date(2026, 8, 20).toISOString(), now)).toBeNull();
    expect(daysLeft(new Date(now).toISOString(), now)).toBeNull();
  });

  test("сегодня — 1, завтра утром — 2, хотя до него меньше суток", () => {
    expect(daysLeft(new Date(2026, 8, 26, 23, 30).toISOString(), now)).toBe(1);
    expect(daysLeft(new Date(2026, 8, 27, 9, 0).toISOString(), now)).toBe(2);
    expect(daysLeft(new Date(2026, 9, 3, 9, 0).toISOString(), now)).toBe(8);
  });

  test("неразборчивая дата — null", () => {
    expect(daysLeft("—", now)).toBeNull();
  });
});

describe("ось покрывает данные на краях", () => {
  const covers = (lo: number, hi: number, atom = 0) => {
    const a = axisFor({ lo, hi, atom });
    expect(a.max).toBeGreaterThanOrEqual(hi - Math.abs(hi) * 1e-12);
    expect(a.min).toBeLessThanOrEqual(lo + Math.abs(lo) * 1e-12);
    expect(a.ticks.at(-1)).toBeCloseTo(a.max, 12);
    expect(a.ticks[0]).toBeCloseTo(a.min, 12);
    // деления различимы: соседние не сливаются в одно число
    expect(new Set(a.ticks).size).toBe(a.ticks.length);
    expect(a.max).toBeGreaterThan(a.min);
    return a;
  };

  test("отрицательные значения не уходят за нижний край, ноль остаётся на оси", () => {
    const a = covers(-5, 3);
    expect(a.min).toBeLessThan(0);
    expect(a.ticks).toContain(0);
    expect(a.zoomed).toBe(false);
    const below = covers(-10, -2);
    expect(below.max).toBe(0);
  });

  test("малые доли: верх не ниже максимума, деления не сливаются", () => {
    // было: верх 0,000403 при максимуме 0,0004031 и одно деление на всё поле
    covers(0.000403, 0.00040309);
    covers(0.00141, 0.0014108);
    covers(0, 0.0004);
  });

  test("одинаковые значения без ошибки измерения — ось от нуля, а не одно деление", () => {
    const a = covers(7, 7);
    expect(a.min).toBe(0);
    expect(a.ticks.length).toBeGreaterThan(1);
  });

  test("не-число и бесконечность — вырожденная сетка, а не пустая", () => {
    for (const [lo, hi] of [
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 3],
    ] as [number, number][]) {
      const a = axisFor({ lo, hi });
      expect(a.ticks.length).toBeGreaterThan(1);
      expect(a.ticks.every(Number.isFinite)).toBe(true);
    }
  });

  test("перебор: максимум внутри оси при любом разбросе и порядке величин", () => {
    // детерминированный перебор вместо случайного: провал обязан повторяться
    for (let mag = -4; mag <= 6; mag++) {
      for (const a of [0, 0.1, 0.35, 0.5, 0.9, 0.99]) {
        for (const w of [0, 0.001, 0.05, 0.3, 1, 3]) {
          const lo = a * 10 ** mag;
          const hi = lo + w * 10 ** mag;
          for (const atom of [0, 10 ** mag]) {
            const ax = axisFor({ lo, hi, atom });
            if (ax.max < hi - Math.abs(hi) * 1e-12 || ax.min > lo + Math.abs(lo) * 1e-12) {
              throw new Error(`не покрыто: lo=${lo} hi=${hi} atom=${atom} → ${JSON.stringify(ax)}`);
            }
          }
        }
      }
    }
  });
});
