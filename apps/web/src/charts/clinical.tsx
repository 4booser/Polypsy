import { useRef, useState, type ReactNode } from "react";
import type { Severity } from "@quizzy/shared";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { NoData } from "../ui/primitives";
import { useChartWidth } from "./index";
import { boundaries, ladderDomain, num, profileRuns, rungOf, segments, share, sortRungs, type Rung } from "./ladder";
import { axisFor } from "./scale";

/**
 * Клинические графики консоли в языке макета Polypsy.
 *
 * Прежние диаграммы (charts/index.tsx, advanced.tsx) писались для «Пульта»:
 * категориальная палитра, кольца, карточки. Макет говорит иначе — «графики:
 * тонкие линии primary, сетка line, подписи muted, цифры mono», тяжесть —
 * «текст и тонкие метки, без заливок». Этот файл — набор форм, собранных по
 * этой фразе, общий для прохождения, аналитики методики, сводки и
 * статистики. Одна форма на один вопрос, и один и тот же вопрос на разных
 * экранах выглядит одинаково:
 *
 *   SeverityRuler — где этот балл на лестнице полос;
 *   ScaleProfile  — то же по всем шкалам методики сразу;
 *   BandTrend     — как балл двигался по лестнице во времени;
 *   ShareBar      — из чего состоит целое (полосы, варианты ответа);
 *   HBars         — сравнение величин по строкам;
 *   PairBars      — то же «было / стало» парой полос;
 *   TimeColumns   — сколько за день/неделю;
 *   StackColumns  — то же с разбивкой столбца на части (классы ответа, уровни);
 *   TimeLines     — несколько величин по одним корзинам времени, с разрывами;
 *   Kpi, Sparkline — одно число, которое читают первым.
 *
 * Цвет. Одиночный ряд — фиолетовый действия (--primary): в макете нет
 * другого цвета для данных, и синий ряд «Пульта» (--s1) на белом листе
 * макета выглядел чужим. Тяжесть — только ступенями --sev-*, и никогда
 * цветом в одиночку: рядом подпись, у точки — форма (круг, квадрат, ромб),
 * как у SeverityTag. Клинические графики янтаря не используют вовсе — он
 * значит «требует внимания», а балл шкалы ничего не требует.
 *
 * Волна 11 (графики техпанели) добавила формы, где янтарь по делу: пятисотки,
 * упавшие проходы задач, строки уровня «помилка», «гірше» после выкатки —
 * это и есть «требует внимания». Поэтому у HBars, TimeColumns и PairBars
 * появился тон attention, а у рядов StackColumns/TimeLines цвет задаёт
 * вызывающий: несколько рядов — токены --cat-* в постоянном порядке и
 * легенда, янтарь — только ряду, который требует внимания. Слово рядом
 * обязательно и здесь: заголовок фигуры, легенда или подпись строки.
 *
 * Раскладка — HTML там, где форма прямоугольная (линейка, доли, полосы):
 * текст подписей в HTML переносится и обрезается браузером, а в SVG его
 * пришлось бы мерить наугад. SVG — там, где нужны оси (динамика, столбцы),
 * и рисуется в пикселях контейнера (useChartWidth), не растягиваясь.
 */

/* ─────────── метка тяжести: цвет + форма ─────────── */

const SEV_BG: Record<Severity, string> = {
  none: "bg-[var(--sev-none)] rounded-full",
  mild: "bg-[var(--sev-mild)] rounded-full",
  moderate: "bg-[var(--sev-moderate)]",
  severe: "bg-[var(--sev-severe)] rotate-45",
};

/** Текст подписи ступени: тот же тон, что у отрезка, в текстовой силе */
export const SEV_TEXT: Record<Severity, string> = {
  none: "text-[var(--sev-none-text)]",
  mild: "text-[var(--sev-mild-text)]",
  moderate: "text-[var(--sev-moderate-text)]",
  severe: "text-[var(--sev-severe-text)]",
};

const SEV_FILL: Record<Severity, string> = {
  none: "bg-[var(--sev-none)]",
  mild: "bg-[var(--sev-mild)]",
  moderate: "bg-[var(--sev-moderate)]",
  severe: "bg-[var(--sev-severe)]",
};

/**
 * Точка ступени. Форма повторяет SeverityTag: лёгкая и нормальная — круг,
 * умеренная — квадрат, тяжёлая — ромб. Читается без цвета — в печати и при
 * любом виде дальтонизма.
 */
