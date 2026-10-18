import { useRef, useState } from "react";
import { severityKey } from "../format";
import type { Severity } from "@quizzy/shared";
import { NoData } from "../ui/primitives";
import { cx } from "../ui/cx";
import { HeatTable } from "./clinical";
import { AxisBreak, AxisNote, useChartWidth } from "./index";
import {
  ATTENTION_COLOR,
  ChartLegend,
  ChartTip,
  FOCUSABLE,
  Marker,
  OTHER_COLOR,
  RowTip,
  SERIES_COLORS,
  SINGLE_COLOR,
  SevChip,
  TipHead,
  TipRow,
  seriesColor,
  useIndexHover,
} from "./kit";
import { axisFor } from "./scale";
import { useLang } from "../lang";

/**
 * Продвинутые формы: профиль-радар, разброс, рассеяние, тепловая карта,
 * воронка, знаковые полосы — в языке «Виразної»: ряды c1…c4 и c5 для
 * сравнения, метки с кольцом поверхности, подсказка у каждой формы. Янтарь —
 * то, что требует внимания (помеченные протоколы, обратная связь пункта);
 * красного здесь нет — риска для человека эти формы не показывают.
 */

/* ─────────── радар: профиль по субшкалам ─────────── */

export function Radar({
  axes,
  compare,
  labels,
  size = 320,
}: {
  axes: { label: string; value: number }[];
  compare?: { label: string; value: number }[];
  labels?: string[];
  size?: number;
}) {
  const { ut } = useLang();
  const [hover, setHover] = useState<number | null>(null);
  /* значение по умолчанию берётся здесь, а не в сигнатуре: словарь читается хуком */
  const names = labels ?? [ut("chart.current"), ut("chart.first")];
  if (axes.length < 3) return <p className="m-0 text-small text-muted">{ut("chart.radarHint")}</p>;
  const c = size / 2;
  const r = c - 62;
  const step = (Math.PI * 2) / axes.length;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + i * step;
    const k = Math.max(0, Math.min(1, v));
    return [c + Math.cos(a) * r * k, c + Math.sin(a) * r * k] as const;
  };
  const poly = (d: { value: number }[]) => d.map((x, i) => pt(i, x.value).join(",")).join(" ");
  const pctOf = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)} %`;
  const now = SERIES_COLORS[0];

  return (
    <div className="relative">
      <svg width={size} height={size} role="img" aria-label={axes.map((a) => `${a.label} ${pctOf(a.value)}`).join(", ")} onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map((ring) => (
          <polygon key={ring} points={axes.map((_, i) => pt(i, ring).join(",")).join(" ")} fill="none" stroke="var(--grid)" />
        ))}
        {axes.map((_, i) => {
          const [x, y] = pt(i, 1);
          return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke={hover === i ? "var(--vink)" : "var(--grid)"} strokeDasharray={hover === i ? "2 2" : undefined} />;
        })}
        {compare ? <polygon points={poly(compare)} fill="none" stroke={OTHER_COLOR} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" /> : null}
        <polygon points={poly(axes)} fill={now} fillOpacity={0.12} stroke={now} strokeWidth={2} strokeLinejoin="round" />
        {axes.map((a, i) => {
          const [x, y] = pt(i, a.value);
          return <Marker key={i} x={x} y={y} r={hover === i ? 5 : 3.6} color={now} />;
        })}
        {axes.map((a, i) => {
          const [x, y] = pt(i, 1.2);
          return (
            <text
              key={i}
              x={x}
              y={y + 4}
              fontSize={11}
              fontWeight={hover === i ? 800 : 600}
              fill={hover === i ? "var(--text)" : "var(--muted)"}
              textAnchor={Math.abs(x - c) < 14 ? "middle" : x > c ? "start" : "end"}
            >
              {a.label.length > 16 ? `${a.label.slice(0, 15)}…` : a.label}
            </text>
          );
        })}
        {/* зона наведения — сектор у каждой оси, а не точка в пять пикселей */}
        {axes.map((_, i) => {
          const [x, y] = pt(i, 1.05);
          return <circle key={`h-${i}`} cx={x} cy={y} r={22} fill="transparent" onMouseEnter={() => setHover(i)} />;
        })}
      </svg>
      {hover !== null ? (
        <ChartTip x={pt(hover, axes[hover]!.value)[0]} y={pt(hover, axes[hover]!.value)[1]} width={size}>
          <TipHead>{axes[hover]!.label}</TipHead>
          <TipRow color={now} label={names[0]} value={pctOf(axes[hover]!.value)} />
          {compare?.[hover] ? <TipRow color={OTHER_COLOR} label={names[1]} value={pctOf(compare[hover]!.value)} /> : null}
        </ChartTip>
      ) : null}
      {compare ? (
        <ChartLegend
          items={[
            { key: "now", label: names[0], color: now, kind: "line" },
            { key: "first", label: names[1], color: OTHER_COLOR, kind: "dash" },
          ]}
        />
      ) : null}
      <p className="m-0 mt-[8px] text-caption leading-[16px] text-muted">{ut("chart.radarNormNote")}</p>
    </div>
  );
}

/* ─────────── ящик с усами ─────────── */

export interface Box {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export function BoxPlot({ boxes, categorical = false, height = 240 }: { boxes: Box[]; categorical?: boolean; height?: number }) {
  const { ut } = useLang();
  const [W, box] = useChartWidth();
  const [hover, setHover] = useState<number | null>(null);
  if (!boxes.length) return <NoData />;

  /*
   * Ось — по нарисованному, а не по теоретическому максимуму шкалы; `atom` —
   * типичная высота коробки: сдвиг медианы меньше размаха не тянет на
   * разницу между шкалами.
   */
  const widths = boxes.map((b) => b.q3 - b.q1).sort((a, b) => a - b);
  const axis = axisFor({
    lo: Math.min(...boxes.map((b) => b.min)),
    hi: Math.max(...boxes.map((b) => b.max)),
    atom: widths[Math.floor(widths.length / 2)] ?? 0,
  });
  const ph = height - 46;
  const yAt = (v: number) => 14 + ph - ((v - axis.min) / Math.max(axis.max - axis.min, Number.EPSILON)) * ph;
  const slot = (W - 60) / boxes.length;
  const cxOf = (i: number) => 50 + slot * i + slot / 2;
  const fmt = (v: number) => String(Math.round(v * 10) / 10);
  const at = hover === null ? null : boxes[hover]!;

  return (
    <div className="relative min-w-0 overflow-x-auto" ref={box}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label={boxes.map((b) => `${b.label} ${fmt(b.median)}`).join(", ")} onMouseLeave={() => setHover(null)}>
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={50} x2={W - 10} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={44} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {boxes.map((b, i) => {
          const cx = cxOf(i);
          const color = categorical ? seriesColor(i, boxes.length) : SINGLE_COLOR;
          const bw = Math.min(40, slot * 0.5);
          return (
            <g key={b.label} opacity={hover === null || hover === i ? 1 : 0.5} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={14} width={slot} height={ph} fill="transparent" />
              <line x1={cx} x2={cx} y1={yAt(b.max)} y2={yAt(b.q3)} stroke="var(--muted)" />
              <line x1={cx} x2={cx} y1={yAt(b.q1)} y2={yAt(b.min)} stroke="var(--muted)" />
              <line x1={cx - 8} x2={cx + 8} y1={yAt(b.max)} y2={yAt(b.max)} stroke="var(--muted)" />
              <line x1={cx - 8} x2={cx + 8} y1={yAt(b.min)} y2={yAt(b.min)} stroke="var(--muted)" />
              <rect
                x={cx - bw / 2}
                y={yAt(b.q3)}
                width={bw}
                height={Math.max(2, yAt(b.q1) - yAt(b.q3))}
                fill={color}
                fillOpacity={0.14}
                stroke={color}
                strokeWidth={2}
                rx={4}
              />
              <line x1={cx - bw / 2} x2={cx + bw / 2} y1={yAt(b.median)} y2={yAt(b.median)} stroke={color} strokeWidth={3} strokeLinecap="round" />
              <text x={cx} y={height - 8} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
                {b.label.length > 12 ? `${b.label.slice(0, 11)}…` : b.label}
              </text>
            </g>
          );
        })}
        {axis.zoomed ? <AxisBreak x={50} y={14 + ph} /> : null}
      </svg>
      {at ? (
        <ChartTip x={cxOf(hover!)} y={yAt(at.q3)} width={W}>
          <TipHead>{at.label}</TipHead>
          <TipRow label={ut("chart.median")} value={fmt(at.median)} />
          <TipRow label={ut("chart.iqr")} value={`${fmt(at.q1)}–${fmt(at.q3)}`} />
          <TipRow label={ut("chart.range")} value={`${fmt(at.min)}–${fmt(at.max)}`} />
        </ChartTip>
      ) : null}
      <p className="m-0 mt-[6px] text-caption leading-[16px] text-muted">{ut("chart.boxHint")}</p>
      <AxisNote axis={axis} lo={Math.min(...boxes.map((b) => b.min))} hi={Math.max(...boxes.map((b) => b.max))} />
    </div>
  );
}

/* ─────────── рассеяние ─────────── */

export function Scatter({
  points,
  xLabel,
  yLabel,
  xThreshold,
  height = 280,
}: {
  points: { x: number; y: number; flagged?: boolean }[];
  xLabel: string;
  yLabel: string;
  xThreshold?: number;
  height?: number;
}) {
  const { ut } = useLang();
  /*
   * Крючки — до любого раннего выхода: при пустых данных React иначе увидел
   * бы на крючок меньше, чем в прошлый раз.
   */
  const [W, box] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(points.length);
  const xMax = Math.max(...points.map((p) => p.x), xThreshold ?? 0, 1);
  const yMax = Math.max(...points.map((p) => p.y), 1);
  if (!points.length) return <NoData />;
  const ph = height - 50;
  const xAt = (v: number) => 50 + (v / xMax) * (W - 70);
  const yAt = (v: number) => 14 + ph - (v / yMax) * ph;
  const flagged = points.filter((p) => p.flagged).length;

  /* ближайшая точка под курсором: метка в 8 px — не цель для указателя */
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const b = svgRef.current?.getBoundingClientRect();
    if (!b) return;
    const px = ((e.clientX - b.left) / b.width) * W;
    const py = ((e.clientY - b.top) / b.height) * height;
    let best = -1;
    let dist = 24 * 24;
    points.forEach((p, i) => {
      const d = (xAt(p.x) - px) ** 2 + (yAt(p.y) - py) ** 2;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    hover.setAt(best < 0 ? null : best);
  };
  const at = hover.at === null ? null : points[hover.at]!;

  return (
    <div className="relative min-w-0 overflow-x-auto" ref={box}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${xLabel} / ${yLabel}: ${points.length}`}
        className={cx("block", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {[0, yMax / 2, yMax].map((t) => (
          <g key={t}>
            <line x1={50} x2={W - 12} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={44} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {xThreshold !== undefined ? (
          <>
            <line x1={xAt(xThreshold)} x2={xAt(xThreshold)} y1={14} y2={14 + ph} stroke={ATTENTION_COLOR} strokeDasharray="4 3" />
            <text x={xAt(xThreshold) + 5} y={26} fontSize={11} fontWeight={700} fill="var(--warn)">
              {ut("chart.threshold")}
            </text>
          </>
        ) : null}
        {points.map((p, i) =>
          p.flagged ? (
            <Marker key={i} shape="diamond" x={xAt(p.x)} y={yAt(p.y)} r={4.5} color={ATTENTION_COLOR} />
          ) : (
            <Marker key={i} x={xAt(p.x)} y={yAt(p.y)} r={hover.at === i ? 5.5 : 4} color={SINGLE_COLOR} ringWidth={1.5} />
          ),
        )}
        <text x={50} y={height - 6} fontSize={11} fontWeight={600} fill="var(--axis)">
          {xLabel}
        </text>
        <text x={44} y={12} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
          {yLabel}
        </text>
      </svg>
      {at ? (
        <ChartTip x={xAt(at.x)} y={yAt(at.y)} width={W}>
          {at.flagged ? <TipHead>{ut("chart.flaggedCareless")}</TipHead> : null}
          <TipRow label={xLabel} value={Math.round(at.x * 10) / 10} />
          <TipRow label={yLabel} value={Math.round(at.y * 10) / 10} />
        </ChartTip>
      ) : null}
      {flagged ? (
        <ChartLegend
          items={[
            { key: "ok", label: ut("chart.ordinary"), color: SINGLE_COLOR, kind: "mark" },
            { key: "flag", label: `${ut("chart.flaggedCareless")} (${flagged})`, color: ATTENTION_COLOR, kind: "mark", shape: "diamond" },
          ]}
        />
      ) : null}
    </div>
  );
}

/* ─────────── тепловая карта ─────────── */

/** Доли по строкам и колонкам — тепловой таблицей набора: значение в каждой клетке */
export function Heatmap({ rows, columns, unit = "%" }: { rows: { label: string; cells: number[] }[]; columns: string[]; unit?: string }) {
  const { ut } = useLang();
  if (!rows.length) return <NoData />;
  const max = Math.max(...rows.flatMap((r) => r.cells), 1);
  return (
    <div>
      <HeatTable
        rows={rows.map((r, i) => ({ key: `${i}-${r.label}`, label: <span className="block max-w-[320px] truncate">{r.label}</span>, cells: r.cells }))}
        columns={columns}
        max={max}
        format={(v) => `${Math.round(v)}${unit}`}
      />
      <p className="m-0 mt-[8px] text-caption leading-[16px] text-muted">{ut("chart.heatHint")}</p>
    </div>
  );
}

/* ─────────── воронка ─────────── */

/**
 * Воронка — полосами строк от общего нуля: сколько дошло до каждого шага и
 * сколько потеряно на переходе. Трапеции прежней воронки рисовали ширину
 * дважды (сверху и снизу), и глаз сравнивал площади вместо длин.
 */
export function Funnel({ stages }: { stages: { label: string; value: number; lost: number }[] }) {
  const { ut } = useLang();
  if (!stages.length) return <NoData />;
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div>
      <ul className="m-0 grid list-none gap-[6px] p-0">
        {stages.map((s, i) => (
          <li
            key={i}
            tabIndex={0}
            className="group/row relative grid min-h-[28px] grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(64px,auto)] items-center gap-[12px] rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
          >
            <span className="truncate text-[13px] font-semibold text-text-2">{s.label}</span>
            <span className="relative h-[14px]">
              <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(1.5, (s.value / max) * 100).toFixed(2)}%`, background: SINGLE_COLOR }} />
            </span>
            <span className="text-right text-[13px] font-extrabold whitespace-nowrap text-text">
              {s.value}
              {s.lost > 0 ? <small className="ml-[8px] text-[11.5px] font-bold text-warn">−{s.lost}</small> : null}
            </span>
            <RowTip at={0.4}>
              <TipHead>{s.label}</TipHead>
              <TipRow value={s.value} extra={s.lost > 0 ? `−${s.lost}` : undefined} />
            </RowTip>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-[8px] text-caption leading-[16px] text-muted">{ut("chart.funnelHint")}</p>
    </div>
  );
}

/* ─────────── знаковые полосы ─────────── */

/**
 * Связь со знаком: полоса от середины влево или вправо. Положительная и
 * достаточная — фиолетовым, слабая — серым «прочего», отрицательная — янтарём:
 * обратная связь пункта со шкалой требует внимания составителя методики.
 */
export function DivergingBar({ items, domain = 1, goodThreshold }: { items: { label: string; value: number }[]; domain?: number; goodThreshold?: number }) {
  const { ut } = useLang();
  if (!items.length) return <NoData />;
  return (
    <div>
      <ul className="m-0 grid list-none gap-[6px] p-0">
        {items.map((it) => {
          const weak = goodThreshold !== undefined && it.value < goodThreshold;
          const color = it.value < 0 ? ATTENTION_COLOR : weak ? OTHER_COLOR : SINGLE_COLOR;
          const pct = (Math.max(-domain, Math.min(domain, it.value)) / domain) * 50;
          return (
            <li
              key={it.label}
              tabIndex={0}
              className="group/row relative grid min-h-[28px] grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(48px,auto)] items-center gap-[12px] rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
            >
              <span className="truncate text-[13px] font-semibold text-text-2">{it.label}</span>
              <span className="relative h-[14px]">
                <span aria-hidden className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px bg-ctl" />
                <span
                  className={cx("absolute top-0 h-full", pct >= 0 ? "rounded-r-[4px]" : "rounded-l-[4px]")}
                  style={{ left: pct >= 0 ? "50%" : `${50 + pct}%`, width: `${Math.abs(pct)}%`, background: color }}
                />
              </span>
              <span className="text-right text-[13px] font-extrabold text-text">{it.value.toFixed(2)}</span>
              <RowTip at={0.4}>
                <TipHead>{it.label}</TipHead>
                <TipRow kind="box" color={color} value={it.value.toFixed(2)} />
              </RowTip>
            </li>
          );
        })}
      </ul>
      {goodThreshold !== undefined ? (
        <p className="m-0 mt-[8px] text-caption leading-[16px] text-muted">
          {ut("chart.lowCorrPrefix")} {goodThreshold} {ut("chart.lowCorrSuffix")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Метка выраженности — плашка набора (.sev): ступень всегда со своим
 * словом, никогда цветом в одиночку.
 */
export function SeverityTag({ severity, label }: { severity: Severity; label?: string }) {
  const { ut } = useLang();
  /*
   * Метка без подписи показывала код ступени — «moderate» рядом с баллом.
   * Запасная подпись — из словаря, как у мобильного близнеца.
   */
  return <SevChip severity={severity} label={label ?? ut(severityKey[severity], severity)} small />;
}
