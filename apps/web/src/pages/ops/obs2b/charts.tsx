import type { ReactNode } from "react";
import type { VitalRating } from "@quizzy/shared";
import { cx } from "../../../ui/cx";

/*
 * Своя фигура раздела «Швидкість екранів»: самые медленные экраны полосами
 * с оценкой. Прежние фигуры волны 11 (доли со статусом, столбцы из двух
 * рядов, линия с разрывами) ушли с экранами до Polypsy 2.0: их заменили
 * таблицы и графики общего набора (charts/clinical.tsx).
 *
 * Отдельным файлом, а не в разметке экрана: у полосы ширина и положение
 * рисок — значения из рантайма, и инлайновый стиль здесь по делу, а сторож
 * оформления (apps/web/test/opsSignals.test.ts) разрешает его только здесь
 * и только с шириной, положением и цветом из данных.
 */

export interface RatedBar {
  key: string;
  /** Маршрут моноширинно */
  label: ReactNode;
  /** Маршрут целиком — для диктора и подсказки */
  title: string;
  value: number;
  text: string;
  rating: VitalRating;
  /** Приписка после числа приглушённым: «мало: 12» */
  extra?: string;
  /** Слово оценки и прочее — в подсказке */
  note?: string;
}

/* полоса — цветом оценки: «добре» зелёным, «потребує уваги» песком, «погано» тёмным янтарём */
const RATED_FILL: Record<VitalRating, string> = { good: "bg-good", needs: "bg-warn-line", poor: "bg-warn" };

/**
 * Самые медленные экраны полосами от нуля, цвет полосы — оценка, риски
 * поперёк — пороги «добре» и «погано» (.hbx набора с отметками). Шкала
 * доходит до порога «погано», даже если все экраны быстрее: иначе полоса
 * в полшкалы читалась бы как «почти плохо».
 */
export function RatedBars({ items, marks }: { items: readonly RatedBar[]; marks: readonly { value: number; label: string }[] }) {
  const top = Math.max(0, ...items.map((i) => i.value), ...marks.map((m) => m.value));
  const pct = (v: number) => `${(top > 0 ? (v / top) * 100 : 0).toFixed(2)}%`;
  return (
    <div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {items.map((i) => (
          <li
            key={i.key}
            tabIndex={0}
            aria-label={`${i.title}: ${i.text}${i.note ? `, ${i.note}` : ""}`}
            title={i.note ? `${i.title}: ${i.note}` : i.title}
            className="grid min-h-7 grid-cols-[minmax(0,176px)_minmax(24px,1fr)_auto] items-center gap-3 rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
          >
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="relative h-3.5">
              {top > 0 && i.value > 0 ? (
                <span className={cx("block h-full rounded-r-[4px]", RATED_FILL[i.rating])} style={{ width: pct(Math.max(i.value, top * 0.012)) }} />
              ) : null}
              {marks.map((m) => (
                <span key={m.label} aria-hidden className="absolute -top-1 -ml-px h-[22px] w-0.5 rounded-[1px] bg-text" style={{ left: pct(m.value) }} />
              ))}
            </span>
            <span className={cx("whitespace-nowrap text-right text-[13px] font-extrabold tabular-nums", i.rating === "good" ? "text-text" : "text-warn")}>
              {i.text}
              {i.extra ? <span className="ml-1.5 text-caption font-semibold text-muted">{i.extra}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {marks.length ? (
        <p className="m-0 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
          {marks.map((m) => (
            <span key={m.label} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-3 w-0.5 rounded-[1px] bg-text" />
              {m.label}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
