import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { DataTable, nextTableSort, parseTableSort, sortRows, tableSortParam, type Column } from "../src/ui";
import { facetOptions, visibleFacetOptions, type Facet } from "../src/ui/facets";

/**
 * Сортировка таблицы — поведение, а не отрисовка (w13:uitests).
 *
 * Внешний разбор: «покрытие интерфейса проверяло в основном отрисовку,
 * оставляя фильтры, сортировку и состояния форм без проверок». Базовые
 * случаи sortRows (числа как числа, алфавит языка) закреплены в
 * dataTable.test.ts, ключи строк — в rowKeys.test.ts. Здесь — то, что
 * человек делает с таблицей: нажимает заголовок второй раз, приходит по
 * старой ссылке, сортирует колонку, где у части строк значения нет, и ждёт,
 * что отмеченная строка останется отмеченной.
 */

interface Row {
  id: string;
  name: string;
  n: number | null;
  note: string | null;
}

const columns: Column<Row>[] = [
  { key: "name", header: "ПІБ", sort: (r) => r.name, render: (r) => r.name },
  { key: "n", header: "Замірів", num: true, sort: (r) => r.n, render: (r) => r.n ?? "—" },
  { key: "note", header: "Примітка", sort: (r) => r.note, render: (r) => r.note ?? "—" },
  { key: "act", header: "", render: () => "дія" },
];

const row = (id: string, name: string, n: number | null, note: string | null = null): Row => ({ id, name, n, note });

const ids = (list: Row[]) => list.map((r) => r.id);

