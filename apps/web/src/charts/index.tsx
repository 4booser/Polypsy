import { useEffect, useRef, useState } from "react";
import { NoData } from "../ui/primitives";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { placeLabels } from "./courseModel";
import {
  ChartLegend,
  ChartTip,
  FOCUSABLE,
  Marker,
  TipHead,
  TipRow,
  seriesColor,
  shapeOf,
  useDecimal,
  useIndexHover,
} from "./kit";
import { axisFor, type Axis } from "./scale";

/**
 * Диаграммы консоли — plain SVG без библиотек, в языке «Виразної».
 *
 * Правила одни на весь проект (подробно — charts/README.md и kit.tsx): цвет
 * ряда идёт за сущностью в постоянном порядке c1…c4, одиночный ряд —
 * фиолетовый набора, у метки есть форма; сетка — волосяная линия
 * разделителя, подписи осей — 11 px приглушённым; линии 2 px, метки с
 * кольцом поверхности; легенда при двух рядах и больше; подсказка с
 * перекрестьем у каждого графика — мышью и с клавиатуры.
 */

const PAD = { top: 18, right: 16, bottom: 26, left: 40 };

/** Число подписи: тысячи — «1,2k», остальное — до двух знаков; дробь — языка экрана */
function useFmt(): (v: number) => string {
  const dec = useDecimal();
  return (v) => (Math.abs(v) >= 1000 ? `${dec(v / 1000, 1)}k` : dec(v));
}

/** Ширина подписи 11 px — оценка для раскладки подписей оси без наложения */
const textW = (s: string) => s.length * 6.2 + 4;

/**
 * Подпись под графиком, объясняющая ось.
 *
 * Обязательная часть подгонки оси под данные, а не украшение. Ось, начатая
 * не с нуля, читается как обычная — разница в два балла на ней выглядит так
 * же, как разница в двадцать на полной шкале. Пока рядом не написано, где
 * именно живут данные и какова полная шкала, подогнанный график врёт
 * убедительнее растянутого.
 */
export function AxisNote({
  axis,
  lo,
  hi,
  fullRange,
  unit = "",
}: {
  axis: Axis;
  lo: number;
  hi: number;
  fullRange?: number | null;
  unit?: string;
}) {
  const { ut } = useLang();
  const fmt = useFmt();
  const hidesFull = fullRange != null && fullRange > axis.max;
  if (!axis.zoomed && !hidesFull) return null;

  return (
    <p className="m-0 mt-[6px] text-caption leading-[16px] text-muted">
      {axis.zoomed ? <strong className="font-bold text-text-2">{ut("chart.axisCut")}. </strong> : null}
      {ut("chart.actualRange")} {fmt(lo)}–{fmt(hi)}
      {unit}
      {hidesFull ? `; ${ut("chart.fullScale")} 0–${fmt(fullRange)}${unit}` : ""}
    </p>
  );
}

/**
 * Излом на оси: общепринятый знак «здесь вырезан кусок».
 *
 * Подписи хватает не всем и не всегда — её читают после графика, а форму
 * видят до. Излом стоит там, где взгляд ищет ноль, и сообщает то же самое
 * раньше, чем человек успеет прочесть подпись.
 */
export function AxisBreak({ x, y }: { x: number; y: number }) {
  return (
    <path
      aria-hidden
      d={`M${x - 4},${y - 3} l8,-4 M${x - 4},${y + 2} l8,-4`}
      stroke="var(--axis)"
      strokeWidth={1.5}
      fill="none"
    />
  );
}

/**
 * Настоящая ширина контейнера в пикселях.
 *
 * Общая для всех графиков, потому что ошибка была общая: рисовать в
 * выдуманной системе координат и растягивать картинку под контейнер. При
 * растяжении по одной оси вместе с линиями растягивается текст — подписи
 * выходят шире задуманного, шрифт «плывёт», и график выглядит кривым, потому
 * что кривым и является. Если рисовать в пикселях контейнера, растягивать
 * нечего.
 */
