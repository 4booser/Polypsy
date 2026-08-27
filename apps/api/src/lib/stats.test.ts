import { describe, expect, test } from "bun:test";
import { cronbachAlpha, median, pearson, percent, round, variance } from "./stats";

describe("статистика", () => {
  test("median: нечётное, чётное, пустое", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test("pearson: идеальные корреляции и константа", () => {
    expect(round(pearson([1, 2, 3], [2, 4, 6]), 4)).toBe(1);
    expect(round(pearson([1, 2, 3], [6, 4, 2]), 4)).toBe(-1);
    // константный ряд: дисперсия нулевая, корреляция не определена → 0
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
  });

  test("pearson: эталонный пример, посчитанный вручную", () => {
    // x=[1,2,4,5], y=[1,3,3,5]: r = 0.8944 (счёт руками через ковариацию)
    expect(round(pearson([1, 2, 4, 5], [1, 3, 3, 5]), 3)).toBe(0.894);
  });

  test("cronbachAlpha: эталонная матрица", () => {
    // 2 пункта, идеально согласованные: alpha = 1
    const perfect = [
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    expect(round(cronbachAlpha(perfect) ?? -1, 3)).toBe(1);

    // независимые пункты: alpha около нуля или отрицательная
    const noise = [
      [1, 3],
      [2, 1],
      [3, 2],
    ];
    expect((cronbachAlpha(noise) ?? 1) < 0.5).toBe(true);
  });

  test("cronbachAlpha: вырожденные случаи не считаются", () => {
    expect(cronbachAlpha([])).toBe(null);
    expect(cronbachAlpha([[1, 2]])).toBe(null); // один респондент
    expect(cronbachAlpha([[1], [2]])).toBe(null); // один пункт
  });

  test("percent и variance", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(0, 0)).toBe(0);
    // выборочная дисперсия (делитель n−1): сумма квадратов отклонений 32, n=8 → 32/7
    expect(round(variance([2, 4, 4, 4, 5, 5, 7, 9]), 3)).toBe(4.571);
  });
});
