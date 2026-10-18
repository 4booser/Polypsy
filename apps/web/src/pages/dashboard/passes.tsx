import { useRef, useState } from "react";
import type { OverviewAnalytics } from "@quizzy/shared";
import { useChartWidth } from "../../charts/index";
import { ChartLegend, ChartTip, FOCUSABLE, OTHER_COLOR, TipHead, TipRow, TipText, useIndexHover } from "../../charts/kit";
import { axisFor } from "../../charts/scale";
import { day, locale } from "../../format";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { NoData, Segmented } from "../../ui/primitives";
import { useLang } from "../../lang";
import { Di } from "../today/icons";
import { fill, localDay, passColumns, passSummary, type PassColumn, type PassRange } from "./model";

/**
 * «Проходження за останній час» — завершённые прохождения столбцами.
 *
 * По дням будни — фиолетовым, выходные — нейтральным «прочим» (c5): ритм
 * недели виден сразу, и спад в субботу не читается как спад. Пунктир —
 * средний день (неделя) предыдущего такого же окна; сегодняшний столбец
 * подписан числом. Над графиком — сводка словами: итог окна рядом с
 * предыдущим, средний будний день, сегодня рядом с тем же днём неделю назад.
 */

const PAD = { top: 18, right: 8, bottom: 28, left: 30 };

const num = (v: number, digits = 1) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(v);

