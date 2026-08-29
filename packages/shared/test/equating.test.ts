import { describe, expect, test } from "bun:test";
import {
  applyEquating,
  equate,
  equatingShift,
  MIN_EQUATING_SAMPLE,
  type VersionMoments,
} from "../src/equating";

/**
 * Приведение баллов между версиями методики.
 *
 * Ошибка здесь не видна глазами: приведённый балл выглядит как обычный.
 * Поэтому проверяется и арифметика, и все случаи, где правильный ответ —
 * «приводить нельзя», а не «приведено с коэффициентом 1».
 */

const v = (over: Partial<VersionMoments> = {}): VersionMoments => ({
  version: 1,
  n: 100,
  mean: 20,
  sd: 5,
  ...over,
});

describe("коэффициенты", () => {
  test("совпадающие моменты дают тождественное преобразование", () => {
    const eq = equate(v({ version: 1 }), v({ version: 2 }))!;
    expect(eq.slope).toBe(1);
    expect(eq.intercept).toBe(0);
    expect(applyEquating(17, eq)).toBe(17);
  });

  test("разный разброс масштабирует", () => {
    // во второй версии разброс вдвое больше — отклонение от среднего удваивается
    const eq = equate(v({ version: 1, sd: 5 }), v({ version: 2, sd: 10 }))!;
    expect(eq.slope).toBe(2);
    expect(applyEquating(20, eq)).toBe(20); // среднее остаётся средним
    expect(applyEquating(25, eq)).toBe(30); // +1 SD остаётся +1 SD
    expect(applyEquating(15, eq)).toBe(10); // −1 SD остаётся −1 SD
  });

  test("разное среднее сдвигает", () => {
    const eq = equate(v({ version: 1, mean: 20 }), v({ version: 2, mean: 30 }))!;
    expect(applyEquating(20, eq)).toBe(30);
    expect(applyEquating(25, eq)).toBe(35);
  });

  test("положение относительно среднего сохраняется всегда", () => {
    /*
     * Главное свойство приведения: человек, бывший на полтора отклонения выше
     * среднего своей версии, остаётся на полтора отклонения выше среднего
     * целевой. Если это нарушится, приведение будет двигать людей по шкале.
     */
    const from = v({ version: 1, mean: 12, sd: 3 });
    const to = v({ version: 2, mean: 40, sd: 8 });
    const eq = equate(from, to)!;

    const raw = from.mean + 1.5 * from.sd;
    const z = (applyEquating(raw, eq) - to.mean) / to.sd;
    expect(z).toBeCloseTo(1.5, 6);
  });
});

describe("когда приводить нельзя", () => {
  test("одна и та же версия", () => {
    // приводить версию к себе — это не «коэффициент 1», это бессмысленный вопрос
    expect(equate(v({ version: 3 }), v({ version: 3 }))).toBeNull();
  });

  test("малая выборка", () => {
    /*
     * Ниже порога стандартная ошибка SD такова, что коэффициент масштаба
     * гуляет на десятки процентов: приведение начнёт добавлять больше шума,
     * чем убирать несравнимости.
     */
    expect(equate(v({ version: 1, n: MIN_EQUATING_SAMPLE - 1 }), v({ version: 2 }))).toBeNull();
    expect(equate(v({ version: 1 }), v({ version: 2, n: MIN_EQUATING_SAMPLE - 1 }))).toBeNull();
    expect(equate(v({ version: 1, n: MIN_EQUATING_SAMPLE }), v({ version: 2 }))).not.toBeNull();
  });

  test("нулевой разброс", () => {
    // все ответили одинаково: делить не на что, и шкалы в этой версии нет
    expect(equate(v({ version: 1, sd: 0 }), v({ version: 2 }))).toBeNull();
    expect(equate(v({ version: 1 }), v({ version: 2, sd: 0 }))).toBeNull();
  });

  test("нечисловые моменты", () => {
    expect(equate(v({ version: 1, sd: Number.NaN }), v({ version: 2 }))).toBeNull();
  });
});

describe("цена приведения", () => {
  test("сдвиг показывает, насколько версии разошлись", () => {
    /*
     * Полбалла — деталь. Пять баллов означают, что версии различаются сильно,
     * и «динамика» между ними без приведения была бы выдумкой.
     */
    const small = equate(v({ version: 1, mean: 20 }), v({ version: 2, mean: 20.5 }))!;
    expect(Math.abs(equatingShift(20, small))).toBeLessThan(1);

    const large = equate(v({ version: 1, mean: 20 }), v({ version: 2, mean: 28 }))!;
    expect(equatingShift(20, large)).toBe(8);
  });

  test("коэффициенты и выборки возвращаются вместе с результатом", () => {
    // решение показывать приведённый балл принимает тот, кто знает, менялся ли
    // контингент, — значит ему нужны основания, а не одно число
    const eq = equate(v({ version: 1, n: 120 }), v({ version: 2, n: 80 }))!;
    expect(eq.from.n).toBe(120);
    expect(eq.to.n).toBe(80);
    expect(eq.from.version).toBe(1);
    expect(eq.to.version).toBe(2);
  });
});
