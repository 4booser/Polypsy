import { describe, expect, test } from "bun:test";

/**
 * Публикация локальных норм.
 *
 * Норма решает, каким T-баллом обернётся сырой балл, а T-балл — какую полосу
 * увидит специалист в заключении. Потерять норму значит не «показать
 * приблизительно», а показать сырой балл под видом T-балла: полосы заданы в
 * T-единицах, и сырой всегда попадает в самую низкую.
 */

import { mergeNorms as merge } from "../src/lib/norms";

describe("локальные нормы", () => {
  test("не стирают норму пособия для пола, по которому выборки не набралось", () => {
    /*
     * Публикация разрешена, если набралась хотя бы одна группа. В учреждении
     * с сорока мужчинами и двенадцатью женщинами публиковалась мужская
     * норма, а женская из пособия исчезала — и все женщины с этого момента
     * попадали в ветку «нормы нет»: сырой балл вместо T-балла, никакой
     * полосы и выключенная шкала лжи.
     */
    const manual = [
      { sex: "male", source: "Пособие НДЦ ГП ЗСУ, 2016" },
      { sex: "female", source: "Пособие НДЦ ГП ЗСУ, 2016" },
    ];
    const local = [{ sex: "male", source: "локальная выборка, N=40" }];

    const result = merge(manual, local);
    const female = result.find((n) => n.sex === "female");
    expect(female, "женская норма пособия исчезла").toBeTruthy();
    expect(female!.source).toContain("Пособие");

    const male = result.find((n) => n.sex === "male");
    expect(male!.source, "локальная норма не заменила мужскую").toContain("локальная");
  });

  test("своя норма для обоих полов заменяет обе", () => {
    // набралось по обоим — заменяем обе, дублей не остаётся
    const manual = [
      { sex: "male", source: "пособие" },
      { sex: "female", source: "пособие" },
    ];
    const local = [
      { sex: "male", source: "локальная" },
      { sex: "female", source: "локальная" },
    ];
    const result = merge(manual, local);
    expect(result.length).toBe(2);
    expect(result.every((n) => n.source === "локальная")).toBe(true);
  });
});
