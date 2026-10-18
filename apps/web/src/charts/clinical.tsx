import { useId, useRef, useState, type ReactNode } from "react";
import type { Severity } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { NoData } from "../ui/primitives";
import { bandSpans, placeLabels } from "./courseModel";
import { useChartWidth } from "./index";
import {
  ATTENTION_COLOR,
  ChartLegend,
  ChartTip,
  DataTable,
  FOCUSABLE,
  Marker,
  OTHER_COLOR,
  RowTip,
  SINGLE_COLOR,
  SevChip,
  SmallCell,
  TipHead,
  TipRow,
  ViewSwitch,
  fillIn,
  sevBg,
  useDecimal,
  sevColor,
  shapeOf,
  useIndexHover,
  type LegendItem,
  type TableView,
} from "./kit";
import { boundaries, ladderDomain, profileRuns, rungOf, segments, share, sortRungs, type Rung } from "./ladder";
import { axisFor } from "./scale";

/**
 * Клинические и служебные графики консоли в языке «Виразної».
 *
 * Одна форма на один вопрос, и один и тот же вопрос на разных экранах
 * выглядит одинаково:
 *
 *   SeverityMeter (SeverityRuler) — где этот балл на лестнице полос;
 *   ScaleProfile  — то же по всем шкалам методики сразу;
 *   BandTrend     — как балл двигался по лестнице во времени;
 *   ShareBar      — из чего состоит целое (полосы, варианты ответа);
 *   HBars         — сравнение величин по строкам;
 *   GroupedHBars  — то же для нескольких рядов, у каждого свой цвет;
 *   PairBars      — «було / стало» парой полос;
 *   HeatTable     — ответы по пунктам во времени, критический — красным;
 *   TimeColumns   — сколько за день/неделю;
 *   StackColumns  — то же с разбивкой столбца на части;
 *   TimeLines     — несколько величин по одним корзинам времени, с разрывами
 *                   и отметками (выкатки);
 *   Kpi, Sparkline — крупное число со сравнением и ходом рядом с ним.
 *
 * Цвет (charts/README.md): одиночный ряд — --series; несколько — c1…c4 в
 * постоянном порядке, c5 — прочее и «було»; упорядоченные категории —
 * лестница h1…h5; тяжесть — ступени --sev-* только в клинических полосах и
 * никогда без слова; янтарь (--warn) — только «требует внимания»; красный —
 * только риск для человека (критический ответ).
 *
 * Раскладка — HTML там, где форма прямоугольная (линейка, доли, полосы,
 * тепловая таблица): текст подписей в HTML переносится и обрезается
 * браузером. SVG — там, где нужны оси, и рисуется в пикселях контейнера
 * (useChartWidth), не растягиваясь.
 */

/* ─────────── метка тяжести: цвет + форма ─────────── */

const SEV_SHAPE: Record<Severity, string> = {
  none: "rounded-full",
  mild: "rounded-full",
  moderate: "",
  severe: "rotate-45",
};

/** Текст подписи ступени: тот же тон, что у отрезка, в текстовой силе */
export const SEV_TEXT: Record<Severity, string> = {
  none: "text-sev-0",
  mild: "text-sev-1",
  moderate: "text-sev-2",
  severe: "text-sev-4",
};

/**
 * Точка ступени. Форма повторяет SeverityTag: лёгкая и нормальная — круг,
 * умеренная — квадрат, тяжёлая — ромб. Читается без цвета — в печати и при
 * любом виде дальтонизма.
 */
