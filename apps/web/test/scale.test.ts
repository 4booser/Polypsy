import { describe, expect, test } from "bun:test";
import { axisFor } from "../src/charts/scale";

/**
 * Ось графика.
 *
 * Проверяется не «красиво ли», а два обещания сразу, и они тянут в разные
 * стороны. Ось обязана показывать разброс — иначе все графики одинаковы; и
 * ось обязана не выдумывать разброс — иначе шум выглядит как событие.
 * Каждая проверка здесь про одно из двух.
 */

/** Какую долю поля занимают данные */
const filled = (lo: number, hi: number, atom = 0) => {
  const a = axisFor({ lo, hi, atom });
  return (hi - lo) / (a.max - a.min);
};

describe("ось по данным", () => {
  test("верх идёт по данным, а не по теоретическому максимуму", () => {
    /*
     * Ровно та поломка, ради которой модуль написан: PHQ-9 рисовался на
     * 0–27, потому что 27 — максимум опросника, а замеры человека жили в
     * полосе 12–18.
     */
    const a = axisFor({ lo: 12, hi: 18 });
    expect(a.max).toBeLessThan(27);
    expect(filled(12, 18)).toBeGreaterThan(0.5);
  });

  test("полоса ошибки расширяет данные и возвращает ноль на место", () => {
    /*
     * Тот же ряд 12–18, но с SEM = 2.5 рисуется полоса 9.5–20.5. Она уже
     * занимает половину поля от нуля — срезать низ незачем, и ось остаётся
     * от нуля, как ей и положено.
     */
    const a = axisFor({ lo: 9.5, hi: 20.5, atom: 5 });
    expect(a.min).toBe(0);
    expect(a.zoomed).toBe(false);
  });

  test("ноль остаётся на месте, пока под данными не пусто", () => {
    // ряд начинается почти от нуля — срезать нечего
    const a = axisFor({ lo: 1, hi: 25 });
    expect(a.min).toBe(0);
    expect(a.zoomed).toBe(false);
  });

  test("узкая полоса высоко над нулём разворачивается и помечается", () => {
    const a = axisFor({ lo: 61, hi: 65 });
    expect(a.zoomed).toBe(true);
    expect(a.min).toBeGreaterThan(0);
    expect(filled(61, 65)).toBeGreaterThan(0.5);
  });

  test("широкий разброс не срезается, даже если начинается высоко", () => {
    // половина поля — это уже читаемый график, двигать ноль не за чем
    const a = axisFor({ lo: 40, hi: 100 });
    expect(a.zoomed).toBe(false);
  });
});

describe("ось не выдумывает разброс", () => {
  test("колебание меньше ошибки измерения остаётся плоским", () => {
    /*
     * Три замера T-балла 62, 63, 64 при SEM = 4 — это одно и то же
     * измерение. Ось, подогнанная под разницу в два балла, показала бы
     * уверенный рост.
     */
    const withoutError = filled(62, 64, 0);
    const withError = filled(62, 64, 4);
    expect(withError).toBeLessThan(0.25);
    expect(withError).toBeLessThan(withoutError);
  });

  test("одинаковые значения не разворачиваются в размах", () => {
    const a = axisFor({ lo: 7, hi: 7, atom: 1 });
    expect(a.max).toBeGreaterThan(a.min);
    expect(a.max - a.min).toBeGreaterThanOrEqual(3);
  });

  test("пустых данных хватает на сетку, а не на деление на ноль", () => {
    const a = axisFor({ lo: 0, hi: 0 });
    expect(a.max).toBeGreaterThan(a.min);
    expect(a.ticks.length).toBeGreaterThan(1);
    expect(a.ticks.every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe("сетка", () => {
  test("подписи круглые, без хвостов двоичной дроби", () => {
    for (const [lo, hi] of [
      [0, 133],
      [0, 0.9],
      [12, 18],
      [61, 65],
      [0, 27],
      [3.4, 6.02],
    ] as [number, number][]) {
      const a = axisFor({ lo, hi });
      for (const t of a.ticks) {
        expect(String(t).replace("-", "").replace(".", "").length).toBeLessThanOrEqual(6);
      }
    }
  });

  test("сетка не гуще пяти промежутков и покрывает данные целиком", () => {
    for (const [lo, hi] of [
      [0, 1],
      [0, 7],
      [0, 133],
      [12, 18],
      [61, 65],
      [0, 4321],
      [0.2, 0.35],
    ] as [number, number][]) {
      const a = axisFor({ lo, hi });
      expect(a.ticks.length).toBeLessThanOrEqual(6);
      expect(a.ticks[0]).toBeCloseTo(a.min, 6);
      expect(a.ticks.at(-1)).toBeCloseTo(a.max, 6);
      expect(a.max).toBeGreaterThanOrEqual(hi);
      expect(a.min).toBeLessThanOrEqual(lo);
    }
  });
});

describe("на настоящих данных стало лучше", () => {
  test("динамика шкалы занимает больше поля, чем на теоретической оси", () => {
    /*
     * Числа не выдуманы: это ряды с демонстрационной базы, где занятая
     * высота при оси 0..maxScore была медианно 19%. Проверка держит именно
     * то улучшение, ради которого всё делалось.
     */
    const rows: [number, number, number][] = [
      // lo, hi, maxScore
      [9.5, 20.5, 27],
      [4, 9, 21],
      [16, 18, 40],
      [1, 5, 25],
      [61, 68, 100],
    ];
    for (const [lo, hi, full] of rows) {
      const before = (hi - lo) / Math.max(full, hi);
      const a = axisFor({ lo, hi });
      const after = (hi - lo) / (a.max - a.min);
      expect(after).toBeGreaterThan(before);
    }
  });
});
