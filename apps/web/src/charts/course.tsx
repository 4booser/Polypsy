import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import type { Incomparable, ResponseSource, ScaleNormalization, UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { NoData } from "../ui/primitives";
import {
  bandSpans,
  courseLayout,
  cutoffOf,
  dodge,
  freeSpot,
  placeLabels,
  pointTip,
  valueOrder,
  type Better,
  type Box,
  type ChangeVerdict,
  type CourseEvent,
  type CoursePoint,
  type Cutoff,
  type PointTip,
} from "./courseModel";
import { BandKey, BandLabels, bandBlocks, fitHeight, placeBlocks, planBandColumn } from "./bands";
import { AxisBreak, useChartWidth } from "./index";
import { bandRange, boundaries, sortRungs, type Rung } from "./ladder";
import {
  ChartLegend,
  ChartTip,
  EventGlyph,
  FOCUSABLE,
  SINGLE_COLOR,
  SevChip,
  TipHead,
  TipText,
  fillIn,
  textWidth,
  useDecimal,
  useFontsReady,
  type LegendItem,
} from "./kit";

/**
 * График курса — график карточки пациента: врач между двумя приёмами
 * должен понять его за десять секунд на 13-дюймовом экране.
 *
 *   — шапка словами: что меряли и чем («Депресія · PHQ-9»), сколько сейчас
 *     («19 з 27»), в какой полосе и что со сдвигом от старта («значуще
 *     погіршення: +8 з 13 трав.»); похибка вимірювання говорится здесь
 *     словом, а не рисуется полосой поперёк поля;
 *   — полосы тяжести тихой заливкой, текущая темнее, подписи — целиком, с
 *     границами, в колонке справа (переносятся, а не режутся многоточием);
 *   — один клинический порог пунктиром с подписью (cutoffOf);
 *   — «менше — краще / більше — краще» словами у оси;
 *   — число у замеров, где оно ни на что не налезает (последний, первый,
 *     крайние и переломы — первыми);
 *   — сигнал риска — красным кольцом на том замере, который его поднял;
 *   — дорожка событий под датами: приёмы, неявки, запланированные,
 *     заключения — значками без номеров, с легендой и подсказкой;
 *   — подсказка замера мышью и с клавиатуры: дата, балл, полоса, сдвиги,
 *     кто заполнял, ссылка на протокол (Enter или нажатие на точку).
 *
 * Прогноза нет сознательно: приложение тренд не считает (см. courseModel.ts).
 * «Сьогодні» на оси тоже нет: линия совпадала с последним замером.
 *
 * Данные — из приложения: courseFromDynamics + courseEventsFromTimeline.
 */

export interface CourseChartProps {
  /** Название шкалы: подпись для диктора и шапка, если measure не задан */
  title: string;
  /** Что меряет: «Депресія» — первая часть шапки */
  measure?: string | null;
  /** Чем: код методики «PHQ-9» — вторая часть шапки */
  method?: string | null;
  points: readonly CoursePoint[];
  rungs: readonly Rung[];
  /** Верх шкалы сырого балла: «19 з 27» в шапке и край оси, если он выше лестницы */
  max?: number | null;
  /** Порог значущої зміни в баллах (MDC95); null — не оценён */
  rc: number | null;
  better: Better | null;
  events?: readonly CourseEvent[];
  /** «Сейчас», мс: прошедший приём без отметки отличается от запланированного. По умолчанию — текущий момент */
  now?: number | null;
  normalization?: ScaleNormalization | null;
  /** Легенда под графиком; false — одну на несколько графиков рисует экран (CourseLegend) */
  legend?: boolean;
  /** Шапка над полем; false — экран называет график сам */
  header?: boolean;
  /** compact — малый формат для сетки на узкой колонке: поле ниже, шапка мельче */
  size?: "full" | "compact";
  /** Код шкалы: сигнал по полосе другой шкалы того же прохождения сюда не встаёт (courseFromDynamics даёт его сам) */
  scaleCode?: string | null;
}

const R = 4;
/** Высота строки подписи оси над полем */
const T = 24;
/** Отступ данных от краёв поля: первый и последний замер не лежат на рамке */
const INSET = 16;

/** Почему замер со стартом не сравнивается — те же слова, что у динамики и сводки */
const INCOMPARABLE: Record<Incomparable, UiKey> = {
  version: "rch.versions",
  units: "rch.units",
  unreliable: "rch.unreliable",
};

const VERDICT: Record<Exclude<ChangeVerdict, "unknown">, UiKey> = {
  better: "course.v.better",
  worse: "course.v.worse",
  changed: "course.v.changed",
  within: "kit.withinError",
};

/** Канал, которым пришло прохождение, заполненное самим человеком */
const CHANNEL: Partial<Record<ResponseSource, UiKey>> = {
  assigned: "rp.src.assigned",
  self: "rp.src.self",
  kiosk: "rp.src.kiosk",
  intake: "rp.src.intake",
};

/** Кто заполнял — фразой без рода: «Заповнено пацієнтом (за призначенням)» */
export function sourceText(source: ResponseSource | null | undefined, ut: (k: UiKey) => string): string | null {
  if (!source) return null;
  if (source === "clinician") return ut("course.byClinician");
  if (source === "informant") return ut("course.byInformant");
  const channel = CHANNEL[source];
  return channel ? `${ut("course.byPatient")} (${ut(channel)})` : ut("course.byPatient");
}

/**
 * Числа курса в единицах экрана: доля — процентами («49 %», сдвиг — «+8
 * в. п.»), остальное — дробью языка. Геометрия остаётся в единицах шкалы.
 */
export function useCourseFormat(normalization: ScaleNormalization | null | undefined) {
  const { ut } = useLang();
  const dec = useDecimal();
  const ratio = normalization === "ratio";
  /* минус — знаком минуса, а не дефисом: «−14–44,9» с дефисом читалось как диапазон из трёх чисел */
  const num = (v: number) => (ratio ? dec(Math.round(v * 100)) : dec(v)).replace(/^-/, "−");
  return {
    ratio,
    /** Число без единицы: у оси, у замера */
    num,
    /** Значение словами экрана: «19», «49 %» */
    value: (v: number) => (ratio ? `${num(v)} %` : num(v)),
    /** Сдвиг со знаком минус, а не дефисом: «+8», «−3», «+8 в. п.» */
    delta: (d: number) => {
      const v = ratio ? Math.round(d * 100) : Math.round(d * 100) / 100;
      const sign = v > 0 ? "+" : v < 0 ? "−" : "";
      return `${sign}${dec(Math.abs(v))}${ratio && v ? ` ${ut("course.pp")}` : ""}`;
    },
    /** Порог значущої зміни: «6,1», «8 в. п.» */
    amount: (d: number) => (ratio ? `${dec(Math.round(d * 100))} ${ut("course.pp")}` : dec(d, 1)),
    /** Границы полосы: «15–19», «24–38 %», у полосы из одного значения — «2» (bandRange); неразрывно */
    range: (r: { min: number; max: number }) => (ratio ? `${bandRange(r, num)} %` : bandRange(r, num)),
  };
}

type CourseFormat = ReturnType<typeof useCourseFormat>;

/** Подпись клинического порога: «клінічний поріг ≥ 10» */
function cutoffText(c: Cutoff, fmt: CourseFormat, ut: (k: UiKey) => string): string {
  return fillIn(ut(c.side === "above" ? "course.cutoffAbove" : "course.cutoffBelow"), { v: fmt.value(c.value) });
}

/** Подпись сдвига от старта для шапки: «значуще погіршення: +8 з 13 трав.» */
function changeText(tip: PointTip, count: number, fmt: CourseFormat, ut: (k: UiKey) => string): { text: string; verdict: ChangeVerdict | null } {
  if (count < 2) return { text: ut("course.first"), verdict: null };
  if (tip.incomparable) return { text: ut(INCOMPARABLE[tip.incomparable]), verdict: null };
  const fs = tip.fromStart;
  if (!fs) return { text: "", verdict: null };
  if (fs.verdict === "unknown") return { text: fillIn(ut("course.changeUnknown"), { delta: fmt.delta(fs.delta), date: fs.since }), verdict: "unknown" };
  return {
    text: fillIn(ut("course.change"), { verdict: ut(VERDICT[fs.verdict]), delta: fmt.delta(fs.delta), date: fs.since }),
    verdict: fs.verdict,
  };
}

/** Цвет слова сдвига: ухудшение требует внимания (янтарь), улучшение — зелёным, прочее — тихо */
const verdictClass = (v: ChangeVerdict | null) =>
  v === "worse" ? "font-bold text-warn" : v === "better" ? "font-bold text-good" : "font-semibold text-text-2";

export function CourseChart({
  title,
  measure,
  method,
  points: raw,
  rungs,
  max,
  rc,
  better,
  events = [],
  now = Date.now(),
  normalization,
  legend = true,
  header = true,
  size = "full",
  scaleCode,
}: CourseChartProps) {
  const { ut } = useLang();
  const fmt = useCourseFormat(normalization);
  const [W0, boxRef] = useChartWidth(560);
  useFontsReady();
  const svgRef = useRef<SVGSVGElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId().replace(/:/g, "");
  const hintId = `ch-${uid}`;
  const points = [...raw].sort((a, b) => a.t - b.t);
  const [pt, setPt] = useState<number | null>(null);
  const [ev, setEv] = useState<number | null>(null);

  if (!points.length) return <NoData />;

  const compact = size === "compact";
  const W = Math.max(320, W0);
  /* уже 320 px картинка ужимается целиком — подсказка идёт за ней */
  const k = W0 / W;
  const ladder = sortRungs(rungs);
  const lay = courseLayout(points, ladder, events, max, scaleCode);
  const spans = bandSpans(ladder, lay.lo, lay.hi);
  const cutoff = cutoffOf(ladder);
  const lastI = points.length - 1;
  const head = pointTip(points, lastI, ladder, rc, better, lay.signals.get(lastI));
  const current = head?.band ? (spans.find((s) => points[lastI]!.value >= s.from && points[lastI]!.value <= s.to)?.rung ?? null) : null;
  const f1 = (v: number) => v.toFixed(1);

  /* ── ось значений: подписи делений определяют левое поле ── */
  const tickText = lay.ticks.map((v) => fmt.num(v));
  const L = Math.max(26, ...tickText.map((s) => textWidth(s, 11, 600) + 10));

  /* ── колонка подписей полос справа (bands.tsx) ── */
  const cutText = cutoff ? cutoffText(cutoff, fmt, ut) : null;
  const col = planBandColumn({ ladder, W, L, R, compact, bandText: (r) => `${fmt.range(r)} ${r.label}`, extra: cutText ? [cutText] : [] });
  const { withCol, colW, colX, plotR } = col;
  const x0 = L + INSET;
  const x1 = plotR - INSET;
  const X = (t: number) => x0 + ((t - lay.t0) / Math.max(1, lay.t1 - lay.t0)) * (x1 - x0);

  /*
   * Высота поля. Один замер — поле ниже: ему нечего показывать, кроме
   * полосы, в которую он лёг. Подписи полос встают каждая в свою полосу, и
   * у узкого графика с длинными подписями («5–9 Лёгкая („субклиническая“)
   * депрессия» в три строки) поле растёт — но не выше 264 px. Малый формат
   * не растёт: там лишние подписи уходят (placeBlocks).
   */
  const base = compact || raw.length === 1 ? 116 : 188;
  const PH = compact ? base : fitHeight({ spans, col, lo: lay.lo, hi: lay.hi, cutoff, base, cap: base === 116 ? 168 : 264 });
  const PB = T + PH;
  const Y = (v: number) => T + PH * (1 - (v - lay.lo) / (lay.hi - lay.lo));

  const fillOf = (rung: Rung | null, i: number) => (rung && rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)");

  const { shown, tops } = placeBlocks(
    bandBlocks({ spans, col, Y, current, rangeOf: fmt.range, cutoff, cutText, lo: lay.lo, hi: lay.hi }),
    T + 1,
    PB + 14,
  );

  /* ── замеры ── */
  const xs = points.map((p) => X(p.t));
  const ys = points.map((p) => Y(p.value));
  const valueSize = compact ? 12 : 13;
  const obstacles: Box[] = [
    ...xs.map((x, i) => {
      const r = lay.signals.has(i) ? 11 : 7;
      return { x0: x - r, y0: ys[i]! - r, x1: x + r, y1: ys[i]! + r };
    }),
    ...xs.slice(1).flatMap((x, i) => {
      const xa = xs[i]!;
      const ya = ys[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x - xa, ys[i + 1]! - ya) / 4));
      return Array.from({ length: n }, (_, j) => {
        const px = xa + ((x - xa) * j) / n;
        const py = ya + ((ys[i + 1]! - ya) * j) / n;
        return { x0: px - 2.5, y0: py - 2.5, x1: px + 2.5, y1: py + 2.5 };
      });
    }),
  ];
  const field: Box = { x0: L + 2, y0: T + 2, x1: plotR - 2, y1: PB - 2 };
  /*
   * Числа у замеров: на коротком курсе — у всех, где помещаются; на длинном
   * (больше восьми) — не больше шести: последний, первый, крайние и самые
   * заметные переломы. Число на каждой из двадцати точек — шум, а не
   * подпись; остальное — в подсказке. Место — над точкой, под ней, сбоку.
   */
  const values = new Map<number, { x: number; y: number }>();
  const cap = points.length > 8 ? 6 : points.length;
  for (const i of valueOrder(points.map((p) => p.value))) {
    if (values.size >= cap) break;
    const text = fmt.num(points[i]!.value);
    const w = textWidth(text, valueSize, 800) + 4;
    const off = lay.signals.has(i) ? 13 : 9;
    const side = lay.signals.has(i) ? 14 : 10;
    const x = xs[i]!;
    const y = ys[i]!;
    const spot = freeSpot(
      [
        { x0: x - w / 2, y0: y - off - valueSize, x1: x + w / 2, y1: y - off, cx: x, ty: y - off - 1 },
        { x0: x - w / 2, y0: y + off, x1: x + w / 2, y1: y + off + valueSize, cx: x, ty: y + off + valueSize - 1 },
        { x0: x + side, y0: y - valueSize / 2 - 1, x1: x + side + w, y1: y + valueSize / 2 + 1, cx: x + side + w / 2, ty: y + valueSize / 2 - 2 },
        { x0: x - side - w, y0: y - valueSize / 2 - 1, x1: x - side, y1: y + valueSize / 2 + 1, cx: x - side - w / 2, ty: y + valueSize / 2 - 2 },
      ],
      obstacles,
      field,
    );
    if (!spot) continue;
    obstacles.push(spot);
    values.set(i, { x: spot.cx, y: spot.ty });
  }

  /* подписи дат: последняя, первая, потом остальные — без наложения */
  const dateShown = placeLabels(xs, points.map((p) => textWidth(p.label, 11, 700) + 4));

  /* ── дорожка событий ── */
  const lane = lay.lane;
  const laneY = PB + 38;
  const laneXs = dodge(
    lane.map((e) => X(e.t)),
    11,
    L + 6,
    plotR - 6,
  );
  const H = PB + 26 + (lane.length ? 24 : 0);

  /* ── подписи у оси ── */
  const unitWord = !normalization || normalization === "raw" ? ut("course.points") : ut(`norm.${normalization}` as UiKey);
  const betterWord = better ? ut(better === "down" ? "course.betterDown" : "course.betterUp") : "";

  /* ── наведение: точка — мышью и стрелками, событие дорожки — мышью ── */
  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hideSoon = () => {
    cancelHide();
    /* указатель идёт от точки к ссылке в подсказке — подсказка ждёт его, а не гаснет на полпути */
    hideTimer.current = setTimeout(() => {
      setPt(null);
      setEv(null);
    }, 240);
  };
  const svgPoint = (e: MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: ((e.clientX - box.left) / box.width) * W, y: ((e.clientY - box.top) / box.height) * H };
  };
  const nearestPoint = (x: number) => {
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
    return best;
  };
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    cancelHide();
    const p = svgPoint(e);
    if (!p) return;
    if (lane.length && p.y > PB + 26) {
      let best = -1;
      for (let j = 0; j < laneXs.length; j++) if (Math.abs(laneXs[j]! - p.x) <= 12 && (best < 0 || Math.abs(laneXs[j]! - p.x) < Math.abs(laneXs[best]! - p.x))) best = j;
      setEv(best < 0 ? null : best);
      setPt(null);
      return;
    }
    if (p.x > plotR + 4) {
      setPt(null);
      return;
    }
    setEv(null);
    setPt(nearestPoint(p.x));
  };
  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const p = svgPoint(e);
    if (!p || p.y > PB + 26) return;
    const i = nearestPoint(p.x);
    /* протокол открывает нажатие на сам замер, а не на пустое поле рядом; подсказка — сначала его */
    if (Math.hypot(xs[i]! - p.x, ys[i]! - p.y) > 18 || !points[i]!.href) return;
    if (pt === i) linkRef.current?.click();
    else setPt(i);
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = (d: number) => {
      e.preventDefault();
      setEv(null);
      setPt((p) => (p === null ? (d > 0 ? 0 : lastI) : Math.min(lastI, Math.max(0, p + d))));
    };
    if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") {
      e.preventDefault();
      setPt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setPt(lastI);
    } else if (e.key === "Escape") {
      setPt(null);
      setEv(null);
    } else if (e.key === "Enter" && pt !== null && points[pt]!.href) {
      e.preventDefault();
      linkRef.current?.click();
    }
  };
  /* фокус ушёл и не в подсказку (ссылка протокола) — подсказка гаснет */
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setPt(null);
    setEv(null);
  };

  const tip = pt === null ? null : pointTip(points, pt, ladder, rc, better, lay.signals.get(pt));
  const event = ev === null ? null : (lane[ev] ?? null);
  const href = pt === null ? null : (points[pt]!.href ?? null);
  const change = head ? changeText(head, points.length, fmt, ut) : { text: "", verdict: null };
  const lastPoint = points[lastI]!;
  /* «19 з 27» у сырого балла, «64 T-бал» у нормированного; доля — уже с «%» */
  const suffix = fmt.ratio
    ? null
    : !normalization || normalization === "raw"
      ? max != null
        ? `${ut("an.of")} ${fmt.num(max)}`
        : null
      : ut(`norm.${normalization}` as UiKey);

  return (
    <div className="relative min-w-0" ref={boxRef} onBlur={onBlur}>
      {header ? (
        <div className={cx("min-w-0", compact ? "mb-[6px]" : "mb-[10px]")} data-course-head>
          <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-[6px] text-body leading-[18px] font-extrabold text-text">
            <span>{measure || title}</span>
            {method ? <span className="font-bold text-muted">· {method}</span> : null}
          </p>
          <p className="m-0 mt-[6px] flex flex-wrap items-center gap-x-[10px] gap-y-[4px]">
            <span className="whitespace-nowrap">
              <b data-course-value className={cx("leading-none font-extrabold text-text", compact ? "text-[20px]" : "text-[24px]")}>
                {fmt.value(lastPoint.value)}
              </b>
              {suffix ? <span className="ml-[5px] text-small font-bold text-muted">{suffix}</span> : null}
            </span>
            {head?.band ? <SevChip severity={head.band.severity} label={head.band.label} small={compact} /> : null}
            {change.text ? (
              <span data-change={change.verdict ?? "none"} className={cx("text-small leading-[18px]", verdictClass(change.verdict))}>
                {change.text}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H * k}
        role="img"
        aria-label={`${title}: ${points.map((p) => `${fmt.value(p.value)} (${p.label})`).join(", ")}`}
        aria-describedby={hintId}
        tabIndex={0}
        className={cx("block overflow-visible", FOCUSABLE, href && pt !== null ? "cursor-pointer" : "")}
        onMouseMove={onMove}
        onMouseLeave={hideSoon}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onFocus={() => setPt((p) => p ?? lastI)}
      >
        <defs>
          <clipPath id={`cp-${uid}`}>
            <rect x={L} y={T} width={W - R - L} height={PH} rx={12} />
          </clipPath>
        </defs>

        {/* поле: полосы тяжести — тихой заливкой, текущая темнее; без лестницы — сетка делений */}
        <g clipPath={`url(#cp-${uid})`}>
          {spans.length ? (
            spans.map((s, i) => (
              <rect
                key={`${s.rung.min}-${s.rung.max}`}
                data-band={s.rung.label}
                data-current={s.rung === current ? "" : undefined}
                x={L}
                y={f1(Y(s.to))}
                width={W - R - L}
                height={f1(Y(s.from) - Y(s.to))}
                fill={fillOf(s.rung, i)}
              />
            ))
          ) : (
            <>
              <rect x={L} y={T} width={W - R - L} height={PH} fill="var(--plot)" />
              {lay.ticks.map((v) => (
                <line key={v} x1={L} x2={W - R} y1={f1(Y(v))} y2={f1(Y(v))} stroke="var(--grid)" />
              ))}
            </>
          )}
          {boundaries(ladder)
            .filter((c) => c > lay.lo && c < lay.hi)
            .map((c) => (
              <line key={c} x1={L} x2={W - R} y1={f1(Y(c))} y2={f1(Y(c))} stroke="var(--plotline)" strokeWidth={2} />
            ))}
        </g>

        {/* клинический порог: пунктир через поле до своей подписи в колонке */}
        {cutoff && cutoff.at > lay.lo && cutoff.at < lay.hi ? (
          <line
            data-cutoff={cutoff.value}
            x1={L}
            x2={withCol ? colX - 16 : W - R}
            y1={f1(Y(cutoff.at))}
            y2={f1(Y(cutoff.at))}
            stroke="var(--text-2)"
            strokeWidth={1.6}
            strokeDasharray="6 4"
          />
        ) : null}

        {/* подписи полос и порога — целиком, переносом (bands.tsx) */}
        <BandLabels shown={shown} tops={tops} colX={colX} colW={colW} />

        {/* ось значений и её подпись: единицы и куда — лучше, словами */}
        {lay.ticks.map((v, i) => (
          <text key={v} x={L - 6} y={f1(Y(v) + 4)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--axis)">
            {tickText[i]}
          </text>
        ))}
        {lay.cut.hi ? <AxisBreak x={L} y={T + 6} /> : null}
        {lay.cut.lo ? <AxisBreak x={L} y={PB - 4} /> : null}
        <text data-label="axis" x={0} y={T - 9} fontSize={12} fontWeight={600} fill="var(--text-2)">
          {unitWord}
          {betterWord ? (
            <>
              {", "}
              <tspan fontWeight={800} fill="var(--text)">
                {betterWord}
              </tspan>
            </>
          ) : null}
        </text>

        {pt !== null ? <line x1={f1(xs[pt]!)} x2={f1(xs[pt]!)} y1={T} y2={PB} stroke="var(--vink)" strokeDasharray="2 2" /> : null}

        {/* курс: линия, замеры с кольцом поверхности, сигнал — красным кольцом на своём замере */}
        {points.length > 1 ? (
          <polyline
            points={xs.map((x, i) => `${f1(x)},${f1(ys[i]!)}`).join(" ")}
            fill="none"
            stroke={SINGLE_COLOR}
            strokeWidth={compact ? 2.5 : 3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {points.map((p, i) =>
          lay.signals.has(i) ? (
            <circle key={`s-${p.key}`} data-signal={i} cx={f1(xs[i]!)} cy={f1(ys[i]!)} r={9.5} fill="none" stroke="var(--risk)" strokeWidth={2.2} />
          ) : null,
        )}
        {points.map((p, i) => (
          <circle
            key={p.key}
            data-point={i}
            cx={f1(xs[i]!)}
            cy={f1(ys[i]!)}
            r={pt === i ? 6.5 : compact ? 4.5 : 5}
            fill={SINGLE_COLOR}
            stroke="var(--panel)"
            strokeWidth={2.5}
          />
        ))}
        {points.map((p, i) => {
          const at = values.get(i);
          if (!at) return null;
          const span = spans.findIndex((s) => p.value >= s.from && p.value <= s.to);
          return (
            <text
              key={`v-${p.key}`}
              data-value={i}
              x={f1(at.x)}
              y={f1(at.y)}
              textAnchor="middle"
              fontSize={valueSize}
              fontWeight={800}
              fill="var(--text)"
              stroke={span >= 0 ? fillOf(spans[span]!.rung, span) : "var(--plot)"}
              strokeWidth={4}
              strokeLinejoin="round"
              style={{ paintOrder: "stroke" }}
            >
              {fmt.num(p.value)}
            </text>
          );
        })}

        {/* даты замеров под осью; последняя — темнее: «где человек сейчас» */}
        {points.map((p, i) =>
          dateShown.has(i) ? (
            <text
              key={`d-${p.key}`}
              x={f1(xs[i]!)}
              y={PB + 16}
              textAnchor="middle"
              fontSize={11}
              fontWeight={i === lastI ? 800 : 600}
              fill={i === lastI ? "var(--text)" : "var(--axis)"}
            >
              {p.label}
            </text>
          ) : null,
        )}

        {/* дорожка событий: приёмы, неявки, запланированные, заключения */}
        {lane.length ? (
          <g data-lane>
            <line x1={L} x2={plotR} y1={laneY} y2={laneY} stroke="var(--divider)" />
            {lane.map((e, j) =>
              e.kind === "signal" ? null : (
                <g key={e.key} data-event={e.kind === "planned" && now !== null && e.t <= now ? "unmarked" : e.kind}>
                  <EventGlyph kind={e.kind} x={laneXs[j]!} y={laneY} active={ev === j} draft={e.kind === "conclusion" && !e.signed} />
                </g>
              ),
            )}
          </g>
        ) : null}
      </svg>

      {tip && pt !== null ? (
        <ChartTip x={xs[pt]! * k} y={ys[pt]! * k} width={W0}>
          <CoursePointTip tip={tip} rc={rc} normalization={normalization} />
          {href ? <p className="m-0 mt-[7px] text-caption font-semibold text-violet-ink">{ut("course.openHint")}</p> : null}
        </ChartTip>
      ) : null}
      {/*
        Переход к протоколу — ссылкой маршрутизатора, которую нажимает график
        (Enter, нажатие на замер): подсказка указатель не ловит, иначе она
        закрывала бы соседние замеры, пока по ним ведут мышью.
      */}
      {href ? <ProtocolLink href={href} linkRef={linkRef} /> : null}

      {event ? (
        <ChartTip x={laneXs[ev!]! * k} y={(laneY - 10) * k} width={W0}>
          <TipHead note={event.label}>{eventTitle(event, now, ut)}</TipHead>
          {event.detail ? <TipText>{event.detail}</TipText> : null}
        </ChartTip>
      ) : null}
      </div>

      {withCol ? null : <BandKey spans={spans} current={current} rangeOf={fmt.range} />}
      {legend ? <CourseLegend cutoff={withCol ? null : cutText} signal={lay.signals.size > 0} lane={lane} now={now} /> : null}

      {/*
        Как пользоваться графиком и что на дорожке — для диктора
        (aria-describedby и список), а не абзацем под каждым графиком.
      */}
      <p id={hintId} className="sr-only">
        {ut("course.hint")}
      </p>
      {lane.length ? (
        <ul className="sr-only">
          {lane.map((e) => (
            <li key={e.key}>
              {eventTitle(e, now, ut)}, {e.label}
              {e.detail ? `: ${e.detail}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Что за событие дорожки — словами */
function eventTitle(e: CourseEvent, now: number | null, ut: (k: UiKey) => string): string {
  if (e.kind === "session") return ut("course.ev.session");
  if (e.kind === "noshow") return ut("course.ev.noshow");
  if (e.kind === "conclusion") return ut(e.signed ? "course.ev.conclSigned" : "course.ev.conclDraft");
  if (e.kind === "signal") return ut("course.ev.signal");
  return now !== null && e.t <= now ? ut("course.ev.unmarked") : ut("course.ev.planned");
}

/**
 * Ссылка на протокол активного замера — невидимая, вне порядка Tab: её
 * нажимает сам график. Внутри маршрутизатора — переход без перезагрузки.
 */
function ProtocolLink({ href, linkRef }: { href: string; linkRef: Ref<HTMLAnchorElement> }) {
  const { ut } = useLang();
  const inRouter = useInRouterContext();
  return inRouter ? (
    <Link ref={linkRef} to={href} tabIndex={-1} className="sr-only" data-protocol>
      {ut("course.protocol")}
    </Link>
  ) : (
    <a ref={linkRef} href={href} tabIndex={-1} className="sr-only" data-protocol>
      {ut("course.protocol")}
    </a>
  );
}

/**
 * Легенда курса: только то, что на графике есть, — порог, сигнал на замере,
 * значки дорожки. Сам ряд замеров её не получает: он один, его называет
 * шапка. Сетка графиков рисует одну легенду на всех (legend={false} у
 * графиков и CourseLegend под сеткой).
 */
export function CourseLegend({
  cutoff,
  signal,
  lane,
  now = Date.now(),
  className,
}: {
  /**
   * Подпись порога — когда её нет на самом графике (поле без колонки
   * подписей) или легенда одна на сетку графиков (тогда — «клінічний поріг»
   * без числа: у каждого графика оно своё и стоит у его пунктира).
   */
  cutoff?: string | null | true;
  signal?: boolean;
  lane?: readonly CourseEvent[];
  now?: number | null;
  className?: string;
}) {
  const { ut } = useLang();
  const has = (kind: CourseEvent["kind"], past?: boolean) =>
    !!lane?.some((e) => e.kind === kind && (past === undefined || (now !== null && e.t <= now) === past));
  const items: LegendItem[] = [
    ...(cutoff
      ? [{ key: "cut", label: cutoff === true ? ut("course.lg.cutoff") : cutoff, color: "var(--text-2)", kind: "cutoff" as const, title: ut("course.cutoffWhy") }]
      : []),
    ...(signal ? [{ key: "sig", label: ut("course.lg.signal"), color: SINGLE_COLOR, kind: "ring" as const }] : []),
    ...(has("session") ? [{ key: "ses", label: ut("course.lg.session"), color: "var(--text-2)", kind: "session" as const }] : []),
    ...(has("noshow") ? [{ key: "ns", label: ut("course.lg.noshow"), color: "var(--text-2)", kind: "noshow" as const }] : []),
    ...(has("planned", false) ? [{ key: "pl", label: ut("course.lg.planned"), color: "var(--text-2)", kind: "planned" as const }] : []),
    ...(has("planned", true) ? [{ key: "um", label: ut("course.lg.unmarked"), color: "var(--text-2)", kind: "planned" as const }] : []),
    ...(has("conclusion") ? [{ key: "cn", label: ut("course.lg.conclusion"), color: "var(--text-2)", kind: "conclusion" as const }] : []),
  ];
  return <ChartLegend items={items} className={className} always />;
}

/**
 * Подсказка замера: дата и пометка «старт / останній замір», значение с
 * полосой словом и её границами, сдвиг от старта со словом значущості и
 * способом оценки, сдвиг от предыдущего, кто заполнял, сигналы этого
 * замера. Отдельным компонентом — его проверяет тест без наведения мышью.
 */
export function CoursePointTip({ tip, rc, normalization }: { tip: PointTip; rc: number | null; normalization?: ScaleNormalization | null }) {
  const { ut } = useLang();
  const fmt = useCourseFormat(normalization);
  const who = sourceText(tip.point.source, ut);
  return (
    <>
      <TipHead note={tip.baseline ? ut("course.start") : tip.last ? ut("course.last") : undefined}>{tip.point.label}</TipHead>
      <p className="m-0 mt-[6px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <b className="text-big leading-none font-extrabold text-text">{fmt.value(tip.point.value)}</b>
        {tip.band ? <SevChip severity={tip.band.severity} label={tip.band.label} small /> : null}
        {tip.range ? <span className="text-muted">{fmt.range(tip.range)}</span> : null}
      </p>
      {tip.baseline ? <TipText muted>{ut("course.baselineNote")}</TipText> : null}
      {tip.incomparable ? <TipText>{ut(INCOMPARABLE[tip.incomparable])}</TipText> : null}
      {tip.fromStart ? (
        <TipText>
          {ut("course.fromStart")}, {tip.fromStart.since}: <b className="font-extrabold text-text">{fmt.delta(tip.fromStart.delta)}</b>
          {" — "}
          <span data-verdict={tip.fromStart.verdict} className={verdictClass(tip.fromStart.verdict === "unknown" ? null : tip.fromStart.verdict)}>
            {tip.fromStart.verdict === "unknown" ? ut("course.v.unknown") : ut(VERDICT[tip.fromStart.verdict])}
          </span>
        </TipText>
      ) : null}
      {tip.fromStart && rc !== null && rc > 0 ? <TipText muted>{fillIn(ut("course.rcMethod"), { n: fmt.amount(rc) })}</TipText> : null}
      {tip.fromPrev ? (
        <TipText muted>
          {fillIn(ut("course.fromPrev"), { d: tip.fromPrev.label })}: {fmt.delta(tip.fromPrev.delta)}
        </TipText>
      ) : null}
      {who ? <TipText muted>{who}</TipText> : null}
      {tip.signals.map((s) => (
        <p key={s.key} data-tip-signal className="m-0 mt-[5px] max-w-[272px] font-bold whitespace-normal text-risk-ink">
          {fillIn(ut("course.signalOn"), { s: s.detail ?? ut("course.ev.signal") })}
        </p>
      ))}
    </>
  );
}
