import { useMemo, useState } from "react";
import type { OpsRouteStat, OpsSlowRequest } from "@quizzy/shared";
import { api } from "../../api";
import { locale } from "../../format";
import { useLang } from "../../lang";
import {
  Callout,
  DataTable,
  Drawer,
  DrawerSection,
  FilterBar,
  KV,
  KbdHints,
  Loading,
  Tooltip,
  parseTableSort,
  sortRows,
  tableSortParam,
  tableToCsv,
  useUrlState,
  type Column,
  type TableSort,
} from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Segmented } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { RouteCharts, TrafficCharts } from "./charts";
import { OpsIcon } from "./icons";
import { ROLE_KEY, clock, filterRoutes, fmtInt, fmtMs, fmtShare, fmtUptime, hhmm, parseTrafficWindow } from "./model";
import {
  CopyLinkButton,
  FilterToggle,
  HttpCode,
  Live,
  MethodRoute,
  Mono,
  OpsHead,
  OpsToolbar,
  PanelNote,
  Quiet,
  RequestId,
  SinceNote,
  StatusMark,
  TraceBox,
  sinceText,
  useCount,
  useOpsResource,
} from "./parts";

/*
 * Запити: какие маршруты нагружены, где долго и где ошибки.
 *
 * Маршрут — шаблоном («GET /api/responses/:id»): так его считает сервер, и
 * иначе нельзя — конкретный адрес несёт идентификатор человека.
 *
 * Сверху — нагрузка за окно (?window=1h|6h|24h): запросы по классам ответа
 * и время ответа перцентилями. Под ней — рейтинги маршрутов с момента
 * запуска: самые частые, самые медленные по p95, доля пятисоток. Дальше —
 * таблица маршрутов (поиск ?q=, порядок и колонки — в адресе, фильтры «лише
 * з 5xx» и «p95 від …»), строка открывает ящик с подробностями маршрута:
 * числа, его медленные запросы с номерами и переходы в трассу и ленту
 * логов. Внизу — медленные запросы поштучно: номер ведёт в трассу и
 * копируется одним нажатием — ровно то, что нужно при разборе «у меня всё
 * висело».
 */

const POLL_MS = 20_000;
const SLOW_SHOWN = 7;

const routeKey = (r: Pick<OpsRouteStat, "method" | "route">) => `${r.method} ${r.route}`;

/* порядок «За числом / За p95 / За помилками» — то же, что нажатие заголовка колонки */
const ORDERS = {
  count: { key: "requests", desc: true },
  p95: { key: "p95", desc: true },
  errors: { key: "c5", desc: true },
} as const satisfies Record<string, TableSort>;
type Order = keyof typeof ORDERS;
const INITIAL: TableSort = ORDERS.count;

