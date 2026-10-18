import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Panel } from "../ui/layout";
import { NoData } from "../ui/primitives";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { placeLabels } from "./courseModel";
import {
  ChartLegend,
  ChartTip,
  FOCUSABLE,
  Marker,
  RowTip,
  SINGLE_COLOR,
  TipHead,
  TipRow,
  seriesColor,
  shapeOf,
  useIndexHover,
  type LegendKind,
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

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100));

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
 * Легенда рядов: образец и подпись строкой под графиком (.lgd набора). Для
 * одного ряда её нет — его называет заголовок.
 */
export function Legend({ items, kind = "band" }: { items: { label: string; color: string }[]; kind?: LegendKind }) {
  return <ChartLegend items={items.map((i, k) => ({ key: `${k}-${i.label}`, label: i.label, color: i.color, kind, shape: shapeOf(i.color, k) }))} />;
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

/** Сетка и подписи оси Y — общие у линии и сложенной области */
function YGrid({ ticks, y, left, right }: { ticks: readonly number[]; y: (v: number) => number; left: number; right: number }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={left - 8} y={y(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
            {fmt(t)}
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
  const right = ends ? (multi ? 76 : 34) : PAD.right;
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
        <YGrid ticks={axis.ticks} y={yAt} left={PAD.left} right={W - right} />
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
                value={fmt(point.y)}
                extra={b > a ? `${fmt(a)}–${fmt(b)}` : undefined}
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

/* ─────────── область с накоплением ─────────── */

export interface StackSeries {
  label: string;
  color: string;
  /** По значению на каждую точку оси времени; длина равна длине `x` */
  values: number[];
}

/**
 * Слои, сложенные друг на друга по оси времени.
 *
 * Отвечает на вопрос, на который не отвечает кольцо: не «сколько тяжёлых
 * всего», а «становится ли их больше». Ось всегда от нуля: у сложенных
 * слоёв читается высота слоя, а высота измеряется от нуля. Порядок слоёв —
 * снизу вверх и не сортируется по величине: слои — ступени выраженности, у
 * них собственный порядок.
 *
 * Между слоями — просвет цвета поверхности 2 px, а не обводка: соседние
 * слои различаются промежутком.
 */
export function StackedArea({
  x,
  series,
  height = 240,
  total,
}: {
  x: string[];
  series: StackSeries[];
  height?: number;
  /** Подпись итога в подсказке: «всего», «обследований» */
  total?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, boxRef] = useChartWidth();
  const n = x.length;
  const hover = useIndexHover(n);

  const totals = x.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const axis = axisFor({ lo: 0, hi: Math.max(...totals, 0) });

  const pw = W - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yAt = (v: number) => PAD.top + ph - ((v - axis.min) / Math.max(axis.max - axis.min, Number.EPSILON)) * ph;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const share = (((e.clientX - box.left) / box.width) * W - PAD.left) / pw;
    if (share < -0.02 || share > 1.02) {
      hover.setAt(null);
      return;
    }
    hover.setAt(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };

  if (!n || !series.length) return <NoData />;

  /* слои снизу вверх: верх предыдущего — низ следующего, без щелей от округления */
  const floors: number[][] = [];
  const running = x.map(() => 0);
  for (const s of series) {
    floors.push([...running]);
    for (let i = 0; i < n; i++) running[i] = running[i]! + (s.values[i] ?? 0);
  }

  const at = hover.at ?? -1;
  const shownX = xLabels(
    x.map((_, i) => xAt(i)),
    x,
  );

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
        aria-label={`${series.map((s) => s.label).join(", ")}: ${x[0] ?? ""} — ${x.at(-1) ?? ""}`}
      >
        <YGrid ticks={axis.ticks} y={yAt} left={PAD.left} right={W - PAD.right} />

        {series.map((s, si) => {
          const base = floors[si]!;
          const upper = base.map((b, i) => b + (s.values[i] ?? 0));
          const top = upper.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
          const d = [top, ...base.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => `L${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`), "Z"].join(" ");
          return (
            <g key={s.label}>
              <path d={d} fill={s.color} fillOpacity={0.85} />
              {/* просвет поверхности по верхней кромке слоя */}
              <path d={top} fill="none" stroke="var(--panel)" strokeWidth={2} />
            </g>
          );
        })}

        {at >= 0 ? <line x1={xAt(at)} x2={xAt(at)} y1={PAD.top} y2={PAD.top + ph} stroke="var(--vink)" strokeDasharray="2 2" /> : null}

        <line x1={PAD.left} x2={W - PAD.right} y1={yAt(0)} y2={yAt(0)} stroke="var(--ctl)" />
        {x.map((l, i) =>
          shownX.has(i) ? (
            <text key={i} x={xAt(i)} y={height - 6} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
      </svg>

      {at >= 0 ? (
        <ChartTip x={xAt(at)} y={yAt(totals[at] ?? 0)} width={W}>
          <TipHead>{x[at]}</TipHead>
          {/* сверху вниз, как на графике: нижний слой в подсказке последний */}
          {[...series].reverse().map((s) => (
            <TipRow key={s.label} kind="box" color={s.color} label={s.label} value={s.values[at] ?? 0} />
          ))}
          {total ? <TipRow label={total} value={totals[at]} /> : null}
        </ChartTip>
      ) : null}

      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
    </div>
  );
}

/* ─────────── горизонтальные столбики ─────────── */

/**
 * Полосы строками (.hbars набора): подпись слева, полоса 14 px со
 * скруглённым концом, число справа. Подсказка строки — по наведению и
 * фокусу.
 */
export function BarList({
  items,
  unit = "",
  max,
}: {
  items: { label: string; value: number; color?: string; caption?: string }[];
  unit?: string;
  max?: number;
}) {
  if (!items.length) return <NoData />;
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="m-0 grid list-none gap-[6px] p-0">
      {items.map((i, k) => {
        const share = Math.max(0.015, Math.min(1, i.value / top));
        return (
          <li
            key={k}
            tabIndex={0}
            className="group/row relative grid min-h-[28px] grid-cols-[minmax(0,40%)_minmax(0,1fr)_auto] items-center gap-[12px] rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
          >
            <span className="truncate text-[13px] font-semibold text-text-2">{i.label}</span>
            <span className="relative h-[14px]">
              <span className="block h-full rounded-r-[4px]" style={{ width: `${(share * 100).toFixed(2)}%`, background: i.color ?? SINGLE_COLOR }} />
            </span>
            <span className="text-right text-[13px] font-extrabold whitespace-nowrap text-text">
              {i.value}
              {unit ? <small className="ml-[2px] text-[11.5px] font-semibold text-muted">{unit}</small> : null}
              {i.caption ? <small className="ml-[8px] text-[11.5px] font-semibold text-muted">{i.caption}</small> : null}
            </span>
            <RowTip at={share * 0.6 + 0.4}>
              <TipHead>{i.label}</TipHead>
              <TipRow value={`${i.value}${unit}`} extra={i.caption} />
            </RowTip>
          </li>
        );
      })}
    </ul>
  );
}

/* ─────────── кольцо ─────────── */

/**
 * Кольцо долей. Набор кольцо не рисует — для долей есть ShareBar, — но
 * прежние экраны его зовут, и оно говорит тем же языком: доли разделены
 * просветом поверхности, у каждой подсказка, рядом — числа строками.
 */
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
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return <NoData />;
  const r = size / 2 - 10;
  const inner = r * 0.64;
  const c = size / 2;
  let a = -Math.PI / 2;
  const pct = (v: number) => Math.round((v / total) * 100);
  const at = hover === null ? null : slices[hover]!;

  return (
    <div className="flex flex-wrap items-center gap-[22px]">
      <div className="relative">
        <svg width={size} height={size} role="img" aria-label={slices.map((s) => `${s.label}: ${s.value}`).join(", ")} onMouseLeave={() => setHover(null)}>
          {slices.map((s, i) => {
            const sweep = (s.value / total) * Math.PI * 2;
            const a0 = a;
            const a1 = a + sweep;
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
                stroke="var(--panel)"
                strokeWidth={2}
                strokeLinejoin="round"
                opacity={hover === null || hover === i ? 1 : 0.55}
                onMouseEnter={() => setHover(i)}
              />
            );
          })}
          {center ? (
            <>
              <text x={c} y={c + 4} fontSize={22} fontWeight={800} fill="var(--text)" textAnchor="middle">
                {center}
              </text>
              {centerLabel ? (
                <text x={c} y={c + 21} fontSize={11} fontWeight={600} fill="var(--muted)" textAnchor="middle">
                  {centerLabel}
                </text>
              ) : null}
            </>
          ) : null}
        </svg>
        {at ? (
          <ChartTip x={c} y={c - 20} width={size}>
            <TipHead>{at.label}</TipHead>
            <TipRow kind="box" color={at.color} value={at.value} extra={`${pct(at.value)} %`} />
          </ChartTip>
        ) : null}
      </div>
      <ul className="m-0 grid min-w-[200px] flex-1 list-none gap-[6px] p-0">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-[8px] text-[13px]">
            <span aria-hidden className="inline-block h-[10px] w-[14px] shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="flex-1 font-semibold text-text-2">{s.label}</span>
            <span className="font-extrabold text-text">{s.value}</span>
            <span className="w-[44px] text-right text-caption text-muted">{pct(s.value)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
