import { describe, expect, test } from "bun:test";
import { cronbachAlpha, median, pearson, percent, quantile, round, variance } from "./stats";

describe("статистика", () => {
  test("median: нечётное, чётное, пустое", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test("quantile: границы, середина и интерполяция", () => {
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(quantile(nine, 0)).toBe(1);
    expect(quantile(nine, 1)).toBe(9);
    expect(quantile(nine, 0.5)).toBe(5);
    // четверть от восьми промежутков — ровно третье наблюдение
    expect(quantile(nine, 0.25)).toBe(3);
    // а на четырёх наблюдениях четверть приходится между первым и вторым
    expect(quantile([10, 20, 30, 40], 0.25)).toBe(17.5);
    expect(quantile([], 0.5)).toBe(0);
    // порядок на входе неважен: выборка сортируется внутри
    expect(quantile([9, 1, 5], 0.5)).toBe(5);
  });

  test("quantile: выброс не двигает коробку, но двигает край", () => {
    /*
     * Ради этого квартили и заведены. Один человек, отвлёкшийся на телефон,
     * растягивает максимум вчетверо — и график по краям показывает его, а не
     * то, сколько пункт занимает у людей.
     */
    const times = [3, 3, 4, 4, 4, 5, 5, 5, 6, 60];
    expect(Math.max(...times)).toBe(60);
    expect(quantile(times, 0.75)).toBeLessThan(6);
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
