import { useMemo } from "react";
import {
  VITAL_METRICS,
  VITAL_THRESHOLDS,
  type OpsVitalCell,
  type OpsVitalRoute,
  type VitalMetric,
  type VitalRating,
} from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, ShareBar, TimeLines } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, DataTable, Loading, SearchField, useUrlState, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Segmented, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { PERIOD_KEY, fmtInt, fmtShare } from "../model";
import { CopyLinkButton, Mono, OpsHead, OpsToolbar, PanelNote, Quiet, useOpsResource } from "../parts";
import { RatedBars } from "./charts";
import {
  LOW_SAMPLE,
  METRIC_KEY,
  METRIC_WHAT,
  RATING_KEY,
  VITAL_WINDOWS,
  dayLabel,
  filterVitalRoutes,
  fmtVital,
  parseMetric,
  parseVitalWindow,
  ratingOfTotals,
  ratingTotals,
  releaseDayMarks,
  slowestRoutes,
  thresholdsOf,
} from "./model";
import { RatingLegend, RatingMark } from "./parts";

/*
 * Швидкість екранів в «Виразній»: Web Vitals консоли по маршрутам.
 *
 * Решение заказчика 2026-09-26: LCP, INP, CLS, TTFB и время перехода между
 * экранами — по маршруту-шаблону, выборкой сессий, пачками; на сервере —
 * p75 по маршруту и дню.
 *
 * Сверху — «Міри»: по строке на меру, с оценкой по всем экранам разом из
 * долей замеров (общего p75 сервер не считает, и выдумывать его нельзя) и
 * порогами; выбранная мера ведёт графики ниже. Затем — самые медленные
 * экраны и доли замеров по оценке, таблица экранов (оценка — формой метки,
 * а не одним цветом) и ход выбранного экрана по дням с разрывами вместо
 * сжатой линии и отметками выкаток.
 *
 * Маршрут, мера и период — в адресе (?route=, ?metric=, ?days=): ссылку
 * «вот этот экран медленный» пересылают. Маршрутов с малым числом замеров
 * не прячем, но говорим прямо: p75 из пяти показов — случай, а не мера.
 */

const POLL_MS = 5 * 60_000;

/** Строк в рейтинге медленных экранов: больше глаз разом не сравнит, остальное — в таблице */
const SLOWEST = 6;

const METRIC_NAME: Record<VitalMetric, "opx.vt.name.LCP" | "opx.vt.name.INP" | "opx.vt.name.CLS" | "opx.vt.name.TTFB" | "opx.vt.name.NAV"> = {
  LCP: "opx.vt.name.LCP",
  INP: "opx.vt.name.INP",
  CLS: "opx.vt.name.CLS",
  TTFB: "opx.vt.name.TTFB",
  NAV: "opx.vt.name.NAV",
};

/* доли замеров по оценке — те же цвета, что у полос медленных экранов */
const RATING_COLOR: Record<VitalRating, string> = { good: "var(--good)", needs: "var(--warnline)", poor: "var(--warn)" };