export default function OpsRequests() {
  const { ut } = useLang();
  const loc = locale();
  const count = useCount();
  const [q, setQ] = useUrlState("q", "");
  const [rawWindow, setWindow] = useUrlState("window", "1h");
  const [only5xx, setOnly5xx] = useUrlState("c5", "");
  const [onlySlow, setOnlySlow] = useUrlState("slow", "");
  const [sortRaw, setSortRaw] = useUrlState("rt.sort", "");
  const [openKey, setOpenKey] = useUrlState("route", "");
  const [drawerOpen, setDrawerOpen] = useState(() => openKey !== "");
  const win = parseTrafficWindow(rawWindow);

  const routes = useOpsResource(() => api.opsRoutes(), [], POLL_MS);
  const slow = useOpsResource(() => api.opsSlow(), [], POLL_MS);
  const traffic = useOpsResource(() => api.opsTraffic(win), [win], POLL_MS);
  /* порог оповещения о p95 — риской в рейтинге и границей фильтра «p95 від …» */
  const alerts = useResource(() => api.opsAlerts(), []);

  const p95Rule = alerts.data?.rules.find((r) => r.key === "p95");
  const p95Limit = p95Rule?.enabled && p95Rule.threshold !== null ? p95Rule.threshold : null;
  const slowFrom = p95Limit ?? slow.data?.thresholdMs ?? 1000;

  const columns = useRouteColumns(p95Limit);
  const rows = useMemo(() => {
    if (!routes.data) return null;
    let list = filterRoutes(routes.data.items, q);
    if (only5xx) list = list.filter((r) => r.errors5xx > 0);
    if (onlySlow) list = list.filter((r) => r.p95 !== null && r.p95 >= slowFrom);
    return list;
  }, [routes.data, q, only5xx, onlySlow, slowFrom]);

  const sort = parseTableSort(sortRaw, columns, INITIAL);
  const order = (Object.keys(ORDERS) as Order[]).find((k) => ORDERS[k].key === sort?.key && ORDERS[k].desc === !!sort?.desc);
  const opened = routes.data?.items.find((r) => routeKey(r) === openKey) ?? null;

  const windowWord = win === "1h" ? ut("opx.rq.per1h") : win === "6h" ? ut("opx.rq.per6h") : ut("opx.rq.per24h");
  const inWindow = traffic.data ? traffic.data.buckets.reduce((s, b) => s + b.requests, 0) : null;

  const head = (
    <OpsHead
      meta={
        routes.data
          ? [
              inWindow === null
                ? ut("ops.routes.title")
                : count(["opx.rq.req.one", "opx.rq.req.few", "opx.rq.req.many"], inWindow, { period: windowWord }),
              count(["opx.rq.routes.one", "opx.rq.routes.few", "opx.rq.routes.many"], routes.data.items.length, {
                time: sinceText(routes.data.since, loc),
              }),
            ]
          : null
      }
      actions={
        <>
          <TraceBox />
          <CopyLinkButton />
        </>
      }
      toolbar={
        <OpsToolbar right={<Live pollSec={POLL_MS / 1000} updatedAt={routes.updatedAt} />}>
          <Segmented
            label={ut("ops.traffic.window")}
            value={win}
            onChange={(w) => setWindow(w)}
            items={[
              { key: "1h", label: ut("ops.window.1h") },
              { key: "6h", label: ut("ops.window.6h") },
              { key: "24h", label: ut("ops.window.24h") },
            ]}
          />
          <FilterToggle label={ut("opx.rq.only5xx")} on={!!only5xx} onChange={(v) => setOnly5xx(v ? "1" : "")} />
          <FilterToggle
            label={fill(ut("opx.rq.slowFrom"), { v: fmtMs(slowFrom, loc) })}
            on={!!onlySlow}
            onChange={(v) => setOnlySlow(v ? "1" : "")}
          />
        </OpsToolbar>
      }
    />
  );

  if (routes.error && !routes.data) {
    return (
      <>
        {head}
        <Loading error={routes.error} onRetry={routes.reload} />
      </>
    );
  }
  if (!routes.data || !rows) {
    return (
      <>
        {head}
        <Loading rows={6} />
      </>
    );
  }

  const first = traffic.data?.buckets[0];
  const last = traffic.data?.buckets.at(-1);
  const exportCsv = () => {
    const blob = new Blob([tableToCsv(sortRows(rows, columns, sort), columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "routes.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  const open = (r: OpsRouteStat) => {
    setOpenKey(routeKey(r));
    setDrawerOpen(true);
  };

  return (
    <div className="flex flex-col gap-4">
      {head}
      <Panel
        title={ut("ops.traffic.title")}
        icon={<OpsIcon name="chart-column" />}
        sub={
          traffic.data && first && last
            ? fill(ut("opx.ov.loadSub"), {
                from: hhmm(first.at, loc),
                to: hhmm(new Date(Date.parse(last.at) + traffic.data.stepSec * 1000).toISOString(), loc),
                step: fmtUptime(traffic.data.stepSec, loc),
              })
            : undefined
        }
      >
        {traffic.error && !traffic.data ? (
          <Loading bare error={traffic.error} onRetry={traffic.reload} />
        ) : !traffic.data ? (
          <Loading bare rows={3} />
        ) : (
          <TrafficCharts buckets={traffic.data.buckets} stepSec={traffic.data.stepSec} since={traffic.data.since} compact />
        )}
      </Panel>

      {routes.data.items.length ? <RouteCharts items={routes.data.items} p95Limit={p95Limit} /> : null}

      <Panel
        title={ut("ops.routes.title")}
        icon={<OpsIcon name="route" />}
        sub={ut("opx.rq.tableSub")}
        flush
      >
        <div className="px-4 pb-3">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: ut("opx.rq.search"), width: 260 }}
            chips={
              <Segmented
                label={ut("ops.routes.sortLabel")}
                value={(order ?? "") as Order}
                onChange={(o) => setSortRaw(tableSortParam(ORDERS[o]) === tableSortParam(INITIAL) ? "" : tableSortParam(ORDERS[o]))}
                items={[
                  { key: "count", label: ut("ops.routes.byCount") },
                  { key: "p95", label: ut("ops.routes.byP95") },
                  { key: "errors", label: ut("ops.routes.byErrors") },
                ]}
              />
            }
            count={{ shown: rows.length, total: routes.data.items.length }}
            right={
              rows.length ? (
                <Tooltip label={ut("ui.exportCsv")}>
                  <Button size="xs" icon={<OpsIcon name="download" />} onClick={exportCsv}>
                    {ut("opx.csv")}
                  </Button>
                </Tooltip>
              ) : null
            }
          />
        </div>
        {routes.data.items.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.routes.empty")}</Quiet>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.routes.noMatch")}</Quiet>
          </div>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={routeKey}
            stateKey="rt"
            initialSort={INITIAL}
            dense
            hotkeys
            label={ut("ops.routes.title")}
            onRowClick={open}
            isRowActive={(r) => drawerOpen && routeKey(r) === openKey}
            rowActions={(r) => (
              <>
                <Tooltip label={ut("opx.rq.details")}>
                  <Button variant="quiet" size="icon-sm" aria-label={ut("opx.rq.details")} icon={<OpsIcon name="panel-right-open" />} onClick={() => open(r)} />
                </Tooltip>
                <Tooltip label={ut("opx.rq.routeLogs")}>
                  <ButtonLink
                    variant="quiet"
                    size="icon-sm"
                    aria-label={ut("opx.rq.routeLogs")}
                    to={`/ops/logs?q=${encodeURIComponent(r.route)}`}
                  >
                    <OpsIcon name="scroll-text" size={15} />
                  </ButtonLink>
                </Tooltip>
              </>
            )}
          />
        )}
        <div className="border-t border-divider px-4 pb-3.5 pt-3">
          <PanelNote>{ut("opx.rq.tableNote")}</PanelNote>
        </div>
        <KbdHints
          bar
          keys={[
            ["J K", ut("opx.kbd.rows")],
            ["Enter", ut("opx.kbd.routeDetails")],
            ["/", ut("opx.kbd.search")],
            ["Esc", ut("opx.kbd.closePanel")],
          ]}
        />
      </Panel>

      <SlowPanel slow={slow.data} error={slow.error} onRetry={slow.reload} since={routes.data.since} />

      <RouteDrawer
        route={opened}
        open={drawerOpen && opened !== null}
        slow={slow.data?.items ?? []}
        onClose={() => {
          setDrawerOpen(false);
          setOpenKey("");
        }}
      />
    </div>
  );
}

