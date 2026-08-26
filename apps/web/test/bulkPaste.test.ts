import { describe, expect, test } from "bun:test";
import { numberingProblems, parseBulk } from "../src/pages/constructor/BulkPaste";

describe("разбор массовой вставки пунктов", () => {
  test("номера с точкой, скобкой, тире срезаются", () => {
    const items = parseBulk("1. Первый\n2) Второй\n3 — Третий\n4: Четвёртый");
    expect(items.map((i) => i.text)).toEqual(["Первый", "Второй", "Третий", "Четвёртый"]);
    expect(items.map((i) => i.n)).toEqual([1, 2, 3, 4]);
  });

  test("перенос строки внутри пункта склеивается", () => {
    const items = parseBulk("1. Начало длинного\nпункта из PDF\n2. Второй");
    expect(items.length).toBe(2);
    expect(items[0]!.text).toBe("Начало длинного пункта из PDF");
  });

  test("пустые строки и строки без номера в начале", () => {
    const items = parseBulk("\n\nПункт без номера\n\n1. С номером");
    expect(items.length).toBe(2);
    expect(items[0]!.n).toBe(null);
  });

  test("дыры и дубли нумерации обнаруживаются", () => {
    const items = parseBulk("1. а\n3. б\n3. в");
    const problems = numberingProblems(items);
    expect(problems.some((p) => p.includes("Пропущен номер 2"))).toBe(true);
    expect(problems.some((p) => p.includes("дважды"))).toBe(true);
  });

  test("номер без разделителя «12 Текст» тоже понимается", () => {
    const items = parseBulk("12 Текст пункта");
    expect(items[0]).toEqual({ n: 12, text: "Текст пункта" });
  });
});
