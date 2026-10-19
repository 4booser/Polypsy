import { useMemo, useState } from "react";
import type { OpsDb, OpsDbNote, OpsLongQuery, OpsTableStat, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { day, locale } from "../../format";
import { useLang } from "../../lang";
import { Callout, DataTable, FilterBar, Loading, Popover, type Column } from "../../ui";
import { cx } from "../../ui/cx";
import { IconTile, Panel } from "../../ui/layout";
import { Button, ButtonLink, Segmented, Tag } from "../../ui/primitives";
import { fill } from "../dashboard/model";
import { ConnectionsShare, TableCharts } from "./charts";
import { OpsIcon } from "./icons";
import { CONN_KEY, deadRowsAlarm, fmtAgo, fmtBytes, fmtInt, fmtSec, fmtShare } from "./model";
import {
  CopyLinkButton,
  GridRow,
  GridTable,
  Live,
  MetricsTable,
  Mono,
  OpsHead,
  OpsToolbar,
  PanelNote,
  Quiet,
  StatusMark,
  Was,
  type MetricRow,
  useOpsResource,
} from "./parts";

/*
 * База: что занимает место, кто подключён, что висит и что ждёт.
 *
 * В отличие от остальных вкладок, здесь не память процесса, а состояние
 * базы в момент вопроса: pg_stat_activity, pg_locks, размеры — поэтому
 * вместо «з моменту запуску» над вкладкой написано «стан зараз».
 *
 * Сверху — «Показники» таблицей: размер, подключения, долгие запросы,
 * блокировки, миграции, у каждого — сравнение и состояние словом. Ниже —
 * место и подключения (самые большие таблицы, мёртвые строки янтарём там,
 * где автоочистка не успевает, подключения по состояниям), таблица строк
 * с поиском и порядком, ожидания блокировок, долгие запросы и миграции.
 *
 * Роли приложения в бою может не хватать прав на pg_stat_activity или на
 * схему миграций. Тогда раздел пуст, а над ним — почему (коды notes с
 * сервера, lib/opsDb.ts); остальные разделы на месте.
 */

const POLL_MS = 30_000;
const LONG_SEC = 5;
const MIGRATIONS_SHOWN = 6;

const NOTE_KEY: Record<OpsDbNote, UiKey> = {
  activityDenied: "ops.db.note.activityDenied",
  activityPartial: "ops.db.note.activityPartial",
  tablesFailed: "ops.db.note.tablesFailed",
  locksFailed: "ops.db.note.locksFailed",
  migrationsDenied: "ops.db.note.migrationsDenied",
  sizeFailed: "ops.db.note.sizeFailed",
};

type TableOrder = "size" | "dead" | "seq";
const ORDER_SORT = { size: "size", dead: "dead", seq: "seq" } as const;

/** Похоже, что таблице не хватает индекса: полных чтений больше, чем по индексу, и строк немало */
export function missingIndex(t: Pick<OpsTableStat, "seqScan" | "idxScan" | "liveRows">): boolean {
  return (t.seqScan ?? 0) > 100 && (t.seqScan ?? 0) > (t.idxScan ?? 0) && (t.liveRows ?? 0) > 10_000;
}

export default function OpsDatabase() {
  const { ut } = useLang();
  const loc = locale();
  const res = useOpsResource(() => api.opsDb(), [], POLL_MS);
  const d = res.data;

  const head = (
    <OpsHead
      meta={[d?.bytes !== null && d?.bytes !== undefined ? fill(ut("opx.db.metaSize"), { size: fmtBytes(d.bytes, loc) }) : ut("ops.tab.db"), ut("opx.db.metaLive")]}
      actions={
        <>
          <ButtonLink to="/ops/statements">
            <OpsIcon name="turtle" size={15} />
            {ut("ops.tab.statements")}
          </ButtonLink>
          <CopyLinkButton />
        </>
      }
      toolbar={
        <OpsToolbar right={<Live pollSec={POLL_MS / 1000} updatedAt={res.updatedAt} />}>
          <Tag tone="info" icon={<OpsIcon name="activity" />}>
            {ut("opx.db.now")}
          </Tag>
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
  if (!d) {
    return (
      <>
        {head}
        <Loading rows={6} />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {head}
      {d.notes.length ? (
        <Callout kind="info" icon={<OpsIcon name="eye-off" />} title={ut("opx.db.notesTitle")}>
          <ul className="m-0 list-none p-0">
            {d.notes.map((n) => (
              <li key={n}>{ut(NOTE_KEY[n])}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <Panel title={ut("opx.db.metrics")} icon={<OpsIcon name="gauge" />} sub={ut("opx.db.metricsSub")} flush>
        <MetricsTable label={ut("opx.db.metrics")} rows={metricRows(d, ut, loc)} />
      </Panel>
      <SpacePanel d={d} />
      <RowsPanel d={d} />
      <LocksPanel d={d} />
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-4 max-[1100px]:grid-cols-1">
        <LongPanel d={d} />
        <MigrationsPanel d={d} />
      </div>
    </div>
  );
}

/* ─────────── показники ─────────── */

function metricRows(d: OpsDb, ut: (k: UiKey) => string, loc: string): MetricRow[] {
  const biggest = d.tables?.length ? d.tables.reduce((m, t) => (t.totalBytes > m.totalBytes ? t : m)) : null;
  const c = d.connections;
  const free = c?.max ? c.max - c.total : null;
  const longest = d.longQueries?.length ? d.longQueries.reduce((m, q) => (q.seconds > m.seconds ? q : m)) : null;
  const waits = d.locks ?? null;
  const longestWait = waits?.length ? waits.reduce((m, l) => (l.seconds > m.seconds ? l : m)) : null;
  const m = d.migrations;
  const lastM = m?.applied[0] ?? null;
  const stateCount = (state: string) => c?.byState.find((s) => s.state === state)?.count ?? 0;
  const unknown = <Was>{ut("ops.db.unavailable")}</Was>;

  return [
    {
      key: "size",
      label: ut("ops.data.size"),
      now: fmtBytes(d.bytes, loc),
      compare: biggest ? (
        <>
          {ut("opx.db.biggest")} <Mono>{biggest.table}</Mono>
          {`, ${fmtBytes(biggest.totalBytes, loc)}`}
        </>
      ) : (
        "—"
      ),
      state: d.tables ? <Was>{fill(ut("opx.db.tablesCount"), { n: fmtInt(d.tables.length, loc) })}</Was> : unknown,
    },
    {
      key: "conn",
      label: ut("ops.db.connections"),
      now: c ? (c.max ? fill(ut("ops.db.connOf"), { n: fmtInt(c.total, loc), max: fmtInt(c.max, loc) }) : fmtInt(c.total, loc)) : "—",
      compare: c
        ? fill(ut("opx.db.connCompare"), {
            active: fmtInt(stateCount("active"), loc),
            idle: fmtInt(stateCount("idle"), loc),
            tx: fmtInt(stateCount("idle_in_transaction"), loc),
          })
        : ut("ops.kpi.dbConnHidden"),
      state:
        free === null || !c?.max ? (
          unknown
        ) : (
          <StatusMark tone={free < c.max * 0.1 ? "warn" : "ok"}>{fill(ut("opx.ov.headroom"), { n: fmtInt(free, loc) })}</StatusMark>
        ),
    },
    {
      key: "long",
      label: ut("ops.db.long"),
      now: d.longQueries ? fmtInt(d.longQueries.length, loc) : "—",
      compare: longest ? fill(ut("opx.db.longest"), { pid: longest.pid, s: fmtSec(longest.seconds, loc) }) : ut("ops.db.longEmpty"),
      state: !d.longQueries ? (
        unknown
      ) : d.longQueries.length ? (
        <StatusMark tone="warn">{fill(ut("opx.db.longer"), { s: fmtSec(LONG_SEC, loc) })}</StatusMark>
      ) : (
        <StatusMark tone="ok">{ut("opx.db.noLong")}</StatusMark>
      ),
    },
    {
      key: "locks",
      label: ut("opx.db.locksLabel"),
      now: waits ? fmtInt(waits.length, loc) : "—",
      compare: longestWait
        ? fill(ut("opx.db.longestWait"), { pid: longestWait.pid, s: fmtSec(longestWait.seconds, loc), rel: longestWait.relation ?? "—" })
        : ut("ops.db.locksEmpty"),
      state: !waits ? (
        unknown
      ) : waits.length ? (
        <StatusMark tone="warn">{fill(ut("opx.db.waiting"), { n: fmtInt(waits.length, loc) })}</StatusMark>
      ) : (
        <StatusMark tone="ok">{ut("opx.db.nobodyWaits")}</StatusMark>
      ),
    },
    {
      key: "migrations",
      label: ut("ops.db.migrations"),
      now: m ? fill(ut("ops.db.connOf"), { n: fmtInt(m.appliedCount, loc), max: fmtInt(m.known, loc) }) : "—",
      compare: lastM ? (
        <>
          {ut("opx.db.lastMigration")} <Mono>{lastM.tag ?? ut("ops.db.unknownTag")}</Mono>
          {`, ${day(lastM.at)}`}
        </>
      ) : (
        "—"
      ),
      state: !m ? (
        unknown
      ) : m.pending > 0 ? (
        <StatusMark tone="fail">{fill(ut("ops.data.pending"), { n: m.pending })}</StatusMark>
      ) : (
        <StatusMark tone="ok">{ut("opx.db.schemaOk")}</StatusMark>
      ),
    },
  ];
}

/* ─────────── место и подключения ─────────── */

function SpacePanel({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const c = d.connections;
  return (
    <Panel title={ut("opx.db.space")} icon={<OpsIcon name="hard-drive" />}>
      <div className="grid grid-cols-3 gap-6 max-[1180px]:grid-cols-2 max-[800px]:grid-cols-1">
        {d.tables ? <TableCharts tables={d.tables} /> : <Quiet>{ut("ops.db.unavailable")}</Quiet>}
        <figure className="m-0 min-w-0">
          <figcaption className="mb-3">
            <span className="block text-body font-extrabold leading-[18px] text-text">{ut("ops.db.connections")}</span>
            <span className="mt-0.5 block text-caption leading-4 text-muted">{ut("ops.ch.connHint")}</span>
          </figcaption>
          {c ? (
            <>
              <div className="mb-2 flex items-baseline gap-2">
                <b className="text-stat font-extrabold leading-none tabular-nums text-text">{fmtInt(c.total, loc)}</b>
                {c.max ? <span className="text-small text-text-2">{fill(ut("ops.kpi.dbConnHint"), { max: fmtInt(c.max, loc) })}</span> : null}
              </div>
              <ConnectionsShare c={c} />
            </>
          ) : (
            <Quiet>{ut("ops.db.unavailable")}</Quiet>
          )}
        </figure>
      </div>
    </Panel>
  );
}

/* ─────────── строки и автоочистка ─────────── */

function RowsPanel({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<TableOrder>("size");
  const now = Date.now();
  const tables = d.tables;
  const rows = useMemo(() => (tables ?? []).filter((t) => t.table.toLowerCase().includes(q.trim().toLowerCase())), [tables, q]);
  const hint = (tables ?? []).find(missingIndex) ?? null;

  const columns: Column<OpsTableStat>[] = [
    {
      key: "table",
      header: ut("ops.col.table"),
      required: true,
      sort: (t) => t.table,
      render: (t) => <Mono className={cx("text-text", deadRowsAlarm(t) || missingIndex(t) ? "font-bold" : undefined)}>{t.table}</Mono>,
    },
    { key: "size", header: ut("opx.db.colSize"), num: true, width: 92, required: true, sort: (t) => t.totalBytes, render: (t) => fmtBytes(t.totalBytes, loc) },
    { key: "live", header: ut("ops.col.live"), num: true, width: 110, required: true, sort: (t) => t.liveRows, render: (t) => fmtInt(t.liveRows, loc) },
    {
      key: "dead",
      header: ut("ops.col.dead"),
      num: true,
      width: 130,
      required: true,
      sort: (t) => t.deadRows,
      render: (t) => {
        const share = t.liveRows ? (t.deadRows ?? 0) / t.liveRows : null;
        return (
          <span className="inline-flex items-center justify-end gap-2">
            {deadRowsAlarm(t) ? (
              <StatusMark tone="warn" className="font-extrabold">
                {fmtInt(t.deadRows, loc)}
              </StatusMark>
            ) : (
              <span>{fmtInt(t.deadRows, loc)}</span>
            )}
            {share !== null ? <span className="w-9 text-caption text-muted">{fmtShare(share, loc)}</span> : null}
          </span>
        );
      },
    },
    {
      key: "seq",
      header: ut("ops.col.seqScan"),
      num: true,
      width: 112,
      required: true,
      sort: (t) => t.seqScan,
      render: (t) => <span className={missingIndex(t) ? "font-extrabold text-warn" : undefined}>{fmtInt(t.seqScan, loc)}</span>,
    },
    { key: "idx", header: ut("ops.col.idxScan"), num: true, width: 104, required: true, sort: (t) => t.idxScan, render: (t) => fmtInt(t.idxScan, loc) },
    {
      key: "vacuum",
      header: ut("ops.col.vacuum"),
      width: 150,
      required: true,
      sort: (t) => t.lastAutovacuum ?? t.lastAutoanalyze,
      render: (t) => (
        <span className={deadRowsAlarm(t) ? "font-extrabold text-warn" : "text-text-2"}>
          {t.lastAutovacuum || t.lastAutoanalyze ? fmtAgo(t.lastAutovacuum ?? t.lastAutoanalyze, now, loc) : ut("opx.db.never")}
        </span>
      ),
    },
    {
      key: "fix",
      header: "",
      width: 140,
      required: true,
      render: (t) => (deadRowsAlarm(t) || missingIndex(t) ? <FixHint t={t} /> : null),
    },
  ];

  return (
    <Panel
      title={ut("ops.db.rowsTitle")}
      icon={<OpsIcon name="table-2" />}
      sub={tables ? fill(ut("opx.db.rowsSub"), { n: tables.length }) : undefined}
      flush
      footer={
        hint ? (
          <PanelNote icon="lightbulb">
            <Mono className="font-bold text-text">{hint.table}</Mono>
            {`: ${fill(ut("opx.db.indexHint"), { n: fmtInt(hint.seqScan, loc) })}`}
          </PanelNote>
        ) : undefined
      }
    >
      {!tables ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.db.unavailable")}</Quiet>
        </div>
      ) : (
        <>
          <div className="px-4 pb-3">
            <FilterBar
              search={{ value: q, onChange: setQ, placeholder: ut("ops.col.table"), width: 240 }}
              chips={
                <Segmented
                  label={ut("opx.er.order")}
                  value={order}
                  onChange={setOrder}
                  items={[
                    { key: "size", label: ut("opx.db.bySize") },
                    { key: "dead", label: ut("opx.db.byDead") },
                    { key: "seq", label: ut("opx.db.bySeq") },
                  ]}
                />
              }
            />
          </div>
          {rows.length ? (
            <DataTable
              key={order}
              rows={rows}
              columns={columns}
              rowKey={(t) => t.table}
              initialSort={{ key: ORDER_SORT[order], desc: true }}
              dense
              sticky={false}
              label={ut("ops.db.rowsTitle")}
            />
          ) : (
            <div className="px-4 pb-3">
              <Quiet>{ut("opx.db.noTable")}</Quiet>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** «Як виправити»: подсказка по требованию — что делать с таблицей, где автоочистка не успевает или нет индекса */
function FixHint({ t }: { t: OpsTableStat }) {
  const { ut } = useLang();
  const dead = deadRowsAlarm(t);
  return (
    <Popover
      title={ut(dead ? "opx.db.fixDeadTitle" : "opx.db.fixIndexTitle")}
      width={340}
      content={
        <div className="flex flex-col gap-2">
          <span>{ut(dead ? "opx.db.fixDead" : "opx.db.fixIndex")}</span>
          {dead ? (
            <code className="block rounded-[8px] bg-sunk px-2 py-1.5 font-mono text-[12px] text-text">{`VACUUM (ANALYZE) ${t.table};`}</code>
          ) : null}
        </div>
      }
    >
      <Button variant="ghost" size="xs" icon={<OpsIcon name="lightbulb" />}>
        {ut("opx.db.howToFix")}
      </Button>
    </Popover>
  );
}

/* ─────────── блокировки ─────────── */

const LOCK_COLS = "grid-cols-[72px_80px_minmax(150px,200px)_minmax(110px,160px)_96px_minmax(0,1fr)]";

function LocksPanel({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const locks = d.locks;
  return (
    <Panel title={ut("ops.db.locks")} icon={<OpsIcon name="lock" />} sub={ut("opx.db.nowWord")} flush={!!locks?.length}>
      {!locks ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : locks.length === 0 ? (
        <div className="flex items-center gap-3">
          <IconTile tone="good" icon={<OpsIcon name="lock-open" />} />
          <div className="min-w-0">
            <b className="block text-[13.5px] font-extrabold text-text">{ut("ops.db.locksEmpty")}</b>
            <span className="text-small text-text-2">{ut("ops.db.locksHint")}</span>
          </div>
        </div>
      ) : (
        <GridTable
          label={ut("ops.db.locks")}
          cols={LOCK_COLS}
          minW="min-w-[860px]"
          head={[ut("ops.col.pid"), ut("ops.col.waits"), ut("ops.col.lock"), ut("ops.col.table"), ut("ops.col.blockedBy"), ut("ops.col.query")]}
        >
          {locks.map((l) => (
            <GridRow key={`${l.pid}-${l.lockType}-${l.relation ?? ""}`} cols={LOCK_COLS} className="items-start">
              <Mono className="text-text-2">{l.pid}</Mono>
              <b className="font-extrabold tabular-nums text-warn">{fmtSec(l.seconds, loc)}</b>
              <Mono className="break-all text-text-2">{`${l.lockType}, ${l.lockMode}`}</Mono>
              <Mono className="break-all text-text">{l.relation ?? "—"}</Mono>
              <Mono className="text-text">{l.blockedBy.length ? l.blockedBy.join(", ") : "—"}</Mono>
              <Mono className="break-words text-text">{l.query}</Mono>
            </GridRow>
          ))}
        </GridTable>
      )}
    </Panel>
  );
}

/* ─────────── долгие запросы ─────────── */

function LongPanel({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const list = d.longQueries;
  return (
    <Panel
      title={ut("ops.db.long")}
      icon={<OpsIcon name="hourglass" />}
      tone={list?.length ? "warn" : "violet"}
      sub={fill(ut("opx.db.longer"), { s: fmtSec(LONG_SEC, loc) })}
      count={list?.length || null}
      footer={<PanelNote>{ut("opx.db.longNote")}</PanelNote>}
    >
      {!list ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : list.length === 0 ? (
        <Quiet>{ut("ops.db.longEmpty")}</Quiet>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {list.map((q) => (
            <LongQuery key={q.pid} q={q} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LongQuery({ q }: { q: OpsLongQuery }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <li className="min-w-0">
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-4 gap-y-1 text-small min-[700px]:grid-cols-[80px_80px_minmax(0,1fr)_minmax(0,1.2fr)]">
        <span className="flex flex-col">
          <span className="text-caption font-bold text-muted">{ut("ops.col.pid")}</span>
          <Mono className="text-text">{q.pid}</Mono>
        </span>
        <span className="flex flex-col">
          <span className="text-caption font-bold text-muted">{ut("ops.col.lasts")}</span>
          <b className="font-extrabold tabular-nums text-warn">{fmtSec(q.seconds, loc)}</b>
        </span>
        <span className="flex flex-col">
          <span className="text-caption font-bold text-muted">{ut("ops.col.state")}</span>
          {q.state ? (
            <StatusMark tone={q.state === "active" ? "run" : "quiet"}>{ut(CONN_KEY[q.state])}</StatusMark>
          ) : (
            <span className="text-muted">—</span>
          )}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-caption font-bold text-muted">{ut("ops.col.wait")}</span>
          <Mono className="truncate text-text">{q.waitEvent ?? "—"}</Mono>
        </span>
      </div>
      <span className="mb-1 mt-3 block text-caption font-bold text-muted">{ut("ops.col.query")}</span>
      <pre className="m-0 whitespace-pre-wrap rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text [overflow-wrap:anywhere]">
        {q.query}
      </pre>
    </li>
  );
}

/* ─────────── миграции ─────────── */

function MigrationsPanel({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const m = d.migrations;
  const [all, setAll] = useState(false);
  const list = m ? (all ? m.applied : m.applied.slice(0, MIGRATIONS_SHOWN)) : [];
  const newest = m?.applied[0]?.at ?? null;
  return (
    <Panel
      title={ut("ops.db.migrations")}
      icon={<OpsIcon name="git-branch" />}
      sub={m ? fill(ut("ops.db.migrationsSummary"), { applied: m.appliedCount, known: m.known }) : undefined}
      actions={
        m ? (
          m.pending > 0 ? (
            <StatusMark tone="fail">{fill(ut("ops.data.pending"), { n: m.pending })}</StatusMark>
          ) : (
            <StatusMark tone="ok">{ut("opx.db.schemaMatches")}</StatusMark>
          )
        ) : null
      }
      flush
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          {m && m.applied.length > MIGRATIONS_SHOWN ? (
            <Button variant="ghost" size="xs" icon={<OpsIcon name={all ? "chevron-up" : "chevron-down"} />} onClick={() => setAll(!all)}>
              {all ? ut("opx.rq.showLess") : fill(ut("opx.rq.showAll"), { n: m.applied.length })}
            </Button>
          ) : null}
          <span className="ml-auto text-caption text-muted">{ut("opx.db.journalNote")}</span>
        </div>
      }
    >
      {!m ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.db.unavailable")}</Quiet>
        </div>
      ) : m.applied.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.db.migrationsEmpty")}</Quiet>
        </div>
      ) : (
        <GridTable
          label={ut("ops.db.migrations")}
          cols="grid-cols-[48px_minmax(0,1fr)_110px]"
          minW="min-w-[380px]"
          head={[ut("ops.col.number"), ut("ops.col.migration"), <span key="s" className="block text-right">{ut("ops.col.stamp")}</span>]}
        >
          {list.map((x) => (
            <GridRow key={x.at} cols="grid-cols-[48px_minmax(0,1fr)_110px]">
              <span className="tabular-nums text-text-2">{x.idx ?? "—"}</span>
              <span className="flex min-w-0 items-center gap-2">
                <Mono className="truncate text-text">{x.tag ?? ut("ops.db.unknownTag")}</Mono>
                {newest && x.at === newest ? <Tag tone="primary">{ut("opx.db.latest")}</Tag> : null}
              </span>
              <Mono className="text-right text-text-2">{day(x.at)}</Mono>
            </GridRow>
          ))}
        </GridTable>
      )}
    </Panel>
  );
}
