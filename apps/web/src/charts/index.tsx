import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { SERIES } from "../format";
import { Panel } from "../ui/layout";

/**
 * Диаграммы консоли — plain SVG без библиотек.
 *
 * Правила одни на весь проект: одна величина рисуется одним цветом,
 * категориальные слоты берутся по фиксированному порядку, сетка приглушена,
 * подписи стоят рядом со значением, легенда обязательна при двух и более сериях.
 */

const PAD = { top: 14, right: 16, bottom: 26, left: 44 };

function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100));

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i className="dot" style={{ background: i.color }} /> {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Обёртка графика — та же панель, что у остального содержимого.
 *
 * Раньше она рисовала свою карточку с собственным ритмом отступов, и на
 * одном экране график стоял рядом с панелью, отличаясь от неё на несколько
 * пикселей поля. По одному такое расхождение незаметно, но экран из панелей
 * и «почти панелей» читается как собранный из двух разных приложений.
 */
export function Chart({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Panel title={title} hint={hint}>
      {children}
    </Panel>
  );
}

/* ─────────── линия / область ─────────── */

export interface LinePoint {
  x: string;
  y: number;
  tone?: string;
  /**
   * Полуширина интервала ошибки измерения (SEM).
   *
   * T-балл без него вводит в заблуждение: 62 и 65 выглядят как разные числа,
   * хотя при SEM = 4 это одно и то же измерение. Полоса рисуется только там,
   * где интервал известен, — придумывать его нельзя.
   */
  err?: number | null;
}

/**
 * Событие на оси времени: ротация, госпитализация, начало терапии.
 *
 * Без них изменение читается как случайность. С ними видно, что балл вырос
 * после перевода в другое подразделение, — и это уже разговор, а не догадка.
 */
export interface TimeMark {
  /** Подпись точки по оси X, к которой привязано событие */
  x: string;
  label: string;
}

export function LineChart({
  series,
  height = 220,
  area = false,
  yMax,
  marks,
}: {
  series: { label: string; points: LinePoint[]; color?: string }[];
  height?: number;
  area?: boolean;
  yMax?: number;
  marks?: TimeMark[];
}) {
  const W = 900;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const all = series.flatMap((s) => s.points);
  // верх шкалы учитывает полосу ошибки: иначе она обрезалась бы краем поля
  const top = Math.max(yMax ?? 0, ...all.map((p) => p.y + (p.err ?? 0)), 1);
  const ts = ticks(top);
  const scale = Math.max(...ts, top);
  const pw = W - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;
  const n = Math.max(1, ...series.map((s) => s.points.length));
  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yAt = (v: number) => PAD.top + ph - (v / scale) * ph;

  /*
   * Индекс точки под курсором считается из доли ширины, а не поиском
   * ближайшего узла: точки расположены равномерно, и деление дешевле перебора
   * на графике в триста замеров.
   */
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const rel = ((e.clientX - box.left) / box.width) * W;
    const share = (rel - PAD.left) / pw;
    if (share < -0.02 || share > 1.02) {
      setHover(null);
      return;
    }
    setHover(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };

  if (!all.length) return <p className="muted">Данных пока нет</p>;

  const at = hover ?? -1;
  const label = series[0]?.points[at]?.x;

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        /*
         * Роль img обязывает дать имя: без него диктор объявляет «графика» и
         * замолкает. Имя собирается из рядов и границ периода — это то, что
         * зрячий читает с осей за секунду.
         */
        aria-label={`${series.map((s) => s.label).join(", ")}: ${all[0]?.x ?? ""} — ${series[0]?.points.at(-1)?.x ?? ""}`}
      >
        {ts.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={PAD.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}

        {/* перекрестье под линиями: оно ориентир, а не содержание */}
        {at >= 0 ? (
          <line
            x1={xAt(at)}
            x2={xAt(at)}
            y1={PAD.top}
            y2={PAD.top + ph}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ) : null}

        {series.map((s, si) => {
          const color = s.color ?? SERIES[si % SERIES.length];
          const d = s.points.map((p, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(p.y)}`).join(" ");

          /*
           * Полоса ошибки рисуется под линией и без обводки: это фон, в
           * котором лежит измерение, а не второй ряд данных. Строится только
           * если интервал известен у всех точек ряда — полоса «местами» врала
           * бы про то, где измерение точнее.
           */
          const hasErr = s.points.length > 1 && s.points.every((p) => (p.err ?? null) !== null);
          const band = hasErr
            ? [
                ...s.points.map((p, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(p.y + p.err!)}`),
                ...s.points
                  .map((p, i) => ({ p, i }))
                  .reverse()
                  .map(({ p, i }) => `L${xAt(i)},${yAt(Math.max(0, p.y - p.err!))}`),
                "Z",
              ].join(" ")
            : null;

          return (
            <g key={s.label}>
              {band ? <path d={band} fill={color} opacity={0.14} /> : null}
              {area ? (
                <path
                  d={`${d} L${xAt(s.points.length - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`}
                  fill={color}
                  opacity={0.12}
                />
              ) : null}
              <path d={d} stroke={color} strokeWidth={2} fill="none" />
              {/*
                Узлы рисуются только на коротких рядах: на трёхстах замерах
                они сливаются в сплошную полосу и мешают читать линию.
                Под курсором узел показывается всегда — он и есть ответ на
                вопрос «сколько здесь».
              */}
              {s.points.length <= 60
                ? s.points.map((p, i) => (
                    <circle
                      key={i}
                      cx={xAt(i)}
                      cy={yAt(p.y)}
                      r={4}
                      fill={p.tone ?? color}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  ))
                : null}
              {at >= 0 && s.points[at] ? (
                <circle
                  cx={xAt(at)}
                  cy={yAt(s.points[at]!.y)}
                  r={5}
                  fill={s.points[at]!.tone ?? color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              ) : null}
            </g>
          );
        })}

        {/*
          Отметки событий — вертикальные пунктиры с подписью у верхнего края.
          Подпись наверху, а не у оси: внизу она столкнулась бы с подписями
          дат, а событие важнее даты, к которой оно привязано.
        */}
        {marks?.map((m) => {
          const i = series[0]?.points.findIndex((p) => p.x === m.x) ?? -1;
          if (i < 0) return null;
          return (
            <g key={`${m.x}-${m.label}`}>
              <line
                x1={xAt(i)}
                x2={xAt(i)}
                y1={PAD.top}
                y2={PAD.top + ph}
                stroke="var(--axis)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              <text x={xAt(i) + 4} y={PAD.top + 10} fontSize="10" fill="var(--axis)">
                {m.label}
              </text>
            </g>
          );
        })}

        <line x1={PAD.left} x2={W - PAD.right} y1={yAt(0)} y2={yAt(0)} stroke="var(--axis)" />
        <text x={PAD.left} y={height - 6} fontSize="11" fill="var(--axis)">
          {all[0]?.x}
        </text>
        <text x={W - PAD.right} y={height - 6} fontSize="11" fill="var(--axis)" textAnchor="end">
          {series[0]?.points.at(-1)?.x}
        </text>
      </svg>

      {at >= 0 && label ? (
        <div
          className="chart-tip"
          style={{ left: `${((xAt(at) / W) * 100).toFixed(2)}%` }}
          role="status"
        >
          <span className="chart-tip-x">{label}</span>
          {series.map((s, si) => {
            const point = s.points[at];
            if (!point) return null;
            return (
              <span key={s.label} className="chart-tip-row">
                <i style={{ background: s.color ?? SERIES[si % SERIES.length] }} />
                {series.length > 1 ? <span className="grow">{s.label}</span> : null}
                <b>{fmt(point.y)}</b>
              </span>
            );
          })}
        </div>
      ) : null}

      <Legend items={series.map((s, i) => ({ label: s.label, color: s.color ?? SERIES[i % SERIES.length]! }))} />
    </div>
  );
}

/* ─────────── горизонтальные столбики ─────────── */

export function BarList({
  items,
  unit = "",
  max,
}: {
  items: { label: string; value: number; color?: string; caption?: string }[];
  unit?: string;
  max?: number;
}) {
  if (!items.length) return <p className="muted">Данных пока нет</p>;
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((i, k) => (
        <div key={k}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 3 }}>
            <span style={{ fontSize: 13 }}>{i.label}</span>
            <span className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {i.value}
              {unit}
              {i.caption ? ` · ${i.caption}` : ""}
            </span>
          </div>
          <div style={{ height: 10, background: "var(--grid)", borderRadius: 6 }}>
            <div
              style={{
                height: 10,
                width: `${Math.max(1.5, (i.value / top) * 100)}%`,
                background: i.color ?? "var(--primary)",
                borderRadius: 6,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────── кольцо ─────────── */

export function Donut({
  slices,
  center,
  centerLabel,
  size = 190,
}: {
  slices: { label: string; value: number; color: string }[];
  center?: string;
  centerLabel?: string;
  size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="muted">Данных пока нет</p>;
  const r = size / 2 - 10;
  const inner = r * 0.62;
  const c = size / 2;
  const GAP = 0.02;
  let a = -Math.PI / 2;

  return (
    <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
      <svg width={size} height={size}>
        {slices.map((s) => {
          const sweep = (s.value / total) * Math.PI * 2;
          const a0 = a + GAP / 2;
          const a1 = a + sweep - GAP / 2;
          a += sweep;
          const large = sweep > Math.PI ? 1 : 0;
          const p = (rad: number, ang: number) => [c + Math.cos(ang) * rad, c + Math.sin(ang) * rad];
          const [x0, y0] = p(r, a0);
          const [x1, y1] = p(r, a1);
          const [x2, y2] = p(inner, a1);
          const [x3, y3] = p(inner, a0);
          return (
            <path
              key={s.label}
              d={`M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${inner},${inner} 0 ${large} 0 ${x3},${y3} Z`}
              fill={s.color}
            />
          );
        })}
        {center ? (
          <>
            <text x={c} y={c + 3} fontSize="23" fontWeight="700" fill="var(--text)" textAnchor="middle">
              {center}
            </text>
            {centerLabel ? (
              <text x={c} y={c + 20} fontSize="11" fill="var(--muted)" textAnchor="middle">
                {centerLabel}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
      <div style={{ flex: 1, minWidth: 200, display: "grid", gap: 6 }}>
        {slices.map((s) => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <i className="dot" style={{ background: s.color }} />
            <span style={{ flex: 1, fontSize: 13 }}>{s.label}</span>
            <span className="muted" style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {s.value} · {Math.round((s.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
