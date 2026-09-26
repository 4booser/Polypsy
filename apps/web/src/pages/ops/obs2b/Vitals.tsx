import { useMemo } from "react";
import { VITAL_METRICS, VITAL_THRESHOLDS, type OpsVitalCell, type OpsVitalRoute, type VitalMetric, type VitalRating } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, HBars } from "../../../charts/clinical";
import { day, locale } from "../../../format";
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
  RATING_ORDER,
  RATING_TONE,
  filterVitalRoutes,
  fmtVital,
  parseMetric,
  ratingTotals,
  slowestRoutes,
  thresholdsOf,
  vitalSeries,
} from "./model";
import { FIG_GRID, GapLine, ToneShare } from "./charts";
import { Meta } from "./parts";

/*
 * Швидкість екранів: Web Vitals консоли по маршрутам.
 *
 * Решение заказчика 2026-09-26: LCP, INP, CLS, TTFB и время перехода между
 * экранами — по маршруту-шаблону, выборкой сессий, пачками; на сервере —
 * p75 по маршруту и дню. Здесь — таблица маршрутов с p75 и оценкой словом
 * («добре / потребує уваги / погано» по порогам Web Vitals, не одним
 * цветом: у слова ещё и форма точки), а под ней — ход выбранного маршрута
 * за тридцать дней. Волна 11 («должны быть графики»): над таблицей — самые
 * медленные экраны по мере и доли замеров по оценке; у выбранного экрана —
 * ход по дням с разрывами вместо сжатой линии и его собственные доли.
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
        {/* графики — по тем же строкам, что таблица: поиск маршрута сужает и их */}
        {rows.length ? <VitalShape routes={rows} metric={metric} onMetric={setMetric} days={d.days.length} /> : null}
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

/** Строк в рейтинге медленных экранов: больше глаз разом не сравнит, остальное — в таблице */
const SLOWEST = 10;

/**
 * Над таблицей (волна 11): какие экраны медленнее всех по выбранной мере и
 * сколько показов вообще уложилось в «добре».
 *
 * Два разных вопроса — две фигуры. p75 по экранам — полосами от нуля (у
 * времени другого нуля нет), самые медленные сверху, оценка словом в
 * подписи числа. Доли — по замерам всех экранов, а не по экранам: экран,
 * который открывают раз в месяц, и экран, с которого начинается каждый
 * день, в «сколько людей ждали дольше порога» весят по-разному, и так и
 * должно быть. Мера — та же, что у хода выбранного экрана ниже (?metric=).
 */
export function VitalShape({
  routes,
  metric,
  onMetric,
  days,
}: {
  routes: readonly OpsVitalRoute[];
  metric: VitalMetric;
  onMetric: (m: VitalMetric) => void;
  days: number;
}) {
  const { ut } = useLang();
  const loc = locale();
  const slow = slowestRoutes(routes, metric, SLOWEST);
  const totals = ratingTotals(routes.map((r) => r.metrics[metric]));
  const t = thresholdsOf(metric, loc);
  const name = ut(METRIC_KEY[metric]);
  return (
    <div className="mb-[28px]">
      <div className="mb-[16px]">
        <PeriodSwitch<VitalMetric>
          label={ut("o2b.v.metric")}
          value={metric}
          onChange={onMetric}
          options={VITAL_METRICS.map((m) => [m, ut(METRIC_KEY[m])] as const)}
        />
      </div>
      {slow.rows.length ? (
        <div className={FIG_GRID}>
          <Figure
            title={fill(ut("sig.v.slowest"), { metric: name })}
            caption={
              slow.more
                ? `${fill(ut("sig.v.slowestCaption"), { days })} ${fill(ut("sig.v.more"), { n: slow.more })}`
                : fill(ut("sig.v.slowestCaption"), { days })
            }
          >
            <HBars
              items={slow.rows.map((r) => ({
                key: r.route,
                label: <span className="font-mono text-[12px]">{r.route}</span>,
                value: r.p75,
                text: `${fmtVital(metric, r.p75, loc)} · ${ut(RATING_KEY[r.rating])}${r.n < LOW_SAMPLE ? ` · ${fill(ut("o2b.v.few"), { n: r.n })}` : ""}`,
                strong: r.rating === "poor",
              }))}
            />
          </Figure>
          <Figure title={fill(ut("sig.v.ratings"), { metric: name })} caption={fill(ut("sig.v.ratingsCaption"), { good: t.good, poor: t.poor })}>
            <RatingShare ratings={totals} label={fill(ut("sig.v.ratings"), { metric: name })} />
          </Figure>
        </div>
      ) : (
        <Quiet>{ut("o2b.v.noMetric")}</Quiet>
      )}
    </div>
  );
}

function RatingShare({ ratings, label }: { ratings: Record<VitalRating, number>; label: string }) {
  const { ut } = useLang();
  return (
    <ToneShare
      label={label}
      parts={RATING_ORDER.map((k) => ({ key: k, label: ut(RATING_KEY[k]), value: ratings[k], tone: RATING_TONE[k] }))}
    />
  );
}

function Trend({ cell, metric, days }: { cell: OpsVitalCell | undefined; metric: VitalMetric; days: readonly string[] }) {
  const { ut } = useLang();
  const loc = locale();
  const points = vitalSeries(cell, days, day);
  const t = thresholdsOf(metric, loc);
  if (!points.length || !cell) return <Quiet>{ut("o2b.v.noMetric")}</Quiet>;
  const fmt = (v: number) => fmtVital(metric, v, loc);
  const name = ut(METRIC_KEY[metric]);
  return (
    <div className={FIG_GRID}>
      <Figure
        title={fill(ut("o2b.v.trend"), { metric: name })}
        caption={fill(ut("o2b.v.trendCaption"), { good: t.good, poor: t.poor, n: fmtInt(cell.n, loc) })}
      >
        {/* пороги — пунктиром, если данные до них доходят; иначе они названы в подписи */}
        <GapLine
          points={points}
          label={`p75 ${name}`}
          format={fmt}
          tick={fmt}
          guides={[
            { value: VITAL_THRESHOLDS[metric].good, label: `${ut("o2b.rating.good")} ≤ ${t.good}` },
            { value: VITAL_THRESHOLDS[metric].poor, label: `${ut("o2b.rating.poor")} > ${t.poor}` },
          ]}
          height={220}
        />
      </Figure>
      <Figure title={fill(ut("sig.v.ratings"), { metric: name })} caption={ut("sig.v.routeRatingsCaption")}>
        <RatingShare ratings={cell.ratings} label={fill(ut("sig.v.ratings"), { metric: name })} />
      </Figure>
    </div>
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
