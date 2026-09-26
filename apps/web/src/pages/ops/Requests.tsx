import { useMemo } from "react";
import { api } from "../../api";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useUrlState } from "../../ui";
import { cx } from "../../ui/cx";
import { Input } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { PeriodSwitch } from "../dashboard/parts";
import { RouteCharts, TrafficCharts } from "./charts";
import {
  ROLE_KEY,
  clock,
  filterRoutes,
  fmtInt,
  fmtMs,
  parseSort,
  parseTrafficWindow,
  sortMetric,
  sortRoutes,
  type RouteSort,
} from "./model";
import { Cell, GridRow, GridTable, NumHead, Quiet, RequestId, Stamp, useOpsResource } from "./parts";

/*
 * Запити: какие маршруты нагружены, где долго и где ошибки.
 *
 * Маршрут — шаблоном («GET /api/responses/:id»): так его считает сервер, и
 * иначе нельзя — конкретный адрес несёт идентификатор человека. Порядок
 * (?sort=count|p95|errors) и поиск (?q=) — в адресе. Полоска под маршрутом
 * — та величина, по которой сейчас отсортировано, от общего максимума: её
 * читают раньше чисел, и глаз находит тяжёлую строку, не сравнивая цифры.
 *
 * Над таблицей (волна 11) — рейтинги: самые частые, самые медленные по p95
 * и доля пятисоток по маршрутам. Поиск на них не действует — он сужает
 * таблицу. Под ней — нагрузка за окно (?window=1h|6h|24h): запросы по
 * классам ответа и время ответа перцентилями, как на «Огляді».
 *
 * Ниже — медленные запросы (от секунды) поштучно: номер запроса ведёт в
 * ленту логов с фильтром по нему и копируется одним нажатием — ровно то,
 * что нужно при разборе «у меня всё висело».
 */

const POLL_MS = 20_000;

const ROUTE_COLS =
  "grid-cols-[minmax(260px,1fr)_76px_56px_56px_72px_64px_64px_64px_72px]";
const SLOW_COLS = "grid-cols-[84px_64px_minmax(220px,1fr)_52px_minmax(120px,170px)_72px_140px]";