export function SevDot({ severity, className }: { severity: Severity; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-[8px] shrink-0", SEV_BG[severity], className)} />;
}

/* ─────────── линейка тяжести ─────────── */

export interface RulerProps {
  rungs: readonly Rung[];
  value: number | null;
  /** Максимум шкалы — только для шкалы без лестницы: тогда рисуется метр 0…max */
  max?: number | null;
  /** lg — одна шкала крупно, с подписями ступеней; sm — строка профиля */
  size?: "lg" | "sm";
  /** Подпись над маркером; по умолчанию — само значение */
  valueLabel?: string;
  /** Подпись для диктора: «Депресія: 12 — помірна» */
  label: string;
}

/**
 * Линейка: вся лестница полос шкалы и маркер там, куда лёг балл.
 *
 * Отвечает на вопрос, который залитая ступень лестницы «від — до» (кадр f34)
 * оставляет без ответа: насколько близко к соседней ступени. «Помірна» у
 * балла 10 и у балла 14 — разные разговоры, и маркер у самого края полосы
 * видно с одного взгляда, а в строке «від 10 до 14» — нет.
 *
 * Отрезки ступеней — тонкие (8px), с просветом 2px, без обводки: это
 * ступени одной шкалы, а не разные ряды. Маркер — фиолетовая точка с
 * белым кольцом поверх отрезка: кольцо отделяет его от ступени того же тона.
 */
export function SeverityRuler({ rungs, value, max, size = "lg", valueLabel, label }: RulerProps) {
  const sorted = sortRungs(rungs);
  const d = ladderDomain(sorted, [value], max);
  const segs = segments(sorted, d);
  const at = value === null ? null : share(value, d);
  const hit = value === null ? null : rungOf(sorted, value);
  const lg = size === "lg";

  /* подпись над маркером у края не должна вылезать за колонку */
  const anchor = at === null ? "center" : at < 0.08 ? "start" : at > 0.92 ? "end" : "center";

  return (
    <div role="img" aria-label={label} className={cx("relative w-full", lg ? "pt-[24px]" : "py-[6px]")}>
      {lg && at !== null ? (
        <span
          aria-hidden
          className={cx(
            "absolute top-0 whitespace-nowrap font-mono text-[15px] font-bold leading-[18px] text-primary tabular-nums",
            anchor === "center" && "-translate-x-1/2",
            anchor === "end" && "-translate-x-full",
          )}
          style={{ left: `${(at * 100).toFixed(2)}%` }}
        >
          {valueLabel ?? num(value!)}
        </span>
      ) : null}

      <div className="relative h-[8px]">
        {segs.length ? (
          <div className="flex h-full gap-[2px]">
            {segs.map((s) => (
              <span
                key={`${s.rung.min}-${s.rung.max}`}
                className={cx(
                  "h-full first:rounded-l-[4px] last:rounded-r-[4px]",
                  SEV_FILL[s.rung.severity],
                  /* попавшая ступень — в полную силу, остальные приглушены: глаз
                     находит ответ раньше, чем читает подписи */
                  hit && s.rung !== hit && "opacity-35",
                )}
                style={{ width: `${(s.width * 100).toFixed(3)}%` }}
              />
            ))}
          </div>
        ) : (
          /* шкала без полос — метр: дорожка сетки и заливка фиолетовым до балла */
          <div className="h-full overflow-hidden rounded-[4px] bg-[var(--grid)]">
            {at !== null ? (
              <div className="h-full rounded-[4px] bg-primary" style={{ width: `${(at * 100).toFixed(2)}%` }} />
            ) : null}
          </div>
        )}
        {at !== null ? (
          <span
            aria-hidden
            className="absolute top-1/2 size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[var(--card)] bg-primary"
            style={{ left: `${(at * 100).toFixed(2)}%` }}
          />
        ) : null}
      </div>

      {lg ? (
        segs.length ? (
          <ol className="m-0 mt-[8px] flex list-none gap-[2px] p-0">
            {segs.map((s) => (
              <li
                key={`${s.rung.min}-${s.rung.max}`}
                className="min-w-0"
                style={{ width: `${(s.width * 100).toFixed(3)}%` }}
                title={`${s.rung.label} · ${num(s.rung.min)}–${num(s.rung.max)}`}
              >
                <span
                  className={cx(
                    "block truncate text-[12px] leading-[15px]",
                    SEV_TEXT[s.rung.severity],
                    s.rung === hit ? "font-bold" : "font-normal",
                  )}
                >
                  {s.rung.label}
                </span>
                <span className="block truncate font-mono text-[11px] leading-[14px] text-muted tabular-nums">
                  {num(s.rung.min)}–{num(s.rung.max)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-[6px] flex justify-between font-mono text-[11px] text-muted tabular-nums">
            <span>{num(d.lo)}</span>
            <span>{num(d.hi)}</span>
          </div>
        )
      ) : null}
    </div>
  );
}

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
 * Профиль: по строке на шкалу — название, линейка, значение и ступень.
 *
 * Строки, а не радар. Радар прежней динамики (charts/advanced.tsx) рисовал
 * шкалы в долях от максимума по кругу, и форма многоугольника зависела от
 * ПОРЯДКА шкал — переставь две, и «профиль» стал другим. У строк порядок
 * тоже есть, но он ничего не рисует: каждая линейка читается сама по себе.
 *
 * Подряд идущие шкалы с одной и той же лестницей (Т-баллы Міні-мульта,
 * стени МЛО) соединяются тонкой линией — это классический профиль,
 * повёрнутый на бок. На шкале с другой лестницей линия рвётся: соединять
 * несоизмеримое нельзя, а терять из-за одной шкалы весь профиль незачем
 * (profileRuns).
 */
export function ScaleProfile({ rows }: { rows: readonly ProfileRow[] }) {
  if (!rows.length) return <NoData />;
  const domains = rows.map((r) => ladderDomain(r.rungs, [r.value], r.max));
  const runs = profileRuns(rows.map((r, i) => ({ rungs: r.rungs, domain: domains[i]!, value: r.value })));
  const H = rows.length * ROW_H;

  return (
    <div className="grid grid-cols-[minmax(96px,220px)_minmax(0,1fr)_minmax(96px,220px)] gap-x-[24px] max-[600px]:gap-x-[12px]">
      <ul className="m-0 list-none p-0">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center border-b border-hairline" style={{ height: ROW_H }}>
            <span className="line-clamp-2 text-[15px] font-bold leading-[18px] text-primary">{r.action ?? r.title}</span>
          </li>
        ))}
      </ul>

      <div className="relative">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center border-b border-hairline" style={{ height: ROW_H }}>
            <SeverityRuler
              size="sm"
              rungs={r.rungs}
              value={r.value}
              max={r.max}
              label={`${r.title}: ${r.valueText}${r.band ? ` — ${r.band.label}` : ""}`}
            />
          </div>
        ))}
        {runs.length ? (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 100 ${H}`}
            preserveAspectRatio="none"
          >
            {runs.map((run) => (
              <polyline
                key={run[0]}
                points={run
                  .map((i) => `${(share(rows[i]!.value!, domains[i]!) * 100).toFixed(3)},${i * ROW_H + ROW_H / 2}`)
                  .join(" ")}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={1.5}
                strokeOpacity={0.55}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
        ) : null}
      </div>

      <ul className="m-0 list-none p-0">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex flex-col justify-center border-b border-hairline"
            style={{ height: ROW_H }}
          >
            <span className="font-mono text-[14px] font-bold leading-[17px] text-text tabular-nums">{r.valueText}</span>
            {r.band ? (
              <span className={cx("flex min-w-0 items-center gap-[6px] text-[12px] leading-[15px]", SEV_TEXT[r.band.severity])}>
                <SevDot severity={r.band.severity} />
                <span className="truncate">{r.band.label}</span>
              </span>
            ) : null}
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

const TP = { top: 12, right: 16, bottom: 28, left: 52 };

/**
 * Динамика шкалы на фоне лестницы полос.
 *
 * Ось Y здесь — ВСЯ лестница, и это отступление от правила charts/scale.ts
 * («ось по данным, а не по теории») сделано сознательно. То правило
 * написано против пустого поля над прижатой к низу линией, когда на оси
 * ничего, кроме линии, нет. Здесь на оси есть содержание — ступени, и
 * вопрос графика не «насколько изменилось», а «в какую ступень пришло»:
 * срезать низ значило бы убрать с глаз ту ступень, куда человек, возможно,
 * вернулся. Без лестницы ось подгоняется обычным axisFor.
 *
 * Слева по оси — полоса ступеней теми же тонами, что у линейки; границы —
 * пунктир (это пороги, и пунктир здесь по делу), подписаны началом верхней
 * ступени — «5», «10», а не 4,5: так они напечатаны в методике.
 *
 * Полоса вокруг линии — ошибка измерения (SEM), только когда она известна:
 * придуманный интервал выглядит как знание.
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
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

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
    ticks = [];
  } else {
    const axis = axisFor({ lo: Math.min(...withErr), hi: Math.max(...withErr), atom: err });
    lo = axis.min;
    hi = axis.max;
    ticks = axis.ticks;
  }
  const span = Math.max(hi - lo, Number.EPSILON);

  const pw = Math.max(40, W - TP.left - TP.right);
  const ph = height - TP.top - TP.bottom;
  const t0 = Math.min(...points.map((p) => p.t));
  const t1 = Math.max(...points.map((p) => p.t));
  const xAt = (t: number) => TP.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * pw : pw / 2);
  const yAt = (v: number) => TP.top + ph - ((v - lo) / span) * ph;

  const cuts = boundaries(sorted);
  const line = points.map((p, i) => `${i ? "L" : "M"}${xAt(p.t).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(" ");
  const band =
    err > 0 && points.length > 1
      ? [
          ...points.map((p, i) => `${i ? "L" : "M"}${xAt(p.t).toFixed(1)},${yAt(p.value + err).toFixed(1)}`),
          ...[...points].reverse().map((p) => `L${xAt(p.t).toFixed(1)},${yAt(p.value - err).toFixed(1)}`),
          "Z",
        ].join(" ")
      : null;

  /* подписи дат: все, если помещаются, иначе края — две даты не налезут никогда */
  const roomy = points.length <= 8 && pw / points.length > 72;
  const xLabels = roomy ? points : [points[0]!, points.at(-1)!].filter((p, i, a) => a.indexOf(p) === i);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(xAt(points[i]!.t) - x) < Math.abs(xAt(points[best]!.t) - x)) best = i;
    }
    setHover(best);
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
        aria-label={`${label}: ${points[0]!.label} — ${points.at(-1)!.label}, ${points.length}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* полоса ступеней вдоль оси и зоны под полем — очень тихо */}
        {sorted.map((r, i) => {
          const from = i === 0 ? lo : cuts[i - 1]!;
          const to = i === sorted.length - 1 ? hi : cuts[i]!;
          const y0 = yAt(to);
          const y1 = yAt(from);
          return (
            <g key={`${r.min}-${r.max}`}>
              <rect
                x={TP.left - 8}
                y={y0 + 1}
                width={4}
                height={Math.max(1, y1 - y0 - 2)}
                rx={2}
                fill={`var(--sev-${r.severity})`}
              />
              {y1 - y0 >= 18 && pw > 280 ? (
                <text x={TP.left + 6} y={y0 + 13} fontSize="10" fill={`var(--sev-${r.severity}-text)`}>
                  {r.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* сетка без лестницы — сплошной волосяной линией, как везде */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={TP.left} x2={W - TP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={TP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}

        {/* пороги ступеней: пунктир, подпись — начало верхней ступени */}
        {cuts.map((c, i) => (
          <g key={c}>
            <line
              x1={TP.left}
              x2={W - TP.right}
              y1={yAt(c)}
              y2={yAt(c)}
              stroke="var(--axis)"
              strokeOpacity={0.5}
              strokeDasharray="3 4"
            />
            <text x={TP.left - 14} y={yAt(c) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(sorted[i + 1]!.min)}
            </text>
          </g>
        ))}
        {sorted.length ? (
          <>
            <text x={TP.left - 14} y={yAt(lo) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(lo)}
            </text>
            <text x={TP.left - 14} y={yAt(hi) + 8} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(hi)}
            </text>
          </>
        ) : null}

        <line x1={TP.left} x2={W - TP.right} y1={yAt(lo)} y2={yAt(lo)} stroke="var(--grid)" />

        {at ? (
          <line x1={xAt(at.t)} x2={xAt(at.t)} y1={TP.top} y2={TP.top + ph} stroke="var(--primary)" strokeOpacity={0.4} />
        ) : null}

        {band ? <path d={band} fill="var(--primary)" fillOpacity={0.12} /> : null}
        {points.length > 1 ? <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} /> : null}

        {points.map((p) => (
          <circle
            key={p.key}
            cx={xAt(p.t)}
            cy={yAt(p.value)}
            r={p.focus ? 6 : 4}
            fill={p.focus ? "var(--card)" : "var(--primary)"}
            stroke={p.focus ? "var(--primary)" : "var(--card)"}
            strokeWidth={p.focus ? 3 : 2}
          />
        ))}

        {xLabels.map((p, i) => (
          <text
            key={p.key}
            x={xAt(p.t)}
            y={height - 8}
            fontSize="11"
            fill="var(--axis)"
            textAnchor={
              xLabels.length === 1 ? "middle" : !roomy && i === 0 ? "start" : !roomy ? "end" : "middle"
            }
          >
            {p.label}
          </text>
        ))}
      </svg>

      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(at.t) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.label}</span>
          <span className="chart-tip-row">
            <b>{num(at.value)}</b>
            {at.band ? (
              <span className={cx("flex items-center gap-[5px]", SEV_TEXT[at.band.severity])}>
                <SevDot severity={at.band.severity} />
                {at.band.label}
              </span>
            ) : null}
          </span>
          {at.focus ? <span className="text-[11px] text-muted">{ut("kit.thisOne")}</span> : null}
        </div>
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
   * «майже щодня». Цвет — фиолетовый от светлого к тёмному: одна величина,
   * один тон, порядок читается светлотой.
   */
  step?: number;
  /**
   * Свой цвет части — токеном. Для частей другой природы, чем остальные:
   * «вільно» рядом с занятыми подключениями — дорожка сетки, а не ещё одна
   * ступень фиолетового (иначе свободное читалось бы как ещё одно состояние).
   */
  color?: string;
}

function partColor(p: SharePart): string {
  if (p.color) return p.color;
  if (p.severity) return `var(--sev-${p.severity})`;
  const k = Math.round(28 + (p.step ?? 1) * 72);
  return `color-mix(in srgb, var(--primary) ${k}%, var(--card))`;
}

/**
 * Полоса долей: одно целое, разрезанное на части, с легендой под ним.
 *
 * Вместо кольца. Кольцо прежней аналитики (Donut) занимало четверть экрана
 * ради пяти чисел и хуже всего читало ровно то, ради чего его смотрят, —
 * сравнение соседних долей. Полоса в строку читается слева направо в том
 * порядке, в каком идут ступени, и таких полос можно поставить десять одну
 * под другой — у колец это уже мозаика.
 *
 * Скрытая ячейка в полосу не входит вовсе: ширина отрезка — тоже число, и
 * нарисовать её значило бы напечатать скрытое. В легенде она стоит
 * прочерком с подписью для диктора.
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
  const { ut } = useLang();
  const shown = parts.filter((p) => p.value !== null && p.value > 0);
  const total = shown.reduce((s, p) => s + (p.value ?? 0), 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value === null ? "—" : format(p.value)}`).join(", ")}`}
        className="flex h-[10px] gap-[2px]"
      >
        {total > 0 ? (
          shown.map((p) => (
            <span
              key={p.key}
              title={`${p.label}: ${format(p.value!)}${percent ? ` (${pct(p.value!)}%)` : ""}`}
              className="h-full min-w-[2px] first:rounded-l-[4px] last:rounded-r-[4px]"
              style={{ width: `${((p.value! / total) * 100).toFixed(3)}%`, background: partColor(p) }}
            />
          ))
        ) : (
          <span className="h-full w-full rounded-[4px] bg-[var(--grid)]" />
        )}
      </div>
      {legend ? (
        <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]">
          {parts.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-[6px]">
              {p.severity ? (
                <SevDot severity={p.severity} />
              ) : (
                <span aria-hidden className="inline-block size-[8px] shrink-0 rounded-[2px]" style={{ background: partColor(p) }} />
              )}
              <span className={cx("truncate", p.severity ? SEV_TEXT[p.severity] : "text-text-2")}>{p.label}</span>
              {p.value === null ? (
                <span className="font-mono text-muted">
                  —<span className="sr-only"> {ut("kit.hidden")}</span>
                </span>
              ) : (
                <span className="font-mono text-muted tabular-nums">
                  {format(p.value)}
                  {percent && total > 0 && p.value > 0 ? ` · ${pct(p.value)}%` : ""}
                </span>
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
  /** Строка, на которую стоит обратить взгляд (выше порога, выше медианы) */
  strong?: boolean;
  /**
   * Величина, которая требует внимания (пятисотки, сбои задач): полоса
   * янтарём в полную силу. Что именно считается, говорит заголовок фигуры.
   */
  attention?: boolean;
}

/**
 * Сравнение величин строками: подпись, число справа, тонкая полоса под ними.
 *
 * Полоса от нуля и до общего максимума строк (или заданного `max`): у
 * длины полосы нет другого нуля, и срезанная полоса врала бы о пропорциях.
 * Скрытое значение — прочерк без полосы, по тому же правилу, что в ShareBar.
 */
export function HBars({ items, max, unit = "" }: { items: readonly HBar[]; max?: number; unit?: string }) {
  const { ut } = useLang();
  if (!items.length) return <NoData />;
  const top = max ?? Math.max(...items.map((i) => i.value ?? 0), 0);
  return (
    <ul className="m-0 grid list-none gap-[10px] p-0">
      {items.map((i) => (
        <li key={i.key} className="min-w-0">
          <div className="mb-[4px] flex items-baseline justify-between gap-[12px]">
            <span className={cx("min-w-0 truncate text-[13px] leading-[17px]", i.strong ? "font-bold text-text" : "text-text-2")}>
              {i.label}
            </span>
            <span className="shrink-0 font-mono text-[12px] text-muted tabular-nums">
              {i.value === null ? (
                <>
                  —<span className="sr-only"> {ut("kit.hidden")}</span>
                </>
              ) : (
                (i.text ?? `${num(i.value)}${unit}`)
              )}
            </span>
          </div>
          <div className="h-[6px] rounded-[3px] bg-[var(--grid-fine)]">
            {i.value !== null && top > 0 ? (
              <div
                className={cx(
                  "h-full rounded-[3px]",
                  i.severity ? SEV_FILL[i.severity] : i.attention ? "bg-accent" : "bg-primary",
                  !i.strong && !i.severity && !i.attention && "opacity-70",
                )}
                style={{ width: `${Math.max(1.5, Math.min(100, (i.value / top) * 100)).toFixed(2)}%` }}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
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

const BEFORE_COLOR = "color-mix(in srgb, var(--primary) 35%, var(--card))";

/**
 * Пара полос на строку: «було» светлой, «стало» полной — от общего нуля.
 *
 * Вместо знаковых столбиков изменения (advanced.tsx, DivergingBar): «+200 мс»
 * у маршрута с p95 в 40 мс и у маршрута с p95 в 3 секунды — разные истории,
 * а полоса разницы рисует их одинаково. Пара показывает обе величины, и
 * разница читается длиной, не теряя масштаба.
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
  if (!rows.length) return <NoData />;
  const top = max ?? Math.max(0, ...rows.flatMap((r) => [r.before ?? 0, r.after ?? 0]));
  const width = (v: number) => `${Math.max(1.5, Math.min(100, (v / top) * 100)).toFixed(2)}%`;
  const bar = (v: number | null, color: string) =>
    v !== null && v > 0 && top > 0 ? <div className="h-full rounded-[2px]" style={{ width: width(v), background: color }} /> : null;
  return (
    <div>
      <ul className="m-0 grid list-none gap-[12px] p-0">
        {rows.map((r) => (
          <li key={r.key} className="min-w-0">
            <div className="mb-[4px] flex items-baseline justify-between gap-[12px]">
              <span className="min-w-0 truncate text-[13px] leading-[17px] text-text-2">{r.label}</span>
              <span className="flex shrink-0 items-baseline gap-[10px]">
                {r.note}
                <span className="font-mono text-[12px] text-muted tabular-nums">{r.text}</span>
              </span>
            </div>
            <div className="grid gap-[2px]">
              <div className="h-[4px] rounded-[2px] bg-[var(--grid-fine)]">{bar(r.before, BEFORE_COLOR)}</div>
              <div className="h-[4px] rounded-[2px] bg-[var(--grid-fine)]">
                {bar(r.after, r.attention ? "var(--accent)" : "var(--primary)")}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <SeriesLegend
        items={[
          { key: "before", label: before, color: BEFORE_COLOR },
          { key: "after", label: after, color: "var(--primary)" },
        ]}
      />
    </div>
  );
}

/* ─────────── легенда рядов ─────────── */

export interface SeriesKey {
  key: string;
  label: string;
  /** Цвет токеном: var(--primary), var(--cat-1), var(--accent) */
  color: string;
}

/**
 * Легенда нескольких рядов — HTML-строкой под графиком, как у ShareBar.
 * Прежняя Legend (charts/index.tsx) держится на классах наследия (.legend,
 * .dot); эта — на утилитах. Один ряд не подписывается: его подпись —
 * заголовок фигуры.
 */
export function SeriesLegend({ items, className }: { items: readonly SeriesKey[]; className?: string }) {
  if (items.length < 2) return null;
  return (
    <ul className={cx("m-0 mt-[10px] flex list-none flex-wrap gap-x-[18px] gap-y-[4px] p-0 text-[13px] leading-[18px]", className)}>
      {items.map((i) => (
        <li key={i.key} className="flex min-w-0 items-center gap-[6px]">
          <span aria-hidden className="inline-block size-[8px] shrink-0 rounded-[2px]" style={{ background: i.color }} />
          <span className="truncate text-text-2">{i.label}</span>
        </li>
      ))}
    </ul>
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
}

/**
 * Столбец, у которого замера может не быть: null — процесс ещё не работал,
 * история не писалась. Столбца тогда нет вовсе, а не нулевой: ноль — это
 * «ничего не было», и он честный, а «не знаем» нулём не рисуется. Отдельным
 * типом, а не `value: number | null` у Column: у рядов по дням из базы
 * пропусков не бывает, и их потребителям незачем проверять null.
 */
export interface GapColumn extends Omit<Column, "value"> {
  value: number | null;
}

const CP = { top: 12, right: 8, bottom: 26, left: 40 };

/** Подписи под столбцами — не чаще, чем раз в 64 пикселя: иначе даты налезут друг на друга */
const tickEvery = (slot: number) => Math.max(1, Math.ceil(64 / slot));

/**
 * Столбцы по дням или неделям: «сколько прошли».
 *
 * Счёт — столбцами, а не линией с заливкой: число прохождений за день — это
 * отдельные корзины, и линия между ними рисовала бы промежуточные значения,
 * которых не было. Ось всегда от нуля — у столбца другой высоты нет.
 *
 * `tone="attention"` — столбцы янтарём: счёт того, что требует внимания
 * (случаи ошибок, упавшие проходы). Тон задаёт смысл всей фигуры, а не
 * отдельного столбца: «вот этот день плохой» говорит высота, а не цвет.
 */
export function TimeColumns({
  columns,
  height = 200,
  label,
  tone = "plain",
  emptyTip,
}: {
  columns: readonly GapColumn[];
  height?: number;
  label: string;
  tone?: "plain" | "attention";
  /** Что сказать в подсказке у корзины без замера; без неё — прочерк */
  emptyTip?: string;
}) {
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!columns.some((c) => c.value !== null)) return <NoData />;

  const axis = axisFor({ lo: 0, hi: Math.max(...columns.map((c) => c.value ?? 0), 0) });
  const pw = Math.max(40, W - CP.left - CP.right);
  const ph = height - CP.top - CP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const yAt = (v: number) => CP.top + ph - (v / Math.max(axis.max, 1)) * ph;
  const xAt = (i: number) => CP.left + slot * i + slot / 2;
  const every = tickEvery(slot);
  const fill = tone === "attention" ? "var(--accent)" : "var(--primary)";

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - CP.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover === null ? null : columns[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}: ${columns[0]!.label} — ${columns.at(-1)!.label}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={CP.left} x2={W - CP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={CP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) =>
          c.value === null ? null : (
            <rect
              key={c.key}
              x={xAt(i) - bw / 2}
              y={yAt(c.value)}
              width={bw}
              height={Math.max(0, yAt(0) - yAt(c.value))}
              rx={2}
              fill={fill}
              fillOpacity={hover === null || hover === i ? 0.85 : 0.4}
            />
          ),
        )}
        {/* шаг считается от конца: последний столбец — «сейчас», его подпись нужнее первой */}
        {columns.map((c, i) =>
          (columns.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.tip ?? at.label}</span>
          <span className="chart-tip-row">
            {at.value === null ? <span className="text-muted">{emptyTip ?? "—"}</span> : <b>{num(at.value)}</b>}
          </span>
        </div>
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
 * величин: переставь их по размеру, и одна и та же часть оказывалась бы то
 * внизу, то посередине, и «стало ли 5xx больше» пришлось бы искать глазами.
 * Ненулевая часть не тоньше пикселя: одна пятисотка среди трёх тысяч
 * запросов иначе не видна вовсе, а ради неё график и смотрят. Сдвиг вершины
 * на пиксель — цена, которую подсказка возвращает числом.
 */
export function StackColumns({
  series,
  columns,
  height = 200,
  label,
  total,
  emptyTip,
  format = num,
}: {
  series: readonly StackSeries[];
  columns: readonly StackColumn[];
  height?: number;
  label: string;
  /** Подпись итога в подсказке: «усього» */
  total?: string;
  emptyTip?: string;
  format?: (v: number) => string;
}) {
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (!series.length || !columns.some((c) => c.values !== null)) return <NoData />;

  const sums = columns.map((c) => (c.values ? c.values.reduce((s, v) => s + Math.max(0, v), 0) : null));
  const axis = axisFor({ lo: 0, hi: Math.max(0, ...sums.map((s) => s ?? 0)) });
  const pw = Math.max(40, W - CP.left - CP.right);
  const ph = height - CP.top - CP.bottom;
  const slot = pw / columns.length;
  const bw = Math.max(2, Math.min(28, slot * 0.62));
  const hOf = (v: number) => (v > 0 ? Math.max(1, (v / axis.max) * ph) : 0);
  const yAt = (v: number) => CP.top + ph - (v / axis.max) * ph;
  const xAt = (i: number) => CP.left + slot * i + slot / 2;
  const every = tickEvery(slot);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = ((e.clientX - box.left) / box.width) * W - CP.left;
    const i = Math.floor(x / slot);
    setHover(i >= 0 && i < columns.length ? i : null);
  };
  const at = hover === null ? null : columns[hover]!;
  const atSum = hover === null ? null : sums[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label} (${series.map((s) => s.label).join(", ")}): ${columns[0]!.label} — ${columns.at(-1)!.label}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={CP.left} x2={W - CP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={CP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {num(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          if (!c.values) return null;
          /* вершина части считается в пикселях: минимум в пиксель у каждой ненулевой */
          let top = yAt(0);
          return (
            <g key={c.key} opacity={hover === null || hover === i ? 0.9 : 0.45}>
              {series.map((s, k) => {
                const h = hOf(c.values![k] ?? 0);
                if (!h) return null;
                top -= h;
                return <rect key={s.key} x={xAt(i) - bw / 2} y={top} width={bw} height={h} fill={s.color} />;
              })}
            </g>
          );
        })}
        {columns.map((c, i) =>
          (columns.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.tip ?? at.label}</span>
          {at.values ? (
            <>
              {/* сверху вниз, как на картинке: нижний ряд в подсказке последний */}
              {series
                .map((s, k) => ({ s, v: at.values![k] ?? 0 }))
                .reverse()
                .map(({ s, v }) => (
                  <span key={s.key} className="chart-tip-row">
                    <i style={{ background: s.color }} />
                    <span className="grow">{s.label}</span>
                    <b>{format(v)}</b>
                  </span>
                ))}
              {total && atSum !== null ? (
                <span className="chart-tip-row">
                  <span className="grow">{total}</span>
                  <b>{format(atSum)}</b>
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">{emptyTip ?? "—"}</span>
          )}
        </div>
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

const LP = { top: 12, right: 12, bottom: 26, left: 48 };

/**
 * Одна или несколько величин по одним корзинам времени: p50/p95/p99, доля
 * пятисоток.
 *
 * Отдельно от LineChart (charts/index.tsx), потому что там ось X — номер
 * точки, а пропусков нет: пустую минуту приходилось выбрасывать, и тихий
 * час сжимался до одной точки рядом с нагруженным. Здесь корзина стоит на
 * своём месте, а её отсутствие — разрыв линии: «ноль миллисекунд» нарисовал
 * бы скорость, которой не было. Одиночная корзина между пустыми — точкой,
 * иначе её не видно вовсе.
 *
 * Корзины — те же слоты, что у TimeColumns: линия рядом со столбцами той же
 * нагрузки стоит точно над своими столбцами.
 *
 * Ось от нуля: время ответа и доля — величины, у которых ноль осмысленен,
 * и полоса «от 180 до 210 мс» на срезанной оси выглядела бы обвалом.
 *
 * `threshold` — порог пунктиром (это порог, и пунктир здесь по делу, как у
 * ступеней BandTrend) с подписью; значения выше порога отмечены янтарной
 * точкой — ровно те корзины, которые требуют внимания. Ось всегда включает
 * порог: «насколько далеко до него» — половина ответа.
 */
export function TimeLines({
  x,
  series,
  height = 200,
  label,
  format = num,
  tick,
  threshold,
}: {
  x: readonly TimeTick[];
  series: readonly LineSeries[];
  height?: number;
  label: string;
  /** Число в подсказке: «240 мс», «1,2 %» */
  format?: (v: number) => string;
  /** Число у оси; по умолчанию — как в подсказке */
  tick?: (v: number) => string;
  threshold?: { value: number; label: string };
}) {
  const [W, boxRef] = useChartWidth();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const known = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (!x.length || !known.length) return <NoData />;

  const axis = axisFor({ lo: 0, hi: Math.max(0, ...known, threshold?.value ?? 0) });
  const pw = Math.max(40, W - LP.left - LP.right);
  const ph = height - LP.top - LP.bottom;
  const slot = pw / x.length;
  const xAt = (i: number) => LP.left + slot * i + slot / 2;
  const span = Math.max(axis.max - axis.min, Number.EPSILON);
  const yAt = (v: number) => LP.top + ph - ((v - axis.min) / span) * ph;
  const every = tickEvery(slot);
  const tickFmt = tick ?? format;
  const single = series.length === 1;

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
    setHover(i >= 0 && i < x.length ? i : null);
  };
  const at = hover === null ? null : x[hover]!;

  return (
    <div className="chart-wrap" ref={boxRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${label}${single ? "" : ` (${series.map((s) => s.label).join(", ")})`}: ${x[0]!.label} — ${x.at(-1)!.label}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={LP.left} x2={W - LP.right} y1={yAt(t)} y2={yAt(t)} stroke="var(--grid)" />
            <text x={LP.left - 8} y={yAt(t) + 4} fontSize="11" fill="var(--axis)" textAnchor="end" fontFamily="var(--font-mono)">
              {tickFmt(t)}
            </text>
          </g>
        ))}

        {threshold ? (
          <g>
            <line
              x1={LP.left}
              x2={W - LP.right}
              y1={yAt(threshold.value)}
              y2={yAt(threshold.value)}
              stroke="var(--axis)"
              strokeOpacity={0.6}
              strokeDasharray="3 4"
            />
            <text x={W - LP.right} y={yAt(threshold.value) - 4} fontSize="10" fill="var(--axis)" textAnchor="end">
              {threshold.label}
            </text>
          </g>
        ) : null}

        {hover !== null ? (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={LP.top} y2={LP.top + ph} stroke="var(--primary)" strokeOpacity={0.4} />
        ) : null}

        {series.map((s) => (
          <g key={s.key}>
            {runsOf(s.values).map((run) =>
              run.length === 1 ? (
                <circle key={run[0]} cx={xAt(run[0]!)} cy={yAt(s.values[run[0]!]!)} r={2.5} fill={s.color} />
              ) : (
                <path
                  key={run[0]}
                  d={run.map((i, k) => `${k ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(s.values[i]!).toFixed(1)}`).join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              ),
            )}
            {threshold
              ? s.values.map((v, i) =>
                  v !== null && v > threshold.value ? (
                    <circle key={i} cx={xAt(i)} cy={yAt(v)} r={3.5} fill="var(--accent)" stroke="var(--card)" strokeWidth={1.5} />
                  ) : null,
                )
              : null}
            {hover !== null && s.values[hover] != null ? (
              <circle cx={xAt(hover)} cy={yAt(s.values[hover]!)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />
            ) : null}
          </g>
        ))}

        {x.map((c, i) =>
          (x.length - 1 - i) % every === 0 ? (
            <text key={c.key} x={xAt(i)} y={height - 8} fontSize="11" fill="var(--axis)" textAnchor="middle">
              {c.label}
            </text>
          ) : null,
        )}
      </svg>
      {at ? (
        <div className="chart-tip" style={{ left: `${((xAt(hover!) / W) * 100).toFixed(2)}%` }} role="status">
          <span className="chart-tip-x">{at.tip ?? at.label}</span>
          {series.map((s) => {
            const v = s.values[hover!] ?? null;
            return (
              <span key={s.key} className="chart-tip-row">
                <i style={{ background: s.color }} />
                {single ? null : <span className="grow">{s.label}</span>}
                {v === null ? <span className="text-muted">—</span> : <b>{format(v)}</b>}
              </span>
            );
          })}
        </div>
      ) : null}
      <SeriesLegend items={series} />
    </div>
  );
}

/* ─────────── плитка числа ─────────── */

/**
 * Плитка: подпись, число, пояснение и — если есть — маленький ход во
 * времени. Заливка — сиреневая плашка макета (как поля-readout), без рамки и
 * тени: плитка показывает состояние, а не приглашает нажать.
 *
 * `tone="attention"` красит число янтарём — и только когда число само по
 * себе требует действия (просроченное, необработанные случаи). Прирост
 * прохождений вниманием не является, сколько бы он ни был велик.
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
    <div className={cx("flex min-w-0 flex-col gap-[6px] rounded-[5px] bg-primary-soft px-[16px] py-[14px]", className)}>
      <span className="text-[13px] font-bold leading-[16px] text-muted">{label}</span>
      <span
        className={cx(
          "font-mono text-[30px] leading-[34px]",
          tone === "attention" ? "text-accent" : "text-primary",
        )}
      >
        {value === null ? "—" : value}
        {unit && value !== null ? <span className="ml-[6px] text-[15px] text-muted">{unit}</span> : null}
      </span>
      {spark && spark.length > 1 ? <Sparkline values={spark} /> : null}
      {hint ? <span className="text-[13px] leading-[17px] text-muted">{hint}</span> : null}
    </div>
  );
}

/**
 * Ход величины одной линией, без осей и подписей — дополнение к числу, а не
 * самостоятельный график. Точка на последнем значении — то, что стоит в
 * плитке числом.
 */
export function Sparkline({ values, height = 28 }: { values: readonly number[]; height?: number }) {
  const W = 100;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [
    (i / Math.max(1, values.length - 1)) * W,
    height - 3 - ((v - lo) / span) * (height - 6),
  ]);
  const last = pts.at(-1)!;
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block h-[28px] w-full">
      <polyline
        points={pts.map(([x, y]) => `${x!.toFixed(2)},${y!.toFixed(2)}`).join(" ")}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--primary)" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ─────────── рамка фигуры ─────────── */

/**
 * Подпись над графиком внутри раздела: заголовок 15/700 и пояснение 13
 * серым. Раздел (RuleSection) держит линию и заголовок 20/700; фигура внутри
 * него — на ступень тише, иначе на экране из шести графиков было бы шесть
 * заголовков раздела.
 */
export function Figure({
  title,
  caption,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  caption?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cx("m-0 min-w-0", className)}>
      <figcaption className="mb-[12px] flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
        <span className="min-w-0">
          <span className="block text-[15px] font-bold leading-[19px] text-primary">{title}</span>
          {caption ? <span className="block text-[13px] leading-[17px] text-muted">{caption}</span> : null}
        </span>
        {aside}
      </figcaption>
      {children}
    </figure>
  );
}
