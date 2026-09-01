import { SERIES, severityColor } from "../format";
import type { Severity } from "@quizzy/shared";
import { NoData } from "../ui/primitives";
import { useChartWidth } from "./index";
import { useLang } from "../lang";

/** Продвинутые формы: профиль, разброс, рассеяние, тепловая карта, воронка, знаковые столбики */

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
  /* значение по умолчанию берётся здесь, а не в сигнатуре: словарь читается
     хуком, а хук в значении параметра вызвать нельзя */
  const names = labels ?? [ut("chart.current"), ut("chart.first")];
  if (axes.length < 3) return <p className="muted">{ut("chart.radarHint")}</p>;
  const c = size / 2;
  const r = c - 62;
  const step = (Math.PI * 2) / axes.length;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + i * step;
    return [c + Math.cos(a) * r * Math.max(0, Math.min(1, v)), c + Math.sin(a) * r * Math.max(0, Math.min(1, v))];
  };
  const poly = (d: { value: number }[]) => d.map((x, i) => pt(i, x.value).join(",")).join(" ");

  return (
    <div>
      <svg width={size} height={size}>
        {[0.25, 0.5, 0.75, 1].map((ring) => (
          <polygon
            key={ring}
            points={axes.map((_, i) => pt(i, ring).join(",")).join(" ")}
            fill="none"
            stroke="var(--grid)"
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = pt(i, 1);
          return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="var(--grid)" />;
        })}
        {compare ? (
          <polygon points={poly(compare)} fill={SERIES[1]} fillOpacity={0.12} stroke={SERIES[1]} strokeWidth={2} strokeDasharray="4 3" />
        ) : null}
        <polygon points={poly(axes)} fill={SERIES[0]} fillOpacity={0.2} stroke={SERIES[0]} strokeWidth={2} />
        {axes.map((a, i) => {
          const [x, y] = pt(i, 1.2);
          return (
            <text
              key={i}
              x={x}
              y={y + 4}
              fontSize="11"
              fill="var(--muted)"
              textAnchor={Math.abs(x - c) < 14 ? "middle" : x > c ? "start" : "end"}
            >
              {a.label.length > 16 ? `${a.label.slice(0, 15)}…` : a.label}
            </text>
          );
        })}
      </svg>
      {compare ? (
        <div className="legend">
          <span><i className="dot" style={{ background: SERIES[0] }} /> {names[0]}</span>
          <span><i className="dot" style={{ background: SERIES[1] }} /> {names[1]}</span>
        </div>
      ) : null}
      <p className="hint" style={{ marginTop: 8 }}>
        {ut("chart.radarNormNote")}
      </p>
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

export function boxOf(label: string, values: number[]): Box | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  return { label, min: s[0]!, q1: at(0.25), median: at(0.5), q3: at(0.75), max: s.at(-1)! };
}