export default function OpsVitals() {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useUrlState("q", "");
  const [selected, setSelected] = useUrlState("route", "");
  const [rawMetric, setMetric] = useUrlState("metric", "LCP");
  const [rawDays, setDays] = useUrlState("days", "30");
  const metric = parseMetric(rawMetric);
  const days = parseVitalWindow(rawDays);

  const res = useOpsResource(() => api.opsVitals(days), [days], POLL_MS);
  const releases = useResource(() => api.opsReleaseVersions(), []);
  const rows = useMemo(() => (res.data ? filterVitalRoutes(res.data.routes, q) : null), [res.data, q]);
  const d = res.data;

  const head = (
    <OpsHead
      meta={[ut("opx.vt.metaBold"), fill(ut("opx.vt.metaSub"), { days, share: d ? fmtShare(d.sampleRate, loc) : "—" })]}
      actions={<CopyLinkButton />}
      toolbar={
        <OpsToolbar right={<span className="text-small text-muted">{ut("opx.vt.navNote")}</span>}>
          <SearchField value={q} onChange={setQ} placeholder={ut("o2b.v.search")} slash width={260} />
          <Segmented
            label={ut("ops.history.periodLabel")}
            value={String(days)}
            onChange={(v) => setDays(v)}
            items={VITAL_WINDOWS.map((w) => ({ key: String(w), label: ut(PERIOD_KEY[`${w}d` as "7d" | "30d"]) }))}
          />
        </OpsToolbar>
      }
    />
  );

  if (res.error && !d) {
    return (
      <>
        {head}
        <Loading error={res.error} onRetry={res.reload} />
      </>
    );
  }
  if (!d || !rows) {
    return (
      <>
        {head}
        <Loading rows={6} />
      </>
    );
  }
  const pick = d.routes.find((r) => r.route === selected) ?? null;
  const name = ut(METRIC_KEY[metric]);

  return (
    <div className="flex flex-col gap-4">
      {head}
      {d.routes.length === 0 ? (
        <Panel title={ut("opx.vt.metrics")} icon={<OpsIcon name="gauge" />}>
          <Quiet>{ut("o2b.v.empty")}</Quiet>
        </Panel>
      ) : (
        <>
          <MetricsPanel routes={rows} metric={metric} onMetric={setMetric} />
          <Panel
            title={fill(ut("opx.vt.overview"), { metric: name })}
            icon={<OpsIcon name="chart-bar" />}
            sub={fill(ut("opx.vt.overviewSub"), { metric: name })}
          >
            {rows.length ? <VitalShape routes={rows} metric={metric} days={d.days.length} /> : <Quiet>{ut("ops.routes.noMatch")}</Quiet>}
          </Panel>
          <ScreensPanel rows={rows} days={d.days.length} selected={selected} onPick={(r) => setSelected(r === selected ? "" : r)} />
          <Panel
            title={ut("opx.vt.trend")}
            icon={<OpsIcon name="activity" />}
            sub={pick ? <Mono className="text-text-2">{pick.route}</Mono> : undefined}
            actions={
              pick ? (
                <Segmented
                  label={ut("o2b.v.metric")}
                  value={metric}
                  onChange={setMetric}
                  items={VITAL_METRICS.map((m) => ({ key: m, label: ut(METRIC_KEY[m]) }))}
                />
              ) : null
            }
          >
            {pick ? (
              <Trend cell={pick.metrics[metric]} metric={metric} days={d.days} releases={releases.data?.items ?? []} />
            ) : (
              <Quiet>{ut("o2b.v.pickHint")}</Quiet>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/* ─────────── меры ─────────── */

interface MetricLine {
  metric: VitalMetric;
  ratings: Record<VitalRating, number>;
  n: number;
  rating: VitalRating | null;
}

function MetricsPanel({ routes, metric, onMetric }: { routes: readonly OpsVitalRoute[]; metric: VitalMetric; onMetric: (m: VitalMetric) => void }) {
  const { ut } = useLang();
  const loc = locale();
  const lines: MetricLine[] = VITAL_METRICS.map((m) => {
    const ratings = ratingTotals(routes.map((r) => r.metrics[m]));
    return { metric: m, ratings, n: ratings.good + ratings.needs + ratings.poor, rating: ratingOfTotals(ratings) };
  });
  const columns: Column<MetricLine>[] = [
    {
      key: "metric",
      header: ut("o2b.v.metric"),
      width: 190,
      required: true,
      render: (l) => (
        <span className="flex flex-col">
          <b className="text-[14px] font-extrabold leading-5 text-text">{ut(METRIC_NAME[l.metric])}</b>
          <Mono className="text-muted">{l.metric === "NAV" ? ut("opx.vt.ours") : l.metric}</Mono>
        </span>
      ),
    },
    {
      key: "n",
      header: ut("o2b.v.samples"),
      num: true,
      width: 100,
      required: true,
      render: (l) => <span className="tabular-nums text-text-2">{fmtInt(l.n, loc)}</span>,
    },
    {
      key: "share",
      header: ut("opx.vt.goodShare"),
      num: true,
      width: 120,
      required: true,
      render: (l) => <b className="font-extrabold tabular-nums text-text">{l.n ? fmtShare(l.ratings.good / l.n, loc) : "—"}</b>,
    },
    {
      key: "rating",
      header: ut("opx.vt.rating"),
      width: 170,
      required: true,
      render: (l) => (l.rating ? <RatingWord rating={l.rating} /> : <span className="text-muted">—</span>),
    },
    {
      key: "good",
      header: ut("o2b.rating.good"),
      width: 96,
      required: true,
      render: (l) => <span className="whitespace-nowrap tabular-nums text-text-2">≤ {thresholdsOf(l.metric, loc).good}</span>,
    },
    {
      key: "poor",
      header: ut("o2b.rating.poor"),
      width: 96,
      required: true,
      render: (l) => <span className="whitespace-nowrap tabular-nums text-text-2">&gt; {thresholdsOf(l.metric, loc).poor}</span>,
    },
    { key: "what", header: ut("o2b.v.what"), required: true, render: (l) => <span className="text-text-2">{ut(METRIC_WHAT[l.metric])}</span> },
  ];
  return (
    <Panel
      title={ut("opx.vt.metrics")}
      icon={<OpsIcon name="gauge" />}
      sub={ut("opx.vt.metricsSub")}
      flush
      footer={<PanelNote>{ut("opx.vt.ratingNote")}</PanelNote>}
    >
      <DataTable
        rows={lines}
        columns={columns}
        rowKey={(l) => l.metric}
        dense
        sticky={false}
        label={ut("opx.vt.metrics")}
        onRowClick={(l) => onMetric(l.metric)}
        isRowActive={(l) => l.metric === metric}
      />
    </Panel>
  );
}

function RatingWord({ rating }: { rating: VitalRating }) {
  const { ut } = useLang();
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-semibold", rating === "good" ? "text-good" : "text-warn", rating === "poor" && "font-extrabold")}>
      <RatingMark rating={rating} />
      {ut(RATING_KEY[rating])}
    </span>
  );
}

/* ─────────── обзор меры ─────────── */

/**
 * Обзор выбранной меры: какие экраны медленнее всех и сколько показов
 * вообще уложилось в «добре».
 *
 * Два разных вопроса — две фигуры. p75 по экранам — полосами от нуля (у
 * времени другого нуля нет), цвет полосы — оценка, риски — пороги. Доли — по
 * замерам всех экранов, а не по экранам: экран, который открывают раз в
 * месяц, и экран, с которого начинается каждый день, в «сколько людей ждали
 * дольше порога» весят по-разному, и так и должно быть.
 */
export function VitalShape({ routes, metric, days }: { routes: readonly OpsVitalRoute[]; metric: VitalMetric; days: number }) {
  const { ut } = useLang();
  const loc = locale();
  const slow = slowestRoutes(routes, metric, SLOWEST);
  const totals = ratingTotals(routes.map((r) => r.metrics[metric]));
  const total = totals.good + totals.needs + totals.poor;
  const t = thresholdsOf(metric, loc);
  if (!slow.rows.length) return <Quiet>{ut("o2b.v.noMetric")}</Quiet>;
  const caption = fill(ut("opx.vt.slowestSub"), { days, good: t.good, poor: t.poor });
  return (
    <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <Figure title={ut("opx.vt.slowest")} caption={slow.more ? `${caption} ${fill(ut("sig.v.more"), { n: slow.more })}` : caption}>
        <RatedBars
          items={slow.rows.map((r) => ({
            key: r.route,
            title: r.route,
            label: <Mono className="text-[11.5px] text-text">{r.route}</Mono>,
            value: r.p75,
            text: fmtVital(metric, r.p75, loc),
            rating: r.rating,
            extra: r.n < LOW_SAMPLE ? fill(ut("o2b.v.few"), { n: r.n }) : undefined,
            note: ut(RATING_KEY[r.rating]),
          }))}
          marks={[
            { value: VITAL_THRESHOLDS[metric].good, label: `${ut("o2b.rating.good")} ≤ ${t.good}` },
            { value: VITAL_THRESHOLDS[metric].poor, label: `${ut("o2b.rating.poor")} > ${t.poor}` },
          ]}
        />
      </Figure>
      <Figure title={ut("opx.vt.byRating")} caption={ut("opx.vt.byRatingSub")}>
        <RatingShare ratings={totals} label={fill(ut("sig.v.ratings"), { metric: ut(METRIC_KEY[metric]) })} />
        <p className="m-0 mt-3 text-caption text-muted">{fill(ut("opx.vt.samplesNote"), { n: fmtInt(total, loc), good: t.good, poor: t.poor })}</p>
      </Figure>
    </div>
  );
}

function RatingShare({ ratings, label }: { ratings: Record<VitalRating, number>; label: string }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <ShareBar
      label={label}
      format={(v) => fmtInt(v, loc)}
      parts={(["good", "needs", "poor"] as const).map((k) => ({ key: k, label: ut(RATING_KEY[k]), value: ratings[k], color: RATING_COLOR[k] }))}
    />
  );
}

/* ─────────── экраны ─────────── */

function ScreensPanel({
  rows,
  days,
  selected,
  onPick,
}: {
  rows: readonly OpsVitalRoute[];
  days: number;
  selected: string;
  onPick: (route: string) => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const samples = (r: OpsVitalRoute) => Math.max(0, ...VITAL_METRICS.map((m) => r.metrics[m]?.n ?? 0));
  const columns: Column<OpsVitalRoute>[] = [
    {
      key: "route",
      header: ut("opx.vt.screen"),
      required: true,
      sort: (r) => r.route,
      render: (r) => <Mono className="break-all text-text">{r.route}</Mono>,
    },
    {
      key: "n",
      header: ut("o2b.v.samples"),
      num: true,
      width: 120,
      required: true,
      sort: samples,
      render: (r) => {
        const n = samples(r);
        return (
          <span className="inline-flex items-center justify-end gap-1.5 tabular-nums text-text-2">
            {fmtInt(n, loc)}
            {n < LOW_SAMPLE ? <Tag tone="attention">{ut("opx.vt.few")}</Tag> : null}
          </span>
        );
      },
    },
    ...VITAL_METRICS.map(
      (m): Column<OpsVitalRoute> => ({
        key: m,
        header: ut(METRIC_KEY[m]),
        num: true,
        width: 112,
        required: true,
        sort: (r) => r.metrics[m]?.p75 ?? -1,
        render: (r) => <VitalValue metric={m} cell={r.metrics[m]} />,
      }),
    ),
  ];
  return (
    <Panel
      title={ut("opx.vt.screens")}
      icon={<OpsIcon name="monitor" />}
      sub={fill(ut("opx.vt.screensSub"), { days })}
      actions={<RatingLegend />}
      flush
      footer={<PanelNote>{fill(ut("opx.vt.p75Note"), { n: LOW_SAMPLE })}</PanelNote>}
    >
      {rows.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.routes.noMatch")}</Quiet>
        </div>
      ) : (
        <DataTable
          rows={rows.slice()}
          columns={columns}
          rowKey={(r) => r.route}
          initialSort={{ key: "n", desc: true }}
          stateKey="vt"
          dense
          sticky={false}
          label={ut("opx.vt.screens")}
          onRowClick={(r) => onPick(r.route)}
          isRowActive={(r) => r.route === selected}
        />
      )}
    </Panel>
  );
}

function VitalValue({ metric, cell }: { metric: VitalMetric; cell: OpsVitalCell | undefined }) {
  const { ut } = useLang();
  const loc = locale();
  if (!cell || cell.p75 === null || !cell.rating) return <span className="text-muted">—</span>;
  const few = cell.n < LOW_SAMPLE;
  return (
    <span
      title={`${ut(RATING_KEY[cell.rating])}${few ? `, ${fill(ut("o2b.v.few"), { n: cell.n })}` : ""}`}
      className={cx(
        "inline-flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums",
        few ? "text-muted" : cell.rating === "good" ? "text-text" : "font-extrabold text-text",
      )}
    >
      {fmtVital(metric, cell.p75, loc)}
      <RatingMark rating={cell.rating} className={few ? "opacity-60" : undefined} />
    </span>
  );
}

/* ─────────── ход экрана ─────────── */

function Trend({
  cell,
  metric,
  days,
  releases,
}: {
  cell: OpsVitalCell | undefined;
  metric: VitalMetric;
  days: readonly string[];
  releases: readonly { version: string; firstAt: string }[];
}) {
  const { ut } = useLang();
  const loc = locale();
  const t = thresholdsOf(metric, loc);
  const name = ut(METRIC_KEY[metric]);
  if (!cell || !cell.daily.some((v) => v !== null) || cell.p75 === null || !cell.rating) return <Quiet>{ut("o2b.v.noMetric")}</Quiet>;
  const fmt = (v: number) => fmtVital(metric, v, loc);
  const marks = releaseDayMarks(days, releases).map((m) => ({ at: days[m.index]!, label: m.label }));
  return (
    <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <Figure title={fill(ut("o2b.v.trend"), { metric: name })} caption={ut("opx.vt.trendSub")}>
        {/* день без замеров — разрыв линии, а не ноль; порог «добре» — пунктиром, выше него — ромбы внимания */}
        <TimeLines
          x={days.map((k) => ({ key: k, label: dayLabel(k, loc) }))}
          series={[{ key: "p75", label: `p75 ${name}`, color: "var(--series)", values: cell.daily }]}
          label={`p75 ${name}`}
          format={fmt}
          threshold={{ value: VITAL_THRESHOLDS[metric].good, label: `${ut("o2b.rating.good")} ≤ ${t.good}` }}
          marks={marks}
          height={220}
        />
      </Figure>
      <Figure title={ut("opx.vt.thisScreen")} caption={fill(ut("opx.vt.samplesN"), { n: fmtInt(cell.n, loc) })}>
        <RatingShare ratings={cell.ratings} label={fill(ut("sig.v.ratings"), { metric: name })} />
        <Callout
          kind={cell.rating === "good" ? "good" : "warn"}
          icon={<OpsIcon name={cell.rating === "good" ? "circle-check" : "turtle"} />}
          title={fill(ut("opx.vt.verdictTitle"), { v: fmt(cell.p75), rating: ut(RATING_KEY[cell.rating]) })}
          className="mt-4"
        >
          {fill(ut("opx.vt.verdict"), { good: t.good, poor: t.poor })}
          {cell.n < LOW_SAMPLE ? ` ${fill(ut("opx.vt.verdictFew"), { n: cell.n })}` : ""}
        </Callout>
      </Figure>
    </div>
  );
}
