import { Suspense, lazy, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import {
  applyFacets,
  facetOptions,
  parseFacets,
  serializeFacets,
  toggleFacet,
  visibleFacetOptions,
  type Facet,
  type FacetSelection,
} from "./facets";
import { BulkBar } from "./filters";
import { Ic } from "./icons";
import { useHotkeys } from "./keys";
import { Pager } from "./pager";
import { Count } from "./layout";
import { Button, Checkbox } from "./primitives";
import { rowKeyOf } from "./rowKeys";
import { Loading } from "./states";
import { useUrlState } from "./urlState";
import type { VirtualRowsProps } from "./virtualRows";
import { useLang } from "../lang";

/*
 * Таблица набора «Виразна» (.dtbl) и её логика: сортировка, CSV, отметка
 * строк, шаг по строкам. Логика вынесена чистыми функциями — её проверяют
 * без React (test/dataTable.test.ts, test/tableSorting.test.tsx,
 * test/kitTable.test.tsx).
 */

export interface Column<T> {
  key: string;
  header: string;
  num?: boolean;
  /**
   * Значение для сортировки; если не задано — колонка не сортируется.
   * null (как и пустая строка, NaN) — «значения нет»: такая строка стоит в
   * конце при любом направлении (sortRows).
   */
  sort?: (row: T) => SortValue;
  render: (row: T) => ReactNode;
  /** Текстовое значение для CSV; без него берётся sort, иначе колонка пропускается */
  csv?: (row: T) => SortValue;
  width?: number;
  /**
   * Колонку нельзя скрыть. Ставится там, где без неё строка перестаёт быть
   * узнаваемой: имя пациента, название методики. Настройка колонок нужна,
   * чтобы убрать лишнее, а не чтобы получить таблицу из одних чисел.
   */
  required?: boolean;
  /** Скрыта, пока её не включат: редкие колонки не должны загромождать вид */
  hiddenByDefault?: boolean;
}

/**
 * CSV из текущего состояния таблицы (с сортировкой пользователя).
 * Разделитель — точка с запятой: русский Excel по умолчанию понимает её,
 * а запятую внутри чисел «1,5» — нет.
 */
/** Значение ячейки для сортировки и выгрузки; null — значения нет */
export type SortValue = string | number | null | undefined;

/** Порядок таблицы: ключ колонки и направление */
export interface TableSort {
  key: string;
  desc?: boolean;
}

/**
 * «Значения нет»: null, пустая строка, строка из пробелов, нечисло.
 *
 * Нечисло сюда попадает не из данных, а из арифметики колонки: доля при
 * нулевом знаменателе. Сравнение с ним даёт NaN, сортировка читает NaN как
 * «равны» — и строки вокруг такой ячейки переставали упорядочиваться вовсе.
 */
function isBlank(v: SortValue): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return Number.isNaN(v);
  return v.trim() === "";
}

/**
 * Сравнение двух непустых значений.
 *
 * Число с числом — как числа, текст с текстом — по алфавиту языка, а число
 * с текстом — число впереди. Прежнее «число с числом как числа, остальное
 * как текст» не было порядком: 2 < 10 числами, «10» < «15» и «15» < «2»
 * текстом — круг, и итог зависел от того, в каком порядке строки пришли.
 * Число впереди потому, что в колонке чисел текст — это почти всегда
 * пометка («н/д», «—»), а не значение.
 */
function compareValues(x: string | number, y: string | number): number {
  if (typeof x === "number" && typeof y === "number") return x === y ? 0 : x < y ? -1 : 1;
  if (typeof x === "number") return -1;
  if (typeof y === "number") return 1;
  return x.localeCompare(y);
}

