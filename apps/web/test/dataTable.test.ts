import { describe, expect, test } from "bun:test";
import { sortRows, tableToCsv, type Column } from "../src/ui";

/**
 * Логика таблицы: сортировка и выгрузка.
 *
 * Обе тихие: ошибка не роняет экран, а переставляет данные местами или
 * портит файл, который человек унесёт в Excel и по которому будет считать.
 * Именно поэтому они и вынесены из компонента — проверяются без React.
 */

interface Row {
  name: string;
  n: number;
  note: string;
}

const columns: Column<Row>[] = [
  { key: "name", header: "ФИО", sort: (r) => r.name, render: (r) => r.name },
  { key: "n", header: "Замеров", num: true, sort: (r) => r.n, render: (r) => r.n },
  { key: "note", header: "Примечание", csv: (r) => r.note, render: (r) => r.note },
  { key: "act", header: "", render: () => "кнопка" },
];

const rows: Row[] = [
  { name: "Ялинка", n: 2, note: "обычная" },
  { name: "Яблуко", n: 10, note: 'с "кавычками"' },
  { name: "Абрикос", n: 1, note: "с;точкой с запятой" },
];

describe("сортировка", () => {
  test("без сортировки порядок не меняется", () => {
    expect(sortRows(rows, columns, null).map((r) => r.name)).toEqual([
      "Ялинка",
      "Яблуко",
      "Абрикос",
    ]);
  });

  test("числа сравниваются как числа, а не как строки", () => {
    // «10» строкой меньше «2» — классическая ошибка
    expect(sortRows(rows, columns, { key: "n" }).map((r) => r.n)).toEqual([1, 2, 10]);
    expect(sortRows(rows, columns, { key: "n", desc: true }).map((r) => r.n)).toEqual([10, 2, 1]);
  });

  test("текст сортируется по алфавиту языка, а не по кодам символов", () => {
    const names = sortRows(rows, columns, { key: "name" }).map((r) => r.name);
    expect(names[0]).toBe("Абрикос");
    // «Яблуко» перед «Ялинкой»: б раньше л
    expect(names.indexOf("Яблуко")).toBeLessThan(names.indexOf("Ялинка"));
  });

  test("исходный массив не меняется", () => {
    const before = rows.map((r) => r.name);
    sortRows(rows, columns, { key: "n" });
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  test("колонка без сортировки её не включает", () => {
    expect(sortRows(rows, columns, { key: "act" })).toBe(rows);
  });
});

describe("выгрузка CSV", () => {
  const csv = tableToCsv(rows, columns);
  const lines = csv.replace("﻿", "").split("\r\n");

  test("начинается с метки кодировки — иначе Excel покажет кракозябры", () => {
    expect(csv.startsWith("﻿")).toBe(true);
  });

  test("разделитель — точка с запятой: русский Excel не понимает запятую", () => {
    expect(lines[0]).toBe("ФИО;Замеров;Примечание");
  });

  test("колонки без данных для выгрузки пропускаются", () => {
    // «кнопка» в файле не нужна — это действие, а не значение
    expect(csv).not.toContain("кнопка");
  });

  test("кавычки удваиваются, а поле берётся в кавычки", () => {
    expect(lines.some((l) => l.includes('"с ""кавычками"""'))).toBe(true);
  });

  test("точка с запятой внутри значения не ломает разбор", () => {
    const line = lines.find((l) => l.startsWith("Абрикос"))!;
    expect(line).toContain('"с;точкой с запятой"');
    // три колонки: имя, число, примечание в кавычках
    expect(line.split(";").length).toBeGreaterThanOrEqual(3);
  });

  test("строк ровно столько, сколько данных, плюс шапка", () => {
    expect(lines.length).toBe(rows.length + 1);
  });
});
