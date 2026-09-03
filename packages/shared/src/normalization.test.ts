import { describe, expect, test } from "bun:test";
import { computeProfile } from "./scoring";

/**
 * Полосы и пороги применяются только к нормированному значению.
 *
 * Это не педантизм о типах. Полосы интерпретации и пороги шкал
 * достоверности заданы В ЕДИНИЦАХ НОРМИРОВКИ — T-баллах, стенах, долях.
 * Когда нормировать не вышло (нормы для этого пола нет), в значении
 * остаётся сырой балл, и прежний код применял к нему те же полосы.
 *
 * Для Мини-мульта это означало: все одиннадцать шкал в полосе «Низкий»
 * (сырой 0–20 всегда попадает в T-полосу 0–44.9) и выключенная шкала лжи
 * (порог 70 T-баллов сырым баллом с максимумом 5 недостижим). Профиль,
 * заполненный заведомо недостоверно, показывался как достоверный и
 * нормальный — без единой пометки на карте.
 */
function survey() {
  const q = (id: string) => ({
    id,
    type: "yesno" as const,
    title: { ru: id },
    required: false,
    reverseScored: false,
    options: [
      { id: `${id}-y`, text: { ru: "Да" }, score: 1, keyCode: "yes" },
      { id: `${id}-n`, text: { ru: "Нет" }, score: 0, keyCode: "no" },
    ],
  });
  const questions = ["a", "b", "c", "d", "e"].map(q);
  return {
    id: "s",
    questions,
    scales: [
      {
        id: "L",
        code: "L",
        title: { ru: "Ложь" },
        kind: "validity" as const,
        aggregation: "sum" as const,
        normalization: "tscore" as const,
        ratioDenominator: null,
        validityThreshold: 70,
        validityDirection: "above" as const,
        validityMessage: { ru: "недостоверно" },
        corrections: [],
        norms: [{ sex: "male" as const, ageMin: null, ageMax: null, mean: 1, sd: 1, source: "пособие" }],
        stenTable: [],
        bands: [
          { minScore: 0, maxScore: 44.9, label: { ru: "Низкий" }, severity: "none" as const },
          { minScore: 70, maxScore: 200, label: { ru: "Высокий" }, severity: "severe" as const },
        ],
        items: questions.map((x) => ({ questionId: x.id, weight: 1, matchKey: "yes" })),
      },
    ],
  } as never;
}

const answers = ["a", "b", "c", "d", "e"].map((id) => ({ questionId: id, optionIds: [`${id}-y`] }));

describe("нормировка", () => {
  test("при известном поле шкала лжи срабатывает", () => {
    const p = computeProfile(survey(), answers as never, { sex: "male", age: 30 });
    const s = p.scores[0]!;
    expect(s.normalized).toBe(true);
    expect(s.value).toBe(90);
    expect(s.band?.severity).toBe("severe");
    expect(p.reliable).toBe(false);
  });

  test("при неизвестном поле полоса не подбирается, а протокол непроверяем", () => {
    /*
     * Ключевая проверка. Раньше здесь было value=5, полоса «Низкий»,
     * severity none и reliable true — то есть заведомо недостоверный
     * бланк выдавался за нормальный.
     *
     * «Не смогли проверить» и «проверили, честно» — разные утверждения,
     * и второе в заключении из первого не следует.
     */
    const p = computeProfile(survey(), answers as never, { sex: null, age: 30 });
    const s = p.scores[0]!;
    expect(s.normalized, "значение объявлено нормированным, хотя нормы нет").toBe(false);
    expect(s.band, "к сырому баллу подобрана полоса в T-единицах").toBeNull();
    expect(p.reliable, "непроверяемый протокол выдан за достоверный").toBe(false);
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  test("нулевое стандартное отклонение нормы — тоже «не нормировано»", () => {
    // норма, введённая руками через конструктор, может иметь sd = 0;
    // прежний код тихо показывал сырой балл без единого предупреждения
    const s = survey() as never as { scales: { norms: { sd: number }[] }[] };
    s.scales[0]!.norms[0]!.sd = 0;
    const p = computeProfile(s as never, answers as never, { sex: "male", age: 30 });
    expect(p.scores[0]!.normalized).toBe(false);
    expect(p.warnings.length).toBeGreaterThan(0);
  });
});
