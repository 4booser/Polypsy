import { useRef, type ReactNode, type Ref } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/*
 * Виртуализация длинной таблицы — отдельным куском по требованию (см.
 * ui/index.tsx, DataTable): короткие таблицы её не зовут, а начальному куску
 * консоли библиотека виртуализации не нужна вовсе.
 *
 * Строку рисует сама таблица (renderRow): разметка строки, выбор и
 * клавиатура живут в одном месте для короткой и длинной таблицы, а здесь —
 * только то, какие строки сейчас видны.
 */
export interface VirtualRowsProps<T> {
  sorted: T[];
  head: ReactNode;
  /** Строка с ключом и замером высоты: ключ — забота таблицы (rowKeyOf), здесь его не выдумывают */
  renderRow: (row: T, index: number, measure: (el: HTMLTableRowElement | null) => void) => ReactNode;
  /** Ожидаемая высота строки набора: 56, в плотной таблице 44 — до замера настоящей */
  rowHeight: number;
  /** Колонок в строке: распорки сверху и снизу — одна ячейка во всю ширину */
  columnCount: number;
  /** Классы и имя таблицы — те же, что у короткой */
  tableClassName: string;
  label?: string;
  /** Тело таблицы: по нему DataTable находит строку для J/K и стрелок */
  bodyRef: Ref<HTMLTableSectionElement>;
}

/**
 * Длинная таблица: в DOM живут только видимые строки.
 *
 * Список пациентов по 100 на странице, журналы техпанели — сотни строк, и
 * все сразу вкладка рисовала бы рывками. Своя прокрутка — до 72 % высоты
 * окна, шапка липнет к её верху.
 *
 * Высота строки — замером (measureElement), а не токеном: прежняя
 * виртуализация брала 38 px из --row-h наследия при строках набора 56, а
 * обёртка с `contain: strict` без высоты схлопывалась в ноль — список из
 * сотни пациентов показывал «1–100 з 134» и пустое место под ним.
 */
export default function VirtualRows<T>({
  sorted,
  head,
  renderRow,
  rowHeight,
  columnCount,
  tableClassName,
  label,
  bodyRef,
}: VirtualRowsProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtual.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  /* распорка — ячейкой во всю ширину: пустая строка таблицы высоту держит не везде */
  const spacer = (height: number) => (
    <tr aria-hidden>
      <td colSpan={columnCount} className="border-0 p-0" style={{ height }} />
    </tr>
  );

  return (
    <div ref={scrollRef} data-virtual className="max-h-[min(72vh,900px)] overflow-auto [contain:content]">
      <table aria-label={label} className={tableClassName}>
        {head}
        <tbody ref={bodyRef}>
          {padTop > 0 ? spacer(padTop) : null}
          {items.map((v) => renderRow(sorted[v.index]!, v.index, virtual.measureElement))}
          {padBottom > 0 ? spacer(padBottom) : null}
        </tbody>
      </table>
    </div>
  );
}
