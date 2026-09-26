import { useRef, useState } from "react";
import { useChartWidth } from "../../../charts/index";
import { num } from "../../../charts/ladder";
import { axisFor } from "../../../charts/scale";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { NoData } from "../../../ui/primitives";
import type { Tone } from "../parts";

/* ═══════════ графики сигналов (волна 11) ═══════════ */

/*
 * Решение заказчика 2026-09-26: «должны быть графики в админ панеле».
 * Здесь — три формы, которых нет в общем наборе (charts/clinical.tsx; его в
 * этой волне дополняет только участок obs): доли со статусом, столбцы из
 * двух рядов и линия с разрывами. Собраны на тех же примитивах и в той же
 * геометрии, что TimeColumns и ShareBar, — координатор перенесёт их в
 * общий набор, если понадобятся второму участку. Пользуются ими и соседние
 * папки сигналов (data, sec): они в том же участке.
 *
 * Отдельным файлом, а не в parts.tsx: у графика положение подсказки,
 * ширина отрезка и его цвет — значения из рантайма, и инлайновый стиль
 * здесь по делу (как в charts/clinical.tsx), а сторож оформления разделов
 * obs2b (apps/web/test/opsObs2b.test.ts) запрещает его в разметке экранов
 * совсем. Своё правило у этого файла — в apps/web/test/opsSignals.test.ts:
 * стиль только с шириной, положением и цветом из данных.
 */

/** Сетка фигур: две рядом с 900 px, одна под другой ниже */
export const FIG_GRID = "grid grid-cols-1 gap-x-[32px] gap-y-[24px] min-[900px]:grid-cols-2";

/**
 * Цвет доли по тону статуса — тем же языком, что StatusMark (../parts.tsx):
 * порядок — фиолетовый (светлота — место в упорядоченном ряду, как у
 * ShareBar), «потребує уваги» — приглушённый янтарь, сбой — янтарь целиком,
 * «ничего» (свободное место, неизвестная версия) — цвет сетки.
 */
export function toneColor(tone: Tone, step?: number): string {
  if (tone === "ok") return `color-mix(in srgb, var(--primary) ${Math.round(28 + (step ?? 1) * 72)}%, var(--card))`;
  if (tone === "warn") return `color-mix(in srgb, var(--accent) ${Math.round(35 + (step ?? 0.45) * 45)}%, var(--card))`;
  if (tone === "fail") return "var(--accent)";
  return "var(--grid)";
}

/* форма точки — как у StatusMark: круг — порядок и «ничего», квадрат — внимание, ромб — сбой */
const MARK_SHAPE: Record<Tone, string> = { ok: "rounded-full", warn: "rounded-[1px]", fail: "rotate-45", quiet: "rounded-full" };

/** Метка ряда или доли: форма по тону, цвет — тот же, что у отрезка */
export function ToneMark({ tone, step }: { tone: Tone; step?: number }) {
  return (
    <span aria-hidden className={cx("inline-block size-[8px] shrink-0", MARK_SHAPE[tone])} style={{ background: toneColor(tone, step) }} />
  );
}

export interface TonePart {
  key: string;
  label: string;
  value: number;
  tone: Tone;
  /** Светлота внутри тона «порядок»: 1 — полный фиолетовый, 0 — самый светлый */
  step?: number;
  /** Приписка в легенде после подписи: «застаріла» */
  note?: string;
  /** Число в легенде, когда сырое значение нечитаемо: байты — «1,2 ГБ» */
  text?: string;
}

/**
 * Полоса долей со статусом частей: ShareBar, у которого часть может
 * требовать внимания.
 *
 * ShareBar из общего набора красит части ступенями тяжести (клиническое)
 * или светлотой фиолетового (порядок). В техпанели у части бывает третье
 * свойство — «это сбой» (упавшая расшифровка, замер «погано», старая
 * сборка), и его несёт янтарь — ровно «требует внимания». Никогда не цветом
 * в одиночку: в легенде у части форма точки, слово и число с долей.
 */