export function useChartWidth(fallback = 900): [number, React.RefObject<HTMLDivElement | null>] {
  const [w, setW] = useState(fallback);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [w, ref];
}

/** Подписи оси X без наложения: последняя, первая, потом остальные с конца */
function xLabels(xs: readonly number[], labels: readonly string[]): Set<number> {
  return placeLabels(xs, labels.map(textW), 12);
}

/**
 * Сетка и подписи оси Y — общие у линии и сложенной области. Единица
 * («с», «%») стоит у верхнего деления: ось без единицы — «8» чего? — не
 * читается, а единица у каждого деления — шум.
 */
function YGrid({ ticks, y, left, right, unit = "" }: { ticks: readonly number[]; y: (v: number) => number; left: number; right: number; unit?: string }) {
  const fmt = useFmt();
  const top = ticks.length ? Math.max(...ticks) : null;
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={left - 8} y={y(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
            {fmt(t)}
            {t === top && unit ? unit : ""}
          </text>
        </g>
      ))}
    </>
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
  /**
   * Несимметричная полоса разброса: нижний и верхний край.
   *
   * Отдельно от `err`, потому что бывает не только ошибка измерения.
   * Межквартильный размах времени ответа вокруг медианы несимметричен почти
   * всегда — сверху его тянет хвост задумавшихся, — и приводить его к
   * «медиана ± половина» значило бы нарисовать разброс, которого нет.
   */
  lo?: number | null;
  hi?: number | null;
}