export function BoxPlot({ boxes, categorical = false, height = 240 }: { boxes: Box[]; categorical?: boolean; height?: number }) {
  const { ut } = useLang();
  const [W, box] = useChartWidth();
  if (!boxes.length) return <NoData />;
  const top = Math.max(...boxes.map((b) => b.max), 1);
  const ph = height - 46;
  const yAt = (v: number) => 14 + ph - (v / top) * ph;
  const slot = (W - 60) / boxes.length;

  return (
    <div className="scroll-x" ref={box}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height}>
        {[0, top / 2, top].map((t) => (
          <g key={t}>
            <line x1={50} x2={W - 10} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={44} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end">
              {Math.round(t * 10) / 10}
            </text>
          </g>
        ))}
        {boxes.map((b, i) => {
          const cx = 50 + slot * i + slot / 2;
          const color = categorical ? SERIES[i % SERIES.length]! : "var(--primary)";
          const bw = Math.min(46, slot * 0.5);
          return (
            <g key={b.label}>
              <line x1={cx} x2={cx} y1={yAt(b.max)} y2={yAt(b.q3)} stroke="var(--axis)" />
              <line x1={cx} x2={cx} y1={yAt(b.q1)} y2={yAt(b.min)} stroke="var(--axis)" />
              <line x1={cx - 10} x2={cx + 10} y1={yAt(b.max)} y2={yAt(b.max)} stroke="var(--axis)" />
              <line x1={cx - 10} x2={cx + 10} y1={yAt(b.min)} y2={yAt(b.min)} stroke="var(--axis)" />
              <rect
                x={cx - bw / 2}
                y={yAt(b.q3)}
                width={bw}
                height={Math.max(2, yAt(b.q1) - yAt(b.q3))}
                fill={color}
                fillOpacity={0.25}
                stroke={color}
                strokeWidth={2}
                rx={3}
              />
              <line x1={cx - bw / 2} x2={cx + bw / 2} y1={yAt(b.median)} y2={yAt(b.median)} stroke={color} strokeWidth={3} />
              <text x={cx} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
                {b.label.length > 12 ? `${b.label.slice(0, 11)}…` : b.label}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="hint">{ut("chart.boxHint")}</p>
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
   * Крючки — до любого раннего выхода.
   *
   * Здесь стоял `if (!points.length) return` перед вызовом крючка: при
   * пустых данных React видел на один крючок меньше, чем в прошлый раз, и
   * это ломается не сразу, а когда график впервые окажется пустым — то есть
   * у первого же пользователя без данных.
   */
  const [W, box] = useChartWidth();
  const xMax = Math.max(...points.map((p) => p.x), xThreshold ?? 0, 1);
  const yMax = Math.max(...points.map((p) => p.y), 1);
  if (!points.length) return <NoData />;
  const ph = height - 50;
  const xAt = (v: number) => 50 + (v / xMax) * (W - 70);
  const yAt = (v: number) => 14 + ph - (v / yMax) * ph;
  const flagged = points.filter((p) => p.flagged).length;

  return (
    <div className="scroll-x" ref={box}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height}>
        {[0, yMax / 2, yMax].map((t) => (
          <g key={t}>
            <line x1={50} x2={W - 12} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={44} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}
        {xThreshold !== undefined ? (
          <>
            <line x1={xAt(xThreshold)} x2={xAt(xThreshold)} y1={14} y2={14 + ph} stroke="var(--sev-severe)" strokeDasharray="4 3" />
            <text x={xAt(xThreshold) + 5} y={26} fontSize="10" fill="var(--sev-severe)">{ut("chart.threshold")}</text>
          </>
        ) : null}
        {points.map((p, i) => (
          <circle
            key={i}
            cx={xAt(p.x)}
            cy={yAt(p.y)}
            r={p.flagged ? 6 : 4}
            fill={p.flagged ? "var(--sev-severe)" : SERIES[0]}
            fillOpacity={p.flagged ? 0.9 : 0.5}
            stroke={p.flagged ? "var(--card)" : "none"}
            strokeWidth={p.flagged ? 2 : 0}
          />
        ))}
        <text x={50} y={height - 6} fontSize="11" fill="var(--axis)">{xLabel}</text>
        <text x={44} y={12} fontSize="11" fill="var(--axis)" textAnchor="end">{yLabel}</text>
      </svg>
      {flagged ? (
        <div className="legend">
          <span><i className="dot" style={{ background: SERIES[0] }} /> {ut("chart.ordinary")}</span>
          <span><i className="dot" style={{ background: "var(--sev-severe)" }} /> {ut("chart.flaggedCareless")} ({flagged})</span>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────── тепловая карта ─────────── */

export function Heatmap({ rows, columns, unit = "%" }: { rows: { label: string; cells: number[] }[]; columns: string[]; unit?: string }) {
  const { ut } = useLang();
  if (!rows.length) return <NoData />;
  const max = Math.max(...rows.flatMap((r) => r.cells), 1);
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c} className="num">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td style={{ maxWidth: 320 }}>{r.label}</td>
              {r.cells.map((v, i) => {
                const k = v / max;
                return (
                  <td
                    key={i}
                    className="num"
                    style={{
                      background: `color-mix(in srgb, var(--s1) ${Math.round(10 + k * 75)}%, transparent)`,
                      fontWeight: k > 0.6 ? 700 : 400,
                    }}
                  >
                    {Math.round(v)}{unit}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{ut("chart.heatHint")}</p>
    </div>
  );
}

/* ─────────── воронка ─────────── */

export function Funnel({ stages }: { stages: { label: string; value: number; lost: number }[] }) {
  const { ut } = useLang();
  const [W, box] = useChartWidth();
  if (!stages.length) return <NoData />;
  const rowH = 38;
  const H = stages.length * rowH + 10;
  const max = Math.max(...stages.map((s) => s.value), 1);
  const labelW = 300;
  const half = (v: number) => (v / max) * ((W - labelW - 60) / 2);
  const cx = labelW + (W - labelW - 60) / 2;

  return (
    <div className="scroll-x" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
        {stages.map((s, i) => {
          const next = stages[i + 1] ?? s;
          const y0 = i * rowH + 4;
          const y1 = y0 + rowH - 6;
          return (
            <g key={i}>
              <text x={0} y={y0 + 20} fontSize="12" fill="var(--text)">
                {s.label.length > 42 ? `${s.label.slice(0, 41)}…` : s.label}
              </text>
              <path
                d={`M${cx - half(s.value)},${y0} L${cx + half(s.value)},${y0} L${cx + half(next.value)},${y1} L${cx - half(next.value)},${y1} Z`}
                fill={SERIES[0]}
                fillOpacity={0.75}
              />
              <text x={W - 4} y={y0 + 20} fontSize="12" fill="var(--muted)" textAnchor="end">{s.value}</text>
              {s.lost > 0 ? (
                <text x={cx} y={y1 + 2} fontSize="10" fill="var(--sev-severe)" textAnchor="middle">−{s.lost}</text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="hint">{ut("chart.funnelHint")}</p>
    </div>
  );
}

/* ─────────── знаковые столбики ─────────── */

export function DivergingBar({ items, domain = 1, goodThreshold }: { items: { label: string; value: number }[]; domain?: number; goodThreshold?: number }) {
  const { ut } = useLang();
  if (!items.length) return <NoData />;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((it) => {
        const weak = goodThreshold !== undefined && it.value < goodThreshold;
        const color = it.value < 0 ? "var(--sev-severe)" : weak ? "var(--sev-mild)" : "var(--primary)";
        const pct = (Math.max(-domain, Math.min(domain, it.value)) / domain) * 50;
        return (
          <div key={it.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
              <span>{it.label}</span>
              <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{it.value.toFixed(2)}</span>
            </div>
            <div style={{ position: "relative", height: 12, background: "var(--grid)", borderRadius: 4 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--axis)" }} />
              <div
                style={{
                  position: "absolute",
                  left: pct >= 0 ? "50%" : `${50 + pct}%`,
                  width: `${Math.abs(pct)}%`,
                  height: 12,
                  background: color,
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        );
      })}
      {goodThreshold !== undefined ? (
        <p className="hint">
          {ut("chart.lowCorrPrefix")} {goodThreshold} {ut("chart.lowCorrSuffix")}
        </p>
      ) : null}
    </div>
  );
}

/** Метка выраженности: цвет + подпись, никогда не цвет в одиночку */
export function SeverityTag({ severity, label }: { severity: Severity; label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
      <i className="dot" style={{ background: severityColor[severity] }} />
      {label ?? severity}
    </span>
  );
}
