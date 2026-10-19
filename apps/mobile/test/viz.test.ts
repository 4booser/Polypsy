import { describe, expect, test } from "bun:test";
import { boxStatsOf, formatShort, heatStep, localDecimal, niceTicks } from "../src/components/viz/math";
import { bandOf, courseLayout, labelWidth } from "../src/components/viz/course";

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
    expect(formatShort(1240, "en")).toBe("1.2k");
    expect(formatShort(9034, "en")).toBe("9k");
  });

  test("малые числа остаются точными", () => {
    expect(formatShort(0, "en")).toBe("0");
    expect(formatShort(7.25, "en")).toBe("7.25");
    expect(formatShort(0.333, "en")).toBe("0.33");
  });

  test("дробная часть — запятой по-украински и по-русски", () => {
    expect(formatShort(7.25, "uk")).toBe("7,25");
    expect(formatShort(1240, "ru")).toBe("1,2k");
    expect(formatShort(12, "uk")).toBe("12");
    expect(localDecimal("11.3%", "uk")).toBe("11,3%");
    expect(localDecimal("11.3%", "en")).toBe("11.3%");
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

  test("сегодняшний последний замер — без черты «сьогодні» поверх его точки; «сегодня» говорит жирная дата", () => {
    const L = lay({ today: t0 + 45 * day + 3_600_000 });
    expect(L.todayX).toBeNull();
    expect(L.futureX).toBeNull();
    expect(L.pts[2]!.isToday).toBe(true);
    // поле кончается на последнем замере, а не на пустом «будущем»
    expect(lay({ today: t0 + 45 * day + 3_600_000 }).pts[2]!.x).toBeCloseTo(lay().pts[2]!.x);
  });

  test("черта «сьогодні» не ложится на точку и тогда, когда до неё сутки на долгом курсе", () => {
    const long = [
      { t: t0, label: "24.08", value: 19 },
      { t: t0 + 150 * day, label: "21.01", value: 16 },
      { t: t0 + 300 * day, label: "20.06", value: 14 },
    ];
    const L = courseLayout({ points: long, max: 27, bands: PHQ_BANDS, width: 326, today: t0 + 301 * day });
    expect(L.todayX).toBeNull();
    // а месяц на том же курсе — уже видна, правее точки
    const month = courseLayout({ points: long, max: 27, bands: PHQ_BANDS, width: 326, today: t0 + 330 * day });
    expect(month.todayX).not.toBeNull();
    expect(month.todayX! - month.pts[2]!.x).toBeGreaterThanOrEqual(10);
  });

  /*
   * Слово нижней полосы стоит у правого края, на оси — там же, где метка
   * свежего сигнала. Было: подпись «сигнал» у правого края уходила влево от
   * метки прямо на слово («Дуже низьке благополуччя» у WHO-5), а сама метка
   * садилась под его буквы.
   */
  describe("сигнал на оси и слово полосы", () => {
    const PHQ_WORDS = [
      { from: 0, to: 5, label: "мінімальна" },
      { from: 5, to: 10, label: "легка" },
      { from: 10, to: 15, label: "помірна" },
      { from: 15, to: 20, label: "помірно тяжка" },
      { from: 20, to: 27, label: "тяжка" },
    ];
    const WHO = [
      { from: 0, to: 8, label: "Дуже низьке благополуччя" },
      { from: 8, to: 13, label: "Знижене благополуччя" },
      { from: 13, to: 25, label: "Без ознак зниженого благополуччя" },
    ];
    const who = [
      { t: t0, label: "04.05", value: 5 },
      { t: t0 + 84 * day, label: "27.07", value: 6 },
      { t: t0 + 168 * day, label: "19.10", value: 3 },
    ];
    const low = [
      { t: t0, label: "24.08", value: 9 },
      { t: t0 + 18 * day, label: "11.09", value: 6 },
      { t: t0 + 45 * day, label: "08.10", value: 3 },
    ];
    const boxOf = (x: number, anchor: "start" | "end", y: number, text: string) => {
      const w = labelWidth(text);
      const x0 = anchor === "start" ? x : x - w;
      return { x0, x1: x0 + w, y0: y - 9, y1: y + 3 };
    };
    const hit = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    const words = (L: ReturnType<typeof courseLayout>) => L.bands.map((b) => boxOf(L.left + L.plotWidth - 6, "end", b.labelY, b.label));

    test("подпись сигнала — у метки, где есть место; на слово полосы не ложится никогда", () => {
      for (const at of [0, 18, 45]) {
        const L = courseLayout({ points: low, max: 27, bands: PHQ_WORDS, width: 326, signals: [{ t: t0 + at * day, label: "сигнал" }] });
        const s = L.signals[0]!;
        // у правого края, под словом нижней полосы, места нет — подписи нет (последний тест)
        if (at === 45) {
          expect(s.label).toBe("");
          continue;
        }
        expect(s.label, `сигнал на ${at}-й день`).toBe("сигнал");
        const sig = boxOf(s.labelX, s.anchor, s.labelY, s.label);
        for (const w of words(L)) expect(hit(sig, w), `сигнал на ${at}-й день`).toBe(false);
        expect(sig.x0).toBeGreaterThanOrEqual(L.left);
        expect(sig.x1).toBeLessThanOrEqual(L.left + L.plotWidth);
        // подпись рядом с меткой: не дальше строки над осью
        expect(L.top + L.plotHeight - s.labelY).toBeLessThanOrEqual(21);
        expect(Math.abs((s.anchor === "start" ? sig.x0 : sig.x1) - s.x)).toBeLessThanOrEqual(9);
      }
    });

    test("слово нижней полосы поднимается над красной меткой, а не садится на неё", () => {
      const signals = [{ t: t0 + 168 * day, label: "сигнал" }];
      const L = courseLayout({ points: who, max: 25, bands: WHO, width: 326, signals });
      const axis = L.top + L.plotHeight;
      expect(L.bands[0]!.labelY + 3).toBeLessThan(axis - 4.5);
      // без сигнала слово на прежнем месте
      expect(courseLayout({ points: who, max: 25, bands: WHO, width: 326 }).bands[0]!.labelY).toBeCloseTo(axis - 6);
    });

    test("подписи негде встать — её нет, метка остаётся (что она значит, говорит легенда)", () => {
      // WHO-5: слово нижней полосы — в полграфика, свежий сигнал у правого края
      const L = courseLayout({ points: who, max: 25, bands: WHO, width: 326, signals: [{ t: t0 + 168 * day, label: "сигнал" }] });
      expect(L.signals).toHaveLength(1);
      expect(L.signals[0]!.label).toBe("");
      expect(L.signals[0]!.x).toBeGreaterThan(L.left);
    });
  });

  test("тесные даты прячутся, последняя видна всегда", () => {
    const dense = [0, 1, 2, 3, 40].map((d, i) => ({ t: t0 + d * day, label: `d${i}`, value: 10 }));
    const { pts } = courseLayout({ points: dense, max: 27, width: 326 });
    expect(pts[0]!.dateHidden).toBe(false);
    expect(pts.slice(1, 4).every((p) => p.dateHidden)).toBe(true);
    expect(pts[4]!.dateHidden).toBe(false);
  });

  test("до шести замеров подписан каждый; гуще — края и крайние значения", () => {
    expect(lay().pts.every((p) => p.labeled)).toBe(true);
    const many = [9, 7, 12, 3, 8, 8, 15, 6, 10].map((v, i) => ({ t: t0 + i * 3 * day, label: `d${i}`, value: v }));
    const { pts } = courseLayout({ points: many, max: 27, width: 326 });
    expect(pts.flatMap((p, i) => (p.labeled ? [i] : []))).toEqual([0, 3, 6, 8]);
  });

  test("подписи делений оси помещаются слева целиком — и у долей «0,75»", () => {
    const share = [
      { from: 0, to: 0.24, label: "низький" },
      { from: 0.24, to: 0.39, label: "нижче середнього" },
      { from: 0.39, to: 0.6, label: "середній" },
      { from: 0.6, to: 0.75, label: "вище середнього" },
      { from: 0.75, to: 1, label: "високий" },
    ];
    const pts = [
      { t: t0, label: "22.09", value: 0.03 },
      { t: t0 + 9 * day, label: "01.10", value: 0.06 },
      { t: t0 + 18 * day, label: "10.10", value: 0.2 },
    ];
    const comma = (v: number) => String(v).replace(".", ",");
    const L = courseLayout({ points: pts, max: 1, bands: share, width: 326, axisLabel: comma });
    for (const t of L.ticks) expect(L.left - 6 - labelWidth(comma(t.v)), comma(t.v)).toBeGreaterThanOrEqual(0);
    // у целых баллов поле как было
    expect(lay().left).toBe(26);
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
