import { useId, useRef, useState, type ReactNode } from "react";
import type { Incomparable, ScaleNormalization, UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { NoData } from "../ui/primitives";
import {
  bandSpans,
  courseLayout,
  labelledPoints,
  placeLabels,
  pointTip,
  type Better,
  type ChangeVerdict,
  type CourseEvent,
  type CoursePoint,
  type PointTip,
} from "./courseModel";
import { useChartWidth } from "./index";
import { boundaries, sortRungs, type Rung } from "./ladder";
import {
  ChartLegend,
  ChartTip,
  FOCUSABLE,
  SINGLE_COLOR,
  SevChip,
  TipHead,
  TipText,
  fillIn,
  useDecimal,
  useIndexHover,
  type LegendItem,
} from "./kit";

/**
 * График курса — эталонный график карточки пациента (style_drawer_vivid):
 *
 *   — «краще ↓ / ↑» у оси и подписанные полосы тяжести с границами;
 *   — межі похибки от старта и линия надёжного улучшения;
 *   — число у каждого замера (у длинного курса — у краёв и крайних);
 *   — «сьогодні», сигналы риска и сессии с неявками на оси времени;
 *   — наведение с перекрестьем: точное значение, дата, полоса словом,
 *     сдвиг от старта с его надёжностью и сдвиг от предыдущего.
 *
 * Прогноза нет сознательно: приложение тренд не считает (см. courseModel.ts).
 *
 * Данные — из приложения: courseFromDynamics + courseEventsFromTimeline.
 */

export interface CourseChartProps {
  /** Название шкалы: заголовок подсказки и подпись для диктора */
  title: string;
  points: readonly CoursePoint[];
  rungs: readonly Rung[];
  /** Верх шкалы без лестницы (у шкалы с лестницей верх — край лестницы) */
  max?: number | null;
  /** Порог надёжной зміни в баллах (MDC95); null — не оценён, зоны нет */
  rc: number | null;
  better: Better | null;
  events?: readonly CourseEvent[];
  /** «Сейчас», мс; null — без линии «сьогодні». По умолчанию — текущий момент */
  now?: number | null;
  normalization?: ScaleNormalization | null;
  /** Легенда и строка «наведіть на графік» под графиком */
  legend?: boolean;
}

const L = 30;
const R = 6;
const T = 30;
const PH = 196;
const PB = T + PH;

/** Ширина подписи 11 px Manrope — с запасом, чтобы подписи не налезали */
const textW = (s: string, size = 11) => s.length * size * 0.56 + 4;

/** Почему замер со стартом не сравнивается — те же слова, что у динамики и сводки */
const INCOMPARABLE: Record<Incomparable, UiKey> = {
  version: "rch.versions",
  units: "rch.units",
  unreliable: "rch.unreliable",
};

const VERDICT: Record<Exclude<ChangeVerdict, "within">, UiKey> = {
  better: "course.v.better",
  worse: "course.v.worse",
  changed: "course.v.changed",
  unknown: "course.v.unknown",
};

export function CourseChart({
  title,
  points: raw,
  rungs,
  max,
  rc,
  better,
  events = [],
  now = Date.now(),
  normalization,
  legend = true,
}: CourseChartProps) {
  const { ut } = useLang();
  const dec = useDecimal();
  const [W0, boxRef] = useChartWidth(560);
  const svgRef = useRef<SVGSVGElement>(null);
  const clip = useId().replace(/:/g, "");
  const points = [...raw].sort((a, b) => a.t - b.t);
  const pointHover = useIndexHover(points.length);
  const [evAt, setEvAt] = useState<number | null>(null);

  if (!points.length) return <NoData />;

  const W = Math.max(360, W0);
  /* уже 360 px картинка ужимается целиком — подсказка идёт за ней */
  const k = W0 / W;
  const ladder = sortRungs(rungs);
  const lay = courseLayout(points, ladder, events, now, max);
  const spans = bandSpans(ladder, lay.lo, lay.hi);
  const sessions = lay.events.filter((e) => e.kind !== "signal");
  const signals = lay.events.filter((e) => e.kind === "signal");

  /* полоса справа под подписи полос — данные в неё не заходят, и подписи не на чем перекрыть */
  const strip = ladder.length ? Math.min(120, Math.max(56, ...ladder.map((r) => textW(r.label) + 12))) : 14;
  const x0 = L + (sessions.length ? 26 : 16);
  const x1 = W - R - strip;
  const X = (t: number) => x0 + ((t - lay.t0) / Math.max(1, lay.t1 - lay.t0)) * (x1 - x0);
  const Y = (v: number) => T + PH * (1 - (v - lay.lo) / (lay.hi - lay.lo));
  const f1 = (v: number) => v.toFixed(1);

  const base = points[0]!.value;
  const last = points.at(-1)!;
  const zone = rc !== null && rc > 0 ? { lo: Math.max(lay.lo, base - rc), hi: Math.min(lay.hi, base + rc) } : null;
  const current = ladder.length ? (spans.find((s) => last.value >= s.from && last.value <= s.to)?.rung ?? null) : null;
  const xs = points.map((p) => X(p.t));
  const ys = points.map((p) => Y(p.value));
  const labelled = labelledPoints(points.map((p) => p.value));
  const sy = PB + 44;
  const H = sessions.length ? sy + 30 : PB + 26;

  /* подписи дат: последняя, первая, потом остальные — без наложения */
  const dateShown = placeLabels(xs, points.map((p) => textW(p.label)));
  const todayX = lay.today !== null ? X(lay.today) : null;
  const sameDay = (t: number) => lay.today !== null && Math.abs(t - lay.today) < 12 * 3_600_000;

  const unitWord = !normalization || normalization === "raw" ? ut("course.points") : ut(`norm.${normalization}` as UiKey);
  const pAt = pointHover.at;
  const tip = pAt === null ? null : pointTip(points, pAt, ladder, rc, better);
  const ev = evAt === null ? null : (lay.events[evAt] ?? null);

  /* сессии по оси: номер, неявка крестом, будущая — пустым кругом */
  const sxs = sessions.map((e) => X(e.t));
  const minGap = sxs.reduce((m, x, i) => (i ? Math.min(m, x - sxs[i - 1]!) : m), Infinity);
  const sr = minGap < 18 ? 5 : 8;
  const firstNext = now === null ? null : sessions.find((e) => e.kind === "planned" && e.t > now);
  const lastNoshow = [...sessions].reverse().find((e) => e.kind === "noshow");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const py = ((e.clientY - box.top) / box.height) * H;
    if (py > PB + 6) return;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - px) < Math.abs(xs[best]! - px)) best = i;
    setEvAt(null);
    pointHover.setAt(best);
  };

  const legendItems: LegendItem[] = [
    { key: "pts", label: ut("course.lg.measures"), color: SINGLE_COLOR, kind: "line" },
    ...(zone ? [{ key: "rc", label: ut("course.lg.rc"), color: "var(--rcz)", kind: "zone" as const }] : []),
    ...(signals.length ? [{ key: "sig", label: ut("course.signal"), color: "var(--risk)", kind: "risk" as const }] : []),
    ...(sessions.some((e) => e.kind === "noshow") ? [{ key: "ns", label: ut("course.lg.noshow"), color: "var(--warn)", kind: "warn" as const }] : []),
  ];

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`${title}: ${points.map((p) => `${dec(p.value)} (${p.label})`).join(", ")}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...pointHover.focusProps}
        onMouseLeave={() => {
          pointHover.setAt(null);
          setEvAt(null);
        }}
      >
        <defs>
          <clipPath id={`cp-${clip}`}>
            <rect x={L} y={T} width={W - R - L} height={PH} rx={14} />
          </clipPath>
        </defs>

        {/* поле: полосы тяжести, будущее, межі похибки — под всем остальным */}
        <g clipPath={`url(#cp-${clip})`}>
          {spans.length ? (
            spans.map((s, i) => (
              <rect
                key={`${s.rung.min}-${s.rung.max}`}
                data-band={s.rung.label}
                x={L}
                y={f1(Y(s.to))}
                width={W - R - L}
                height={f1(Y(s.from) - Y(s.to))}
                fill={s.rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)"}
              />
            ))
          ) : (
            <rect x={L} y={T} width={W - R - L} height={PH} fill="var(--plot)" />
          )}
          {boundaries(ladder).map((c) => (
            <line key={c} x1={L} x2={W - R} y1={f1(Y(c))} y2={f1(Y(c))} stroke="var(--plotline)" strokeWidth={2} />
          ))}
          {todayX !== null ? <rect x={f1(todayX)} y={T} width={f1(W - R - todayX)} height={PH} fill="var(--future)" /> : null}
          {zone ? <rect data-zone="rc" x={L} y={f1(Y(zone.hi))} width={W - R - L} height={f1(Y(zone.lo) - Y(zone.hi))} fill="var(--rcz)" /> : null}
        </g>

        {/* подписи полос: слово и границы, у правого края */}
        {spans.map((s, i) => {
          const top = Y(s.to);
          const h = Y(s.from) - top;
          if (h < 13) return null;
          const halo = s.rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)";
          const yc = top + h / 2;
          const two = h >= 28;
          return (
            <g key={`l-${s.rung.min}`} style={{ paintOrder: "stroke" }} stroke={halo} strokeWidth={4} strokeLinejoin="round">
              <text
                x={W - R - 8}
                y={f1(two ? yc - 1 : yc + 4)}
                textAnchor="end"
                fontSize={11}
                fontWeight={s.rung === current ? 800 : 700}
                fill={s.rung === current ? "var(--vink)" : "var(--muted)"}
              >
                {s.rung.label}
              </text>
              {two ? (
                <text x={W - R - 8} y={f1(yc + 12)} textAnchor="end" fontSize={10.5} fontWeight={500} fill="var(--muted)">
                  {dec(s.rung.min)}–{dec(s.rung.max)}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* ось значений и её подпись: единицы, диапазон и куда — лучше */}
        {lay.ticks.map((v) => (
          <text key={v} x={L - 7} y={f1(Y(v) + 4)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--muted)">
            {dec(v)}
          </text>
        ))}
        <text x={L - 7} y={T - 12} fontSize={11} fontWeight={600} fill="var(--muted)">
          {unitWord} {dec(lay.lo)}–{dec(lay.hi)}
          {better ? (
            <>
              {", "}
              <tspan fill="var(--text)">{ut(better === "down" ? "course.betterDown" : "course.betterUp")}</tspan>
            </>
          ) : null}
        </text>

        {/* межі похибки от старта и граница надёжного улучшения */}
        {zone ? (
          <g style={{ paintOrder: "stroke" }} stroke="var(--plot)" strokeWidth={4} strokeLinejoin="round">
            {better ? (
              <>
                <line
                  x1={L}
                  x2={f1(x1)}
                  y1={f1(Y(better === "down" ? zone.lo : zone.hi))}
                  y2={f1(Y(better === "down" ? zone.lo : zone.hi))}
                  stroke="var(--vink)"
                  strokeWidth={1.2}
                  strokeDasharray="4 3"
                  opacity={0.85}
                />
                <text
                  x={L + 6}
                  y={f1(better === "down" ? Y(zone.lo) + 14 : Y(zone.hi) - 5)}
                  fontSize={11}
                  fontWeight={700}
                  fill="var(--vink)"
                >
                  {fillIn(ut(better === "down" ? "course.rcBelow" : "course.rcAbove"), { v: dec(better === "down" ? base - rc! : base + rc!, 1) })}
                </text>
              </>
            ) : null}
            <text
              x={x0 + 8}
              y={f1(better === "up" ? Y(zone.lo) - 6 : Y(zone.hi) + 14)}
              fontSize={11}
              fontWeight={600}
              fill="var(--vink)"
            >
              {fillIn(ut("course.rcZone"), { base: dec(base), rc: dec(rc!, 1) })}
            </text>
          </g>
        ) : null}

        {todayX !== null ? (
          <>
            <line x1={f1(todayX)} x2={f1(todayX)} y1={T - 6} y2={PB} stroke="var(--text)" strokeWidth={1.2} />
            <text x={f1(todayX)} y={T - 10} textAnchor="middle" fontSize={11} fontWeight={800} fill="var(--text)">
              {ut("course.today")}
            </text>
          </>
        ) : null}

        {pAt !== null ? (
          <line x1={f1(xs[pAt]!)} x2={f1(xs[pAt]!)} y1={T} y2={PB} stroke="var(--vink)" strokeDasharray="2 2" />
        ) : null}

        {/* курс: линия 3 px, замеры с кольцом поверхности, число у замера */}
        {points.length > 1 ? (
          <polyline
            points={xs.map((x, i) => `${f1(x)},${f1(ys[i]!)}`).join(" ")}
            fill="none"
            stroke={SINGLE_COLOR}
            strokeWidth={3}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {points.map((p, i) => (
          <circle
            key={p.key}
            data-point={i}
            cx={f1(xs[i]!)}
            cy={f1(ys[i]!)}
            r={pAt === i ? 6.5 : 5}
            fill={SINGLE_COLOR}
            stroke="var(--panel)"
            strokeWidth={2.5}
          />
        ))}
        {points.map((p, i) => {
          if (!labelled.has(i)) return null;
          const above = better !== "up";
          let y = above ? ys[i]! - 11 : ys[i]! + 19;
          if (above && y < T + 12) y = ys[i]! + 19;
          if (!above && y > PB - 4) y = ys[i]! - 11;
          return (
            <text
              key={`v-${p.key}`}
              data-value={i}
              x={f1(xs[i]!)}
              y={f1(y)}
              textAnchor="middle"
              fontSize={13}
              fontWeight={800}
              fill="var(--text)"
              stroke="var(--plot)"
              strokeWidth={4}
              strokeLinejoin="round"
              style={{ paintOrder: "stroke" }}
            >
              {dec(p.value)}
            </text>
          );
        })}

        {/* сигналы — красным квадратом на оси, подписан последний */}
        {signals.map((e, k) => {
          const x = X(e.t);
          const lastOne = k === signals.length - 1;
          const word = ut("course.signal");
          const right = x + 9 + textW(word) < W - R;
          return (
            <g key={e.key} data-event="signal">
              <rect x={f1(x - 4.5)} y={PB - 4.5} width={9} height={9} rx={2.5} fill="var(--risk)" />
              {lastOne ? (
                <text
                  x={f1(right ? x + 9 : x - 9)}
                  y={PB - 6}
                  textAnchor={right ? "start" : "end"}
                  fontSize={11}
                  fontWeight={700}
                  fill="var(--riskink)"
                  stroke="var(--panel)"
                  strokeWidth={4}
                  strokeLinejoin="round"
                  style={{ paintOrder: "stroke" }}
                >
                  {word}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* даты замеров под осью */}
        {points.map((p, i) =>
          dateShown.has(i) ? (
            <text
              key={`d-${p.key}`}
              x={f1(xs[i]!)}
              y={PB + 16}
              textAnchor="middle"
              fontSize={11}
              fontWeight={sameDay(p.t) ? 800 : 600}
              fill={sameDay(p.t) ? "var(--text)" : "var(--muted)"}
            >
              {p.label}
            </text>
          ) : null,
        )}

        {sessions.length ? (
          <SessionsRow
            sessions={sessions}
            xs={sxs}
            y={sy}
            r={sr}
            numbers={lay.sessionNo}
            firstNext={firstNext ?? null}
            lastNoshow={lastNoshow ?? null}
            label={ut("course.sessions")}
            noshowLabel={(d) => fillIn(ut("course.noshowOn"), { d })}
          />
        ) : null}

        {/* зоны наведения: по полосе на замер, по кругу на событие */}
        {lay.events.map((e, i) => {
          const isSession = e.kind !== "signal";
          return (
            <rect
              key={`h-${e.key}`}
              x={f1(X(e.t) - 12)}
              y={isSession ? sy - 12 : PB - 12}
              width={24}
              height={24}
              fill="transparent"
              onMouseEnter={() => {
                pointHover.setAt(null);
                setEvAt(i);
              }}
              onMouseMove={(ev) => ev.stopPropagation()}
            />
          );
        })}
      </svg>

      {tip && pAt !== null ? (
        <ChartTip x={xs[pAt]! * k} y={ys[pAt]! * k} width={W0}>
          <CoursePointTip title={title} tip={tip} rc={zone ? rc : null} base={base} />
        </ChartTip>
      ) : null}

      {ev ? (
        <ChartTip x={X(ev.t) * k} y={(ev.kind === "signal" ? PB - 8 : sy - 8) * k} width={W0}>
          <TipHead note={ev.label}>
            {ev.kind === "session"
              ? fillIn(ut("course.ev.session"), { n: lay.sessionNo.get(ev.key) ?? "" })
              : ev.kind === "planned"
                ? ut("course.ev.planned")
                : ev.kind === "noshow"
                  ? ut("course.lg.noshow")
                  : ut("course.ev.signal")}
          </TipHead>
          {ev.detail ? <TipText>{ev.detail}</TipText> : null}
        </ChartTip>
      ) : null}

      {legend ? (
        <>
          <ChartLegend items={legendItems} always />
          {zone ? null : <p className="m-0 mt-[6px] text-caption leading-[16px] text-muted">{ut("course.noRc")}</p>}
          <p className="m-0 mt-[6px] text-caption leading-[16px] text-muted">{ut("course.hint")}</p>
        </>
      ) : null}
    </div>
  );
}

/**
 * Подсказка замера: дата и пометка «старт / останній замір», значение с
 * полосой словом и её границами, сдвиг от старта с порогом и словом
 * надёжности, сдвиг от предыдущего. Отдельным компонентом — его проверяет
 * тест без наведения мышью.
 */
export function CoursePointTip({ title, tip, rc, base }: { title: string; tip: PointTip; rc: number | null; base: number }) {
  const { ut } = useLang();
  const dec = useDecimal();
  const sign = (d: number) => (d > 0 ? `+${dec(d)}` : d < 0 ? `−${dec(-d)}` : "0");
  return (
    <>
      <TipHead note={tip.baseline ? ut("course.start") : tip.last ? ut("course.last") : undefined}>
        {title}, {tip.point.label}
      </TipHead>
      <p className="m-0 mt-[6px] flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
        <b className="text-big leading-none font-extrabold text-text">{dec(tip.point.value)}</b>
        {tip.band ? <SevChip severity={tip.band.severity} label={tip.band.label} small /> : null}
        {tip.range ? (
          <span className="text-muted">
            {dec(tip.range.min)}–{dec(tip.range.max)}
          </span>
        ) : null}
      </p>
      {tip.baseline ? (
        <TipText muted>{rc !== null ? fillIn(ut("course.baselineRc"), { base: dec(base), rc: dec(rc, 1) }) : ut("course.baseline")}</TipText>
      ) : null}
      {tip.incomparable ? <TipText>{ut(INCOMPARABLE[tip.incomparable])}</TipText> : null}
      {tip.fromStart ? (
        <TipText>
          {ut("course.fromStart")} <b className="font-extrabold text-text">{sign(tip.fromStart.delta)}</b>:{" "}
          <span
            data-verdict={tip.fromStart.verdict}
            className={cx(tip.fromStart.verdict === "better" && "font-bold text-good", tip.fromStart.verdict === "worse" && "font-bold text-warn")}
          >
            {tip.fromStart.verdict === "within" ? ut("sum.withinError") : ut(VERDICT[tip.fromStart.verdict])}
          </span>
          {rc !== null ? ` (${fillIn(ut("course.threshold"), { n: dec(rc, 1) })})` : ""}.
        </TipText>
      ) : null}
      {tip.fromPrev ? (
        <TipText muted>
          {fillIn(ut("course.fromPrev"), { d: tip.fromPrev.label })}: {sign(tip.fromPrev.delta)}.
        </TipText>
      ) : null}
    </>
  );
}

/**
 * Ряд сессий под осью времени: дорожка от первой до последней, проведённые —
 * тёмным кругом с номером, неявка — янтарным кругом с крестом, следующая —
 * фиолетовым кольцом, дальнейшие — пустыми кругами.
 */
function SessionsRow({
  sessions,
  xs,
  y,
  r,
  numbers,
  firstNext,
  lastNoshow,
  label,
  noshowLabel,
}: {
  sessions: readonly CourseEvent[];
  xs: readonly number[];
  y: number;
  r: number;
  numbers: Map<string, number>;
  firstNext: CourseEvent | null;
  lastNoshow: CourseEvent | null;
  label: string;
  noshowLabel: (d: string) => string;
}) {
  const f1 = (v: number) => v.toFixed(1);
  const a0 = xs[0]!;
  const a1 = xs.at(-1)!;
  const big = r >= 8;
  const nextI = firstNext ? sessions.indexOf(firstNext) : -1;
  const nsI = lastNoshow ? sessions.indexOf(lastNoshow) : -1;
  const nsText = lastNoshow ? noshowLabel(lastNoshow.label) : "";
  /* подпись неявки и подпись следующей не должны налезать друг на друга */
  const nsFrom = nsI >= 0 ? xs[nsI]! + 6 - textW(nsText) : 0;
  const nsTo = nsI >= 0 ? xs[nsI]! + 6 : 0;
  const nxFrom = nextI >= 0 ? xs[nextI]! - 7 : 0;
  const nxTo = nextI >= 0 && firstNext ? nxFrom + textW(firstNext.label) : 0;
  const clash = nsI >= 0 && nextI >= 0 && nsFrom < nxTo && nsTo > nxFrom;
  const marks: ReactNode[] = sessions.map((e, i) => {
    const x = xs[i]!;
    const n = numbers.get(e.key);
    if (e.kind === "noshow") {
      const k = r * 0.38;
      return (
        <g key={e.key} data-event="noshow">
          <circle cx={f1(x)} cy={y} r={r} fill="var(--warntint)" stroke="var(--warn)" strokeWidth={1.5} />
          <path
            d={`M${f1(x - k)} ${f1(y - k)}L${f1(x + k)} ${f1(y + k)}M${f1(x + k)} ${f1(y - k)}L${f1(x - k)} ${f1(y + k)}`}
            stroke="var(--warn)"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
      );
    }
    if (e.kind === "session") {
      return (
        <g key={e.key} data-event="session">
          <circle cx={f1(x)} cy={y} r={r} fill="var(--text-2)" />
          {big && n ? (
            <text x={f1(x)} y={y + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={800} fill="var(--panel)">
              {n}
            </text>
          ) : null}
        </g>
      );
    }
    const next = e === firstNext;
    return (
      <g key={e.key} data-event="planned">
        <circle cx={f1(x)} cy={y} r={r} fill="var(--panel)" stroke={next ? SINGLE_COLOR : "var(--ctl)"} strokeWidth={next ? 1.8 : 1.5} />
        {big && n ? (
          <text x={f1(x)} y={y + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={800} fill={next ? "var(--vink)" : "var(--muted)"}>
            {n}
          </text>
        ) : null}
      </g>
    );
  });
  return (
    <g>
      <text x={0} y={y + 4} fontSize={11} fontWeight={600} fill="var(--muted)">
        {label}
      </text>
      <rect x={f1(a0 - 14)} y={y - 14} width={f1(a1 - a0 + 28)} height={28} rx={14} fill="var(--sunk)" />
      {a1 > a0 ? <line x1={f1(a0)} x2={f1(a1)} y1={y} y2={y} stroke="var(--track)" strokeWidth={2} /> : null}
      {marks}
      {nsI >= 0 && !clash ? (
        <text x={f1(nsTo)} y={y + 24} textAnchor="end" fontSize={11} fontWeight={700} fill="var(--warn)">
          {nsText}
        </text>
      ) : null}
      {nextI >= 0 && firstNext ? (
        <text x={f1(nxFrom)} y={y + 24} fontSize={11} fontWeight={600} fill="var(--text-2)">
          {firstNext.label}
        </text>
      ) : null}
    </g>
  );
}
