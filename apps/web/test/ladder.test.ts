import { describe, expect, test } from "bun:test";
import { bandRange, boundaries, ladderDomain, num, profileRuns, rungOf, sameLadder, segments, share } from "../src/charts/ladder";

/**
 * Арифметика лестницы полос — общая для линейки, профиля и динамики.
 *
 * Ломается она не типами, а границами: разрыв между ступенями, дробные
 * Т-баллы, балл за краем лестницы. Каждая проверка ниже — один такой край.
 */

const phq9 = [
  { min: 0, max: 4, label: "Мінімальна", severity: "none" as const },
  { min: 5, max: 9, label: "Легка", severity: "mild" as const },
  { min: 10, max: 14, label: "Помірна", severity: "moderate" as const },
  { min: 15, max: 19, label: "Помірно тяжка", severity: "severe" as const },
  { min: 20, max: 27, label: "Тяжка", severity: "severe" as const },
];

describe("границы ступеней", () => {
  test("граница — посередине разрыва, а не на начале следующей ступени", () => {
    // иначе балл 5 стоял бы ровно на границе, между ступенями
    expect(boundaries(phq9)).toEqual([4.5, 9.5, 14.5, 19.5]);
  });

  test("дробные Т-баллы дают дробную границу", () => {
    const t = [
      { min: 0, max: 44.9, label: "a", severity: "none" as const },
      { min: 45, max: 55.9, label: "b", severity: "none" as const },
    ];
    expect(boundaries(t)[0]).toBeCloseTo(44.95, 5);
  });

  test("перекрытие ступеней не даёт отрезкам налезать друг на друга", () => {
    const bad = [
      { min: 0, max: 10, label: "a", severity: "none" as const },
      { min: 8, max: 20, label: "b", severity: "mild" as const },
    ];
    expect(boundaries(bad)).toEqual([8]);
  });
});

describe("область линейки", () => {
  test("края — края лестницы, а не данные", () => {
    expect(ladderDomain(phq9, [7])).toEqual({ lo: 0, hi: 27 });
  });

  test("значение за лестницей растягивает область до себя", () => {
    expect(ladderDomain(phq9, [31]).hi).toBe(31);
  });

  test("без лестницы — метр от нуля до максимума шкалы", () => {
    expect(ladderDomain([], [12], 40)).toEqual({ lo: 0, hi: 40 });
  });

  test("без лестницы и максимума — до самого значения, а не до нуля", () => {
    expect(ladderDomain([], [0])).toEqual({ lo: 0, hi: 1 });
  });
});

describe("отрезки и положение", () => {
  test("отрезки покрывают область без щелей", () => {
    const segs = segments(phq9, ladderDomain(phq9));
    const total = segs.reduce((s, x) => s + x.width, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(segs[0]!.start).toBe(0);
  });

  test("положение прижимается к краям, а не вылетает за них", () => {
    const d = { lo: 0, hi: 27 };
    expect(share(-5, d)).toBe(0);
    expect(share(40, d)).toBe(1);
  });

  test("ступень балла — тем же сравнением, что движок подсчёта", () => {
    expect(rungOf(phq9, 9)!.label).toBe("Легка");
    expect(rungOf(phq9, 10)!.label).toBe("Помірна");
  });

  test("балл в разрыве дробной лестницы уходит к ближайшей границе", () => {
    const t = [
      { min: 0, max: 44.9, label: "a", severity: "none" as const },
      { min: 45, max: 55.9, label: "b", severity: "none" as const },
    ];
    expect(rungOf(t, 44.93)!.label).toBe("a");
    expect(rungOf(t, 44.97)!.label).toBe("b");
  });
});

describe("соединение профиля", () => {
  test("одинаковые лестницы соединяются линией", () => {
    const d = ladderDomain(phq9);
    expect(sameLadder([{ rungs: phq9, domain: d }, { rungs: phq9, domain: d }])).toBe(true);
  });

  test("разные лестницы — нет: линия соединяла бы несоизмеримое", () => {
    const other = [{ min: 0, max: 1, label: "x", severity: "none" as const }];
    expect(
      sameLadder([
        { rungs: phq9, domain: ladderDomain(phq9) },
        { rungs: other, domain: ladderDomain(other) },
      ]),
    ).toBe(false);
  });

  test("одна строка — не профиль", () => {
    expect(sameLadder([{ rungs: phq9, domain: ladderDomain(phq9) }])).toBe(false);
  });
});

describe("отрезки линии профиля", () => {
  const d = ladderDomain(phq9);
  const row = (value: number | null, rungs = phq9) => ({ rungs, domain: rungs === phq9 ? d : ladderDomain(rungs, [value]), value });

  test("шкала с другой лестницей рвёт линию, а не выключает её целиком", () => {
    // так у Міні-мульта: девятая шкала без норм стоит сырым метром среди Т-шкал
    const rows = [row(3), row(12), row(7, []), row(20), row(15)];
    expect(profileRuns(rows)).toEqual([[0, 1], [3, 4]]);
  });

  test("строка без значения тоже рвёт линию", () => {
    expect(profileRuns([row(3), row(null), row(12)])).toEqual([]);
  });

  test("одна строка своей лестницы — не отрезок", () => {
    expect(profileRuns([row(3), row(7, [])])).toEqual([]);
  });
});

describe("число подписи", () => {
  test("дробь — языка экрана: «44,9» по-украински и по-русски, «44.9» по-английски", () => {
    expect(num(44.9, "uk")).toBe("44,9");
    expect(num(0.23, "ru")).toBe("0,23");
    expect(num(44.9, "en")).toBe("44.9");
    // язык консоли по умолчанию (в проверке — украинский)
    expect(num(12.5)).toBe("12,5");
  });

  test("целое без хвоста, два знака без 0.30000000000000004", () => {
    expect(num(14, "uk")).toBe("14");
    expect(num(0.1 + 0.2, "en")).toBe("0.3");
  });
});

describe("границы полосы словами", () => {
  test("полоса из одного значения — одним числом: ступени CGI-S «2», а не «2–2»", () => {
    expect(bandRange({ min: 2, max: 2 })).toBe("2");
    expect(bandRange({ min: 0, max: 0 }, (v) => num(v, "uk"))).toBe("0");
    expect(bandRange({ min: 10, max: 14 })).toBe("10–14");
  });

  test("число — тем форматом, что дали: дробь языка, проценты", () => {
    expect(bandRange({ min: 45, max: 55.9 }, (v) => num(v, "uk"))).toBe("45–55,9");
    expect(bandRange({ min: 45, max: 55.9 }, (v) => num(v, "en"))).toBe("45–55.9");
    expect(bandRange({ min: 0.24, max: 0.24 }, (v) => `${Math.round(v * 100)} %`)).toBe("24 %");
  });
});