/** Края полосы разброса точки: явные `lo`/`hi` либо симметричный SEM */
function bandOf(p: LinePoint): [number, number] {
  if (p.lo != null && p.hi != null) return [p.lo, p.hi];
  if (p.err != null) return [Math.max(0, p.y - p.err), p.y + p.err];
  return [p.y, p.y];
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
  fullRange,
  unit,
  marks,
}: {
  series: { label: string; points: LinePoint[]; color?: string }[];
  height?: number;
  area?: boolean;
  /**
   * Полный диапазон величины, если он известен: 27 у PHQ-9, 80 у PCL-5.
   *
   * Ось идёт по данным, а полный диапазон уходит в подпись. Он не лишний:
   * без него «14» на графике не отличить от «14 из 15» и «14 из 80».
   */
  fullRange?: number | null;
  /** Единица для подписи диапазона: « с», « %». Ось подписывается числами */
  unit?: string;
  marks?: TimeMark[];
}) {
  const { ut } = useLang();
  const fmt = useFmt();
  const svgRef = useRef<SVGSVGElement>(null);

  /*
   * Ширина берётся настоящая, а не выдуманная: единица viewBox равна
   * пикселю экрана, и растягивать нечего — ни линии, ни текст.
   */
  const [W, boxRef] = useChartWidth();

  const all = series.flatMap((s) => s.points);
  const n = Math.max(1, ...series.map((s) => s.points.length));
  const hover = useIndexHover(n);
  const bands = all.map(bandOf);

  /*
   * Ось строится по тому, что нарисовано, — вместе с полосами разброса:
   * полоса, вылезшая за край поля, читается как обрезанные данные.
   * `atom` — ширина самой полосы: сдвиг меньше неё не событие, а дрожание.
   */
  const lo = bands.length ? Math.min(...bands.map(([a]) => a)) : 0;
  const hi = bands.length ? Math.max(...bands.map(([, b]) => b)) : 0;
  const widths = bands.map(([a, b]) => b - a).sort((a, b) => a - b);
  const atom = widths[Math.floor(widths.length / 2)] ?? 0;
  const axis = axisFor({ lo, hi, atom });

  const multi = series.length > 1;
  /* подписи у концов линий: значение одного ряда, значение и имя — у двух–четырёх */
  const ends = series.length <= 4;
  const right = ends ? (multi ? 76 : unit ? 48 : 34) : PAD.right;
  const pw = W - PAD.left - right;
  const ph = height - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const span = Math.max(axis.max - axis.min, Number.EPSILON);
  const yAt = (v: number) => PAD.top + ph - ((v - axis.min) / span) * ph;

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
      hover.setAt(null);
      return;
    }
    hover.setAt(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };

  if (!all.length) return <NoData />;

  /*
   * По одной точке динамики не бывает: показываем число крупно и говорим
   * прямо, что сравнивать не с чем, — точка посреди пустой сетки выглядит
   * как поломка.
   */
  if (all.length === 1) {
    const only = all[0]!;
    return (
      <div className="flex items-baseline gap-[10px] py-[8px]">
        <span className="text-stat font-extrabold text-text">{fmt(only.y)}</span>
        <span className="text-caption text-muted">
          {only.x}, {ut("chart.singlePoint")}
        </span>
      </div>
    );
  }

  const at = hover.at ?? -1;
  const label = series[0]?.points[at]?.x;
  const colorOf = (s: { color?: string }, i: number) => s.color ?? seriesColor(i, series.length);
  const xsAll = Array.from({ length: n }, (_, i) => xAt(i));
  const labels = Array.from({ length: n }, (_, i) => series[0]?.points[i]?.x ?? "");
  const shownX = xLabels(xsAll, labels);

  /* подписи у концов: по высоте последней точки, раздвинутые на строку */
  const endRows = ends
    ? series
        .map((s, si) => {
          const p = s.points.at(-1);
          return p ? { si, y: yAt(p.y), x: xAt(s.points.length - 1), v: p.y, label: s.label } : null;
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.y - b.y)
    : [];
  for (let k = 1; k < endRows.length; k++) if (endRows[k]!.y - endRows[k - 1]!.y < 13) endRows[k]!.y = endRows[k - 1]!.y + 13;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        onMouseMove={onMove}
        {...hover.focusProps}
        role="img"
        className={cx("block overflow-visible", FOCUSABLE)}
        /*
         * Роль img обязывает дать имя: без него диктор объявляет «графика» и
         * замолкает. Имя собирается из рядов и границ периода.
         */
        aria-label={`${series.map((s) => s.label).join(", ")}: ${all[0]?.x ?? ""} — ${series[0]?.points.at(-1)?.x ?? ""}`}
      >
        <YGrid ticks={axis.ticks} y={yAt} left={PAD.left} right={W - right} unit={unit} />
        {axis.zoomed ? <AxisBreak x={PAD.left} y={PAD.top + ph} /> : null}

        {/* перекрестье под линиями: оно ориентир, а не содержание */}
        {at >= 0 ? <line x1={xAt(at)} x2={xAt(at)} y1={PAD.top} y2={PAD.top + ph} stroke="var(--vink)" strokeDasharray="2 2" /> : null}

        {series.map((s, si) => {
          const color = colorOf(s, si);
          const d = s.points.map((p, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(" ");

          /*
           * Полоса разброса — под линией и без обводки: фон, в котором лежит
           * измерение, а не второй ряд. Только если разброс известен у всех
           * точек ряда — полоса «местами» врала бы, где измерение точнее.
           */
          const edges = s.points.map(bandOf);
          const hasBand = s.points.length > 1 && edges.some(([a, b]) => b > a) && edges.every(([a, b]) => b >= a);
          const known = s.points.every((p) => (p.lo != null && p.hi != null) || p.err != null);
          const band =
            hasBand && known
              ? [
                  ...edges.map(([, b], i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(b).toFixed(1)}`),
                  ...edges
                    .map(([a], i) => ({ a, i }))
                    .reverse()
                    .map(({ a, i }) => `L${xAt(i).toFixed(1)},${yAt(a).toFixed(1)}`),
                  "Z",
                ].join(" ")
              : null;
          const shape = shapeOf(s.color, si);

          return (
            <g key={s.label}>
              {band ? <path d={band} fill={color} opacity={0.14} /> : null}
              {area ? (
                /* заливка до низа поля, а не до нуля: на срезанной оси ноль ниже рамки */
                <path
                  d={`${d} L${xAt(s.points.length - 1).toFixed(1)},${yAt(axis.min).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(axis.min).toFixed(1)} Z`}
                  fill={color}
                  opacity={0.1}
                />
              ) : null}
              <path d={d} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
              {/*
                Метки — только на коротких рядах: на трёхстах замерах они
                сливаются в полосу. Под курсором метка видна всегда.
              */}
              {s.points.length <= 60
                ? s.points.map((p, i) => <Marker key={i} shape={shape} x={xAt(i)} y={yAt(p.y)} color={p.tone ?? color} />)
                : null}
              {at >= 0 && s.points[at] ? (
                <Marker shape={shape} x={xAt(at)} y={yAt(s.points[at]!.y)} r={5.5} color={s.points[at]!.tone ?? color} />
              ) : null}
            </g>
          );
        })}

        {/*
          Отметки событий — пунктир с подписью у верхнего края: внизу она
          столкнулась бы с датами, а событие важнее даты.
        */}
        {marks?.map((m) => {
          const i = series[0]?.points.findIndex((p) => p.x === m.x) ?? -1;
          if (i < 0) return null;
          return (
            <g key={`${m.x}-${m.label}`} data-mark={m.label}>
              <line x1={xAt(i)} x2={xAt(i)} y1={PAD.top - 4} y2={PAD.top + ph} stroke="var(--muted)" strokeDasharray="3 3" />
              <text
                x={xAt(i) + 4}
                y={PAD.top + 8}
                fontSize={11}
                fontWeight={700}
                fill="var(--text-2)"
                stroke="var(--panel)"
                strokeWidth={4}
                strokeLinejoin="round"
                style={{ paintOrder: "stroke" }}
              >
                {m.label}
              </text>
            </g>
          );
        })}

        {endRows.map((r) => (
          <text key={`e-${r.si}`} x={r.x + 9} y={r.y + 4} fontSize={11} fontWeight={600} fill="var(--text-2)">
            <tspan fontWeight={800} fill="var(--text)">
              {fmt(r.v)}
              {unit ?? ""}
            </tspan>
            {multi ? ` ${r.label}` : ""}
          </text>
        ))}

        <line x1={PAD.left} x2={W - right} y1={yAt(axis.min)} y2={yAt(axis.min)} stroke="var(--ctl)" />
        {labels.map((l, i) =>
          shownX.has(i) ? (
            <text key={i} x={xAt(i)} y={height - 6} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
      </svg>

      {at >= 0 && label ? (
        <ChartTip x={xAt(at)} y={Math.min(...series.map((s) => (s.points[at] ? yAt(s.points[at]!.y) : height)))} width={W}>
          <TipHead>{label}</TipHead>
          {series.map((s, si) => {
            const point = s.points[at];
            if (!point) return null;
            /* разброс рядом со значением: типичное без разброса — половина ответа */
            const [a, b] = bandOf(point);
            return (
              <TipRow
                key={s.label}
                color={colorOf(s, si)}
                label={multi ? s.label : undefined}
                value={`${fmt(point.y)}${unit ?? ""}`}
                extra={b > a ? `${fmt(a)}–${fmt(b)}${unit ?? ""}` : undefined}
              />
            );
          })}
        </ChartTip>
      ) : null}

      <ChartLegend
        items={series.map((s, i) => ({ key: s.label, label: s.label, color: colorOf(s, i), kind: "line", shape: shapeOf(s.color, i) }))}
      />
      <AxisNote axis={axis} lo={lo} hi={hi} fullRange={fullRange} unit={unit} />
    </div>
  );
}
