import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SERIES } from "../format";
import { Panel } from "../ui/layout";
import { NoData, Num } from "../ui/primitives";
import { useLang } from "../lang";
import { axisFor, type Axis } from "./scale";

/**
 * Диаграммы консоли — plain SVG без библиотек.
 *
 * Правила одни на весь проект: одна величина рисуется одним цветом,
 * категориальные слоты берутся по фиксированному порядку, сетка приглушена,
 * подписи стоят рядом со значением, легенда обязательна при двух и более сериях.
 */

const PAD = { top: 14, right: 16, bottom: 26, left: 44 };

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 100) / 100));

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
    <p className="hint">
      {axis.zoomed ? <strong>{ut("chart.axisCut")} · </strong> : null}
      {ut("chart.actualRange")} {fmt(lo)}–{fmt(hi)}
      {unit}
      {hidesFull ? ` · ${ut("chart.fullScale")} 0–${fmt(fullRange)}${unit}` : ""}
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
   * Раньше это был `yMax` — и ось растягивалась до него. Именно из-за этого
   * все графики динамики выглядели одинаково: на демонстрационной базе
   * данные занимали пятую часть высоты, а четыре пятых были пустым полем над
   * прижатой к низу линией.
   *
   * Теперь ось идёт по данным, а полный диапазон уходит в подпись. Он не
   * лишний: без него «14» на графике не отличить от «14 из 15» и «14 из 80».
   */
  fullRange?: number | null;
  /** Единица для подписи диапазона: « с», « %». Ось подписывается числами */
  unit?: string;
  marks?: TimeMark[];
}) {
  const { ut } = useLang();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);


  /*
   * Ширина берётся настоящая, а не выдуманная.
   *
   * Раньше здесь стояло W = 900 и preserveAspectRatio="none": браузер
   * растягивал картинку под ширину контейнера — и вместе с линиями
   * растягивал текст. Подписи осей выходили на четверть шире, чем задумано,
   * шрифт «плыл», и график выглядел кривым, потому что кривым и был.
   *
   * Измеряем контейнер и рисуем в его собственных пикселях: тогда единица
   * viewBox равна пикселю экрана, и растягивать нечего.
   */
  const [W, boxRef] = useChartWidth();

  const all = series.flatMap((s) => s.points);
  const bands = all.map(bandOf);

  /*
   * Ось строится по тому, что нарисовано, — вместе с полосами разброса:
   * полоса, вылезшая за край поля, читается как обрезанные данные.
   *
   * `atom` — ширина самой полосы. Это и есть та разница, ниже которой
   * различать нечего: сдвиг медианы на четверть межквартильного размаха не
   * событие, а обычное дрожание выборки. Из-за него узкий ряд внутри широкой
   * полосы останется плоским, а не растянется во весь экран.
   */
  const lo = bands.length ? Math.min(...bands.map(([a]) => a)) : 0;
  const hi = bands.length ? Math.max(...bands.map(([, b]) => b)) : 0;
  const widths = bands.map(([a, b]) => b - a).sort((a, b) => a - b);
  const atom = widths[Math.floor(widths.length / 2)] ?? 0;
  const axis = axisFor({ lo, hi, atom });

  const pw = W - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;
  const n = Math.max(1, ...series.map((s) => s.points.length));
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
      setHover(null);
      return;
    }
    setHover(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };

  if (!all.length) return <NoData />;

  /*
   * По одной точке динамики не бывает.
   *
   * Раньше единственный замер рисовался точкой посреди пустой сетки в
   * тысячу пикселей шириной, и ось времени показывала одну и ту же дату с
   * обоих концов. Это выглядит как поломка и читается как «данных нет», хотя
   * данные есть — их просто нечем сравнивать.
   *
   * Показываем число и говорим прямо: сравнивать не с чем.
   */
  if (all.length === 1) {
    const only = all[0]!;
    return (
      <div className="flex items-baseline gap-3 px-1 py-3">
        <Num className="text-stat leading-none">{fmt(only.y)}</Num>
        <span className="text-caption text-muted">
          {only.x} · {ut("chart.singlePoint")}
        </span>
      </div>
    );
  }

  const at = hover ?? -1;
  const label = series[0]?.points[at]?.x;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
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
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={PAD.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}
        {axis.zoomed ? <AxisBreak x={PAD.left} y={PAD.top + ph} /> : null}

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
           * Полоса разброса рисуется под линией и без обводки: это фон, в
           * котором лежит измерение, а не второй ряд данных. Строится только
           * если разброс известен у всех точек ряда — полоса «местами» врала
           * бы про то, где измерение точнее.
           */
          const edges = s.points.map(bandOf);
          const hasBand = s.points.length > 1 && edges.some(([a, b]) => b > a) && edges.every(([a, b]) => b >= a);
          const known = s.points.every((p) => (p.lo != null && p.hi != null) || p.err != null);
          const band =
            hasBand && known
              ? [
                  ...edges.map(([, b], i) => `${i ? "L" : "M"}${xAt(i)},${yAt(b)}`),
                  ...edges
                    .map(([a], i) => ({ a, i }))
                    .reverse()
                    .map(({ a, i }) => `L${xAt(i)},${yAt(a)}`),
                  "Z",
                ].join(" ")
              : null;

          return (
            <g key={s.label}>
              {band ? <path d={band} fill={color} opacity={0.14} /> : null}
              {area ? (
                /* заливка идёт до низа поля, а не до нуля: на срезанной оси
                   ноль лежит ниже рамки, и фигура вывернулась бы наизнанку */
                <path
                  d={`${d} L${xAt(s.points.length - 1)},${yAt(axis.min)} L${xAt(0)},${yAt(axis.min)} Z`}
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

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={yAt(axis.min)}
          y2={yAt(axis.min)}
          stroke="var(--axis)"
        />
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
            /* в подсказке разброс стоит рядом со значением: типичное без
               разброса — половина ответа, а на графике их разделяет цвет */
            const [a, b] = bandOf(point);
            return (
              <span key={s.label} className="chart-tip-row">
                <i style={{ background: s.color ?? SERIES[si % SERIES.length] }} />
                {series.length > 1 ? <span className="grow">{s.label}</span> : null}
                <b>{fmt(point.y)}</b>
                {b > a ? (
                  <span className="text-muted">
                    {fmt(a)}–{fmt(b)}
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}

      <Legend items={series.map((s, i) => ({ label: s.label, color: s.color ?? SERIES[i % SERIES.length]! }))} />
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
 * всего», а «становится ли их больше». Одно и то же кольцо получается и
 * когда тяжёлые копились полгода ровно, и когда все пришли на прошлой
 * неделе.
 *
 * Ось здесь всегда от нуля, и это не оплошность на фоне остальных графиков,
 * а свойство самой формы: у сложенных слоёв читается высота слоя, а высота
 * измеряется от нуля. Срезать низ значило бы отрезать нижний слой и оставить
 * висеть остальные.
 *
 * Порядок слоёв задан снизу вверх и не сортируется по величине: слои —
 * степени выраженности, у них есть собственный порядок, и перестановка его
 * сломала бы главное свойство графика — узнаваемость с одного взгляда.
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
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [W, boxRef] = useChartWidth();

  const n = x.length;
  const totals = x.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const axis = axisFor({ lo: 0, hi: Math.max(...totals, 0) });

  const pw = W - PAD.left - PAD.right;
  const ph = height - PAD.top - PAD.bottom;
  const xAt = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
  const yAt = (v: number) => PAD.top + ph - ((v - axis.min) / Math.max(axis.max - axis.min, 1)) * ph;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const share = (((e.clientX - box.left) / box.width) * W - PAD.left) / pw;
    if (share < -0.02 || share > 1.02) {
      setHover(null);
      return;
    }
    setHover(Math.min(n - 1, Math.max(0, Math.round(share * (n - 1)))));
  };

  if (!n || !series.length) return <NoData />;

  /*
   * Слои считаются один раз снизу вверх: верх предыдущего — низ следующего.
   * Считать каждый слой отдельной суммой значило бы получить между ними щель
   * в полпикселя от округления — и график распался бы на полоски.
   */
  const floors: number[][] = [];
  const running = x.map(() => 0);
  for (const s of series) {
    floors.push([...running]);
    for (let i = 0; i < n; i++) running[i] = running[i]! + (s.values[i] ?? 0);
  }

  const at = hover ?? -1;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${series.map((s) => s.label).join(", ")}: ${x[0] ?? ""} — ${x.at(-1) ?? ""}`}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={PAD.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end">
              {fmt(t)}
            </text>
          </g>
        ))}

        {series.map((s, si) => {
          const base = floors[si]!;
          const upper = base.map((b, i) => b + (s.values[i] ?? 0));
          const d = [
            ...upper.map((v, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(v)}`),
            ...base.map((v, i) => ({ v, i })).reverse().map(({ v, i }) => `L${xAt(i)},${yAt(v)}`),
            "Z",
          ].join(" ");
          return (
            <path
              key={s.label}
              d={d}
              fill={s.color}
              /* заливка приглушена, кромка нет: без кромки соседние слои
                 сливаются там, где один из них тонкий */
              fillOpacity={0.55}
              stroke={s.color}
              strokeWidth={1}
            />
          );
        })}

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

        <line x1={PAD.left} x2={W - PAD.right} y1={yAt(0)} y2={yAt(0)} stroke="var(--axis)" />
        <text x={PAD.left} y={height - 6} fontSize="11" fill="var(--axis)">
          {x[0]}
        </text>
        <text x={W - PAD.right} y={height - 6} fontSize="11" fill="var(--axis)" textAnchor="end">
          {x.at(-1)}
        </text>
      </svg>

      {at >= 0 ? (
        <div className="chart-tip" style={{ left: `${((xAt(at) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{x[at]}</span>
          {/* сверху вниз, как на графике: снизу лежит первый слой, и в
              подсказке он должен оказаться последним, иначе список читается
              задом наперёд относительно картинки */}
          {[...series].reverse().map((s) => (
            <span key={s.label} className="chart-tip-row">
              <i style={{ background: s.color }} />
              <span className="grow">{s.label}</span>
              <b>{s.values[at] ?? 0}</b>
            </span>
          ))}
          {total ? (
            <span className="chart-tip-row">
              <span className="grow">{total}</span>
              <b>{totals[at]}</b>
            </span>
          ) : null}
        </div>
      ) : null}

      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
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
  if (!items.length) return <NoData />;
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
  if (!total) return <NoData />;
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
