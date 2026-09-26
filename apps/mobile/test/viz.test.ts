import { describe, expect, test } from "bun:test";
import { boxStatsOf, dailyBuckets, formatShort, lineRuns, niceTicks, xFractions } from "../src/components/viz/math";

describe("деления оси", () => {
  test("круглые значения вместо дробных", () => {
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
  });

  test("последнее деление покрывает максимум", () => {
    // иначе верхняя точка графика уходит за сетку
    for (const max of [3, 7, 12, 45, 99, 137, 4820]) {
      const ticks = niceTicks(max);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
    }
  });

  test("пустые данные не превращаются в бесконечный цикл", () => {
    /*
     * max = 0 бывает всегда, когда за период нет ни одного прохождения.
     * Без этой проверки шаг вышел бы нулевым и цикл не завершился —
     * экран просто повис бы.
     */
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(-5)).toEqual([0]);
    expect(niceTicks(Number.NaN)).toEqual([0]);
  });

  test("дробный масштаб тоже разбивается ровно", () => {
    // доли (шкала лжи СР-45) живут в диапазоне 0..1
    expect(niceTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});

describe("короткое число", () => {
  test("тысячи сокращаются", () => {
    expect(formatShort(1240)).toBe("1.2k");
    expect(formatShort(9034)).toBe("9k");
  });

  test("малые числа остаются точными", () => {
    expect(formatShort(0)).toBe("0");
    expect(formatShort(7.25)).toBe("7.25");
    expect(formatShort(0.333)).toBe("0.33");
  });

  test("не-число не попадает на ось как NaN", () => {
    expect(formatShort(Number.NaN)).toBe("—");
  });
});

describe("квартили", () => {
  test("считаются с интерполяцией", () => {
    // 1..9: медиана 5, квартили ровно на элементах
    expect(boxStatsOf("A", [1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({
      label: "A",
      min: 1,
      q1: 3,
      median: 5,
      q3: 7,
      max: 9,
      n: 9,
    });
    // чётная выборка: медиана между элементами, а не «ближайший»
    expect(boxStatsOf("B", [1, 2, 3, 4])!.median).toBe(2.5);
    expect(boxStatsOf("B", [1, 2, 3, 4])!.q1).toBe(1.75);
  });

  test("порядок входа не важен", () => {
    const a = boxStatsOf("x", [5, 1, 9, 3, 7]);
    const b = boxStatsOf("x", [9, 7, 5, 3, 1]);
    expect(a).toEqual(b!);
  });

  test("исходный массив не переставляется", () => {
    // он приходит из состояния экрана: сортировка на месте испортила бы список
    const values = [3, 1, 2];
    boxStatsOf("x", values);
    expect(values).toEqual([3, 1, 2]);
  });

  test("одно значение — вырожденный ящик, а не ошибка", () => {
    expect(boxStatsOf("x", [4])).toEqual({ label: "x", min: 4, q1: 4, median: 4, q3: 4, max: 4, n: 1 });
  });

  test("пустая выборка — null, а не нули", () => {
    // нулевой ящик нарисовался бы как настоящий результат «все по нулям»
    expect(boxStatsOf("x", [])).toBeNull();
  });
});

/*
 * Линия во времени: дни без замеров — разрыв, а не соседние точки.
 *
 * Дефект: сервер отдаёт счёт только за дни, когда что-то было, и график
 * ставил их подряд — три недели тишины выглядели как соседние сутки, а линия
 * шла через пустоту. В веб-наборе (TimeLines) у пустой корзины null и линия
 * рвётся; теперь так же.
 */
describe("счёт по дням", () => {
  test("у каждого дня своё место; день без замера — null", () => {
    expect(
      dailyBuckets([
        { date: "2026-03-01", count: 4 },
        { date: "2026-03-04", count: 2 },
      ]),
    ).toEqual([
      { x: "03-01", y: 4 },
      { x: "03-02", y: null },
      { x: "03-03", y: null },
      { x: "03-04", y: 2 },
    ]);
  });

  test("порядок и повторы дня не важны; переход месяца считается честно", () => {
    expect(
      dailyBuckets([
        { date: "2026-03-01", count: 1 },
        { date: "2026-02-28", count: 2 },
        { date: "2026-03-01", count: 3 },
      ]),
    ).toEqual([
      { x: "02-28", y: 2 },
      { x: "03-01", y: 4 },
    ]);
  });

  test("пусто — пусто", () => {
    expect(dailyBuckets([])).toEqual([]);
  });
});

describe("отрезки линии", () => {
  test("null рвёт линию; одиночный замер — свой отрезок из одной точки", () => {
    expect(lineRuns([1, 2, null, null, 5, null, 7, 8])).toEqual([[0, 1], [4], [6, 7]]);
  });

  test("без пропусков — одна линия, как было", () => {
    expect(lineRuns([3, 1, 4])).toEqual([[0, 1, 2]]);
    expect(lineRuns([null, null])).toEqual([]);
  });
});

describe("ось X", () => {
  test("у всех точек есть момент — ось по времени: месяц между замерами — месяц на графике", () => {
    const day = 86_400_000;
    const [xs] = xFractions([{ points: [{ t: 0 }, { t: day }, { t: 31 * day }] }]);
    expect(xs![0]).toBe(0);
    expect(xs![1]).toBeCloseTo(1 / 31);
    expect(xs![2]).toBe(1);
  });

  test("моментов нет — равные шаги по номеру, общие для рядов", () => {
    expect(xFractions([{ points: [{}, {}, {}] }, { points: [{}, {}] }])).toEqual([
      [0, 0.5, 1],
      [0, 0.5],
    ]);
  });

  test("одна точка — посередине", () => {
    expect(xFractions([{ points: [{ t: 5 }] }])).toEqual([[0.5]]);
    expect(xFractions([{ points: [{}] }])).toEqual([[0.5]]);
  });
});
