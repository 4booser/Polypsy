import { describe, expect, test } from "bun:test";
import {
  applyFacets,
  facetOptions,
  parseFacets,
  serializeFacets,
  toggleFacet,
  type Facet,
} from "../src/ui/facets";

/**
 * Фасеты таблиц.
 *
 * Счётчик «сколько будет» — то, на что человек смотрит, прежде чем нажать.
 * Если он врёт, фильтр хуже, чем его отсутствие: тогда хотя бы никто не
 * принимает решений по неверному числу.
 */

interface Row {
  unit: string;
  severity: string | null;
}

const rows: Row[] = [
  { unit: "Рота 1", severity: "severe" },
  { unit: "Рота 1", severity: "moderate" },
  { unit: "Рота 1", severity: "moderate" },
  { unit: "Рота 2", severity: "severe" },
  { unit: "Рота 2", severity: null },
];

const facets: Facet<Row>[] = [
  { key: "unit", label: "Подразделение", valueOf: (r) => r.unit },
  { key: "severity", label: "Выраженность", valueOf: (r) => r.severity },
];

describe("фасеты", () => {
  test("без выбора проходят все строки", () => {
    expect(applyFacets(rows, facets, {})).toHaveLength(5);
  });

  test("выбор внутри одного фасета соединяется «или»", () => {
    // «рота 1 ИЛИ рота 2» — иначе выбрать две роты было бы невозможно
    expect(applyFacets(rows, facets, { unit: ["Рота 1", "Рота 2"] })).toHaveLength(5);
    expect(applyFacets(rows, facets, { unit: ["Рота 2"] })).toHaveLength(2);
  });

  test("разные фасеты соединяются «и»", () => {
    const out = applyFacets(rows, facets, { unit: ["Рота 1"], severity: ["moderate"] });
    expect(out).toHaveLength(2);
  });

  test("строка без значения фасета отсеивается выбором по нему", () => {
    // «выраженность: severe» не должно молча протаскивать случаи без оценки
    const out = applyFacets(rows, facets, { severity: ["severe"] });
    expect(out).toHaveLength(2);
  });

  test("счётчик считается по остальным фасетам, но не по своему", () => {
    /*
     * Иначе выбор варианта обнулял бы счётчики его соседей, и человек не мог
     * бы увидеть, что даст переключение, — а именно для этого счётчик и есть.
     */
    const options = facetOptions(rows, facets, { unit: ["Рота 1"] }, "unit");
    expect(options.find((o) => o.value === "Рота 2")?.count).toBe(2);
    expect(options.find((o) => o.value === "Рота 1")?.selected).toBe(true);
  });

  test("счётчик соседнего фасета учитывает уже выбранное", () => {
    const options = facetOptions(rows, facets, { unit: ["Рота 1"] }, "severity");
    expect(options.find((o) => o.value === "moderate")?.count).toBe(2);
    expect(options.find((o) => o.value === "severe")?.count).toBe(1);
  });

  test("выбранный вариант не исчезает, когда счётчик обнулился", () => {
    // иначе снять фильтр, который ничего не выбирает, было бы нечем
    const options = facetOptions(rows, facets, { unit: ["Рота 3"] }, "unit");
    expect(options.find((o) => o.value === "Рота 3")).toEqual({
      value: "Рота 3",
      count: 0,
      selected: true,
    });
  });

  test("переключение добавляет и убирает, пустой ключ выбрасывается", () => {
    const once = toggleFacet({}, "unit", "Рота 1");
    expect(once).toEqual({ unit: ["Рота 1"] });
    expect(toggleFacet(once, "unit", "Рота 1")).toEqual({});
  });

  test("выбор переживает адресную строку", () => {
    const selection = { unit: ["Рота 1", "Рота 2"], severity: ["severe"] };
    const round = parseFacets(serializeFacets(selection));
    expect(round).toEqual(selection);
  });

  test("значение со спецсимволами не ломает разбор", () => {
    // подразделения называют как угодно, включая «Рота 1; 2-й взвод»
    const selection = { unit: ["Рота 1; 2-й взвод", "Б,В"] };
    expect(parseFacets(serializeFacets(selection))).toEqual(selection);
  });

  test("мусор в адресе не роняет разбор", () => {
    expect(parseFacets("")).toEqual({});
    expect(parseFacets(";;")).toEqual({});
    expect(parseFacets(":нет ключа")).toEqual({});
  });
});

describe("адрес читается глазами", () => {
  test("кириллица не превращается в частокол процентов", () => {
    // ссылками обмениваются постоянно; нечитаемая ссылка — это ссылка, о
    // которой в письме приходится писать «просто нажмите»
    expect(serializeFacets({ unit: ["Разведрота"] })).toBe("unit:Разведрота");
  });

  test("экранируются только разделители и сам знак экранирования", () => {
    expect(serializeFacets({ u: ["а;б"] })).toBe("u:а%3Bб");
    expect(serializeFacets({ u: ["а,б"] })).toBe("u:а%2Cб");
    expect(serializeFacets({ u: ["100%"] })).toBe("u:100%25");
  });

  test("значение, похожее на экранированный разделитель, переживает круг", () => {
    /*
     * «%3B» набранное человеком не должно развернуться в разделитель:
     * порядок замен при разборе выбран именно для этого.
     */
    const selection = { u: ["%3B", "%25", "а;б"] };
    expect(parseFacets(serializeFacets(selection))).toEqual(selection);
  });
});
