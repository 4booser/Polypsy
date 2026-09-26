import { useMemo } from "react";
import { VITAL_METRICS, type OpsVitalCell, type OpsVitalRoute, type VitalMetric } from "@quizzy/shared";
import { api } from "../../../api";
import { LineChart } from "../../../charts";
import { Figure } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useUrlState } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Input } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { fill } from "../../dashboard/model";
import { PeriodSwitch } from "../../dashboard/parts";
import { fmtInt, fmtShare } from "../model";
import { Cell, GridRow, GridTable, NumHead, Quiet, Stamp, StatusMark, useOpsResource } from "../parts";
import {
  LOW_SAMPLE,
  METRIC_KEY,
  METRIC_WHAT,
  RATING_KEY,
  RATING_TONE,
  filterVitalRoutes,
  fmtVital,
  parseMetric,
  thresholdsOf,
  vitalSeries,
} from "./model";
import { Meta } from "./parts";

/*
 * Швидкість екранів: Web Vitals консоли по маршрутам.
 *
 * Решение заказчика 2026-09-26: LCP, INP, CLS, TTFB и время перехода между
 * экранами — по маршруту-шаблону, выборкой сессий, пачками; на сервере —
 * p75 по маршруту и дню. Здесь — таблица маршрутов с p75 и оценкой словом
 * («добре / потребує уваги / погано» по порогам Web Vitals, не одним
 * цветом: у слова ещё и форма точки), а под ней — ход выбранного маршрута
 * за тридцать дней.
 *
 * Маршрут и мера графика — в адресе (?route=, ?metric=): ссылку «вот этот
 * экран медленный» пересылают. Маршрутов с малым числом замеров не
 * прячем, но говорим прямо: p75 из пяти показов — случай, а не мера.
 */

const POLL_MS = 5 * 60_000;

const COLS = "grid-cols-[minmax(220px,1fr)_repeat(5,128px)_72px]";

