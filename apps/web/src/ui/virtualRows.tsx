import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** Строка с ключом: ключ — забота таблицы (rowKeyOf), здесь его не выдумывают */
  renderRow: (row: T, index: number, height: number) => ReactNode;
}

/**
 * Длинная таблица: в DOM живут только видимые строки.
 *
 * Список пациентов — девять тысяч человек, и раньше все девять тысяч строк
 * рисовались сразу: вкладка занимала полгигабайта и прокручивалась рывками.
 * Высота строки берётся из токена плотности, поэтому в плотном режиме
 * пересчёт происходит сам.
 */
export default function VirtualRows<T>({ sorted, head, renderRow }: VirtualRowsProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = useRowHeight(scrollRef);

  const virtual = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const items = virtual.getVirtualItems();
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtual.getTotalSize() - (items[items.length - 1]?.end ?? 0);

  return (
    <div className="scroll-x virtual-wrap" ref={scrollRef}>
      <table>
        {head}
        <tbody>
          {/* распорки вместо абсолютного позиционирования: строки таблицы
              нельзя вынимать из потока, не потеряв выравнивание колонок */}
          {padTop > 0 ? <tr style={{ height: padTop }} aria-hidden /> : null}
          {items.map((v) => renderRow(sorted[v.index]!, v.index, rowHeight))}
          {padBottom > 0 ? <tr style={{ height: padBottom }} aria-hidden /> : null}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Высота строки из токена плотности.
 *
 * Захардкодить нельзя: в плотном режиме строка ниже на восемь пикселей, и
 * виртуализация с чужой высотой оставляет пустоты в конце списка.
 */
function useRowHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(38);
  useEffect(() => {
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-h");
      const px = Number.parseFloat(raw);
      if (Number.isFinite(px) && px > 0) setH(px);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, [ref]);
  return h;
}

