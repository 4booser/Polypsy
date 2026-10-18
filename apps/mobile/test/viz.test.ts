import { describe, expect, test } from "bun:test";
import { boxStatsOf, dailyBuckets, formatShort, heatStep, lineRuns, niceTicks, xFractions } from "../src/components/viz/math";
import { bandOf, courseLayout } from "../src/components/viz/course";

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

describe("тепловая лестница", () => {
  test("доля от максимума — ступень 0…4, края не выходят за лестницу", () => {
    expect(heatStep(0)).toBe(0);
    expect(heatStep(0.19)).toBe(0);
    expect(heatStep(0.2)).toBe(1);
    expect(heatStep(0.99)).toBe(4);
    expect(heatStep(1)).toBe(4);
    expect(heatStep(Number.NaN)).toBe(0);
    expect(heatStep(-1)).toBe(0);
  });
});

/*
 * График курса: решения раскладки, которые видит специалист. PHQ-9 из
 * набора: 19 → 16 → 14 за 24.08, 11.09, 08.10.
 */
describe("график курса", () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 7, 24, 12);
  const PHQ_BANDS = [
    { from: 0, to: 5, label: "a" },
    { from: 5, to: 10, label: "b" },
    { from: 10, to: 15, label: "c" },
    { from: 15, to: 20, label: "d" },
    { from: 20, to: 27, label: "e" },
  ];
  const points = [
    { t: t0, label: "24.08", value: 19 },
    { t: t0 + 18 * day, label: "11.09", value: 16 },
    { t: t0 + 45 * day, label: "08.10", value: 14 },
  ];
  const lay = (extra: Partial<Parameters<typeof courseLayout>[0]> = {}) =>
    courseLayout({ points, max: 27, bands: PHQ_BANDS, width: 326, ...extra });

  test("полоса последнего замера — текущая, остальные чередуются", () => {
    expect(bandOf(PHQ_BANDS, 14)!.label).toBe("c");
    // верхняя граница последней полосы — её же: 27 из 27 — тяжёлая, а не «вне шкалы»
    expect(bandOf(PHQ_BANDS, 27)!.label).toBe("e");
    expect(lay().bands.map((b) => b.cls)).toEqual(["b0", "b1", "bc", "b1", "b0"]);
  });

  test("время идёт слева направо, меньший балл — ниже", () => {
    const { pts } = lay();
    expect(pts[0]!.x).toBeLessThan(pts[1]!.x);
    expect(pts[1]!.x).toBeLessThan(pts[2]!.x);
    expect(pts[2]!.y).toBeGreaterThan(pts[0]!.y);
    // 18 и 27 дней между замерами — разные промежутки и на графике
    expect(pts[2]!.x - pts[1]!.x).toBeGreaterThan(pts[1]!.x - pts[0]!.x);
  });

  test("межі похибки — от базового замера ± порог; без порога зоны нет", () => {
    const { zone } = lay({ rc: 5 });
    const Y = (v: number) => 26 + 156 * (1 - v / 27);
    expect(zone!.y0).toBeCloseTo(Y(24));
    expect(zone!.y1).toBeCloseTo(Y(14));
    expect(lay({ rc: null }).zone).toBeNull();
    expect(lay().zone).toBeNull();
  });

  test("«сьогодні» рисуется рядом с замерами и не рисуется через полгода", () => {
    const near = lay({ today: t0 + 47 * day });
    expect(near.todayX).not.toBeNull();
    expect(near.pts[2]!.x).toBeLessThan(near.todayX!);
    expect(lay({ today: t0 + 400 * day }).todayX).toBeNull();
    // сегодняшний замер подписан жирно
    expect(lay({ today: t0 + 45 * day + 3_600_000 }).pts[2]!.isToday).toBe(true);
  });

  test("тесные даты прячутся, последняя видна всегда", () => {
    const dense = [0, 1, 2, 3, 40].map((d, i) => ({ t: t0 + d * day, label: `d${i}`, value: 10 }));
    const { pts } = courseLayout({ points: dense, max: 27, width: 326 });
    expect(pts[0]!.dateHidden).toBe(false);
    expect(pts.slice(1, 4).every((p) => p.dateHidden)).toBe(true);
    expect(pts[4]!.dateHidden).toBe(false);
  });

  test("деления оси — границы полос и верх шкалы, без слипшихся", () => {
    const { ticks } = lay();
    expect(ticks.map((t) => t.v)).toEqual([27, 20, 15, 10, 5, 0]);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.y - ticks[i - 1]!.y).toBeGreaterThanOrEqual(12);
  });

  test("один замер — посередине; зоны нажатия покрывают всё поле без зазоров", () => {
    const one = courseLayout({ points: [points[0]!], max: 27, width: 326 });
    expect(one.pts[0]!.x).toBeCloseTo(26 + one.plotWidth / 2);
    const { hits, left, plotWidth } = lay();
    expect(hits[0]!.x0).toBe(left);
    expect(hits.at(-1)!.x1).toBe(left + plotWidth);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.x0).toBe(hits[i - 1]!.x1);
  });
});