describe("порядок", () => {
  test("равные значения остаются в исходном порядке — и при обратном направлении тоже", () => {
    /*
     * Обратный порядок — не «перевернуть список». Перевёрнутый список
     * переставил бы и равных между собой: три человека с двумя замерами
     * менялись бы местами на каждое нажатие заголовка, и глаз терял бы
     * того, на кого смотрел.
     */
    const rows = [row("a", "Коваль", 2), row("b", "Бондар", 5), row("c", "Мельник", 2), row("d", "Шевчук", 2)];
    expect(ids(sortRows(rows, columns, { key: "n" }))).toEqual(["a", "c", "d", "b"]);
    expect(ids(sortRows(rows, columns, { key: "n", desc: true }))).toEqual(["b", "a", "c", "d"]);
  });

  test("пустое значение — в конце при любом направлении", () => {
    /*
     * «Ще не проходив» — остаток, а не начало списка: так же устроены
     * «без відділення» в справочнике людей и пустой p95 в техпанели. Раньше
     * пустое шло первым при прямом порядке: сортировка по примечанию
     * открывалась строками, где примечания нет.
     */
    const rows = [row("a", "А", 3, ""), row("b", "Б", null, "друга"), row("c", "В", 1, "перша"), row("d", "Г", 2, "  ")];
    expect(ids(sortRows(rows, columns, { key: "n" }))).toEqual(["c", "d", "a", "b"]);
    expect(ids(sortRows(rows, columns, { key: "n", desc: true }))).toEqual(["a", "d", "c", "b"]);
    expect(ids(sortRows(rows, columns, { key: "note" }))).toEqual(["b", "c", "a", "d"]);
    expect(ids(sortRows(rows, columns, { key: "note", desc: true }))).toEqual(["c", "b", "a", "d"]);
  });

  test("null не превращается в слово «null» посреди алфавита", () => {
    const rows = [row("a", "А", 1, "олівець"), row("b", "Б", 1, null), row("c", "В", 1, "ніж"), row("d", "Г", 1, "перо")];
    // «ніж» < «олівець» < «перо», а строки без примечания — после всех
    expect(ids(sortRows(rows, columns, { key: "note" }))).toEqual(["c", "a", "d", "b"]);
  });

  test("нечисло (деление на ноль в доле) не рвёт порядок остальных", () => {
    const rows = [row("a", "А", 3), row("b", "Б", Number.NaN), row("c", "В", 1), row("d", "Г", 2)];
    expect(ids(sortRows(rows, columns, { key: "n" }))).toEqual(["c", "d", "a", "b"]);
    expect(ids(sortRows(rows, columns, { key: "n", desc: true }))).toEqual(["a", "d", "c", "b"]);
  });

  test("число и строка в одной колонке: порядок один и тот же при любой исходной перестановке", () => {
    /*
     * Колонка, где у части строк число, а у части — текст («2», «10»,
     * «15» строкой из старой выгрузки). Сравнение «число с числом — как
     * числа, остальное — как текст» не транзитивно: 2 < 10 как числа,
     * «10» < «15» как текст, «15» < «2» как текст — круг, и порядок
     * зависел от того, в каком порядке строки пришли с сервера.
     */
    type Mixed = { id: string; v: string | number };
    const mixed: Column<Mixed>[] = [{ key: "v", header: "v", sort: (r) => r.v, render: (r) => r.v }];
    const items: Mixed[] = [
      { id: "два", v: 2 },
      { id: "десять", v: 10 },
      { id: "п’ятнадцять", v: "15" },
      { id: "а", v: "а" },
    ];
    const orders = new Set<string>();
    const permute = (list: Mixed[]): Mixed[][] =>
      list.length <= 1 ? [list] : list.flatMap((x, i) => permute([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of permute(items)) orders.add(sortRows(p, mixed, { key: "v" }).map((r) => r.id).join(","));
    expect([...orders]).toHaveLength(1);
    // числа — впереди текста: число здесь значение, текст — скорее пометка
    expect([...orders][0]!.split(",").slice(0, 2)).toEqual(["два", "десять"]);
  });
});

describe("заголовок и адрес", () => {
  test("второе нажатие того же заголовка переворачивает направление, другой заголовок — снова по возрастанию", () => {
    expect(nextTableSort(null, "n")).toEqual({ key: "n", desc: false });
    expect(nextTableSort({ key: "n" }, "n")).toEqual({ key: "n", desc: true });
    expect(nextTableSort({ key: "n", desc: true }, "n")).toEqual({ key: "n", desc: false });
    expect(nextTableSort({ key: "n", desc: true }, "name")).toEqual({ key: "name", desc: false });
  });

  test("адрес: «ключ» и «ключ:desc», туда и обратно", () => {
    expect(tableSortParam({ key: "n", desc: true })).toBe("n:desc");
    expect(tableSortParam({ key: "n" })).toBe("n");
    expect(tableSortParam(null)).toBe("");
    expect(parseTableSort("n:desc", columns, null)).toEqual({ key: "n", desc: true });
    expect(parseTableSort("name", columns, null)).toEqual({ key: "name", desc: false });
  });

  test("кривое значение в адресе — порядок по умолчанию, а не «никакого»", () => {
    /*
     * Старая ссылка на колонку, которой больше нет, или колонку без
     * сортировки («дія»). Раньше такой ключ принимался как есть: sortRows
     * его не находил и отдавал строки в порядке сервера, а порядок по
     * умолчанию (у направлений — свежие сверху) пропадал без следа — ни
     * стрелки, ни объяснения.
     */
    const fallback = { key: "n", desc: true };
    expect(parseTableSort("нет_такой:desc", columns, fallback)).toEqual(fallback);
    expect(parseTableSort("act", columns, fallback)).toEqual(fallback);
    expect(parseTableSort(":desc", columns, fallback)).toEqual(fallback);
    expect(parseTableSort("", columns, fallback)).toEqual(fallback);
    expect(parseTableSort("нет_такой", columns, null)).toBeNull();
  });
});

/* ─────────── таблица целиком ─────────── */

const draw = (node: ReactNode, url = "/t") =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[url]}>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

/** Имена строк тела таблицы в том порядке, в каком они в разметке */
const bodyNames = (html: string) =>
  [...(html.split("<tbody>")[1] ?? "").matchAll(/<tr[^>]*><td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);

const people = [row("a", "Коваль", 2), row("b", "Бондар", 5), row("c", "Мельник", null), row("d", "Шевчук", 1)];

describe("таблица: порядок из адреса", () => {
  test("сортировка из адреса применяется и видна стрелкой у своей колонки", () => {
    const html = draw(<DataTable rows={people} columns={columns} stateKey="t" />, "/t?t.sort=n:desc");
    expect(bodyNames(html)).toEqual(["Бондар", "Коваль", "Шевчук", "Мельник"]);
    expect(html).toMatch(/Замірів<span class="arrow">↓<\/span>/);
  });

  test("без адреса — порядок по умолчанию; кривой адрес — тоже он, а не порядок сервера", () => {
    const initial = { key: "n", desc: true };
    const plain = draw(<DataTable rows={people} columns={columns} stateKey="t" initialSort={initial} />);
    const broken = draw(<DataTable rows={people} columns={columns} stateKey="t" initialSort={initial} />, "/t?t.sort=vanished:desc");
    expect(bodyNames(plain)).toEqual(["Бондар", "Коваль", "Шевчук", "Мельник"]);
    expect(bodyNames(broken)).toEqual(bodyNames(plain));
    expect(broken).toMatch(/Замірів<span class="arrow">↓<\/span>/);
  });

  test("выделенная строка остаётся выделенной после сортировки: выбор идёт за данными, а не за местом", () => {
    const active = (r: Row) => r.id === "d";
    for (const url of ["/t", "/t?t.sort=name", "/t?t.sort=n:desc"]) {
      const html = draw(
        <DataTable rows={people} columns={columns} stateKey="t" onRowClick={() => {}} isRowActive={active} />,
        url,
      );
      const selected = [...html.matchAll(/<tr[^>]*aria-selected="true"[^>]*><td[^>]*>([^<]*)</g)].map((m) => m[1]);
      expect(selected, url).toEqual(["Шевчук"]);
    }
  });
});

describe("фасеты вместе с сортировкой", () => {
  interface Unit {
    id: string;
    unit: string;
    n: number;
  }
  /* девять подразделений: восемь по три человека и одно, в котором человек один */
  const units: Unit[] = [];
  for (let u = 1; u <= 8; u += 1) for (let k = 0; k < 3; k += 1) units.push({ id: `${u}-${k}`, unit: `Рота ${u}`, n: k });
  units.push({ id: "9-0", unit: "Рота 9", n: 7 });
  const unitFacets: Facet<Unit>[] = [{ key: "unit", label: "Підрозділ", valueOf: (r) => r.unit }];
  const unitCols: Column<Unit>[] = [
    { key: "id", header: "id", sort: (r) => r.id, render: (r) => r.id },
    { key: "n", header: "n", num: true, sort: (r) => r.n, render: (r) => r.n },
  ];

  test("выбранный вариант виден, даже если по счётчику он не входит в первые восемь", () => {
    /*
     * На панели показываются восемь самых частых вариантов. Вариант из
     * адреса с малым счётчиком оказывался девятым — и пропадал с панели:
     * фильтр действует, а какой — не видно, и снять его можно только
     * сбросом всех. facetOptions обещает «выбранный вариант остаётся в
     * списке» — обещание держалось в модели и терялось в разметке.
     */
    const options = facetOptions(units, unitFacets, { unit: ["Рота 9"] }, "unit");
    const visible = visibleFacetOptions(options, 8);
    expect(visible.some((o) => o.value === "Рота 9" && o.selected)).toBe(true);
    // без выбора — ровно восемь, хвост не показывается
    expect(visibleFacetOptions(facetOptions(units, unitFacets, {}, "unit"), 8)).toHaveLength(8);

    const html = draw(<DataTable rows={units} columns={unitCols} facets={unitFacets} stateKey="u" />, "/t?u.f=unit:Рота%209");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Рота 9 /);
  });

  test("отбор и сортировка складываются: сортируется то, что осталось после фасета", () => {
    const html = draw(
      <DataTable rows={units} columns={unitCols} facets={unitFacets} stateKey="u" />,
      "/t?u.f=unit:Рота%202&u.sort=n:desc",
    );
    expect(bodyNames(html)).toEqual(["2-2", "2-1", "2-0"]);
  });
});