export function SevDot({ severity, className }: { severity: Severity; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-[8px] shrink-0", SEV_SHAPE[severity], className)} style={{ background: sevColor(severity) }} />;
}

/* ─────────── линейка тяжести ─────────── */

export interface RulerProps {
  rungs: readonly Rung[];
  value: number | null;
  /** Максимум шкалы — только для шкалы без лестницы: тогда рисуется метр 0…max */
  max?: number | null;
  /** lg — одна шкала крупно, с границами и словом ступени; sm — строка профиля */
  size?: "lg" | "sm";
  /** Подпись значения рядом со словом ступени; по умолчанию — само значение */
  valueLabel?: string;
  /** Подпись для диктора: «Депресія: 12 — помірна» */
  label: string;
}

/**
 * Шкала тяжести (meter набора): вся лестница полос, булавка там, куда лёг
 * балл, границы числами и слово ступени под ней.
 *
 * Отвечает на вопрос, которого не видно в строке «від — до»: насколько
 * близко к соседней ступени. «Помірна» у балла 10 и у балла 14 — разные
 * разговоры. Попавшая ступень — в полную силу, остальные — подложкой той же
 * ступени: шкала читается целиком, а ответ находится раньше подписей.
 */
export function SeverityMeter({ rungs, value, max, size = "lg", valueLabel, label }: RulerProps) {
  const dec = useDecimal();
  const sorted = sortRungs(rungs);
  const d = ladderDomain(sorted, [value], max);
  const segs = segments(sorted, d);
  const at = value === null ? null : share(value, d);
  const hit = value === null ? null : rungOf(sorted, value);
  const lg = size === "lg";
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  /* слово ступени — под серединой попавшего отрезка, но не у самого края шкалы */
  const hitSeg = segs.find((s) => s.rung === hit);
  const wordAt = Math.min(0.88, Math.max(0.12, hitSeg ? hitSeg.start + hitSeg.width / 2 : (at ?? 0)));

  return (
    <div role="img" aria-label={label} className={cx("relative w-full", lg ? "pt-[6px]" : "py-[6px]")}>
      <div className={cx("relative", lg ? "h-[10px]" : "h-[8px]")}>
        {segs.length ? (
          <div className="flex h-full gap-[2px]">
            {segs.map((s) => {
              const on = s.rung === hit;
              return (
                <span
                  key={`${s.rung.min}-${s.rung.max}`}
                  data-rung={on ? "on" : "off"}
                  className="group/row relative h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                  style={{ width: pct(s.width), background: on ? sevColor(s.rung.severity) : sevBg(s.rung.severity) }}
                >
                  {lg ? (
                    <RowTip>
                      <TipHead>{s.rung.label}</TipHead>
                      <TipRow value={`${dec(s.rung.min)}–${dec(s.rung.max)}`} />
                    </RowTip>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : (
          /* шкала без полос — метр: дорожка и заливка фиолетовым до балла */
          <div className="h-full overflow-hidden rounded-[4px] bg-track">
            {at !== null ? <div data-fill className="h-full rounded-r-[4px]" style={{ width: pct(at), background: SINGLE_COLOR }} /> : null}
          </div>
        )}
        {at !== null ? (
          <span
            aria-hidden
            data-pin
            className={cx(
              "absolute rounded-[2px] bg-text shadow-[0_0_0_2px_var(--panel)]",
              lg ? "-top-[6px] h-[22px] w-[4px] -ml-[2px]" : "-top-[4px] h-[16px] w-[3px] -ml-[1.5px]",
            )}
            style={{ left: pct(at) }}
          />
        ) : null}
      </div>

      {lg ? (
        <>
          <div aria-hidden className="relative mt-[6px] h-[16px] text-[11px] font-semibold text-muted">
            {(segs.length ? [...segs.map((s) => ({ at: s.start, v: s.start === 0 ? d.lo : s.rung.min })), { at: 1, v: d.hi }] : [{ at: 0, v: d.lo }, { at: 1, v: d.hi }]).map(
              (t, i, all) => (
                <span
                  key={`${t.at}-${t.v}`}
                  className={cx("absolute whitespace-nowrap", i === 0 ? "" : i === all.length - 1 ? "-translate-x-full" : "-translate-x-1/2")}
                  style={{ left: pct(t.at) }}
                >
                  {dec(t.v)}
                </span>
              ),
            )}
          </div>
          {value !== null ? (
            <div className="relative h-[18px] text-caption">
              {/*
                Длинное слово ступени («Депресія відсутня, 2») у края шкалы
                вылезало за её левый или правый край и обрезалось панелью:
                у краёв подпись прижимается к краю, а не центрируется.
              */}
              <span
                className={cx(
                  "absolute font-extrabold whitespace-nowrap text-text",
                  wordAt < 0.3 ? "" : wordAt > 0.7 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: wordAt < 0.3 ? 0 : wordAt > 0.7 ? "100%" : pct(wordAt) }}
              >
                {hit ? `${hit.label}, ` : ""}
                {valueLabel ?? dec(value)}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Прежнее имя шкалы тяжести — вызовы экранов остаются как были */
export const SeverityRuler = SeverityMeter;

/* ─────────── профиль по шкалам ─────────── */

export interface ProfileRow {
  key: string;
  title: string;
  rungs: readonly Rung[];
  value: number | null;
  max?: number | null;
  /** Как печатать значение справа: «12 з 27», «T 64» */
  valueText: string;
  band: { label: string; severity: Severity } | null;
  /** Строка — ссылка (на шкалу, на прохождение); без неё — просто текст */
  action?: ReactNode;
}

const ROW_H = 52;

/**
 * Профиль: по строке на шкалу — название, шкала тяжести, значение и
 * ступень словом.
 *
 * Строки, а не радар: у радара форма многоугольника зависит от порядка шкал.
 * Подряд идущие шкалы с одной и той же лестницей (Т-баллы Міні-мульта)
 * соединяются тонкой линией — классический профиль, повёрнутый на бок; на
 * шкале с другой лестницей линия рвётся (profileRuns).
 */
export function ScaleProfile({ rows }: { rows: readonly ProfileRow[] }) {
  if (!rows.length) return <NoData />;
  const domains = rows.map((r) => ladderDomain(r.rungs, [r.value], r.max));
  const runs = profileRuns(rows.map((r, i) => ({ rungs: r.rungs, domain: domains[i]!, value: r.value })));
  const H = rows.length * ROW_H;

  return (
    <div className="grid grid-cols-[minmax(96px,220px)_minmax(0,1fr)_minmax(96px,200px)] gap-x-[24px] max-[600px]:gap-x-[12px]">
      <ul className="m-0 list-none p-0">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center border-b border-divider" style={{ height: ROW_H }}>
            <span className="line-clamp-2 text-body leading-[18px] font-bold text-text">{r.action ?? r.title}</span>
          </li>
        ))}
      </ul>

      <div className="relative">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center border-b border-divider" style={{ height: ROW_H }}>
            <SeverityMeter
              size="sm"
              rungs={r.rungs}
              value={r.value}
              max={r.max}
              label={`${r.title}: ${r.valueText}${r.band ? ` — ${r.band.label}` : ""}`}
            />
          </div>
        ))}
        {runs.length ? (
          <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 100 ${H}`} preserveAspectRatio="none">
            {runs.map((run) => (
              <polyline
                key={run[0]}
                points={run.map((i) => `${(share(rows[i]!.value!, domains[i]!) * 100).toFixed(3)},${i * ROW_H + ROW_H / 2}`).join(" ")}
                fill="none"
                stroke={SINGLE_COLOR}
                strokeWidth={1.5}
                strokeOpacity={0.6}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        ) : null}
      </div>

      <ul className="m-0 list-none p-0">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-[8px] gap-y-[2px] border-b border-divider" style={{ height: ROW_H }}>
            <span className="text-[15px] leading-[18px] font-extrabold text-text">{r.valueText}</span>
            {r.band ? <SevChip severity={r.band.severity} label={r.band.label} small /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────── динамика по лестнице ─────────── */

export interface TrendPoint {
  key: string;
  /** Момент замера, мс — ось времени честная, а не «замер через равные шаги» */
  t: number;
  /** Подпись момента: дата так, как её печатает экран */
  label: string;
  value: number;
  band?: { label: string; severity: Severity } | null;
  /** Замер, ради которого экран открыт: кольцом, а не цветом */
  focus?: boolean;
}

const TP = { top: 14, right: 8, bottom: 26, left: 34 };

/**
 * Динамика шкалы на фоне лестницы полос — тем же полем, что у графика курса:
 * подписанные полосы тяжести с границами, текущая — темнее.
 *
 * Ось Y здесь — ВСЯ лестница: вопрос графика не «насколько изменилось», а
 * «в какую ступень пришло», и срезать низ значило бы убрать с глаз ступень,
 * куда человек, возможно, вернулся. Без лестницы ось подгоняется axisFor.
 *
 * Полоса вокруг линии — ошибка измерения (SEM), только когда она известна.
 */
export function BandTrend({
  points,
  rungs,
  max,
  sem,
  height = 240,
  label,
}: {
  points: readonly TrendPoint[];
  rungs: readonly Rung[];
  max?: number | null;
  sem?: number | null;
  height?: number;
  label: string;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(points.length);
  const clip = useId().replace(/:/g, "");

  if (!points.length) return <NoData />;

  const sorted = sortRungs(rungs);
  const values = points.map((p) => p.value);
  const err = sem != null && sem > 0 ? sem : 0;
  const withErr = [...values.map((v) => v - err), ...values.map((v) => v + err)];

  let lo: number;
  let hi: number;
  let ticks: number[];
  if (sorted.length) {
    const d = ladderDomain(sorted, withErr, max);
    lo = d.lo;
    hi = d.hi;
    ticks = [lo, ...boundaries(sorted).map((_, i) => sorted[i + 1]!.min), hi].filter((v, i, a) => a.indexOf(v) === i && v >= lo && v <= hi);
  } else {
    const axis = axisFor({ lo: Math.min(...withErr), hi: Math.max(...withErr), atom: err });
    lo = axis.min;
    hi = axis.max;
    ticks = axis.ticks;
  }
  const span = Math.max(hi - lo, Number.EPSILON);
  const spans = bandSpans(sorted, lo, hi);
  /* полоса подписей не шире трети графика: длинное название полосы сокращается многоточием */
  const labelW = sorted.length ? Math.min(Math.round(W * 0.3), 176, Math.max(48, ...sorted.map((r) => r.label.length * 6.2 + 14))) : 0;
  const showBandLabels = sorted.length > 0 && W - labelW > 300;
  const fitLabel = (s: string) => {
    const room = Math.floor((labelW - 14) / 6.2);
    return s.length <= room ? s : `${s.slice(0, Math.max(1, room - 1)).trimEnd()}…`;
  };

  const right = TP.right + (showBandLabels ? labelW : 0);
  const pw = Math.max(40, W - TP.left - right - 10);
  const ph = height - TP.top - TP.bottom;
  const t0 = Math.min(...points.map((p) => p.t));
  const t1 = Math.max(...points.map((p) => p.t));
  const xAt = (t: number) => TP.left + 10 + (t1 > t0 ? ((t - t0) / (t1 - t0)) * pw : pw / 2);
  const yAt = (v: number) => TP.top + ph - ((v - lo) / span) * ph;
  const f1 = (v: number) => v.toFixed(1);

  const last = points.at(-1)!;
  const current = sorted.length ? (spans.find((s) => last.value >= s.from && last.value <= s.to)?.rung ?? null) : null;
  const line = points.map((p, i) => `${i ? "L" : "M"}${f1(xAt(p.t))},${f1(yAt(p.value))}`).join(" ");
  const band =
    err > 0 && points.length > 1
      ? [
          ...points.map((p, i) => `${i ? "L" : "M"}${f1(xAt(p.t))},${f1(yAt(p.value + err))}`),
          ...[...points].reverse().map((p) => `L${f1(xAt(p.t))},${f1(yAt(p.value - err))}`),
          "Z",
        ].join(" ")
      : null;

  const xs = points.map((p) => xAt(p.t));
  const shownX = placeLabels(xs, points.map((p) => p.label.length * 6.2 + 4), 12);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(xs[i]! - x) < Math.abs(xs[best]! - x)) best = i;
    hover.setAt(best);
  };
  const at = hover.at === null ? null : points[hover.at]!;
  const fieldW = W - TP.left - TP.right;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${points[0]!.label} — ${points.at(-1)!.label}, ${points.length}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        <defs>
          <clipPath id={`bt-${clip}`}>
            <rect x={TP.left} y={TP.top} width={fieldW} height={ph} rx={12} />
          </clipPath>
        </defs>
        {sorted.length ? (
          <g clipPath={`url(#bt-${clip})`}>
            {spans.map((s, i) => (
              <rect
                key={`${s.rung.min}-${s.rung.max}`}
                x={TP.left}
                y={f1(yAt(s.to))}
                width={fieldW}
                height={f1(yAt(s.from) - yAt(s.to))}
                fill={s.rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)"}
              />
            ))}
            {boundaries(sorted).map((c) => (
              <line key={c} x1={TP.left} x2={TP.left + fieldW} y1={f1(yAt(c))} y2={f1(yAt(c))} stroke="var(--plotline)" strokeWidth={2} />
            ))}
          </g>
        ) : (
          ticks.map((t) => <line key={t} x1={TP.left} x2={W - TP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />)
        )}

        {/* подписи полос у правого края — в своей полосе, данные туда не заходят */}
        {showBandLabels
          ? spans.map((s, i) => {
              const top = yAt(s.to);
              const h = yAt(s.from) - top;
              if (h < 13) return null;
              const two = h >= 28;
              const yc = top + h / 2;
              return (
                <g key={`l-${s.rung.min}`}>
                  <text
                    x={W - TP.right - 8}
                    y={f1(two ? yc - 1 : yc + 4)}
                    textAnchor="end"
                    fontSize={11}
                    fontWeight={s.rung === current ? 800 : 700}
                    fill={s.rung === current ? "var(--vink)" : "var(--muted)"}
                    stroke={s.rung === current ? "var(--plotc)" : i % 2 ? "var(--plot2)" : "var(--plot)"}
                    strokeWidth={4}
                    strokeLinejoin="round"
                    style={{ paintOrder: "stroke" }}
                  >
                    {fitLabel(s.rung.label)}
                  </text>
                  {two ? (
                    <text x={W - TP.right - 8} y={f1(yc + 12)} textAnchor="end" fontSize={10.5} fontWeight={500} fill="var(--muted)">
                      {dec(s.rung.min)}–{dec(s.rung.max)}
                    </text>
                  ) : null}
                </g>
              );
            })
          : null}

        {ticks.map((t) => (
          <text key={`t-${t}`} x={TP.left - 7} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
            {dec(t)}
          </text>
        ))}

        {at ? <line x1={xAt(at.t)} x2={xAt(at.t)} y1={TP.top} y2={TP.top + ph} stroke="var(--vink)" strokeDasharray="2 2" /> : null}

        {band ? <path d={band} fill={SINGLE_COLOR} fillOpacity={0.12} /> : null}
        {points.length > 1 ? <path d={line} fill="none" stroke={SINGLE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}

        {points.map((p) =>
          p.focus ? (
            <circle key={p.key} cx={f1(xAt(p.t))} cy={f1(yAt(p.value))} r={6} fill="var(--panel)" stroke={SINGLE_COLOR} strokeWidth={3} />
          ) : (
            <Marker key={p.key} x={xAt(p.t)} y={yAt(p.value)} r={at === p ? 5.5 : 4} color={SINGLE_COLOR} />
          ),
        )}

        {/* число — у последнего замера: остальные в подсказке */}
        <text
          x={f1(xAt(last.t))}
          y={f1(yAt(last.value) - 10)}
          textAnchor="middle"
          fontSize={12}
          fontWeight={800}
          fill="var(--text)"
          stroke="var(--plot)"
          strokeWidth={4}
          strokeLinejoin="round"
          style={{ paintOrder: "stroke" }}
        >
          {dec(last.value)}
        </text>

        {points.map((p, i) =>
          shownX.has(i) ? (
            <text key={`x-${p.key}`} x={f1(xs[i]!)} y={height - 8} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {p.label}
            </text>
          ) : null,
        )}
      </svg>

      {at ? (
        <ChartTip x={xAt(at.t)} y={yAt(at.value)} width={W}>
          <TipHead note={at.focus ? ut("kit.thisOne") : undefined}>{at.label}</TipHead>
          <p className="m-0 mt-[6px] flex items-center gap-[8px]">
            <b className="text-[15px] font-extrabold text-text">{dec(at.value)}</b>
            {at.band ? <SevChip severity={at.band.severity} label={at.band.label} small /> : null}
          </p>
        </ChartTip>
      ) : null}
    </div>
  );
}

/* ─────────── доли целого ─────────── */

export interface SharePart {
  key: string;
  label: string;
  /** null — ячейка скрыта порогом малых чисел: не ноль, а «не показываем» */
  value: number | null;
  severity?: Severity | null;
  /**
   * Место в упорядоченном ряду (0…1) для вариантов без тяжести: «ніколи» →
   * «майже щодня». Цвет — лестница h2…h5 одного фиолетового: одна величина,
   * один тон, порядок читается светлотой.
   */
  step?: number;
  /**
   * Свой цвет части — токеном. Для частей другой природы, чем остальные:
   * «вільно» рядом с занятыми подключениями — дорожка, а не ещё одна ступень.
   */
  color?: string;
}

function partColor(p: SharePart): string {
  if (p.color) return p.color;
  if (p.severity) return sevColor(p.severity);
  return `var(--h${2 + Math.round(Math.min(1, Math.max(0, p.step ?? 1)) * 3)})`;
}

/**
 * Полоса долей (stacked набора): одно целое, разрезанное на части с
 * просветом 2 px, и легенда с числами под ним.
 *
 * Вместо кольца: полоса читается слева направо в порядке ступеней, и таких
 * полос можно поставить десять одну под другой. Скрытая ячейка в полосу не
 * входит вовсе — ширина отрезка тоже число; в легенде у неё «n < 5».
 */
export function ShareBar({
  parts,
  legend = true,
  label,
  className,
  format = String,
  percent = true,
}: {
  parts: readonly SharePart[];
  legend?: boolean;
  label: string;
  className?: string;
  /** Как печатать величину части: «120 мс», «41 %»; по умолчанию — числом */
  format?: (v: number) => string;
  /** Дописывать ли долю от целого; у частей, которые сами доли, она повторила бы число */
  percent?: boolean;
}) {
  const shown = parts.filter((p) => p.value !== null && p.value > 0);
  const total = shown.reduce((s, p) => s + (p.value ?? 0), 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value === null ? "—" : format(p.value)}`).join(", ")}`}
        className="flex h-[16px] gap-[2px]"
      >
        {total > 0 ? (
          shown.map((p) => (
              <span
                key={p.key}
                data-part={p.key}
                className="group/row relative h-full min-w-[2px] first:rounded-l-[4px] last:rounded-r-[4px] hover:opacity-85"
                style={{ flexGrow: p.value!, flexBasis: 0, background: partColor(p) }}
              >
                <RowTip at={0}>
                  <TipHead>{p.label}</TipHead>
                  <TipRow kind="box" color={partColor(p)} value={format(p.value!)} extra={percent ? `${pct(p.value!)} %` : undefined} />
                </RowTip>
              </span>
            ))
        ) : (
          <span className="h-full w-full rounded-[4px] bg-track" />
        )}
      </div>
      {legend ? (
        <ul className="m-0 mt-[10px] flex list-none flex-wrap gap-x-[18px] gap-y-[6px] p-0 text-[13px] leading-[18px]">
          {parts.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-[6px]">
              {p.severity ? (
                <SevDot severity={p.severity} />
              ) : (
                <span aria-hidden className="inline-block h-[10px] w-[14px] shrink-0 rounded-[3px]" style={{ background: partColor(p) }} />
              )}
              <span data-legend-label className="truncate font-semibold text-text-2">
                {p.label}
              </span>
              {p.value === null ? (
                <SmallCell />
              ) : (
                <>
                  <span className="font-extrabold text-text">{format(p.value)}</span>
                  {percent && total > 0 && p.value > 0 ? <span className="text-caption text-muted">{pct(p.value)} %</span> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ─────────── полосы по строкам ─────────── */

export interface HBar {
  key: string;
  label: ReactNode;
  value: number | null;
  /** Подпись справа вместо самого числа: «12 з 27», «48 с» */
  text?: string;
  severity?: Severity | null;
  /** Строка, на которую стоит обратить взгляд: она — фиолетовым, остальные — «прочим» */
  strong?: boolean;
  /**
   * Величина, которая требует внимания (пятисотки, сбои задач): полоса
   * янтарём. Что именно считается, говорит заголовок фигуры.
   */
  attention?: boolean;
}

/** Решётка строки-полосы: подпись, полоса, число */
const HBAR_ROW =
  "group/row relative grid min-h-[28px] grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(48px,auto)] items-center gap-[12px] rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]";

/**
 * Сравнение величин строками (hbars набора): подпись, полоса 14 px со
 * скруглённым концом, число справа.
 *
 * Полоса от нуля и до общего максимума строк (или заданного `max`): у
 * длины полосы нет другого нуля. Скрытое значение — пустая обведённая
 * дорожка и «n < 5» с объяснением по наведению.
 */
export function HBars({
  items,
  max,
  unit = "",
  floor = 5,
  reference,
}: {
  items: readonly HBar[];
  max?: number;
  unit?: string;
  /** Порог малых чисел — подпись скрытой строки «n < 5» */
  floor?: number;
  /** Отметка сравнения поперёк полос: среднее отделения, порог */
  reference?: { value: number; label: string };
}) {
  const dec = useDecimal();
  if (!items.length) return <NoData />;
  const top = max ?? Math.max(...items.map((i) => i.value ?? 0), reference?.value ?? 0, 0);
  const anyStrong = items.some((i) => i.strong);
  const colorOf = (i: HBar) =>
    i.severity ? sevColor(i.severity) : i.attention ? ATTENTION_COLOR : !anyStrong || i.strong ? SINGLE_COLOR : OTHER_COLOR;
  const ref =
    reference && top > 0 ? (
      <span
        aria-hidden
        className="absolute -top-[4px] h-[22px] w-[2px] -ml-[1px] rounded-[1px] bg-text"
        style={{ left: `${Math.min(100, (reference.value / top) * 100).toFixed(2)}%` }}
      />
    ) : null;
  return (
    <div>
      <ul className="m-0 grid list-none gap-[6px] p-0">
        {items.map((i) => {
          const w = i.value !== null && top > 0 ? Math.max(0.015, Math.min(1, i.value / top)) : 0;
          return (
            <li key={i.key} tabIndex={0} className={HBAR_ROW}>
              <span className={cx("min-w-0 truncate text-[13px] leading-[17px]", i.strong ? "font-extrabold text-text" : "font-semibold text-text-2")}>
                {i.label}
              </span>
              <span className="relative h-[14px]">
                {i.value === null ? (
                  <span className="block h-full w-full rounded-r-[4px] shadow-[inset_0_0_0_1px_var(--ctl)]" />
                ) : top > 0 && i.value > 0 ? (
                  <span data-bar className="block h-full rounded-r-[4px]" style={{ width: `${(w * 100).toFixed(2)}%`, background: colorOf(i) }} />
                ) : null}
                {ref}
              </span>
              <span className="text-right text-[13px] font-extrabold whitespace-nowrap text-text">
                {i.value === null ? <SmallCell floor={floor} /> : (i.text ?? `${dec(i.value)}${unit}`)}
              </span>
              {i.value !== null ? (
                <RowTip at={0.4 + w * 0.6 * 0.6}>
                  <TipHead>{i.label}</TipHead>
                  <TipRow kind="box" color={colorOf(i)} value={i.text ?? `${dec(i.value)}${unit}`} />
                  {reference ? <TipRow label={reference.label} value={`${dec(reference.value)}${unit}`} /> : null}
                </RowTip>
              ) : null}
            </li>
          );
        })}
      </ul>
      {reference ? (
        <p className="m-0 mt-[8px] flex items-center gap-[6px] text-caption text-muted">
          <span aria-hidden className="inline-block h-[12px] w-[2px] rounded-[1px] bg-text" />
          {reference.label}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────── сгруппированные полосы ─────────── */

export interface GroupedRow {
  key: string;
  label: ReactNode;
  /** По значению на ряд, в порядке рядов; null — скрыто порогом малых чисел */
  values: readonly (number | null)[];
}

/**
 * Несколько рядов на строку: у каждого ряда свой цвет (c1…c4) и легенда.
 * Отвечает на «как группы отличаются по одной величине» — по строке на
 * величину, по полосе на группу.
 */
export function GroupedHBars({
  rows,
  series,
  max,
  format: formatProp,
  floor = 5,
  hiddenWhy,
  legend = true,
}: {
  rows: readonly GroupedRow[];
  series: readonly SeriesKey[];
  max?: number;
  /** Как печатать величину; по умолчанию — числом с дробью языка */
  format?: (v: number) => string;
  floor?: number;
  /** Своё объяснение скрытой ячейки (SmallCell, `why`) */
  hiddenWhy?: ReactNode;
  /** false — легенду рисует экран, одну на несколько групп полос */
  legend?: boolean;
}) {
  const dec = useDecimal();
  const format = formatProp ?? ((v: number) => dec(v));
  if (!rows.length || !series.length) return <NoData />;
  const top = max ?? Math.max(0, ...rows.flatMap((r) => r.values.map((v) => v ?? 0)));
  return (
    <div>
      <ul className="m-0 grid list-none gap-[12px] p-0">
        {rows.map((r) => (
          <li key={r.key} tabIndex={0} className="group/row relative grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-[12px] rounded-[8px] outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
            <span className="min-w-0 truncate text-[13px] font-semibold text-text-2">{r.label}</span>
            <span className="grid gap-[2px]">
              {series.map((s, k) => {
                const v = r.values[k] ?? null;
                return (
                  <span key={s.key} className="grid grid-cols-[minmax(0,1fr)_minmax(44px,auto)] items-center gap-[10px]">
                    <span className="relative h-[8px]">
                      {v === null ? (
                        <span className="block h-full w-full rounded-r-[3px] shadow-[inset_0_0_0_1px_var(--ctl)]" />
                      ) : top > 0 && v > 0 ? (
                        <span
                          data-bar={s.key}
                          className="block h-full rounded-r-[3px]"
                          style={{ width: `${Math.max(1.5, Math.min(100, (v / top) * 100)).toFixed(2)}%`, background: s.color }}
                        />
                      ) : null}
                    </span>
                    <span className="text-right text-caption font-bold whitespace-nowrap text-text">{v === null ? <SmallCell floor={floor} why={hiddenWhy} /> : format(v)}</span>
                  </span>
                );
              })}
            </span>
            <RowTip at={0.4}>
              <TipHead>{r.label}</TipHead>
              {series.map((s, k) => {
                const v = r.values[k] ?? null;
                return <TipRow key={s.key} kind="box" color={s.color} label={s.label} value={v === null ? "—" : format(v)} />;
              })}
            </RowTip>
          </li>
        ))}
      </ul>
      {legend ? <SeriesLegend items={series} /> : null}
    </div>
  );
}

/* ─────────── пары «было / стало» ─────────── */

export interface PairRow {
  key: string;
  label: ReactNode;
  /** null — в этом окне величины нет (маршрута не было): полосы нет, а не нулевая */
  before: number | null;
  after: number | null;
  /** Числа справа: «120 → 340 мс» */
  text: string;
  /** «Стало» требует внимания: полоса янтарём, слово — в note */
  attention?: boolean;
  /** Слово сдвига рядом с числами — цвет полосы в одиночку ничего не значит */
  note?: ReactNode;
}

/**
 * Пара полос на строку: «було» — серым «прочего», «стало» — фиолетовым (или
 * янтарём, если требует внимания), от общего нуля. Показывает обе величины,
 * и разница читается длиной, не теряя масштаба.
 */
export function PairBars({
  rows,
  before,
  after,
  max,
}: {
  rows: readonly PairRow[];
  /** Подписи легенды: «Було», «Стало» */
  before: string;
  after: string;
  max?: number;
}) {
  const dec = useDecimal();
  if (!rows.length) return <NoData />;
  const top = max ?? Math.max(0, ...rows.flatMap((r) => [r.before ?? 0, r.after ?? 0]));
  const width = (v: number) => `${Math.max(1.5, Math.min(100, (v / top) * 100)).toFixed(2)}%`;
  const bar = (v: number | null, color: string) =>
    v !== null && v > 0 && top > 0 ? <div className="h-full rounded-r-[3px]" style={{ width: width(v), background: color }} /> : null;
  return (
    <div>
      <ul className="m-0 grid list-none gap-[12px] p-0">
        {rows.map((r) => (
          <li key={r.key} tabIndex={0} className="group/row relative min-w-0 rounded-[8px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--focus)]">
            <div className="mb-[5px] flex items-baseline justify-between gap-[12px]">
              <span className="min-w-0 truncate text-[13px] leading-[17px] font-semibold text-text-2">{r.label}</span>
              <span className="flex shrink-0 items-baseline gap-[10px]">
                {r.note}
                <span className="text-caption font-bold text-text">{r.text}</span>
              </span>
            </div>
            <div className="grid gap-[2px]">
              <div className="h-[6px]">{bar(r.before, OTHER_COLOR)}</div>
              <div className="h-[6px]">{bar(r.after, r.attention ? ATTENTION_COLOR : SINGLE_COLOR)}</div>
            </div>
            <RowTip at={0.3}>
              <TipHead>{r.label}</TipHead>
              <TipRow kind="box" color={OTHER_COLOR} label={before} value={r.before === null ? "—" : dec(r.before)} />
              <TipRow kind="box" color={r.attention ? ATTENTION_COLOR : SINGLE_COLOR} label={after} value={r.after === null ? "—" : dec(r.after)} />
            </RowTip>
          </li>
        ))}
      </ul>
      <SeriesLegend
        items={[
          { key: "before", label: before, color: OTHER_COLOR },
          { key: "after", label: after, color: SINGLE_COLOR },
        ]}
      />
    </div>
  );
}

/* ─────────── тепловая таблица ─────────── */

export interface HeatRow {
  key: string;
  label: ReactNode;
  /** По значению на колонку; null — ответа нет */
  cells: readonly (number | null)[];
  /** Критический пункт: ненулевой ответ в нём — красным, это риск для человека */
  critical?: boolean;
}

/**
 * Тепловая таблица ответов по пунктам (heat набора): строка — пункт,
 * колонка — замер, в каждой клетке напечатано её значение. Лестница h1…h5
 * одного фиолетового по доле от максимума, ноль — тихой подложкой, ответа
 * нет — прочерком в рамке. Ненулевой ответ критического пункта (пункт 9
 * PHQ-9) — красным: единственный красный в таблице — риск для человека.
 */
export function HeatTable({
  rows,
  columns,
  max,
  legend,
  format: formatProp,
  caption,
}: {
  rows: readonly HeatRow[];
  /** Подписи колонок: даты замеров */
  columns: readonly string[];
  /** Верх лестницы: максимальный балл пункта (3 у PHQ-9) */
  max: number;
  /** Подписи значений под таблицей: 0 «зовсім ні» … 3 «майже щодня» */
  legend?: readonly { value: number; label: string }[];
  /** Как печатать значение клетки; по умолчанию — числом с дробью языка */
  format?: (v: number) => string;
  /** Подпись таблицы для диктора */
  caption?: string;
}) {
  const dec = useDecimal();
  const format = formatProp ?? ((v: number) => dec(v));
  if (!rows.length || !columns.length) return <NoData />;
  const level = (v: number) => (v <= 0 ? 0 : Math.min(5, Math.max(1, Math.round((v / Math.max(max, 1)) * 5 + 0.49))));
  const cellCls = (v: number | null, crit: boolean) =>
    v === null
      ? "bg-transparent text-muted shadow-[inset_0_0_0_1px_var(--border)]"
      : crit && v > 0
        ? "bg-risk text-onfill"
        : level(v) === 0
          ? "bg-sunk text-muted"
          : "";
  const cellStyle = (v: number | null, crit: boolean) => {
    if (v === null || (crit && v > 0) || level(v) === 0) return undefined;
    const k = level(v);
    return { background: `var(--h${k})`, color: `var(--h${k}i)` };
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-auto border-separate border-spacing-[3px] text-small">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            <th scope="col" className="static h-auto border-0 bg-transparent p-0" />
            {columns.map((c, j) => (
              <th key={`${j}-${c}`} scope="col" className="static h-auto border-0 bg-transparent px-[4px] pt-0 pb-[4px] text-center text-[11.5px] leading-none font-bold tracking-normal whitespace-nowrap normal-case text-muted">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-transparent">
              <th
                scope="row"
                className={cx("h-auto border-0 py-0 pr-[12px] pl-0 text-left text-[13px] font-semibold whitespace-nowrap", r.critical ? "text-risk-ink" : "text-text-2")}
              >
                {r.label}
              </th>
              {columns.map((c, j) => {
                const v = r.cells[j] ?? null;
                const crit = !!r.critical && v !== null && v > 0;
                return (
                  <td key={`${j}-${c}`} className="h-auto border-0 p-0">
                    <span
                      tabIndex={0}
                      data-cell={crit ? "critical" : v === null ? "empty" : `h${level(v)}`}
                      className={cx(
                        "group/row relative grid h-[28px] min-w-[40px] cursor-default place-items-center rounded-[7px] px-[6px] text-caption font-bold outline-none hover:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)] focus-visible:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)]",
                        cellCls(v, !!r.critical),
                      )}
                      style={cellStyle(v, !!r.critical)}
                    >
                      {v === null ? "—" : format(v)}
                      <RowTip>
                        <TipHead note={c}>{r.label}</TipHead>
                        <TipRow
                          value={v === null ? "—" : format(v)}
                          label={legend?.find((l) => l.value === v)?.label}
                        />
                      </RowTip>
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {legend?.length ? (
        <ul className="m-0 mt-[10px] flex list-none flex-wrap gap-x-[14px] gap-y-[6px] p-0 text-caption font-semibold text-text-2">
          {legend.map((l) => {
            const k = level(l.value);
            return (
              <li key={l.value} className="flex items-center gap-[6px]">
                <span
                  aria-hidden
                  className={cx("grid h-[18px] min-w-[22px] place-items-center rounded-[5px] px-[4px] text-[11px] font-bold", k === 0 && "bg-sunk text-muted")}
                  style={k ? { background: `var(--h${k})`, color: `var(--h${k}i)` } : undefined}
                >
                  {format(l.value)}
                </span>
                {l.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* ─────────── легенда рядов ─────────── */

export interface SeriesKey {
  key: string;
  label: string;
  /** Цвет токеном: var(--series), var(--c2), var(--warn) */
  color: string;
  /** Линия пунктиром (TimeLines) — и в легенде образец пунктиром */
  dashed?: boolean;
}

/**
 * Легенда нескольких рядов — строкой под графиком (.lgd набора). Один ряд
 * не подписывается: его подпись — заголовок фигуры.
 */
export function SeriesLegend({ items, className, lines }: { items: readonly SeriesKey[]; className?: string; lines?: boolean }) {
  return (
    <ChartLegend
      className={className}
      items={items.map(
        (i, k): LegendItem => ({
          key: i.key,
          label: i.label,
          color: i.color,
          kind: i.dashed ? "dash" : lines ? "line" : "band",
          shape: shapeOf(i.color, k),
        }),
      )}
    />
  );
}

/* ─────────── столбцы по времени ─────────── */

export interface Column {
  key: string;
  /** Подпись под столбцом и в подсказке: «12 вер», «тиж. 38» */
  label: string;
  value: number;
  /** Подпись в подсказке, когда она длиннее подписи под столбцом: «25 вер., 14:00–15:00» */
  tip?: string;
  /** Корзина ещё идёт (неделя не кончилась): столбец светлее, чтобы его не читали как спад */
  partial?: boolean;
}

/**
 * Столбец, у которого замера может не быть: null — процесс ещё не работал,
 * история не писалась. Столбца тогда нет вовсе, а не нулевой. `hidden` —
 * число есть, но скрыто порогом малых чисел: на его месте — пустой контур.
 */
export interface GapColumn extends Omit<Column, "value"> {
  value: number | null;
  hidden?: boolean;
}

const CP = { top: 16, right: 8, bottom: 26, left: 40 };

/** Подписи под столбцами — не чаще, чем раз в 64 пикселя: иначе даты налезут друг на друга */
const tickEvery = (slot: number) => Math.max(1, Math.ceil(64 / slot));

/** Столбец со скруглением 4 px у конца данных и прямым углом у основания */
function colPath(x: number, w: number, y: number, base: number): string {
  const h = Math.max(0, base - y);
  const r = Math.min(4, h, w / 2);
  const f = (v: number) => v.toFixed(1);
  return `M${f(x)} ${f(base)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(base)}Z`;
}

/** Подсветка под курсором: остальные столбцы отступают */
const fade = (hover: number | null, i: number) => (hover === null || hover === i ? 1 : 0.5);

/**
 * Столбцы по дням или неделям: «сколько прошли».
 *
 * Счёт — столбцами, а не линией: число за день — отдельные корзины. Ось
 * всегда от нуля. Столбец не шире 24 px — остаток слота остаётся воздухом.
 * Числа на столбцах печатаются, пока их немного (`values`), остальное — в
 * подсказке.
 *
 * `tone="attention"` — столбцы янтарём: счёт того, что требует внимания.
 */
export function TimeColumns({
  columns,
  height = 200,
  label,
  tone = "plain",
  emptyTip,
  values = "auto",
  floor = 5,
}: {
  columns: readonly GapColumn[];
  height?: number;
  label: string;
  tone?: "plain" | "attention";
  /** Что сказать в подсказке у корзины без замера; без неё — прочерк */
  emptyTip?: string;
  /** Числа на столбцах: auto — пока столбцов не больше 16 и им хватает места */
  values?: "auto" | "all" | "none";
  floor?: number;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(columns.length);
  if (!columns.some((c) => c.value !== null)) return <NoData />;

  /* счёт — целыми делениями: у «0 или 1 за день» ось не идёт через 0,2 */
  const axis = axisFor({
    lo: 0,
    hi: Math.max(...columns.map((c) => c.value ?? 0), 0),
    integer: columns.every((c) => c.value === null || Number.isInteger(c.value)),
  });
  const pw = Math.max(40, W - CP.left - CP.right);
  const ph = height - CP.top - CP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(24, slot * 0.56));
  const yAt = (v: number) => CP.top + ph - (v / Math.max(axis.max, 1)) * ph;
  const xAt = (i: number) => CP.left + slot * i + slot / 2;
  const every = tickEvery(slot);
  const fill = tone === "attention" ? ATTENTION_COLOR : SINGLE_COLOR;
  const printValues = values === "all" || (values === "auto" && columns.length <= 16 && slot >= 26);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - CP.left;
    const i = Math.floor(x / slot);
    hover.setAt(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover.at === null ? null : columns[hover.at]!;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${columns[0]!.label} — ${columns.at(-1)!.label}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={CP.left} x2={W - CP.right} y1={yAt(t)} y2={yAt(t)} stroke={t === 0 ? "var(--ctl)" : "var(--grid)"} />
            <text x={CP.left - 8} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {dec(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) =>
          c.value === null ? (
            c.hidden ? (
              <rect
                key={c.key}
                data-col="hidden"
                x={(xAt(i) - bw / 2).toFixed(1)}
                y={(yAt(0) - 10).toFixed(1)}
                width={bw.toFixed(1)}
                height={10}
                rx={2}
                fill="none"
                stroke="var(--ctl)"
                strokeDasharray="2 2"
              />
            ) : null
          ) : (
            <path
              key={c.key}
              data-col={i}
              d={colPath(xAt(i) - bw / 2, bw, yAt(c.value), yAt(0))}
              fill={fill}
              fillOpacity={c.partial ? 0.45 : 1}
              opacity={fade(hover.at, i)}
            />
          ),
        )}
        {printValues
          ? columns.map((c, i) =>
              c.value === null ? null : (
                <text key={`v-${c.key}`} x={xAt(i)} y={yAt(c.value) - 6} fontSize={12} fontWeight={800} fill="var(--text)" textAnchor="middle">
                  {dec(c.value)}
                </text>
              ),
            )
          : null}
        {/* шаг считается от конца: последний столбец — «сейчас», его подпись нужнее первой */}
        {columns.map((c, i) =>
          (columns.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <ChartTip x={xAt(hover.at!)} y={at.value === null ? yAt(0) - 20 : yAt(at.value)} width={W}>
          <TipHead>{at.tip ?? at.label}</TipHead>
          {at.value === null ? (
            <p className="m-0 mt-[5px] text-muted">{at.hidden ? `${ut("kit.hidden")}, ${fillIn(ut("chart.smallCell"), { n: floor })}` : (emptyTip ?? "—")}</p>
          ) : (
            <TipRow kind="box" color={fill} value={dec(at.value)} />
          )}
        </ChartTip>
      ) : null}
    </div>
  );
}

/* ─────────── столбцы с разбивкой ─────────── */

/** Ряд столбцов: подпись и цвет токеном (порядок рядов — снизу вверх) */
export type StackSeries = SeriesKey;

export interface StackColumn {
  key: string;
  label: string;
  tip?: string;
  /** По числу на ряд, в порядке рядов снизу вверх; null — замера нет, столбца нет */
  values: readonly number[] | null;
}

/**
 * Столбцы по времени, разрезанные на части: ответы по классам, строки лога
 * по уровням.
 *
 * Части лежат в постоянном порядке снизу вверх — порядок рядов, а не
 * величин. Между частями — просвет поверхности 2 px. Ненулевая часть не
 * тоньше пикселя: одна пятисотка среди трёх тысяч запросов иначе не видна.
 */
export function StackColumns({
  series,
  columns,
  height = 200,
  label,
  total,
  emptyTip,
  format: formatProp,
}: {
  series: readonly StackSeries[];
  columns: readonly StackColumn[];
  height?: number;
  label: string;
  /** Подпись итога в подсказке: «усього» */
  total?: string;
  emptyTip?: string;
  /** Как печатать часть и итог; по умолчанию — числом с дробью языка */
  format?: (v: number) => string;
}) {
  const dec = useDecimal();
  const format = formatProp ?? ((v: number) => dec(v));
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(columns.length);
  if (!series.length || !columns.some((c) => c.values !== null)) return <NoData />;

  const sums = columns.map((c) => (c.values ? c.values.reduce((s, v) => s + Math.max(0, v), 0) : null));
  const axis = axisFor({
    lo: 0,
    hi: Math.max(0, ...sums.map((s) => s ?? 0)),
    integer: columns.every((c) => !c.values || c.values.every((v) => Number.isInteger(v))),
  });
  const pw = Math.max(40, W - CP.left - CP.right);
  const ph = height - CP.top - CP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(24, slot * 0.56));
  const hOf = (v: number) => (v > 0 ? Math.max(1, (v / axis.max) * ph) : 0);
  const yAt = (v: number) => CP.top + ph - (v / axis.max) * ph;
  const xAt = (i: number) => CP.left + slot * i + slot / 2;
  const every = tickEvery(slot);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - CP.left;
    const i = Math.floor(x / slot);
    hover.setAt(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover.at === null ? null : columns[hover.at]!;
  const atSum = hover.at === null ? null : sums[hover.at]!;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label} (${series.map((s) => s.label).join(", ")}): ${columns[0]!.label} — ${columns.at(-1)!.label}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={CP.left} x2={W - CP.right} y1={yAt(t)} y2={yAt(t)} stroke={t === 0 ? "var(--ctl)" : "var(--grid)"} />
            <text x={CP.left - 8} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {dec(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          if (!c.values) return null;
          /* вершина части считается в пикселях: минимум в пиксель у каждой ненулевой */
          let top = yAt(0);
          const cuts: number[] = [];
          const parts = series.map((s, k) => {
            const h = hOf(c.values![k] ?? 0);
            if (!h) return null;
            top -= h;
            cuts.push(top);
            return <rect key={s.key} x={(xAt(i) - bw / 2).toFixed(1)} y={top.toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} fill={s.color} />;
          });
          return (
            <g key={c.key} opacity={fade(hover.at, i)}>
              {parts}
              {/* просвет поверхности между частями, а не обводка */}
              {cuts.slice(0, -1).map((y) => (
                <line key={y} x1={xAt(i) - bw / 2} x2={xAt(i) + bw / 2} y1={y} y2={y} stroke="var(--panel)" strokeWidth={2} />
              ))}
            </g>
          );
        })}
        {columns.map((c, i) =>
          (columns.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <ChartTip x={xAt(hover.at!)} y={atSum === null ? yAt(0) - 20 : yAt(atSum)} width={W}>
          <TipHead>{at.tip ?? at.label}</TipHead>
          {at.values ? (
            <>
              {/* сверху вниз, как на картинке: нижний ряд в подсказке последний */}
              {series
                .map((s, k) => ({ s, v: at.values![k] ?? 0 }))
                .reverse()
                .map(({ s, v }) => (
                  <TipRow key={s.key} kind="box" color={s.color} label={s.label} value={format(v)} />
                ))}
              {total && atSum !== null ? <TipRow label={total} value={format(atSum)} /> : null}
            </>
          ) : (
            <p className="m-0 mt-[5px] text-muted">{emptyTip ?? "—"}</p>
          )}
        </ChartTip>
      ) : null}
      <SeriesLegend items={series} />
    </div>
  );
}

/* ─────────── линии по корзинам времени ─────────── */

export interface TimeTick {
  key: string;
  label: string;
  tip?: string;
}

export interface LineSeries extends SeriesKey {
  /** По значению на корзину; null — замера нет, и линия здесь рвётся */
  values: readonly (number | null)[];
}

/** Отметка на оси времени: выкатка, перезапуск — пунктир с подписью у верхнего края */
export interface TimeLineMark {
  /** Ключ корзины, к которой привязана отметка */
  at: string;
  label: string;
}

const LP = { top: 16, right: 12, bottom: 26, left: 48 };

/**
 * Одна или несколько величин по одним корзинам времени: p50/p95/p99, доля
 * пятисоток.
 *
 * Корзина стоит на своём месте, а её отсутствие — разрыв линии: «ноль
 * миллисекунд» нарисовал бы скорость, которой не было. Одиночная корзина
 * между пустыми — меткой, иначе её не видно. Ось от нуля.
 *
 * `threshold` — порог пунктиром с подписью; корзины выше порога отмечены
 * янтарным ромбом — ровно те, что требуют внимания. `marks` — отметки
 * событий (выкатки). У двух–четырёх рядов значения подписаны у концов линий,
 * легенда есть всегда.
 */
export function TimeLines({
  x,
  series,
  height = 200,
  label,
  format: formatProp,
  tick,
  threshold,
  marks,
}: {
  x: readonly TimeTick[];
  series: readonly LineSeries[];
  height?: number;
  label: string;
  /** Число в подсказке: «240 мс», «1,2 %»; по умолчанию — числом с дробью языка */
  format?: (v: number) => string;
  /** Число у оси; по умолчанию — как в подсказке */
  tick?: (v: number) => string;
  threshold?: { value: number; label: string };
  marks?: readonly TimeLineMark[];
}) {
  const dec = useDecimal();
  const format = formatProp ?? ((v: number) => dec(v));
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(x.length);
  const known = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (!x.length || !known.length) return <NoData />;

  const single = series.length === 1;
  const ends = series.length <= 4;
  const right = ends ? 84 : LP.right;
  const axis = axisFor({ lo: 0, hi: Math.max(0, ...known, threshold?.value ?? 0), integer: known.every((v) => Number.isInteger(v)) });
  const pw = Math.max(40, W - LP.left - right);
  const ph = height - LP.top - LP.bottom;
  const slot = pw / x.length;
  const xAt = (i: number) => LP.left + slot * i + slot / 2;
  const span = Math.max(axis.max - axis.min, Number.EPSILON);
  const yAt = (v: number) => LP.top + ph - ((v - axis.min) / span) * ph;
  const every = tickEvery(slot);
  const tickFmt = tick ?? format;
  const f1 = (v: number) => v.toFixed(1);

  /* отрезки подряд идущих известных корзин: линия идёт только внутри отрезка */
  const runsOf = (values: readonly (number | null)[]): number[][] => {
    const runs: number[][] = [];
    let run: number[] = [];
    values.forEach((v, i) => {
      if (v === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(i);
    });
    if (run.length) runs.push(run);
    return runs;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W - LP.left;
    const i = Math.floor(px / slot);
    hover.setAt(i >= 0 && i < x.length ? i : null);
  };
  const at = hover.at === null ? null : x[hover.at]!;

  /*
   * Подписи у концов: значение и имя ряда у последней известной корзины,
   * раздвинутые на строку. Подпись порога стоит в том же столбце справа —
   * внутри поля её перечёркивали бы сами ряды.
   */
  const endRows: { key: string; y: number; x: number; v: number | null; label: string }[] = ends
    ? [
        ...series
          .map((s) => {
            const i = s.values.reduce<number>((m, v, k) => (v === null ? m : k), -1);
            return i < 0 ? null : { key: s.key, y: yAt(s.values[i]!), x: xAt(i), v: s.values[i]!, label: s.label };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
        ...(threshold ? [{ key: "__threshold", y: yAt(threshold.value), x: W - right, v: null, label: threshold.label }] : []),
      ].sort((a, b) => a.y - b.y)
    : [];
  for (let k = 1; k < endRows.length; k++) if (endRows[k]!.y - endRows[k - 1]!.y < 13) endRows[k]!.y = endRows[k - 1]!.y + 13;

  return (
    <div className="relative min-w-0" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}${single ? "" : ` (${series.map((s) => s.label).join(", ")})`}: ${x[0]!.label} — ${x.at(-1)!.label}`}
        className={cx("block overflow-visible", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={LP.left} x2={W - right} y1={yAt(t)} y2={yAt(t)} stroke={t === 0 ? "var(--ctl)" : "var(--grid)"} />
            <text x={LP.left - 8} y={yAt(t) + 4} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="end">
              {tickFmt(t)}
            </text>
          </g>
        ))}

        {threshold ? (
          <g>
            <line
              x1={LP.left}
              x2={W - right}
              y1={yAt(threshold.value)}
              y2={yAt(threshold.value)}
              stroke="var(--warn)"
              strokeOpacity={0.8}
              strokeDasharray="4 3"
            />
            {ends ? null : (
              <text
                x={W - right}
                y={yAt(threshold.value) - 5}
                fontSize={11}
                fontWeight={700}
                fill="var(--warn)"
                textAnchor="end"
                stroke="var(--panel)"
                strokeWidth={4}
                strokeLinejoin="round"
                style={{ paintOrder: "stroke" }}
              >
                {threshold.label}
              </text>
            )}
          </g>
        ) : null}

        {marks?.map((m) => {
          const i = x.findIndex((t) => t.key === m.at);
          if (i < 0) return null;
          return (
            <g key={`${m.at}-${m.label}`} data-mark={m.label}>
              <line x1={xAt(i)} x2={xAt(i)} y1={LP.top - 6} y2={LP.top + ph} stroke="var(--muted)" strokeDasharray="3 3" />
              <text
                x={xAt(i) + 4}
                y={LP.top + 6}
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

        {hover.at !== null ? (
          <line x1={xAt(hover.at)} x2={xAt(hover.at)} y1={LP.top} y2={LP.top + ph} stroke="var(--vink)" strokeDasharray="2 2" />
        ) : null}

        {series.map((s, si) => {
          const shape = shapeOf(s.color, si);
          return (
            <g key={s.key} data-series={s.key}>
              {runsOf(s.values).map((run) =>
                run.length === 1 ? (
                  <g key={run[0]} data-single>
                    <Marker shape={shape} x={xAt(run[0]!)} y={yAt(s.values[run[0]!]!)} r={3.5} color={s.color} />
                  </g>
                ) : (
                  <path
                    key={run[0]}
                    data-run={run.length}
                    d={run.map((i, k) => `${k ? "L" : "M"}${f1(xAt(i))},${f1(yAt(s.values[i]!))}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeDasharray={s.dashed ? "5 4" : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ),
              )}
              {threshold
                ? s.values.map((v, i) =>
                    v !== null && v > threshold.value ? (
                      <g key={i} data-over="threshold">
                        <Marker shape="diamond" x={xAt(i)} y={yAt(v)} r={3.6} color={ATTENTION_COLOR} ringWidth={1.5} />
                      </g>
                    ) : null,
                  )
                : null}
              {hover.at !== null && s.values[hover.at] != null ? (
                <Marker shape={shape} x={xAt(hover.at)} y={yAt(s.values[hover.at]!)} r={4.5} color={s.color} />
              ) : null}
            </g>
          );
        })}

        {endRows.map((r) =>
          r.v === null ? (
            <text key={`e-${r.key}`} x={r.x + 9} y={r.y + 4} fontSize={11} fontWeight={700} fill="var(--warn)">
              {r.label}
            </text>
          ) : (
            <text key={`e-${r.key}`} x={r.x + 9} y={r.y + 4} fontSize={11} fontWeight={600} fill="var(--text-2)">
              <tspan fontWeight={800} fill="var(--text)">
                {format(r.v)}
              </tspan>
              {single ? "" : ` ${r.label}`}
            </text>
          ),
        )}

        {x.map((c, i) =>
          (x.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize={11} fontWeight={600} fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <ChartTip
          x={xAt(hover.at!)}
          y={Math.min(LP.top + ph, ...series.map((s) => (s.values[hover.at!] == null ? LP.top + ph : yAt(s.values[hover.at!]!))))}
          width={W}
        >
          <TipHead>{at.tip ?? at.label}</TipHead>
          {series.map((s) => {
            const v = s.values[hover.at!] ?? null;
            return <TipRow key={s.key} color={s.color} label={single ? undefined : s.label} value={v === null ? "—" : format(v)} />;
          })}
          {marks
            ?.filter((m) => m.at === at.key)
            .map((m) => (
              <p key={m.label} className="m-0 mt-[6px] font-bold text-text-2">
                {m.label}
              </p>
            ))}
        </ChartTip>
      ) : null}
      <SeriesLegend items={series} lines />
    </div>
  );
}

/* ─────────── крупное число ─────────── */

/**
 * Крупное число набора (big value): подпись, число 32/800 со своей
 * единицей, ход рядом с числом, которое он объясняет, и пояснение-сравнение
 * под ним. Без плитки: ни заливки, ни рамки, ни тени — набор запрещает ряды
 * плиток «число + подпись + дельта». Разделить стоящие в ряд числа
 * линией, как столбцы «Методик» в карточке пациента, — дело экрана: только
 * он знает, где кончается строка сетки.
 *
 * `tone="attention"` красит число янтарём — и только когда число само по
 * себе требует действия (просроченное, необработанные случаи).
 */
export function Kpi({
  label,
  value,
  unit,
  hint,
  spark,
  tone = "plain",
  className,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  hint?: ReactNode;
  spark?: readonly number[];
  tone?: "plain" | "attention";
  className?: string;
}) {
  return (
    <div
      data-kpi
      className={cx("flex min-w-0 flex-col gap-[6px]", className)}
    >
      <span className="text-[13px] leading-[16px] font-bold text-text-2">{label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-[8px] gap-y-[4px]">
        <span className={cx("text-stat leading-none font-extrabold", tone === "attention" ? "text-warn" : "text-text")}>
          {value === null ? "—" : value}
        </span>
        {unit && value !== null ? <span className="text-[14px] font-bold text-muted">{unit}</span> : null}
        {spark && spark.length > 1 ? <Sparkline values={spark} color={tone === "attention" ? ATTENTION_COLOR : undefined} /> : null}
      </span>
      {hint ? <span className="text-small leading-[17px] text-muted">{hint}</span> : null}
    </div>
  );
}

/**
 * Ход величины одной линией — только рядом с числом, которое он объясняет,
 * и никогда как украшение. Фиксированного размера (84 × 24 по умолчанию),
 * без растяжения: точка на последнем значении — то, что стоит числом.
 */
export function Sparkline({
  values,
  height = 24,
  width = 84,
  color = SINGLE_COLOR,
}: {
  values: readonly number[];
  height?: number;
  width?: number;
  color?: string;
}) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const X = (i: number) => 4 + ((width - 8) * i) / Math.max(1, values.length - 1);
  const Y = (v: number) => 4 + (height - 8) * (1 - (v - lo) / span);
  const last = values.length - 1;
  return (
    <svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block shrink-0 overflow-visible align-middle">
      <polyline
        points={values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <Marker x={X(last)} y={Y(values[last]!)} r={3.2} color={color} />
    </svg>
  );
}

/* ─────────── рамка фигуры ─────────── */

/**
 * Подпись над графиком внутри раздела: заголовок 13,5/800 и пояснение 12
 * приглушённым, справа — легенда или действие (как «Запити» на «Огляді»
 * техпанели). `table` добавляет переключатель «Діаграма / Таблиця»: то же
 * самое числами — для того, кто сверяет, и для диктора.
 */
export function Figure({
  title,
  caption,
  aside,
  children,
  className,
  table,
}: {
  title: ReactNode;
  caption?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  table?: TableView;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className={cx("m-0 min-w-0", className)}>
      <figcaption className="mb-[12px] flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[6px]">
        <span className="min-w-0">
          <span className="block text-body leading-[18px] font-extrabold text-text">{title}</span>
          {caption ? <span className="mt-[2px] block text-caption leading-[16px] text-muted">{caption}</span> : null}
        </span>
        {aside || table ? (
          <span className="flex items-center gap-[12px]">
            {aside}
            {table ? <ViewSwitch table={asTable} onTable={setAsTable} /> : null}
          </span>
        ) : null}
      </figcaption>
      {table && asTable ? <DataTable table={table} caption={typeof title === "string" ? title : undefined} /> : children}
    </figure>
  );
}
