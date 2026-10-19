import { cx } from "../../../ui/cx";

/*
 * Мелкие фигуры «Дані й продукт», которых нет в общем наборе графиков:
 * полоса доли в строке и образец цвета ряда. Инлайновый стиль — только
 * здесь и только из данных (ширина отрезка, цвет ряда токеном): экраны
 * раздела стилей в разметке не держат (opsSignals.test.ts).
 */

/**
 * Полоса доли в строке (.pbar набора): дорожка и отрезок от нуля до `max`.
 * Длина отрезка — тоже число, поэтому у нуля и у скрытого значения его нет.
 */
export function Meter({
  value,
  max,
  color = "var(--c1)",
  thin,
  className,
}: {
  value: number;
  max: number;
  /** Цвет отрезка токеном: var(--c1), var(--c5) */
  color?: string;
  /** 4 px вместо 10 — полоса в ячейке таблицы */
  thin?: boolean;
  className?: string;
}) {
  const w = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const round = thin ? "rounded-[2px]" : "rounded-[5px]";
  return (
    <span aria-hidden className={cx("relative block min-w-0 overflow-hidden bg-track", thin ? "h-1" : "h-2.5", round, className)}>
      {w > 0 ? (
        <i className={cx("absolute inset-y-0 left-0", round)} style={{ width: `${(w * 100).toFixed(1)}%`, background: color }} />
      ) : null}
    </span>
  );
}

/** Образец цвета ряда рядом с подписью строки: тот же цвет, что у линии на графике */
export function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />;
}