/* ─────────── таблица маршрутов ─────────── */

function useRouteColumns(p95Limit: number | null): Column<OpsRouteStat>[] {
  const { ut } = useLang();
  const loc = locale();
  return useMemo(() => {
    const ms = (v: number | null) => <span className="text-text-2">{fmtMs(v, loc)}</span>;
    return [
      {
        key: "route",
        header: ut("ops.col.route"),
        required: true,
        sort: (r) => `${r.route} ${r.method}`,
        csv: (r) => routeKey(r),
        render: (r) => <MethodRoute method={r.method} route={r.route} />,
      },
      {
        key: "requests",
        header: ut("ops.col.count"),
        num: true,
        width: 88,
        required: true,
        sort: (r) => r.requests,
        render: (r) => <b className="font-extrabold">{fmtInt(r.requests, loc)}</b>,
      },
      {
        key: "c4",
        header: ut("ops.col.c4"),
        num: true,
        width: 56,
        required: true,
        sort: (r) => r.errors4xx,
        render: (r) => <span className={r.errors4xx ? "text-text-2" : "text-muted"}>{fmtInt(r.errors4xx, loc)}</span>,
      },
      {
        key: "c5",
        header: ut("ops.col.c5"),
        num: true,
        width: 64,
        required: true,
        /* «за помилками»: сначала пятисотки, потом 4xx — одна поломка важнее сотни «немає прав» */
        sort: (r) => r.errors5xx * 1_000_000 + r.errors4xx,
        csv: (r) => r.errors5xx,
        render: (r) =>
          r.errors5xx ? (
            <StatusMark tone="fail" className="justify-end">
              {fmtInt(r.errors5xx, loc)}
            </StatusMark>
          ) : (
            <span className="text-muted">0</span>
          ),
      },
      { key: "avg", header: ut("ops.col.avg"), num: true, width: 84, required: true, sort: (r) => r.avgMs, render: (r) => ms(r.avgMs) },
      { key: "p50", header: ut("ops.col.p50"), num: true, width: 72, required: true, sort: (r) => r.p50, render: (r) => ms(r.p50) },
      {
        key: "p95",
        header: ut("ops.col.p95"),
        num: true,
        width: 76,
        required: true,
        sort: (r) => r.p95,
        render: (r) => (
          <b className={p95Limit !== null && r.p95 !== null && r.p95 >= p95Limit ? "font-extrabold text-warn" : "font-extrabold"}>
            {fmtMs(r.p95, loc)}
          </b>
        ),
      },
      { key: "p99", header: ut("ops.col.p99"), num: true, width: 76, required: true, sort: (r) => r.p99, render: (r) => ms(r.p99) },
      { key: "max", header: ut("ops.col.max"), num: true, width: 76, required: true, sort: (r) => r.maxMs, render: (r) => ms(r.maxMs) },
    ];
  }, [ut, loc, p95Limit]);
}