export default function OpsRequests() {
  const { ut } = useLang();
  const loc = locale();
  const [rawSort, setSort] = useUrlState("sort", "count");
  const [q, setQ] = useUrlState("q", "");
  const [rawWindow, setWindow] = useUrlState("window", "1h");
  const sort = parseSort(rawSort);
  const win = parseTrafficWindow(rawWindow);

  const routes = useOpsResource(() => api.opsRoutes(), [], POLL_MS);
  const slow = useOpsResource(() => api.opsSlow(), [], POLL_MS);
  const traffic = useOpsResource(() => api.opsTraffic(win), [win], POLL_MS);

  const rows = useMemo(
    () => (routes.data ? sortRoutes(filterRoutes(routes.data.items, q), sort) : null),
    [routes.data, q, sort],
  );
  const top = rows?.length ? Math.max(...rows.map((r) => sortMetric(r, sort)), 0) : 0;

  if (routes.error && !routes.data) return <Loading error={routes.error} onRetry={routes.reload} />;
  if (!routes.data || !rows) return <Loading rows={6} />;

  return (
    <div>
      <Stamp since={routes.data.since} updatedAt={routes.updatedAt} />

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.routes.title")}
        hint={ut("ops.routes.hint")}
        actions={
          <>
            <Input
              look="fill"
              aria-label={ut("ops.routes.search")}
              placeholder={ut("ops.routes.search")}
              ph="plain"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-[260px] px-[10px] max-[600px]:w-full"
              autoComplete="off"
              maxLength={120}
            />
            <PeriodSwitch<RouteSort>
              label={ut("ops.routes.sortLabel")}
              value={sort}
              onChange={(v) => setSort(v)}
              options={[
                ["count", ut("ops.routes.byCount")],
                ["p95", ut("ops.routes.byP95")],
                ["errors", ut("ops.routes.byErrors")],
              ]}
            />
          </>
        }
      >
        {routes.data.items.length ? (
          <div className="mb-[28px]">
            <RouteCharts items={routes.data.items} />
            {q ? <p className="m-0 mt-[16px] text-[13px] leading-[18px] text-muted">{ut("ops.ch.searchNote")}</p> : null}
          </div>
        ) : null}
        {routes.data.items.length === 0 ? (
          <Quiet>{ut("ops.routes.empty")}</Quiet>
        ) : rows.length === 0 ? (
          <Quiet>{ut("ops.routes.noMatch")}</Quiet>
        ) : (
          <GridTable
            label={ut("ops.routes.title")}
            cols={ROUTE_COLS}
            minW="min-w-[920px]"
            head={[
              ut("ops.col.route"),
              <NumHead key="n">{ut("ops.col.count")}</NumHead>,
              <NumHead key="4">{ut("ops.col.c4")}</NumHead>,
              <NumHead key="5">{ut("ops.col.c5")}</NumHead>,
              <NumHead key="a">{ut("ops.col.avg")}</NumHead>,
              <NumHead key="p50">{ut("ops.col.p50")}</NumHead>,
              <NumHead key="p95">{ut("ops.col.p95")}</NumHead>,
              <NumHead key="p99">{ut("ops.col.p99")}</NumHead>,
              <NumHead key="m">{ut("ops.col.max")}</NumHead>,
            ]}
          >
            {rows.map((r) => {
              const share = top > 0 ? sortMetric(r, sort) / top : 0;
              return (
                <GridRow key={`${r.method} ${r.route}`} cols={ROUTE_COLS}>
                  <Cell>
                    <span className="flex min-w-0 items-baseline gap-[8px] font-mono text-[12px]">
                      <span className="w-[48px] shrink-0 text-muted">{r.method}</span>
                      <span className="min-w-0 truncate text-text" title={r.route}>
                        {r.route}
                      </span>
                    </span>
                    <span aria-hidden className="mt-[4px] block h-[4px] rounded-[2px] bg-[var(--grid-fine)]">
                      <span
                        className="block h-full rounded-[2px] bg-primary opacity-70"
                        style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100).toFixed(2)}%` }}
                      />
                    </span>
                  </Cell>
                  <Cell num>{fmtInt(r.requests, loc)}</Cell>
                  <Cell num className={r.errors4xx ? "text-text" : "text-muted"}>
                    {fmtInt(r.errors4xx, loc)}
                  </Cell>
                  {/* пятисотка — единственное, что здесь требует внимания: янтарём */}
                  <Cell num className={r.errors5xx ? "font-bold text-accent" : "text-muted"}>
                    {fmtInt(r.errors5xx, loc)}
                  </Cell>
                  <Cell num>{fmtMs(r.avgMs, loc)}</Cell>
                  <Cell num>{fmtMs(r.p50, loc)}</Cell>
                  <Cell num className={sort === "p95" ? "font-bold text-primary" : undefined}>
                    {fmtMs(r.p95, loc)}
                  </Cell>
                  <Cell num>{fmtMs(r.p99, loc)}</Cell>
                  <Cell num>{fmtMs(r.maxMs, loc)}</Cell>
                </GridRow>
              );
            })}
          </GridTable>
        )}
      </RuleSection>

      <RuleSection
        title={ut("ops.traffic.title")}
        actions={
          <PeriodSwitch
            label={ut("ops.traffic.window")}
            value={win}
            onChange={(w) => setWindow(w)}
            options={[
              ["1h", ut("ops.window.1h")],
              ["6h", ut("ops.window.6h")],
              ["24h", ut("ops.window.24h")],
            ]}
          />
        }
      >
        {traffic.error && !traffic.data ? (
          <Loading error={traffic.error} onRetry={traffic.reload} />
        ) : !traffic.data ? (
          <Loading rows={3} />
        ) : (
          <TrafficCharts buckets={traffic.data.buckets} stepSec={traffic.data.stepSec} since={traffic.data.since} compact />
        )}
      </RuleSection>

      <RuleSection
        title={ut("ops.slow.title")}
        hint={
          slow.data
            ? fill(ut("ops.slow.hint"), { ms: fmtMs(slow.data.thresholdMs, loc), n: fmtInt(slow.data.capacity, loc) })
            : undefined
        }
      >
        {slow.error && !slow.data ? (
          <Loading error={slow.error} onRetry={slow.reload} />
        ) : !slow.data ? (
          <Loading rows={3} />
        ) : slow.data.items.length === 0 ? (
          <Quiet>{ut("ops.slow.empty")}</Quiet>
        ) : (
          <GridTable
            label={ut("ops.slow.title")}
            cols={SLOW_COLS}
            minW="min-w-[860px]"
            head={[
              ut("ops.col.time"),
              ut("ops.col.method"),
              ut("ops.col.route"),
              <NumHead key="c">{ut("ops.col.code")}</NumHead>,
              ut("adm.role"),
              <NumHead key="ms">{ut("ops.col.ms")}</NumHead>,
              ut("ops.col.requestId"),
            ]}
          >
            {slow.data.items.map((s) => (
              <GridRow key={`${s.requestId}-${s.at}`} cols={SLOW_COLS}>
                <Cell className="font-mono text-[12px] text-muted tabular-nums">{clock(s.at, loc)}</Cell>
                <Cell className="font-mono text-[12px] text-muted">{s.method}</Cell>
                <Cell className="truncate font-mono text-[12px] text-text">{s.route}</Cell>
                <Cell num className={cx(s.code >= 500 && "font-bold text-accent")}>
                  {s.code}
                </Cell>
                <Cell className="truncate text-text-2">{s.role ? ut(ROLE_KEY[s.role]) : "—"}</Cell>
                <Cell num className="text-text">
                  {fmtInt(s.ms, loc)}
                </Cell>
                <Cell>
                  <RequestId id={s.requestId} />
                </Cell>
              </GridRow>
            ))}
          </GridTable>
        )}
      </RuleSection>
    </div>
  );
}
