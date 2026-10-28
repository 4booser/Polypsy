import { Children, isValidElement, type ReactNode } from "react";
import { cx } from "../ui/cx";
import { bandSpans, courseColumns, courseDomain, cutoffOf, gridSpans, type CoursePoint } from "./courseModel";
import { useChartWidth } from "./index";
import { boundaries, sortRungs, type Rung } from "./ladder";
import { SINGLE_COLOR } from "./kit";
import { axisFor } from "./scale";

/**
 * Сетка графиков курса — без осиротевших полурядов.
 *
 * Прежде «Графіки» карточки ставили графики по два в ряд, и третий стоял
 * один рядом с пустой половиной. Здесь число столбцов — по ширине
 * контейнера (график не уже `min`, от одного до трёх в ряд), а последний
 * неполный ряд растягивается: одинокий последний график — на всю ширину,
 * два последних при трёх в ряду — по половине (courseModel.ts, gridSpans).
 *
 * ```tsx
 * <CourseGrid>
 *   {rows.map((r) => <Panel key={r.key}><CourseChart … legend={false} /></Panel>)}
 * </CourseGrid>
 * ```
 */
export function CourseGrid({ children, min = 420, className }: { children: ReactNode; min?: number; className?: string }) {
  const items = Children.toArray(children).filter(isValidElement);
  const [W, ref] = useChartWidth(900);
  const cols = courseColumns(W, items.length, min);
  const spans = gridSpans(items.length, cols);
  return (
    <div ref={ref} data-course-grid={cols} className={cx("grid items-start gap-4", className)} style={{ gridTemplateColumns: "repeat(6, minmax(0, 1fr))" }}>
      {items.map((child, i) => (
        <div key={child.key ?? i} className="min-w-0" style={{ gridColumn: `span ${spans[i]} / span ${spans[i]}` }}>
          {child}
        </div>
      ))}
    </div>
  );
}

/**
 * Курс в строке таблицы — малый рисунок фиксированного размера: полосы
 * лестницы тихой заливкой (текущая темнее), клинический порог пунктиром,
 * линия замеров и точка на последнем. Чисел нет: они стоят в соседних
 * ячейках таблицы, а рисунок отвечает только на «куда шло». Для диктора —
 * подпись `label` («PHQ-9: 11 → 16 → 19»).
 */
export function CourseSpark({
  points,
  rungs,
  max,
  label,
  width = 96,
  height = 28,
}: {
  points: readonly Pick<CoursePoint, "t" | "value">[];
  rungs: readonly Rung[];
  max?: number | null;
  label: string;
  width?: number;
  height?: number;
}) {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.value);
  const ladder = sortRungs(rungs);
  const d = ladder.length
    ? courseDomain(ladder, values, max)
    : (() => {
        const a = axisFor({ lo: 0, hi: Math.max(max ?? 0, ...values) });
        return { lo: a.min, hi: a.max };
      })();
  const pad = 3;
  const t0 = sorted[0]!.t;
  const t1 = sorted.at(-1)!.t;
  const X = (t: number) => pad + (t1 > t0 ? ((t - t0) / (t1 - t0)) * (width - 2 * pad) : (width - 2 * pad) / 2);
  const Y = (v: number) => pad + (height - 2 * pad) * (1 - (v - d.lo) / Math.max(d.hi - d.lo, Number.EPSILON));
  const f = (v: number) => v.toFixed(1);
  const last = sorted.at(-1)!;
  const spans = bandSpans(ladder, d.lo, d.hi);
  const current = spans.find((s) => last.value >= s.from && last.value <= s.to)?.rung ?? null;
  const cutoff = cutoffOf(ladder);
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block shrink-0 align-middle">
      {spans.length ? (
        spans.map((s, i) => (
          <rect
            key={`${s.rung.min}-${s.rung.max}`}
            x={0}
            y={f(Y(s.to))}
            width={width}
            height={f(Y(s.from) - Y(s.to))}
            fill={s.rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)"}
          />
        ))
      ) : (
        <rect x={0} y={0} width={width} height={height} rx={4} fill="var(--plot)" />
      )}
      {boundaries(ladder)
        .filter((c) => c > d.lo && c < d.hi)
        .map((c) => (
          <line key={c} x1={0} x2={width} y1={f(Y(c))} y2={f(Y(c))} stroke="var(--plotline)" strokeWidth={1} />
        ))}
      {cutoff && cutoff.at > d.lo && cutoff.at < d.hi ? (
        <line x1={0} x2={width} y1={f(Y(cutoff.at))} y2={f(Y(cutoff.at))} stroke="var(--text-2)" strokeWidth={1} strokeDasharray="3 2" />
      ) : null}
      {sorted.length > 1 ? (
        <polyline
          points={sorted.map((p) => `${f(X(p.t))},${f(Y(p.value))}`).join(" ")}
          fill="none"
          stroke={SINGLE_COLOR}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      <circle cx={f(X(last.t))} cy={f(Y(last.value))} r={2.8} fill={SINGLE_COLOR} stroke="var(--panel)" strokeWidth={1.5} />
    </svg>
  );
}