function PassBars({ columns, mean, weekly, label }: { columns: PassColumn[]; mean: number | null; weekly: boolean; label: string }) {
  const { ut } = useLang();
  const [W, box] = useChartWidth();
  const svg = useRef<SVGSVGElement>(null);
  const hover = useIndexHover(columns.length);
  const H = 250;
  /* не меньше пяти: на пустом окне деления 0,2 … 1 печатались бы одинаковыми «0» и «1» */
  const axis = axisFor({ lo: 0, hi: Math.max(5, mean ?? 0, ...columns.map((c) => c.value)) });
  const pw = Math.max(40, W - PAD.left - PAD.right);
  const ph = H - PAD.top - PAD.bottom;
  const slot = pw / Math.max(1, columns.length);
  const bw = Math.max(2, Math.min(24, slot * 0.62));
  const y = (v: number) => PAD.top + ph * (1 - v / Math.max(axis.max, 1));
  const base = PAD.top + ph;
  const every = weekly ? 1 : columns.length > 40 ? 14 : 7;
  const at = hover.at;
  const tip = at === null ? null : columns[at];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.floor((((e.clientX - r.left) / r.width) * W - PAD.left) / slot);
    hover.setAt(i >= 0 && i < columns.length ? i : null);
  };

  return (
    <div ref={box} className="relative">
      <svg
        ref={svg}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        className={cx("block", FOCUSABLE)}
        onMouseMove={onMove}
        {...hover.focusProps}
      >
        {axis.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + pw} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--ctl)" : "var(--divider)"} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-muted text-micro font-semibold tabular-nums">
              {num(t, 0)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const x = PAD.left + slot * i + (slot - bw) / 2;
          const top = y(c.value);
          const h = Math.max(0, base - top);
          const r = Math.min(3, h, bw / 2);
          const fillColor = c.current ? "var(--v)" : c.weekend ? OTHER_COLOR : "var(--series)";
          const showLabel = (columns.length - 1 - i) % every === 0;
          return (
            <g key={c.key} opacity={at === null || at === i ? 1 : 0.55}>
              {h > 0 ? (
                <path
                  d={`M${x} ${base}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + bw - r}Q${x + bw} ${top} ${x + bw} ${top + r}V${base}Z`}
                  fill={fillColor}
                  fillOpacity={c.partial ? 0.55 : 1}
                />
              ) : null}
              {c.current && c.value > 0 ? (
                <text x={x + bw / 2} y={top - 6} textAnchor="middle" className="fill-text text-caption font-extrabold tabular-nums">
                  {c.value}
                </text>
              ) : null}
              {showLabel ? (
                <text
                  x={x + bw / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className={cx("text-micro tabular-nums", c.current ? "fill-text font-extrabold" : "fill-muted font-semibold")}
                >
                  {c.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {mean !== null ? (
          <line
            x1={PAD.left}
            x2={PAD.left + pw}
            y1={y(mean)}
            y2={y(mean)}
            stroke="var(--text-2)"
            strokeWidth={1.4}
            strokeDasharray="5 4"
          />
        ) : null}
      </svg>
      {tip && at !== null ? (
        <ChartTip x={PAD.left + slot * at + slot / 2} y={y(tip.value)} width={W}>
          <TipHead note={tip.weekend ? ut("dashA.weekend") : weekly ? undefined : ut("dashA.weekday")}>
            {weekly ? fill(ut("dashA.weekOf"), { d: tip.label }) : tip.label}
          </TipHead>
          <TipRow kind="box" color={tip.current ? "var(--v)" : tip.weekend ? OTHER_COLOR : "var(--series)"} label={ut("dashA.passesWord")} value={tip.value} />
          {tip.partial ? <TipText muted>{ut("dashA.weekGoing")}</TipText> : null}
        </ChartTip>
      ) : null}
    </div>
  );
}

export function PassesWidget({ overview }: { overview: OverviewAnalytics }) {
  const { ut } = useLang();
  const [range, setRange] = useState<PassRange>("30d");
  const today = localDay(new Date());
  const weekly = range === "12w";
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 84;
  const { columns, mean } = passColumns(overview.timeline, range, today, day);
  const sum = passSummary(overview.timeline, days, today);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  return (
    <Panel
      title={ut("dash.passes")}
      icon={<Di.columns />}
      sub={weekly ? ut("dashA.passesWeekly") : ut("dashA.passesDaily")}
      actions={
        <Segmented
          label={ut("dash.rangeLabel")}
          value={range}
          onChange={setRange}
          items={[
            { key: "30d", label: ut("dash.range30d") },
            { key: "90d", label: ut("dash.range90d") },
            { key: "12w", label: ut("dash.range12w") },
          ]}
        />
      }
      flush
    >
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 pb-1 text-small text-text-2">
        <span>
          {fill(ut("dashA.sumWindow"), { n: days })} <b className="font-extrabold text-text tabular-nums">{sum.current}</b>
          {", "}
          {fill(ut("dashA.sumPrev"), { n: days, prev: sum.previous })}
          {sum.changePct !== null && sum.changePct !== 0 ? (
            <>
              {": "}
              <span className={cx("font-bold", sum.changePct > 0 ? "text-good" : "text-text")}>
                {fill(ut(sum.changePct > 0 ? "dashA.more" : "dashA.less"), { p: Math.abs(sum.changePct) })}
              </span>
            </>
          ) : null}
        </span>
        {!weekly && sum.weekdayMean !== null ? (
          <span>
            {ut("dashA.weekdayMean")} <b className="font-extrabold text-text tabular-nums">{num(sum.weekdayMean)}</b>
          </span>
        ) : null}
        <span>
          {fill(ut("dashA.todayUntil"), { t: hhmm })} <b className="font-extrabold text-text tabular-nums">{sum.today}</b>
          {", "}
          {ut("dashA.weekAgo")} <b className="font-extrabold text-text tabular-nums">{sum.weekAgo}</b>
        </span>
      </div>
      <div className="px-4 pb-1 pt-2">
        {columns.some((c) => c.value > 0) ? (
          <PassBars columns={columns} mean={mean} weekly={weekly} label={ut("dash.passes")} />
        ) : (
          <NoData className="py-6" />
        )}
      </div>
      <div className="px-4 pb-4">
        <ChartLegend
          className="!mt-1.5"
          items={[
            ...(weekly
              ? [{ key: "w", label: ut("dashA.weeks"), color: "var(--series)" }]
              : [
                  { key: "wd", label: ut("dashA.weekdays"), color: "var(--series)" },
                  { key: "we", label: ut("dashA.weekends"), color: OTHER_COLOR },
                ]),
            ...(mean !== null
              ? [{ key: "m", kind: "dash" as const, color: "var(--text-2)", label: fill(ut(weekly ? "dashA.meanPrevWeeks" : "dashA.meanPrevDays"), { n: days, v: num(mean) }) }]
              : []),
          ]}
        />
      </div>
    </Panel>
  );
}
