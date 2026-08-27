import { describe, expect, test } from "bun:test";
import {
  directStandardize,
  ewma,
  guttmanErrorsNormed,
  icc21,
  mantelHaenszel,
  pChart,
  psi,
  quantile,
  roc,
} from "../src/medstats";

/*
 * Каждый пример посчитан руками — числа в комментариях и есть «золото».
 */

describe("Mantel–Haenszel", () => {
  test("нет DIF: одинаковые шансы в обеих группах → αMH=1, класс A", () => {
    // страта: ref 30/10, focal 30/10 → ad/N = 30*10/80=3.75, bc/N = 10*30/80=3.75
    const r = mantelHaenszel([
      { refYes: 30, refNo: 10, focalYes: 30, focalNo: 10 },
      { refYes: 20, refNo: 20, focalYes: 20, focalNo: 20 },
    ])!;
    expect(r.alphaMH).toBe(1);
    expect(r.deltaMH).toBe(-0);
    expect(r.etsClass).toBe("A");
  });

  test("выраженный DIF руками: αMH=4 в двух стратах → ΔMH=−3.26, класс C", () => {
    // страта1: ref 40/10, focal 20/20 → ad/N=40*20/90=8.889, bc/N=10*20/90=2.222
    // страта2: та же → αMH = (8.889+8.889)/(2.222+2.222) = 4
    // ΔMH = −2.35·ln4 = −3.258 → C при значимости.
    // χ²: E1 = 50*60/90 = 33.333, V1 = 50*40*60*30/(90²·89) = 4.994…
    //    A=80, E=66.667, V=9.9875 → (13.333−0.5)²/9.9875 = 16.4900
    const s = { refYes: 40, refNo: 10, focalYes: 20, focalNo: 20 };
    const r = mantelHaenszel([s, s])!;
    expect(r.alphaMH).toBe(4);
    expect(r.deltaMH).toBe(-3.26);
    expect(r.chi2).toBe(16.49);
    expect(r.significant).toBe(true);
    expect(r.etsClass).toBe("C");
  });

  test("полное разделение — максимальный DIF, а не «не посчитать»", () => {
    // мужчины никогда по ключу, женщины всегда: наивная формула дала бы αMH=0.
    // С поправкой Хальдейна–Анскомба (+0.5): a=0.5,b=30.5,c=30.5,d=0.5
    // ad/N=0.25/62, bc/N=930.25/62 → αMH = 0.25/930.25 = 0.000269
    const r = mantelHaenszel([{ refYes: 0, refNo: 30, focalYes: 30, focalNo: 0 }])!;
    expect(r.alphaMH).toBeLessThan(0.01);
    expect(r.deltaMH).toBeGreaterThan(15); // огромное различие в дельта-единицах
    expect(r.etsClass).toBe("C");
    expect(r.significant).toBe(true);
  });

  test("вырожденные страты — null, а не мусор", () => {
    // ни у кого нет вариативности ответа: сравнивать нечего даже с поправкой
    expect(mantelHaenszel([])).toBeNull();
    expect(mantelHaenszel([{ refYes: 0, refNo: 0, focalYes: 0, focalNo: 0 }])).toBeNull();
  });
});

describe("прямая стандартизация", () => {
  test("классический пример руками: молодая группа со старым стандартом", () => {
    // группа: молодые rate 0.30 (вес стандарта 40), старшие rate 0.10 (вес 60)
    // стандартизовано = (0.3·40 + 0.1·60)/100 = (12+6)/100 = 0.18
    expect(directStandardize([
      { rate: 0.3, standardWeight: 40 },
      { rate: 0.1, standardWeight: 60 },
    ])).toBe(0.18);
  });

  test("нулевой стандарт — null", () => {
    expect(directStandardize([{ rate: 0.5, standardWeight: 0 }])).toBeNull();
  });

  test("стандартизация может перевернуть сравнение (сама суть метода)", () => {
    // Рота А: молодых 90% (rate .3), старших 10% (rate .1) → сырое 0.28
    // Рота Б: молодых 10% (rate .25), старших 90% (rate .08) → сырое 0.097
    // Стандарт 50/50: А = (0.3+0.1)/2 = 0.20; Б = (0.25+0.08)/2 = 0.165
    // Сырое А почти втрое выше Б; стандартизованное — лишь на 0.035:
    // разница объяснялась возрастной структурой
    const std = [{ w: 50 }, { w: 50 }];
    const a = directStandardize([
      { rate: 0.3, standardWeight: std[0]!.w },
      { rate: 0.1, standardWeight: std[1]!.w },
    ])!;
    const b = directStandardize([
      { rate: 0.25, standardWeight: std[0]!.w },
      { rate: 0.08, standardWeight: std[1]!.w },
    ])!;
    const rawA = 0.3 * 0.9 + 0.1 * 0.1;
    const rawB = 0.25 * 0.1 + 0.08 * 0.9;
    expect(rawA / rawB).toBeGreaterThan(2.5);
    expect(a - b).toBeLessThan(0.05);
  });
});