export function ToneShare({ parts, label, className }: { parts: readonly TonePart[]; label: string; className?: string }) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((s, p) => s + p.value, 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`${label}: ${parts.map((p) => `${p.label}${p.note ? ` (${p.note})` : ""} ${p.text ?? p.value}`).join(", ")}`}
        className="flex h-[10px] gap-[2px]"
      >
        {total > 0 ? (
          shown.map((p) => (
            <span
              key={p.key}
              title={`${p.label}: ${p.text ?? p.value} (${pct(p.value)}%)`}
              className="h-full min-w-[2px] first:rounded-l-[4px] last:rounded-r-[4px]"
              style={{ width: `${((p.value / total) * 100).toFixed(3)}%`, background: toneColor(p.tone, p.step) }}
            />
          ))
        ) : (
          <span className="h-full w-full rounded-[4px] bg-[var(--grid)]" />
        )}
      </div>
      <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]">
        {parts.map((p) => (
          <li key={p.key} className="flex min-w-0 items-center gap-[6px]">
            <ToneMark tone={p.tone} step={p.step} />
            <span className={cx("truncate", p.tone === "fail" ? "font-bold text-accent" : p.tone === "warn" ? "text-accent" : "text-text-2")}>
              {p.label}
            </span>
            {p.note ? <span className="text-muted">{p.note}</span> : null}
            <span className="font-mono text-muted tabular-nums">
              {p.text ?? p.value}
              {total > 0 && p.value > 0 ? ` · ${pct(p.value)}%` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Легенда рядов: форма, цвет и слово — у графика с двумя рядами и больше */
export function SeriesLegend({ items }: { items: readonly { key: string; label: string; tone: Tone; step?: number; total?: string }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]">
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-[6px] text-text-2">
          <ToneMark tone={i.tone} step={i.step} />
          {i.label}
          {i.total ? <span className="font-mono text-muted tabular-nums">{i.total}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export interface ColumnGroup {
  key: string;
  /** Подпись под группой и в подсказке: «12 вер.» */
  label: string;
  /** По значению на ряд, по ключу ряда */
  values: Readonly<Record<string, number>>;
}

export interface ColumnSeries {
  key: string;
  label: string;
  tone: Tone;
  step?: number;
}

const GP = { top: 12, right: 8, bottom: 26, left: 40 };

/**
 * Столбцы по дням из нескольких рядов — рядом, а не друг на друге.
 *
 * «Збій» и «відновлено» — не части одного целого: сложить их в столбец
 * значило бы нарисовать сумму, у которой нет смысла. Поэтому столбцы
 * стоят парой в одной корзине дня, у каждого ряда свой тон, и легенда
 * называет их словами. Ось от нуля — у столбца другой высоты нет (правило
 * TimeColumns), подписи дат — не чаще раза в 64 пикселя, считая от
 * последнего дня.
 */
export function GroupedColumns({
  groups,
  series,
  height = 200,
  label,
}: {
  groups: readonly ColumnGroup[];
  series: readonly ColumnSeries[];
  height?: number;
  label: string;
}) {
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!groups.length || !series.length) return <NoData />;

  const top = Math.max(0, ...groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0)));
  const axis = axisFor({ lo: 0, hi: top });
  const pw = Math.max(40, W - GP.left - GP.right);
  const ph = height - GP.top - GP.bottom;
  const slot = pw / groups.length;
  const gw = Math.max(2 * series.length, Math.min(14 * series.length, slot * 0.7));
  const bw = gw / series.length;
  const yAt = (v: number) => GP.top + ph - (v / Math.max(axis.max, 1)) * ph;
  const xAt = (i: number) => GP.left + slot * i + slot / 2;
  const every = Math.max(1, Math.ceil(64 / slot));
  const totals = series.map((s) => groups.reduce((sum, g) => sum + (g.values[s.key] ?? 0), 0));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const i = Math.floor((((e.clientX - box.left) / box.width) * W - GP.left) / slot);
    setHover(i >= 0 && i < groups.length ? i : null);
  };
  const at = hover === null ? null : groups[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${groups[0]!.label} — ${groups.at(-1)!.label}; ${series.map((s, i) => `${s.label} ${totals[i]}`).join(", ")}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={GP.left} x2={W - GP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={GP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}
        {groups.map((g, i) =>
          series.map((s, si) => {
            const v = g.values[s.key] ?? 0;
            if (v <= 0) return null;
            return (
              <rect
                key={`${g.key}-${s.key}`}
                x={xAt(i) - gw / 2 + si * bw}
                y={yAt(v)}
                width={Math.max(1, bw - 1)}
                height={Math.max(0, yAt(0) - yAt(v))}
                rx={1.5}
                fill={toneColor(s.tone, s.step)}
                fillOpacity={hover === null || hover === i ? 1 : 0.45}
              />
            );
          }),
        )}
        {groups.map((g, i) =>
          (groups.length - 1 - i) % every === 0 ? (
            <text key={g.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
              {g.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.label}</span>
          {series.map((s) => (
            <span key={s.key} className="chart-tip-row">
              <ToneMark tone={s.tone} step={s.step} />
              <span className="grow">{s.label}</span>
              <b>{num(at.values[s.key] ?? 0)}</b>
            </span>
          ))}
        </div>
      ) : null}
      <SeriesLegend items={series.map((s, i) => ({ ...s, total: String(totals[i]) }))} />
    </div>
  );
}

export interface GapPoint {
  key: string;
  label: string;
  /** null — в этот день мерить было нечего: линия рвётся, а не падает в ноль */
  value: number | null;
}

const LP = { top: 12, right: 12, bottom: 26, left: 52 };

/**
 * Линия по дням с разрывами.
 *
 * LineChart общего набора ставит точки через равные шаги по их номеру, и
 * день без данных, выброшенный из ряда, сжимал бы время: неделя тишины
 * между двумя замерами выглядела бы соседними днями. Здесь ось — все дни
 * периода, а день без данных — разрыв линии: у доли отказов в день без
 * отправок нет значения, у p75 в день без замеров — тоже, и ноль на их
 * месте был бы неправдой (docs/ARCHITECTURE.md: невычислимое — null).
 *
 * Ось от нуля: у доли и у времени ноль — настоящее начало, и срезанная ось
 * показала бы «вдвое хуже» там, где хуже на процент. Пороги (`guides`) —
 * пунктиром, и только когда попадают в ось данных: тянуть ось к порогу,
 * до которого данные не доходят, — то самое растягивание, от которого
 * предостерегает charts/scale.ts; порог при этом назван в подписи фигуры.
 */
export function GapLine({
  points,
  label,
  format,
  tick = num,
  guides = [],
  height = 200,
}: {
  points: readonly GapPoint[];
  label: string;
  /** Значение в подсказке: «4,2 %», «2,1 с» */
  format: (v: number) => string;
  /** Подпись деления оси: короче значения */
  tick?: (v: number) => string;
  guides?: readonly { value: number; label: string }[];
  height?: number;
}) {
  const { ut } = useLang();
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const known = points.filter((p): p is GapPoint & { value: number } => p.value !== null);
  if (!known.length) return <NoData />;

  const axis = axisFor({ lo: 0, hi: Math.max(...known.map((p) => p.value)) });
  const pw = Math.max(40, W - LP.left - LP.right);
  const ph = height - LP.top - LP.bottom;
  const n = points.length;
  const xAt = (i: number) => LP.left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yAt = (v: number) => LP.top + ph - ((v - axis.min) / Math.max(axis.max - axis.min, Number.EPSILON)) * ph;
  const every = Math.max(1, Math.ceil(64 / (pw / Math.max(1, n - 1))));

  /* отрезки — между соседними известными днями; одиночный день — только точкой */
  const runs: number[][] = [];
  points.forEach((p, i) => {
    if (p.value === null) return;
    const last = runs.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else runs.push([i]);
  });

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const share = (((e.clientX - box.left) / box.width) * W - LP.left) / pw;
    setHover(share < -0.02 || share > 1.02 ? null : Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };
  const at = hover === null ? null : points[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${points[0]!.label} — ${points.at(-1)!.label}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={LP.left} x2={W - LP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={LP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {tick(t)}
            </text>
          </g>
        ))}
        {guides
          .filter((g) => g.value > axis.min && g.value <= axis.max)
          .map((g) => (
            <g key={g.label}>
              <line
                x1={LP.left}
                x2={W - LP.right}
                y1={yAt(g.value)}
                y2={yAt(g.value)}
                stroke="var(--axis)"
                strokeOpacity={0.6}
                strokeDasharray="3 4"
              />
              <text x={W - LP.right} y={yAt(g.value) - 4} fontSize="10" fill="var(--axis)" textAnchor="end">
                {g.label}
              </text>
            </g>
          ))}
        {at ? <line x1={xAt(hover!)} x2={xAt(hover!)} y1={LP.top} y2={LP.top + ph} stroke="var(--primary)" strokeOpacity={0.35} /> : null}
        {runs.map((run) =>
          run.length > 1 ? (
            <path
              key={run[0]}
              d={run.map((i, k) => `${k ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(points[i]!.value!).toFixed(1)}`).join(" ")}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2}
            />
          ) : null,
        )}
        {points.map((p, i) =>
          p.value === null ? null : (
            <circle key={p.key} cx={xAt(i)} cy={yAt(p.value)} r={hover === i ? 5 : 3} fill="var(--primary)" stroke="var(--card)" strokeWidth={1.5} />
          ),
        )}
        {points.map((p, i) =>
          (n - 1 - i) % every === 0 ? (
            <text key={p.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
              {p.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.label}</span>
          <span className="chart-tip-row">{at.value === null ? <span className="text-muted">{ut("sig.noValue")}</span> : <b>{format(at.value)}</b>}</span>
        </div>
      ) : null}
    </div>
  );
}
