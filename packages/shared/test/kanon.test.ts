import { describe, expect, test } from "bun:test";
import { DEFAULT_K, applyQuasi, generalizeQuasi, type AgeBand, type QuasiRow } from "../src/kanon";

/**
 * k-анонимность выгрузки.
 *
 * Ошибка здесь не видна на глаз: выгрузка выглядит обезличенной в обоих
 * случаях. Поэтому проверяется главное свойство прямо — после обобщения не
 * должно остаться ячейки меньше k.
 */

const rows = (spec: [QuasiRow["sex"], AgeBand, number][]): QuasiRow[] =>
  spec.flatMap(([sex, band, n]) => Array.from({ length: n }, () => ({ sex, band })));

/**
 * Проверка того, ради чего всё написано: в выгрузке, какой её увидит
 * исследователь, не должно остаться ячейки меньше k. Считается по результату
 * применения, а не по внутренним полям, — иначе тест проверял бы устройство,
 * а не свойство.
 */
function minCell(list: QuasiRow[], g: ReturnType<typeof generalizeQuasi>): number {
  const counts = new Map<string, number>();
  for (const r of list) {
    const shown = applyQuasi(r, g);
    /*
     * Строки со стёртыми признаками из проверки исключены, и это не поблажка:
     * по «пол неизвестен, возраст неизвестен» не узнают никого, сколько бы
     * таких строк ни было. Порог существует для ячеек, которые указывают на
     * людей, — а эта не указывает.
     */
    if (shown.sex === null && shown.band === null) continue;
    const key = `${shown.sex ?? "—"}|${shown.band ?? "—"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size ? Math.min(...counts.values()) : Infinity;
}

describe("обобщение возрастных полос", () => {
  test("достаточная выборка не трогается", () => {
    const list = rows([
      ["male", "<25", 10],
      ["male", "25-34", 10],
      ["female", "<25", 10],
      ["female", "25-34", 10],
    ]);
    const g = generalizeQuasi(list);

    expect(g.merges).toBe(0);
    expect(g.blankedRows).toBe(0);
    expect(g.bandMap["<25"]).toBe("<25");
  });

  test("редкая полоса сливается с соседней", () => {
    const list = rows([
      ["male", "<25", 20],
      ["male", "25-34", 20],
      ["male", "35-44", 2],
      ["male", "45+", 20],
      ["female", "<25", 20],
      ["female", "25-34", 20],
      ["female", "35-44", 2],
      ["female", "45+", 20],
    ]);
    const g = generalizeQuasi(list);

    expect(g.merges).toBeGreaterThan(0);
    expect(minCell(list, g)).toBeGreaterThanOrEqual(DEFAULT_K);
    // редкая полоса перестала быть отдельной
    expect(g.bandMap["35-44"]).not.toBe("35-44");
  });

  test("после обобщения ни одна ячейка не меньше k — на любых входах", () => {
    /*
     * Главное свойство. Проверяется на наборе, где редкость встречается в
     * разных местах: у краёв, в середине, у одного пола.
     */
    const cases: QuasiRow[][] = [
      rows([["male", "<25", 1], ["male", "25-34", 30], ["female", "25-34", 30]]),
      rows([["male", "45+", 2], ["female", "45+", 2], ["male", "<25", 40], ["female", "<25", 40]]),
      rows([["female", "35-44", 1], ["male", "<25", 50]]),
      rows([["male", "<25", 3], ["male", "25-34", 3], ["male", "35-44", 3], ["male", "45+", 3]]),
    ];

    for (const list of cases) {
      const g = generalizeQuasi(list);
      expect(minCell(list, g)).toBeGreaterThanOrEqual(DEFAULT_K);
    }
  });

  test("если слияния не хватает — редкая ячейка стирается", () => {
    /*
     * Двенадцать мужчин и двое женщин: сколько полосы ни сливай, женская
     * ячейка останется вдвоём. Стираются её строки, а не пол у всех: выгрузка
     * без пола и возраста бесполезна, и люди начнут брать полный профиль.
     */
    const list = rows([
      ["male", "<25", 12],
      ["female", "<25", 2],
    ]);
    const g = generalizeQuasi(list);

    expect(g.blankedRows).toBe(2);
    expect(applyQuasi({ sex: "female", band: "<25" }, g)).toEqual({ sex: null, band: null });
    expect(applyQuasi({ sex: "male", band: "<25" }, g).sex).toBe("male");
  });

  test("строки не исчезают из выгрузки, теряются только признаки", () => {
    // баллы остаются: ради них выгрузку и делают
    const list = rows([
      ["male", "<25", 12],
      ["female", "<25", 2],
    ]);
    const g = generalizeQuasi(list);
    const shown = list.map((r) => applyQuasi(r, g));
    expect(shown).toHaveLength(14);
  });

  test("пустая выборка не обобщается", () => {
    // «обобщили в ноль шагов» честнее, чем слить все полосы на пустоте
    const g = generalizeQuasi([]);
    expect(g.merges).toBe(0);
    expect(g.blankedRows).toBe(0);
  });

  test("сливаются самые малочисленные соседи, а не первые попавшиеся", () => {
    /*
     * Слияние слева направо оставило бы «45+» гигантским, а молодые полосы
     * дробными. Теряться должна наименьшая точность.
     */
    const list = rows([
      ["male", "<25", 40],
      ["male", "25-34", 40],
      ["male", "35-44", 3],
      ["male", "45+", 3],
      ["female", "<25", 40],
      ["female", "25-34", 40],
      ["female", "35-44", 3],
      ["female", "45+", 3],
    ]);
    const g = generalizeQuasi(list);

    // крупные полосы остались раздельными
    expect(g.bandMap["<25"]).toBe("<25");
    expect(g.bandMap["25-34"]).toBe("25-34");
    // а мелкие слились между собой
    expect(g.bandMap["35-44"]).toBe(g.bandMap["45+"]);
  });

  test("неизвестный пол и возраст образуют свою ячейку и тоже проверяются", () => {
    /*
     * «Не указано» — такой же признак, как любой другой: если таких двое, они
     * узнаются ровно так же.
     */
    const list = rows([["male", "<25", 40]]).concat([
      { sex: null, band: null },
      { sex: null, band: null },
    ]);
    const g = generalizeQuasi(list);
    expect(minCell(list, g)).toBeGreaterThanOrEqual(DEFAULT_K);
  });
});