export default function OpsVitals() {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useUrlState("q", "");
  const [selected, setSelected] = useUrlState("route", "");
  const [rawMetric, setMetric] = useUrlState("metric", "LCP");
  const metric = parseMetric(rawMetric);

  const res = useOpsResource(() => api.opsVitals(30), [], POLL_MS);
  const rows = useMemo(() => (res.data ? filterVitalRoutes(res.data.routes, q) : null), [res.data, q]);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data || !rows) return <Loading rows={6} />;
  const d = res.data;
  const pick = d.routes.find((r) => r.route === selected) ?? null;

  return (
    <div>
      <Stamp updatedAt={res.updatedAt} note={fill(ut("o2b.v.stamp"), { share: fmtShare(d.sampleRate, loc), days: d.days.length })} />

      <RuleSection
        className="mt-[16px]"
        title={ut("o2b.tab.vitals")}
        hint={ut("o2b.v.hint")}
        actions={
          <Input
            look="fill"
            ph="plain"
            aria-label={ut("o2b.v.search")}
            placeholder={ut("o2b.v.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-[260px] px-[10px] max-[600px]:w-full"
            autoComplete="off"
            maxLength={120}
          />
        }
      >
        {d.routes.length === 0 ? (
          <Quiet>{ut("o2b.v.empty")}</Quiet>
        ) : rows.length === 0 ? (
          <Quiet>{ut("ops.routes.noMatch")}</Quiet>
        ) : (
          <GridTable
            label={ut("o2b.tab.vitals")}
            cols={COLS}
            minW="min-w-[1040px]"
            head={[
              ut("ops.col.route"),
              ...VITAL_METRICS.map((m) => <NumHead key={m}>{ut(METRIC_KEY[m])}</NumHead>),
              <NumHead key="n">{ut("o2b.v.samples")}</NumHead>,
            ]}
          >
            {rows.map((r) => (
              <RouteRow key={r.route} r={r} active={r.route === selected} onPick={() => setSelected(r.route === selected ? "" : r.route)} />
            ))}
          </GridTable>
        )}
      </RuleSection>

      {pick ? (
        <RuleSection
          title={<span className="font-mono text-[18px]">{pick.route}</span>}
          actions={
            <PeriodSwitch<VitalMetric>
              label={ut("o2b.v.metric")}
              value={metric}
              onChange={setMetric}
              options={VITAL_METRICS.map((m) => [m, ut(METRIC_KEY[m])] as const)}
            />
          }
        >
          <Trend cell={pick.metrics[metric]} metric={metric} days={d.days} />
        </RuleSection>
      ) : rows.length ? (
        <Quiet>{ut("o2b.v.pickHint")}</Quiet>
      ) : null}

      <RuleSection title={ut("o2b.v.thresholds")} hint={ut("o2b.v.thresholdsHint")}>
        <Thresholds />
      </RuleSection>
    </div>
  );
}

function RouteRow({ r, active, onPick }: { r: OpsVitalRoute; active: boolean; onPick: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const samples = Math.max(0, ...VITAL_METRICS.map((m) => r.metrics[m]?.n ?? 0));
  return (
    <GridRow cols={COLS} className={cx("items-start", active && "bg-primary-tint")}>
      <Cell>
        <button
          type="button"
          aria-pressed={active}
          onClick={onPick}
          title={ut("o2b.v.pick")}
          className="max-w-full truncate rounded-[4px] border-0 bg-transparent p-0 text-left font-mono text-[12px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {r.route}
        </button>
      </Cell>
      {VITAL_METRICS.map((m) => (
        <VitalCell key={m} metric={m} cell={r.metrics[m]} />
      ))}
      <Cell num className={samples < LOW_SAMPLE ? "text-muted" : undefined}>
        {fmtInt(samples, loc)}
      </Cell>
    </GridRow>
  );
}

function VitalCell({ metric, cell }: { metric: VitalMetric; cell: OpsVitalCell | undefined }) {
  const { ut } = useLang();
  const loc = locale();
  if (!cell || cell.p75 === null || !cell.rating) return <Cell num className="text-muted">—</Cell>;
  return (
    <Cell>
      <span className="block text-right font-mono tabular-nums text-text">{fmtVital(metric, cell.p75, loc)}</span>
      <span className="flex justify-end">
        <StatusMark tone={RATING_TONE[cell.rating]}>{ut(RATING_KEY[cell.rating])}</StatusMark>
      </span>
      {cell.n < LOW_SAMPLE ? <Meta className="block text-right">{fill(ut("o2b.v.few"), { n: cell.n })}</Meta> : null}
    </Cell>
  );
}

function Trend({ cell, metric, days }: { cell: OpsVitalCell | undefined; metric: VitalMetric; days: readonly string[] }) {
  const { ut } = useLang();
  const loc = locale();
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(loc, { day: "numeric", month: "short" });
  const points = vitalSeries(cell, days, label);
  const t = thresholdsOf(metric, loc);
  if (!points.length) return <Quiet>{ut("o2b.v.noMetric")}</Quiet>;
  return (
    <Figure
      title={fill(ut("o2b.v.trend"), { metric: ut(METRIC_KEY[metric]) })}
      caption={fill(ut("o2b.v.trendCaption"), { good: t.good, poor: t.poor, n: fmtInt(cell?.n ?? 0, loc) })}
    >
      <LineChart series={[{ label: `p75 ${ut(METRIC_KEY[metric])}`, points }]} height={220} />
    </Figure>
  );
}

const TH_COLS = "grid-cols-[120px_120px_120px_minmax(0,1fr)]";

function Thresholds() {
  const { ut } = useLang();
  const loc = locale();
  return (
    <GridTable
      label={ut("o2b.v.thresholds")}
      cols={TH_COLS}
      minW="min-w-[640px]"
      head={[ut("o2b.v.metric"), <NumHead key="g">{ut("o2b.rating.good")}</NumHead>, <NumHead key="p">{ut("o2b.rating.poor")}</NumHead>, ut("o2b.v.what")]}
    >
      {VITAL_METRICS.map((m) => {
        const t = thresholdsOf(m, loc);
        return (
          <GridRow key={m} cols={TH_COLS}>
            <Cell className="font-bold text-primary">{ut(METRIC_KEY[m])}</Cell>
            <Cell num>≤ {t.good}</Cell>
            <Cell num>&gt; {t.poor}</Cell>
            <Cell className="text-muted">{ut(METRIC_WHAT[m])}</Cell>
          </GridRow>
        );
      })}
    </GridTable>
  );
}