/**
 * Сортировка строк таблицы. Вынесена из компонента, чтобы её можно было
 * проверить без React: это логика, а не разметка, и ошибка в ней тихо
 * переставляет данные местами.
 *
 * Числа сравниваются как числа, остальное — как текст с учётом языка:
 * «Ялинка» и «Яблуко» должны идти в порядке украинского алфавита, а не по
 * кодам символов.
 *
 * Равные остаются в том порядке, в каком пришли, при любом направлении:
 * обратный порядок — это обратное сравнение, а не перевёрнутый список,
 * иначе три человека с одинаковым числом замеров менялись бы местами на
 * каждое нажатие заголовка. Пустые — в конце при любом направлении: «ещё не
 * проходил» — остаток, а не начало списка (так же «без відділення» в
 * справочнике людей и пустой p95 в техпанели).
 */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: TableSort | null): T[] {
  if (!sort) return rows;
  const col = columns.find((c) => c.key === sort.key);
  if (!col?.sort) return rows;
  const get = col.sort;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const bx = isBlank(x);
    const by = isBlank(y);
    if (bx || by) return bx === by ? 0 : bx ? 1 : -1;
    const cmp = compareValues(x as string | number, y as string | number);
    return sort.desc ? -cmp : cmp;
  });
}

/**
 * Порядок из адреса: «ключ» или «ключ:desc».
 *
 * Ключ, которого среди сортируемых колонок нет (колонку убрали, ссылка
 * старая, руками вписана колонка действий), — не порядок, а умолчание
 * таблицы. Раньше такой ключ принимался как есть: sortRows его не находил
 * и отдавал строки в порядке сервера, и порядок по умолчанию («свіжі
 * згори» у направлений) пропадал без следа — ни стрелки, ни объяснения.
 */
export function parseTableSort<T>(raw: string, columns: Column<T>[], fallback: TableSort | null): TableSort | null {
  if (!raw) return fallback;
  const [key = "", dir] = raw.split(":");
  if (!columns.some((c) => c.key === key && c.sort)) return fallback;
  return { key, desc: dir === "desc" };
}

/** Порядок — в строку адреса; читается глазами и разбирается одним split */
export function tableSortParam(sort: TableSort | null): string {
  return sort ? `${sort.key}${sort.desc ? ":desc" : ""}` : "";
}

/** Нажатие заголовка: та же колонка — обратное направление, другая — по возрастанию */
export function nextTableSort(current: TableSort | null, key: string): TableSort {
  return current?.key === key ? { key, desc: !current.desc } : { key, desc: false };
}

