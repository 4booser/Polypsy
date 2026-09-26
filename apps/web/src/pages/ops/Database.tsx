import type { OpsDb, OpsDbNote, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { HBars, ShareBar } from "../../charts/clinical";
import { day, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading } from "../../ui";
import { Num } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { CONN_KEY, fmtAgo, fmtBytes, fmtInt, fmtSec } from "./model";
import { Cell, GridRow, GridTable, NumHead, Quiet, Stamp, StatusMark, useOpsResource } from "./parts";

/*
 * База: что занимает место, кто подключён, что висит и что ждёт.
 *
 * В отличие от остальных вкладок, здесь не память процесса, а состояние
 * базы в момент вопроса: pg_stat_activity, pg_locks, размеры — поэтому
 * вместо «з моменту запуску» над вкладкой написано «стан зараз».
 *
 * Роли приложения в бою может не хватать прав на pg_stat_activity или на
 * схему миграций. Тогда раздел пуст, а над ним — почему (коды notes с
 * сервера, lib/opsDb.ts); остальные разделы на месте.
 */

const POLL_MS = 30_000;

const NOTE_KEY: Record<OpsDbNote, UiKey> = {
  activityDenied: "ops.db.note.activityDenied",
  activityPartial: "ops.db.note.activityPartial",
  tablesFailed: "ops.db.note.tablesFailed",
  locksFailed: "ops.db.note.locksFailed",
  migrationsDenied: "ops.db.note.migrationsDenied",
  sizeFailed: "ops.db.note.sizeFailed",
};

const ROWS_COLS = "grid-cols-[minmax(180px,1fr)_96px_96px_96px_96px_130px]";
const LONG_COLS = "grid-cols-[64px_72px_minmax(120px,170px)_minmax(110px,160px)_minmax(0,1fr)]";
const LOCK_COLS = "grid-cols-[64px_72px_minmax(150px,200px)_minmax(110px,160px)_96px_minmax(0,1fr)]";
const MIGR_COLS = "grid-cols-[56px_minmax(0,1fr)_140px]";

export default function OpsDatabase() {
  const { ut } = useLang();
  const res = useOpsResource(() => api.opsDb(), [], POLL_MS);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const d = res.data;

  return (
    <div>
      <Stamp updatedAt={res.updatedAt} note={ut("ops.db.live")} />
      {d.notes.length ? (
        <ul className="m-0 mt-[8px] list-none p-0">
          {d.notes.map((n) => (
            <li key={n} className="py-[4px] text-[13px] leading-[18px] text-muted">
              {ut(NOTE_KEY[n])}
            </li>
          ))}
        </ul>
      ) : null}

      <Tables d={d} />
      <Connections d={d} />
      <LongQueries d={d} />
      <Locks d={d} />
      <Migrations d={d} />
    </div>
  );
}

function Tables({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const now = Date.now();
  return (
    <RuleSection
      className="mt-[16px]"
      title={ut("ops.db.tables")}
      hint={ut("ops.db.tablesHint")}
      actions={
        d.bytes !== null ? (
          <Num className="text-[13px] text-muted">{fill(ut("ops.db.total"), { size: fmtBytes(d.bytes, loc) })}</Num>
        ) : null
      }
    >
      {!d.tables ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : (
        <div className="grid grid-cols-1 gap-x-[45px] gap-y-[28px] min-[1100px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <HBars
            items={d.tables.map((t) => ({
              key: t.table,
              label: <span className="font-mono text-[12px]">{t.table}</span>,
              value: t.totalBytes,
              text: fmtBytes(t.totalBytes, loc),
            }))}
          />
          <GridTable
            label={ut("ops.db.rowsTitle")}
            cols={ROWS_COLS}
            minW="min-w-[660px]"
            head={[
              ut("ops.col.table"),
              <NumHead key="l">{ut("ops.col.live")}</NumHead>,
              <NumHead key="d">{ut("ops.col.dead")}</NumHead>,
              <NumHead key="s">{ut("ops.col.seqScan")}</NumHead>,
              <NumHead key="i">{ut("ops.col.idxScan")}</NumHead>,
              ut("ops.col.vacuum"),
            ]}
          >
            {d.tables.map((t) => (
              <GridRow key={t.table} cols={ROWS_COLS}>
                <Cell className="truncate font-mono text-[12px] text-text">{t.table}</Cell>
                <Cell num>{fmtInt(t.liveRows, loc)}</Cell>
                {/*
                  Мёртвых больше пятой части живых — автоочистка не успевает:
                  таблица пухнет, и выборки по ней медленнеют. Это требует
                  внимания, остальное — нет.
                */}
                <Cell
                  num
                  className={
                    t.deadRows !== null && t.liveRows !== null && t.deadRows > 1000 && t.deadRows > t.liveRows * 0.2
                      ? "font-bold text-accent"
                      : "text-muted"
                  }
                >
                  {fmtInt(t.deadRows, loc)}
                </Cell>
                <Cell num className="text-muted">
                  {fmtInt(t.seqScan, loc)}
                </Cell>
                <Cell num className="text-muted">
                  {fmtInt(t.idxScan, loc)}
                </Cell>
                <Cell className="truncate text-muted">{fmtAgo(t.lastAutovacuum ?? t.lastAutoanalyze, now, loc)}</Cell>
              </GridRow>
            ))}
          </GridTable>
        </div>
      )}
    </RuleSection>
  );
}

function Connections({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  const c = d.connections;
  return (
    <RuleSection
      title={ut("ops.db.connections")}
      actions={
        c ? (
          <Num className="text-[13px] text-muted">
            {c.max
              ? fill(ut("ops.db.connOf"), { n: fmtInt(c.total, loc), max: fmtInt(c.max, loc) })
              : fmtInt(c.total, loc)}
          </Num>
        ) : null
      }
    >
      {!c ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : (
        <ShareBar
          label={ut("ops.db.connections")}
          parts={c.byState.map((s, i) => ({
            key: s.state,
            label: ut(CONN_KEY[s.state]),
            value: s.count,
            /* одна величина — один тон, порядок читается светлотой: самое частое темнее */
            step: c.byState.length > 1 ? 1 - i / (c.byState.length - 1) : 1,
          }))}
        />
      )}
    </RuleSection>
  );
}

function LongQueries({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <RuleSection title={ut("ops.db.long")} hint={ut("ops.db.longHint")}>
      {!d.longQueries ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : d.longQueries.length === 0 ? (
        <Quiet>{ut("ops.db.longEmpty")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.db.long")}
          cols={LONG_COLS}
          minW="min-w-[760px]"
          head={[
            ut("ops.col.pid"),
            <NumHead key="t">{ut("ops.col.lasts")}</NumHead>,
            ut("ops.col.state"),
            ut("ops.col.wait"),
            ut("ops.col.query"),
          ]}
        >
          {d.longQueries.map((q) => (
            <GridRow key={q.pid} cols={LONG_COLS} className="items-start">
              <Cell className="font-mono text-[12px] text-muted">{q.pid}</Cell>
              <Cell num className="font-bold text-accent">
                {fmtSec(q.seconds, loc)}
              </Cell>
              <Cell className="text-text-2">{q.state ? ut(CONN_KEY[q.state]) : "—"}</Cell>
              <Cell className="break-all font-mono text-[12px] text-muted">{q.waitEvent ?? "—"}</Cell>
              <Cell className="break-words font-mono text-[12px] text-text">{q.query}</Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </RuleSection>
  );
}

function Locks({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <RuleSection title={ut("ops.db.locks")} hint={ut("ops.db.locksHint")}>
      {!d.locks ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : d.locks.length === 0 ? (
        <Quiet>{ut("ops.db.locksEmpty")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.db.locks")}
          cols={LOCK_COLS}
          minW="min-w-[860px]"
          head={[
            ut("ops.col.pid"),
            <NumHead key="t">{ut("ops.col.waits")}</NumHead>,
            ut("ops.col.lock"),
            ut("ops.col.table"),
            ut("ops.col.blockedBy"),
            ut("ops.col.query"),
          ]}
        >
          {d.locks.map((l) => (
            <GridRow key={`${l.pid}-${l.lockType}-${l.relation ?? ""}`} cols={LOCK_COLS} className="items-start">
              <Cell className="font-mono text-[12px] text-muted">{l.pid}</Cell>
              <Cell num className="font-bold text-accent">
                {fmtSec(l.seconds, loc)}
              </Cell>
              <Cell className="break-all font-mono text-[12px] text-text-2">
                {l.lockType} · {l.lockMode}
              </Cell>
              <Cell className="break-all font-mono text-[12px] text-text">{l.relation ?? "—"}</Cell>
              <Cell className="font-mono text-[12px] text-text">{l.blockedBy.length ? l.blockedBy.join(", ") : "—"}</Cell>
              <Cell className="break-words font-mono text-[12px] text-text">{l.query}</Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </RuleSection>
  );
}

function Migrations({ d }: { d: OpsDb }) {
  const { ut } = useLang();
  const m = d.migrations;
  return (
    <RuleSection
      title={ut("ops.db.migrations")}
      actions={
        m ? (
          <span className="flex flex-wrap items-center gap-x-[14px]">
            <Num className="text-[13px] text-muted">
              {fill(ut("ops.db.migrationsSummary"), { applied: m.appliedCount, known: m.known })}
            </Num>
            {m.pending > 0 ? <StatusMark tone="fail">{fill(ut("ops.data.pending"), { n: m.pending })}</StatusMark> : null}
          </span>
        ) : null
      }
    >
      {!m ? (
        <Quiet>{ut("ops.db.unavailable")}</Quiet>
      ) : m.applied.length === 0 ? (
        <Quiet>{ut("ops.db.migrationsEmpty")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.db.migrations")}
          cols={MIGR_COLS}
          minW="min-w-[420px]"
          head={[<NumHead key="n">{ut("ops.col.number")}</NumHead>, ut("ops.col.migration"), ut("ops.col.stamp")]}
        >
          {m.applied.map((x) => (
            <GridRow key={x.at} cols={MIGR_COLS}>
              <Cell num className="text-muted">
                {x.idx ?? "—"}
              </Cell>
              <Cell className="truncate font-mono text-[12px] text-text">{x.tag ?? ut("ops.db.unknownTag")}</Cell>
              <Cell className="text-muted">{day(x.at)}</Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </RuleSection>
  );
}