/* ─────────── повільні запити ─────────── */

function SlowPanel({
  slow,
  error,
  onRetry,
  since,
}: {
  slow: { thresholdMs: number; capacity: number; items: OpsSlowRequest[] } | null;
  error: string | null;
  onRetry: () => void;
  since: string;
}) {
  const { ut } = useLang();
  const loc = locale();
  const [all, setAll] = useState(false);
  const items = slow?.items ?? [];
  const top = Math.max(1, ...items.map((s) => s.ms));
  const columns: Column<OpsSlowRequest>[] = [
    {
      key: "at",
      header: ut("ops.col.time"),
      width: 96,
      required: true,
      sort: (s) => s.at,
      render: (s) => <Mono className="text-text-2">{clock(s.at, loc)}</Mono>,
    },
    { key: "route", header: ut("ops.col.route"), required: true, render: (s) => <MethodRoute method={s.method} route={s.route} /> },
    { key: "code", header: ut("ops.col.code"), width: 64, required: true, render: (s) => <HttpCode code={s.code} /> },
    {
      key: "ms",
      header: ut("opx.rq.took"),
      width: 180,
      required: true,
      sort: (s) => s.ms,
      render: (s) => (
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-[90px] shrink-0 overflow-hidden rounded-[4px] bg-track">
            <i
              className={cx("block h-full rounded-[4px]", s.code >= 500 ? "bg-[var(--c2)]" : "bg-[var(--c1)]")}
              style={{ width: `${Math.max(4, (s.ms / top) * 100).toFixed(0)}%` }}
            />
          </span>
          <b className="whitespace-nowrap font-extrabold tabular-nums">{fmtMs(s.ms, loc)}</b>
        </span>
      ),
    },
    {
      key: "role",
      header: ut("adm.role"),
      width: 130,
      required: true,
      render: (s) => <span className="text-text-2">{s.role ? ut(ROLE_KEY[s.role]) : "—"}</span>,
    },
    { key: "id", header: ut("ops.col.requestId"), width: 140, required: true, render: (s) => <RequestId id={s.requestId} /> },
  ];

  return (
    <Panel
      title={ut("ops.slow.title")}
      icon={<OpsIcon name="hourglass" />}
      sub={slow ? fill(ut("opx.rq.slowSub"), { ms: fmtMs(slow.thresholdMs, loc), n: fmtInt(slow.capacity, loc) }) : undefined}
      actions={
        items.length > SLOW_SHOWN ? (
          <Button variant="ghost" size="xs" icon={<OpsIcon name={all ? "chevron-up" : "chevron-down"} />} onClick={() => setAll(!all)}>
            {all ? ut("opx.rq.showLess") : fill(ut("opx.rq.showAll"), { n: items.length })}
          </Button>
        ) : null
      }
      flush
      footer={<SinceNote since={since} />}
    >
      {error && !slow ? (
        <div className="px-4 pb-3">
          <Loading bare error={error} onRetry={onRetry} />
        </div>
      ) : !slow ? (
        <div className="px-4 pb-3">
          <Loading bare rows={3} />
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.slow.empty")}</Quiet>
        </div>
      ) : (
        <DataTable
          rows={all ? items : items.slice(0, SLOW_SHOWN)}
          columns={columns}
          rowKey={(s) => `${s.requestId}-${s.at}`}
          dense
          sticky={false}
          label={ut("ops.slow.title")}
          rowActions={(s) => (
            <>
              <ButtonLink to={`/ops/trace/${encodeURIComponent(s.requestId)}`} size="xs">
                <OpsIcon name="route" size={14} />
                {ut("opx.rq.trace")}
              </ButtonLink>
              <ButtonLink to={`/ops/logs?q=${encodeURIComponent(s.requestId)}`} size="xs" variant="quiet">
                <OpsIcon name="scroll-text" size={14} />
                {ut("opx.rq.logs")}
              </ButtonLink>
            </>
          )}
        />
      )}
    </Panel>
  );
}