describe("p-карта", () => {
  test("центр, пределы и выход за предел — руками", () => {
    // 4 недели по 100, события 10,12,8,30 → p̄ = 60/400 = 0.15
    // σ = √(0.15·0.85/100) = 0.0357; UCL = 0.15+3·0.0357 = 0.2571
    // неделя с 30/100 = 0.30 > UCL → сигнал
    const r = pChart([
      { n: 100, x: 10 },
      { n: 100, x: 12 },
      { n: 100, x: 8 },
      { n: 100, x: 30 },
    ])!;
    expect(r.center).toBe(0.15);
    expect(r.rows[3]!.ucl).toBe(0.2571);
    expect(r.rows[3]!.beyondLimits).toBe(true);
    expect(r.rows[0]!.beyondLimits).toBe(false);
  });

  test("правило серии: 8 точек по одну сторону центра", () => {
    // центр тянут вниз две большие недели, дальше 8 недель слегка выше центра
    const pts = [
      { n: 1000, x: 50 },
      { n: 1000, x: 50 },
      ...Array.from({ length: 8 }, () => ({ n: 100, x: 7 })),
    ];
    const r = pChart(pts)!;
    expect(r.rows[9]!.runSignal).toBe(true);
    expect(r.rows[8]!.runSignal).toBe(false);
  });
});

describe("EWMA", () => {
  test("сглаживание руками при λ=0.5", () => {
    // z0=10; z1=0.5·20+0.5·10=15; z2=0.5·10+0.5·15=12.5
    expect(ewma([10, 20, 10], 0.5)).toEqual([10, 15, 12.5]);
  });
});

describe("ROC", () => {
  test("идеальный классификатор: AUC=1, Юден на пороге между классами", () => {
    const r = roc([
      { score: 0.9, positive: true },
      { score: 0.8, positive: true },
      { score: 0.3, positive: false },
      { score: 0.1, positive: false },
    ])!;
    expect(r.auc).toBe(1);
    expect(r.bestSensitivity).toBe(1);
    expect(r.bestSpecificity).toBe(1);
    expect(r.bestThreshold).toBe(0.8);
  });

  test("случайный классификатор: AUC≈0.5 руками", () => {
    // пары (1,+)(1,−)(0,+)(0,−): порог 1 → TPR .5 FPR .5; порог 0 → 1,1
    // AUC = 0.5·(0+ .5)/... трапеции: (0.5-0)*(0.5+0)/2 + (1-0.5)*(1+0.5)/2 = 0.125+0.375 = 0.5
    const r = roc([
      { score: 1, positive: true },
      { score: 1, positive: false },
      { score: 0, positive: true },
      { score: 0, positive: false },
    ])!;
    expect(r.auc).toBe(0.5);
  });

  test("один класс — null", () => {
    expect(roc([{ score: 1, positive: true }])).toBeNull();
  });
});

describe("ICC(2,1)", () => {
  test("идеальное совпадение замеров → 1", () => {
    expect(icc21([[1, 1], [2, 2], [3, 3], [4, 4]])).toBe(1);
  });

  test("систематический сдвиг второго замера снижает ICC(2,1), но не к нулю", () => {
    // ретест ровно на +1 у всех: согласованность рангов идеальна,
    // но ICC(2,1) наказывает системный сдвиг
    const v = icc21([[1, 2], [2, 3], [3, 4], [4, 5]])!;
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(1);
  });

  test("меньше трёх пар — null", () => {
    expect(icc21([[1, 2], [2, 3]])).toBeNull();
  });
});

describe("PSI", () => {
  test("идентичные распределения → 0", () => {
    expect(psi([10, 20, 30], [20, 40, 60])).toBe(0); // те же доли
  });

  test("известный пример руками", () => {
    // ожид. доли .5/.5, факт .8/.2:
    // (0.8−0.5)·ln(1.6) + (0.2−0.5)·ln(0.4) = 0.3·0.470 + (−0.3)·(−0.916) = 0.4159
    expect(psi([50, 50], [80, 20])).toBe(0.4159);
  });
});

describe("ошибки Гуттмана", () => {
  test("идеальный профиль: все лёгкие пройдены, трудные нет → 0", () => {
    expect(guttmanErrorsNormed([1, 1, 1, 0, 0, 0])).toBe(0);
  });

  test("полная инверсия → 1", () => {
    expect(guttmanErrorsNormed([0, 0, 0, 1, 1, 1])).toBe(1);
  });

  test("одна ошибка руками: [1,0,1,0] → errors=1, max=2·2=4 → 0.25", () => {
    expect(guttmanErrorsNormed([1, 0, 1, 0])).toBe(0.25);
  });

  test("крайние профили не информативны — null", () => {
    expect(guttmanErrorsNormed([1, 1, 1, 1])).toBeNull();
    expect(guttmanErrorsNormed([0, 0, 0, 0])).toBeNull();
  });
});

describe("квантили", () => {
  test("тип 7 (R default) руками", () => {
    // [1,2,3,4]: q=0.5 → pos=1.5 → 2 + 0.5·(3−2) = 2.5
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([4, 1, 3, 2], 0)).toBe(1);
    expect(quantile([4, 1, 3, 2], 1)).toBe(4);
  });
});