export function tableToCsv<T>(rows: T[], columns: Column<T>[]): string {
  const cols = columns.filter((c) => c.csv ?? c.sort);
  const cell = (v: SortValue) => {
    // пустое — пустая ячейка, а не слово «null» в файле, который унесут в Excel
    const str = isBlank(v) ? "" : String(v);
    return /[";\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
  };
  const head = cols.map((c) => cell(c.header)).join(";");
  const body = rows.map((r) => cols.map((c) => cell((c.csv ?? c.sort)!(r))).join(";"));
  return "\ufeff" + [head, ...body].join("\r\n");
}

/* ─────────── выбор строк ─────────── */

/** Отметить или снять одну строку */
export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Состояние «выбрать все» по видимым строкам: никто, часть, все */
export function selectAllState(visible: readonly string[], selected: ReadonlySet<string>): "none" | "some" | "all" {
  if (!visible.length) return "none";
  const n = visible.filter((k) => selected.has(k)).length;
  return n === 0 ? "none" : n === visible.length ? "all" : "some";
}

/**
 * Нажатие «выбрать все»: если отмечены все видимые — снять их; иначе —
 * отметить все видимые. Отмеченные на других страницах не трогаются.
 */
export function toggleAll(visible: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (selectAllState(visible, selected) === "all") for (const k of visible) next.delete(k);
  else for (const k of visible) next.add(k);
  return next;
}

/** Следующая строка по J/K и стрелкам; на краю — остаётся на месте */
export function stepRow(keys: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (!keys.length) return null;
  const at = current === null ? -1 : keys.indexOf(current);
  if (at < 0) return step > 0 ? keys[0]! : keys[keys.length - 1]!;
  return keys[Math.min(keys.length - 1, Math.max(0, at + step))]!;
}

/* ─────────── таблица ─────────── */

/** Тон строки: выбранная (показана в панели), отмеченная галочкой, риск для человека */
export type RowTone = "active" | "picked" | "risk";

const PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Плотная таблица набора (.dtbl): липкий заголовок, сортировка по нажатию
 * заголовка, отметка строк с «выбрать все» и полосой массовых действий,
 * действия строки на наведении и фокусе, J/K и стрелки по строкам, Enter
 * открывает, страницы снизу.
 *
 * Состояние в адресе (`stateKey`): сортировка, скрытые колонки, фасеты и
 * страница переживают перезагрузку и пересылаются ссылкой.
 *
 * ```tsx
 * <DataTable rows={rows} columns={cols} stateKey="pt" rowKey={(r) => r.id}
 *   onRowClick={openDrawer} selectable bulkActions={(picked, clear) => …}
 *   rowActions={(r) => <Button size="icon-sm" variant="quiet" …/>} pageSize={25} />
 * ```
 */
export function DataTable<T>({
  rows,
  columns,
  empty,
  initialSort,
  csvName,
  stateKey,
  rowKey,
  facets,
  facetNote,
  onRowClick,
  isRowActive,
  selectable,
  selected: selectedProp,
  onSelectedChange,
  bulkActions,
  rowActions,
  rowTone,
  pageSize,
  hotkeys,
  dense,
  label,
  sticky = true,
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  initialSort?: { key: string; desc?: boolean };
  /** Имя файла включает выгрузку CSV текущего вида таблицы */
  csvName?: string;
  /**
   * Префикс параметров адреса. Задан — сортировка, колонки, фасеты и
   * страница переживают перезагрузку и передаются ссылкой; не задан —
   * живут в памяти компонента.
   */
  stateKey?: string;
  /**
   * Устойчивый ключ строки. По умолчанию — поле `id`, иначе порядковый
   * номер (см. rowKeys.ts): при сортировке номер переезжает с данными.
   */
  rowKey?: (row: T) => string;
  /** Фасетные фильтры над таблицей — со счётчиком «сколько будет» до применения */
  facets?: Facet<T>[];
  /** Приписка к фасетам: по чему они считают («із завантажених») */
  facetNote?: string;
  /**
   * Открыть строку: нажатие, Enter. Ссылки и кнопки внутри ячеек работают
   * как свои — нажатие по ним строку не открывает.
   */
  onRowClick?: (row: T) => void;
  /** Какая строка сейчас открыта (в ящике, в панели контекста) */
  isRowActive?: (row: T) => boolean;
  /** Колонка отметки с «выбрать все» */
  selectable?: boolean;
  /** Отмеченные ключи — управляемо; без них таблица помнит отметку сама */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (keys: Set<string>) => void;
  /** Полоса массовых действий над таблицей, пока что-то отмечено */
  bulkActions?: (picked: T[], clear: () => void) => ReactNode;
  /** Действия строки — всплывают справа на наведении и фокусе */
  rowActions?: (row: T) => ReactNode;
  /** Тон строки: риск для человека — только красным */
  rowTone?: (row: T) => RowTone | undefined;
  /** Страницы по N строк снизу таблицы (на клиенте) */
  pageSize?: number;
  /** J/K работают с любого места экрана, а не только на строке в фокусе */
  hotkeys?: boolean;
  /** Строки 44 вместо 56 */
  dense?: boolean;
  /** Имя таблицы для диктора */
  label?: string;
  /** Заголовок липнет к верху прокручиваемой области */
  sticky?: boolean;
}) {
  const { ut } = useLang();

  const keyOf = (row: T, i: number): string => rowKeyOf(row, i, rowKey);

  const [urlSort, setUrlSort] = useUrlState(stateKey ? `${stateKey}.sort` : "");
  const [localSort, setLocalSort] = useState<TableSort | null>(initialSort ?? null);
  // «ключ» или «ключ:desc» — читаемо в адресной строке; чужой ключ — умолчание (parseTableSort)
  const sort = stateKey ? parseTableSort(urlSort, columns, initialSort ?? null) : localSort;
  const setSort = (next: TableSort | null) => {
    if (!stateKey) {
      setLocalSort(next);
      return;
    }
    setUrlSort(tableSortParam(next));
  };

  /* скрытые колонки — в адресе рядом с сортировкой: настроенный вид пересылается ссылкой */
  const [hiddenRaw, setHiddenRaw] = useUrlState(stateKey ? `${stateKey}.cols` : "");
  const [localHidden, setLocalHidden] = useState("");
  const hiddenParam = stateKey ? hiddenRaw : localHidden;
  const hidden = useMemo(() => {
    if (hiddenParam) return new Set(hiddenParam.split(","));
    return new Set(columns.filter((c) => c.hiddenByDefault).map((c) => c.key));
  }, [hiddenParam, columns]);
  const setHidden = (next: Set<string>) => {
    const raw = [...next].join(",");
    if (stateKey) setHiddenRaw(raw);
    else setLocalHidden(raw);
  };
  const shown = useMemo(() => columns.filter((c) => c.required || !hidden.has(c.key)), [columns, hidden]);

  const [facetRaw, setFacetRaw] = useUrlState(stateKey && facets ? `${stateKey}.f` : "");
  const [localFacets, setLocalFacets] = useState("");
  const facetParam = stateKey ? facetRaw : localFacets;
  const selection = useMemo(() => parseFacets(facetParam), [facetParam]);
  const setSelection = (next: FacetSelection) => {
    const raw = serializeFacets(next);
    if (stateKey) setFacetRaw(raw);
    else setLocalFacets(raw);
  };

  const filtered = useMemo(
    () => (facets?.length ? applyFacets(rows, facets, selection) : rows),
    [rows, facets, selection],
  );
  const sorted = useMemo(() => sortRows(filtered, shown, sort), [filtered, sort, shown]);

  /* страницы: номер и размер — в адресе, если таблица его держит */
  const [pageRaw, setPageRaw] = useUrlState(stateKey && pageSize ? `${stateKey}.page` : "");
  const [perRaw, setPerRaw] = useUrlState(stateKey && pageSize ? `${stateKey}.per` : "");
  const [localPage, setLocalPage] = useState(1);
  const [localPer, setLocalPer] = useState(pageSize ?? 0);
  const per = pageSize ? (stateKey ? Number(perRaw) || pageSize : localPer || pageSize) : 0;
  const pages = per ? Math.max(1, Math.ceil(sorted.length / per)) : 1;
  const page = Math.min(pages, Math.max(1, stateKey ? Number.parseInt(pageRaw, 10) || 1 : localPage));
  const setPage = (p: number) => (stateKey ? setPageRaw(p > 1 ? String(p) : "") : setLocalPage(p));
  const setPer = (n: number) => {
    if (stateKey) {
      setPerRaw(n === pageSize ? "" : String(n));
      setPageRaw("");
    } else {
      setLocalPer(n);
      setLocalPage(1);
    }
  };
  const visible = per ? sorted.slice((page - 1) * per, page * per) : sorted;

  /* отметка строк: управляемая или своя */
  const [ownSelected, setOwnSelected] = useState<Set<string>>(() => new Set());
  const picked = selectedProp ?? ownSelected;
  const setPicked = (next: Set<string>) => {
    if (!selectedProp) setOwnSelected(next);
    onSelectedChange?.(next);
  };
  const keyed = useMemo(() => visible.map((r, i) => [keyOf(r, i), r] as const), [visible, rowKey]);
  const visibleKeys = keyed.map(([k]) => k);
  const allState = selectAllState(visibleKeys, picked);
  const pickedRows = useMemo(() => {
    const byKey = new Map(sorted.map((r, i) => [keyOf(r, i), r] as const));
    return [...picked].map((k) => byKey.get(k)).filter((r): r is T => r !== undefined);
  }, [picked, sorted, rowKey]);

  /* строка «в руке» клавиатуры: на ней tabIndex=0, остальные — −1 (одна остановка Tab на таблицу) */
  const keyboard = !!onRowClick || !!selectable;
  const [cursor, setCursor] = useState<string | null>(null);
  const activeKey = keyed.find(([, r]) => isRowActive?.(r))?.[0] ?? null;
  const home = cursor && visibleKeys.includes(cursor) ? cursor : (activeKey ?? visibleKeys[0] ?? null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const focusRow = (key: string | null) => {
    if (!key) return;
    setCursor(key);
    const tr = bodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(key)}"]`);
    tr?.focus();
    tr?.scrollIntoView({ block: "nearest" });
  };

  useHotkeys(
    {
      j: () => focusRow(stepRow(visibleKeys, home, 1)),
      k: () => focusRow(stepRow(visibleKeys, home, -1)),
    },
    !!hotkeys && keyboard,
  );

  if (rows.length === 0 && empty) return <>{empty}</>;

  // выгружается видимый срез: то, что человек настроил, — и есть его ответ
  const exportCsv = () => {
    const blob = new Blob([tableToCsv(sorted, shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = cx(
    "h-[38px] whitespace-nowrap border-y border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold normal-case leading-none tracking-normal text-muted",
    "first:pl-4 last:pr-4",
    sticky && "sticky top-[var(--sticky-top,0px)] z-[3]",
  );

  const head = (
    <thead>
      <tr>
        {selectable ? (
          <th className={cx(th, "w-[46px] pr-0")}>
            <Checkbox
              aria-label={ut("kit.selectAll")}
              checked={allState === "all"}
              indeterminate={allState === "some"}
              onChange={() => setPicked(toggleAll(visibleKeys, picked))}
            />
          </th>
        ) : null}
        {shown.map((c) => {
          const on = sort?.key === c.key;
          return (
            <th
              key={c.key}
              scope="col"
              aria-sort={c.sort ? (on ? (sort?.desc ? "descending" : "ascending") : "none") : undefined}
              className={cx(th, c.num && "text-right", on && "text-text")}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.sort ? (
                <button
                  type="button"
                  onClick={() => setSort(nextTableSort(sort, c.key))}
                  className={cx(
                    "-mx-1.5 inline-flex h-7 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-[7px] border-0 bg-transparent px-1.5",
                    "text-caption font-bold text-inherit hover:bg-sunk hover:text-text",
                    c.num && "flex-row-reverse",
                  )}
                >
                  {c.header}
                  {on ? (
                    sort?.desc ? (
                      <Ic.arrowDown size={13} className="text-violet-ink" />
                    ) : (
                      <Ic.arrowUp size={13} className="text-violet-ink" />
                    )
                  ) : (
                    <Ic.sortable size={13} />
                  )}
                </button>
              ) : (
                c.header
              )}
            </th>
          );
        })}
        {rowActions ? <th className={cx(th, "w-0 p-0 first:pl-0 last:pr-0")} aria-hidden /> : null}
      </tr>
    </thead>
  );

  const hideable = columns.filter((c) => !c.required);
  const tools =
    (csvName && rows.length) || hideable.length || facets?.length ? (
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {facets?.length ? (
          <FacetBar
            rows={rows}
            facets={facets}
            selection={selection}
            onChange={setSelection}
            shownCount={sorted.length}
            totalCount={rows.length}
            note={facetNote}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {hideable.length ? (
            <ColumnPicker
              columns={hideable}
              hidden={hidden}
              onToggle={(key) => {
                const next = new Set(hidden);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                setHidden(next);
              }}
            />
          ) : null}
          {csvName && sorted.length ? (
            <Button variant="quiet" size="xs" icon={<Ic.download />} onClick={exportCsv}>
              {ut("ui.exportCsv")}
              <Count n={sorted.length} />
            </Button>
          ) : null}
        </div>
      </div>
    ) : null;

  const bulk =
    selectable && bulkActions && picked.size ? (
      <BulkBar
        className="mx-3 mb-2.5"
        count={picked.size}
        total={sorted.length}
        onSelectAll={() => setPicked(new Set(sorted.map((r, i) => keyOf(r, i))))}
        onClear={() => setPicked(new Set())}
      >
        {bulkActions(pickedRows, () => setPicked(new Set()))}
      </BulkBar>
    ) : null;

  const renderRow = (row: T, key: string, height?: number) => (
    <Row
      key={key}
      rowKey={key}
      row={row}
      columns={shown}
      height={height}
      dense={dense}
      onOpen={onRowClick}
      tone={isRowActive?.(row) ? "active" : picked.has(key) ? "picked" : rowTone?.(row)}
      active={isRowActive?.(row) ?? false}
      selectable={selectable}
      checked={picked.has(key)}
      onCheck={() => setPicked(toggleKey(picked, key))}
      actions={rowActions?.(row)}
      tabStop={keyboard ? key === home : undefined}
      onStep={(step) => focusRow(stepRow(visibleKeys, key, step))}
      onFocusRow={() => setCursor(key)}
      selectLabel={ut("kit.selectRow")}
      actionsLabel={ut("kit.rowActions")}
    />
  );

  /*
   * Короткие и постраничные таблицы рисуются целиком: виртуализация стоит
   * собственной сложности (фиксированная высота строки, свой контейнер
   * прокрутки) и на двух десятках строк только мешает.
   */
  if (per || visible.length <= VIRTUAL_FROM) {
    return (
      <div>
        {tools}
        {bulk}
        <div className="overflow-x-auto">
          <table aria-label={label} className="w-full border-separate border-spacing-0 text-body leading-[19px]">
            {head}
            <tbody ref={bodyRef}>{keyed.map(([key, row]) => renderRow(row, key))}</tbody>
          </table>
        </div>
        {per && sorted.length > Math.min(...PAGE_SIZES) ? (
          <div className="border-t border-divider py-2.5 pl-4 pr-3">
            <Pager page={page} pages={pages} per={per} onPer={setPer} onPage={setPage} total={sorted.length} sizes={PAGE_SIZES} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {tools}
      {bulk}
      {/* пока кусок виртуализации в пути — скелет, а не пустое место: длинные таблицы открывают на медленной сети */}
      <Suspense fallback={<Loading rows={8} />}>
        <VirtualRows
          sorted={visible}
          head={head}
          renderRow={(row, i, height) => renderRow(row, keyOf(row, i), height)}
        />
      </Suspense>
    </>
  );
}

/**
 * Строка таблицы.
 *
 * Открыть — нажатие по строке или Enter; ссылки и кнопки в ячейках — свои.
 * J/K и стрелки ведут по строкам, пробел и X отмечают. Действия строки
 * всплывают справа на наведении и фокусе (на устройствах без наведения
 * видны всегда — иначе до них не дотянуться).
 */
function Row<T>({
  row,
  rowKey,
  columns,
  height,
  dense,
  onOpen,
  tone,
  active,
  selectable,
  checked,
  onCheck,
  actions,
  tabStop,
  onStep,
  onFocusRow,
  selectLabel,
  actionsLabel,
}: {
  row: T;
  rowKey: string;
  columns: Column<T>[];
  height?: number;
  dense?: boolean;
  onOpen?: (row: T) => void;
  tone?: RowTone;
  active: boolean;
  selectable?: boolean;
  checked: boolean;
  onCheck: () => void;
  actions?: ReactNode;
  /** Остановка Tab: true — эта строка, false — нет, undefined — строка не фокусируется */
  tabStop?: boolean;
  onStep: (step: 1 | -1) => void;
  onFocusRow: () => void;
  selectLabel: string;
  actionsLabel: string;
}) {
  const clickable = !!onOpen;
  const focusable = tabStop !== undefined;
  const td = cx(
    "border-b border-divider px-2.5 align-middle text-text transition-colors duration-[var(--dur-fast)] first:pl-4 last:pr-4",
    "group-last/row:border-b-0",
    dense ? "h-11 py-1" : "h-14 py-1.5",
    tone === "active" && "bg-violet-tint",
    tone === "picked" && "bg-sunk",
    tone === "risk" && "bg-risk-tint",
    !tone && "group-hover/row:bg-panel-2",
  );
  return (
    <tr
      data-key={rowKey}
      data-row
      style={height ? { height } : undefined}
      className={cx("group/row outline-offset-[-2px]", clickable && "cursor-pointer")}
      aria-selected={clickable ? active : undefined}
      tabIndex={focusable ? (tabStop ? 0 : -1) : undefined}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow();
      }}
      onClick={
        clickable
          ? (e) => {
              // нажатие по ссылке, кнопке или полю — их действие, а не открытие строки
              if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label")) return;
              onOpen(row);
            }
          : undefined
      }
      onKeyDown={
        focusable
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" && clickable) {
                e.preventDefault();
                onOpen(row);
                return;
              }
              /* по коду клавиши, а не по букве: J/K/X работают и в украинской раскладке */
              if ((e.key === " " || e.code === "KeyX") && selectable) {
                e.preventDefault();
                onCheck();
                return;
              }
              const step =
                e.key === "ArrowDown" || e.code === "KeyJ" ? 1 : e.key === "ArrowUp" || e.code === "KeyK" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              onStep(step);
            }
          : undefined
      }
    >
      {selectable ? (
        <td className={cx(td, "w-[46px] pr-0")}>
          <Checkbox aria-label={selectLabel} checked={checked} onChange={onCheck} />
        </td>
      ) : null}
      {columns.map((c) => (
        <td key={c.key} className={cx(td, c.num && "whitespace-nowrap text-right tabular-nums")}>
          {c.render(row)}
        </td>
      ))}
      {actions ? (
        <td className={cx(td, "relative w-0 p-0 first:pl-0 last:pr-0")}>
          <span
            role="group"
            aria-label={actionsLabel}
            className={cx(
              "absolute right-2.5 top-1/2 z-[2] inline-flex -translate-y-1/2 items-center gap-0.5 rounded-[12px] bg-panel p-[3px] shadow-tile",
              "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease)]",
              tone === "active" || tone === "picked"
                ? ""
                : "[@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:pointer-events-auto [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:pointer-events-auto [@media(hover:hover)]:group-focus-within/row:opacity-100",
            )}
          >
            {actions}
          </span>
        </td>
      ) : null}
    </tr>
  );
}

/** С какого числа строк включается виртуализация */
const VIRTUAL_FROM = 60;

/*
 * Длинная таблица (VirtualRows) — в virtualRows.tsx и по требованию: она
 * одна тянет за собой @tanstack/react-virtual, а в начальный кусок консоли
 * ui/index попадает целиком — ради сообщений, загрузки и окон.
 */
const VirtualRows = lazy(() => import("./virtualRows")) as <T>(props: VirtualRowsProps<T>) => ReactNode;

/* ─────────── настройка колонок и фасеты ─────────── */

/**
 * Какие колонки показывать. Обязательные не предлагаются к скрытию вовсе:
 * список выбора состоит только из того, что действительно можно выбрать.
 */
function ColumnPicker<T>({
  columns,
  hidden,
  onToggle,
}: {
  columns: Column<T>[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState(false);
  const count = columns.filter((c) => !hidden.has(c.key)).length;

  return (
    <div className="relative">
      <Button
        variant="quiet"
        size="xs"
        icon={<Ic.columns />}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        {ut("tbl.columns")}
        <Count n={`${count}/${columns.length}`} />
      </Button>
      {open ? (
        <>
          {/* клик мимо закрывает: меню без этого остаётся висеть поверх работы */}
          <div aria-hidden className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="group"
            aria-label={ut("tbl.columns")}
            className="absolute right-0 top-[calc(100%+6px)] z-50 flex min-w-[232px] flex-col gap-0.5 rounded-panel border border-border bg-panel p-1.5 shadow-pop"
          >
            {columns.map((c) => (
              <label
                key={c.key}
                className="m-0 flex h-9 cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 text-[13px] font-semibold text-text hover:bg-sunk"
              >
                <Checkbox checked={!hidden.has(c.key)} onChange={() => onToggle(c.key)} />
                {c.header}
              </label>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Фасеты над таблицей: у каждого варианта — счётчик «сколько строк
 * останется», посчитанный по строкам, прошедшим остальные фасеты, но не
 * этот: иначе выбор обнулял бы счётчики соседей.
 */
function FacetBar<T>({
  rows,
  facets,
  selection,
  onChange,
  shownCount,
  totalCount,
  note,
}: {
  rows: T[];
  facets: Facet<T>[];
  selection: FacetSelection;
  onChange: (next: FacetSelection) => void;
  shownCount: number;
  totalCount: number;
  note?: string;
}) {
  const { ut } = useLang();
  const active = Object.values(selection).some((v) => v.length);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      {facets.map((facet) => {
        const options = facetOptions(rows, facets, selection, facet.key);
        if (!options.length) return null;
        return (
          <div key={facet.key} role="group" aria-label={facet.label} className="flex flex-wrap items-center gap-[5px]">
            <span className="mr-1 text-caption font-bold text-muted">{facet.label}</span>
            {visibleFacetOptions(options, 8).map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={o.selected}
                onClick={() => onChange(toggleFacet(selection, facet.key, o.value))}
                className={cx(
                  "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
                  o.selected ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2",
                )}
              >
                {o.value} <span className={cx("font-bold tabular-nums", o.selected ? "text-onfill-muted" : "text-muted")}>{o.count}</span>
              </button>
            ))}
          </div>
        );
      })}
      {active ? (
        <Button variant="quiet" size="xs" icon={<Ic.x />} onClick={() => onChange({})}>
          {ut("tbl.resetFacets")}
          <Count n={`${shownCount}/${totalCount}`} />
        </Button>
      ) : null}
      {note ? <span className="text-caption text-muted">{note}</span> : null}
    </div>
  );
}