/* ─────────── ящик маршрута ─────────── */

function RouteDrawer({
  route,
  open,
  slow,
  onClose,
}: {
  route: OpsRouteStat | null;
  open: boolean;
  slow: readonly OpsSlowRequest[];
  onClose: () => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const mine = route ? slow.filter((s) => s.method === route.method && s.route === route.route) : [];
  const slowest = mine.reduce<OpsSlowRequest | null>((m, s) => (!m || s.ms > m.ms ? s : m), null);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={route ? <span className="font-mono text-[15px] font-bold tracking-normal">{route.route}</span> : ut("ops.routes.title")}
      sub={route ? fill(ut("opx.rq.drawerSub"), { method: route.method }) : undefined}
      icon={<OpsIcon name="arrow-left-right" />}
      tone={route?.errors5xx ? "warn" : "violet"}
      note={ut("opx.rq.drawerNote")}
      noteIcon={<OpsIcon name="shield-check" />}
      footer={
        route ? (
          <>
            {slowest ? (
              <ButtonLink to={`/ops/trace/${encodeURIComponent(slowest.requestId)}`} variant="primary">
                <OpsIcon name="route" size={15} />
                {ut("opx.rq.slowestTrace")}
              </ButtonLink>
            ) : null}
            <ButtonLink to={`/ops/logs?q=${encodeURIComponent(route.route)}`}>
              <OpsIcon name="scroll-text" size={15} />
              {ut("opx.rq.routeLogs")}
            </ButtonLink>
          </>
        ) : null
      }
    >
      {route ? (
        <>
          <DrawerSection title={ut("opx.rq.sinceStartTitle")}>
            <KV
              w={110}
              rows={[
                [ut("ops.col.count"), <b key="n">{fmtInt(route.requests, loc)}</b>],
                [ut("ops.col.c4"), fmtInt(route.errors4xx, loc)],
                [
                  ut("ops.col.c5"),
                  route.errors5xx ? (
                    <span key="5" className="flex flex-wrap items-center gap-2">
                      <StatusMark tone="fail">{fmtInt(route.errors5xx, loc)}</StatusMark>
                      <span className="text-text-2">
                        {fill(ut("opx.rq.shareOfAll"), { v: fmtShare(route.errors5xx / route.requests, loc), m: fmtInt(route.requests, loc) })}
                      </span>
                    </span>
                  ) : (
                    "0"
                  ),
                ],
                [ut("ops.col.avg"), fmtMs(route.avgMs, loc)],
                [ut("opx.rq.p50p95"), `${fmtMs(route.p50, loc)} / ${fmtMs(route.p95, loc)}`],
                [ut("opx.rq.p99max"), `${fmtMs(route.p99, loc)} / ${fmtMs(route.maxMs, loc)}`],
              ]}
            />
          </DrawerSection>
          <DrawerSection title={ut("opx.rq.slowOfRoute")}>
            {mine.length ? (
              <ul className="m-0 list-none p-0">
                {mine.map((s) => (
                  <li key={`${s.requestId}-${s.at}`} className="flex min-h-10 items-center gap-2.5 border-t border-divider first:border-t-0">
                    <Mono className="text-text-2">{clock(s.at, loc)}</Mono>
                    <HttpCode code={s.code} />
                    <b className="whitespace-nowrap font-extrabold">{fmtMs(s.ms, loc)}</b>
                    <span className="ml-auto">
                      <RequestId id={s.requestId} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Quiet>{ut("opx.rq.slowNone")}</Quiet>
            )}
          </DrawerSection>
          {route.errors5xx ? (
            <DrawerSection>
              <Callout
                kind="warn"
                title={ut("opx.rq.failTitle")}
                actions={
                  <ButtonLink to={`/ops/errors?q=${encodeURIComponent(route.route)}`} size="xs">
                    <OpsIcon name="bug" size={14} />
                    {ut("opx.rq.toErrors")}
                  </ButtonLink>
                }
              >
                {fill(ut("opx.rq.failText"), { n: fmtInt(route.errors5xx, loc), m: fmtInt(route.requests, loc) })}
              </Callout>
            </DrawerSection>
          ) : null}
        </>
      ) : null}
    </Drawer>
  );
}
