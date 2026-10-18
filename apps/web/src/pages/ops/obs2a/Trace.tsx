import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type { OpsErrorGroup, OpsLevel, OpsSqlTop, OpsTrace, OpsTraceAudit } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { DataTable, Loading, useToast, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconTile, Panel } from "../../../ui/layout";
import { Button, ButtonLink, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { LEVEL_KEY, ROLE_KEY, clock, fieldsText, fmtInt, fmtMs, fmtShare, shortId } from "../model";
import {
  CopyLinkButton,
  HttpCode,
  MethodRoute,
  Mono,
  OpsHead,
  PanelNote,
  Quiet,
  RefreshButton,
  StatusMark,
  TraceBox,
  useCount,
} from "../parts";
import { TraceTime } from "./charts";
import { OUTCOME_KEY, offsets } from "./model";

/*
 * Траса запиту — всё о одном обращении на одной странице (/ops/trace/:id).
 *
 * Решение заказчика 2026-09-26: человек называет номер с экрана ошибки,
 * разработчик открывает одну страницу — итог (маршрут, код, время, роль,
 * SQL), куда ушло время, все строки лога по порядку со смещением от
 * начала, ошибка со стеком, самые долгие SQL и записи журнала. Собирает
 * сервер (apps/api/src/lib/opsTrace.ts) из истории в базе и памяти
 * процесса; строгое правило — только этот номер.
 *
 * Трасса не опрашивается: запрос уже кончился, и новых строк у него не
 * будет. «Оновити» — на случай, когда открыли раньше, чем история успела
 * записаться (такт записи — десять секунд).
 *
 * Из журнала — действие, исход, вид ресурса и роль, без людей: право
 * ops.read не открывает ни почт, ни адресатов, подробности записи — во
 * вкладке «Аудит» по праву audit.read. Чтение трассы само пишется в журнал.
 *
 * Пошагового водопада (сколько шёл каждый SQL от начала запроса) нет:
 * сервер хранит SQL запроса суммами по тексту, а не отрезками времени.
 */

export default function OpsTracePage() {
  const { requestId = "" } = useParams();
  const { ut } = useLang();
  const res = useResource(() => api.opsTrace(requestId), [requestId]);

  return (
    <div className="flex flex-col gap-4">
      <OpsHead
        title={ut("ops.trace.open")}
        back={{ to: "/ops/requests", label: ut("ops.tab.requests") }}
        meta={[<Mono key="id">{shortId(requestId)}</Mono>, ut("opx.tr.metaAudit")]}
        actions={
          <>
            <TraceBox key={requestId} initial={requestId} wide />
            <RefreshButton onRefresh={res.reload} busy={res.loading} />
            <CopyLinkButton />
          </>
        }
      />
      {res.error && !res.data ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : (
        <TraceBody t={res.data} onReload={res.reload} />
      )}
    </div>
  );
}

function TraceBody({ t, onReload }: { t: OpsTrace; onReload: () => void }) {
  const { ut } = useLang();

  if (t.candidates.length) {
    return (
      <Panel title={ut("ops.trace.ambiguous")} icon={<OpsIcon name="route" />} hint={ut("ops.trace.ambiguousHint")}>
        <ul className="m-0 list-none p-0">
          {t.candidates.map((id) => (
            <li key={id} className="border-t border-divider py-2 first:border-t-0">
              <Link to={`/ops/trace/${encodeURIComponent(id)}`} className="break-all font-mono text-[13px] font-semibold text-violet-ink no-underline hover:underline">
                {id}
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  if (!t.lines.length && !t.summary) {
    return (
      <>
        <Panel
          title={ut("ops.trace.notFound")}
          icon={<OpsIcon name="scan-search" />}
          tone="neutral"
          actions={
            <Button size="xs" icon={<OpsIcon name="refresh-cw" />} onClick={onReload}>
              {ut("ops.trace.reload")}
            </Button>
          }
        >
          <Quiet>{fill(ut("ops.trace.notFoundHint"), { n: t.retentionDays })}</Quiet>
        </Panel>
        {t.audit && t.audit.length ? <AuditPanel t={t} /> : null}
      </>
    );
  }

  return (
    <>
      <SummaryPanel t={t} />
      {/*
        Две колонки — с 1366: на 1280 строкам лога и тексту SQL нужна вся
        ширина. В одну колонку сбой запроса (если он есть) встаёт первым —
        ради него трассу и открывают.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-4 max-[1365px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <LinesPanel t={t} />
          <SqlPanel t={t} />
        </div>
        <div className={cx("flex min-w-0 flex-col gap-4", t.errors.length > 0 && "max-[1365px]:order-first")}>
          {t.errors.map((g) => (
            <ErrorPanel key={g.fingerprint} g={g} />
          ))}
          <AuditPanel t={t} />
        </div>
      </div>
    </>
  );
}

/* ─────────── итог ─────────── */

function SummaryPanel({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const loc = locale();
  const toast = useToast();
  const count = useCount();
  const s = t.summary;
  const failed = s?.status !== null && s?.status !== undefined && s.status >= 500;
  const errorsInLog = t.lines.filter((l) => l.level === "error").length;
  const audit = t.audit ?? [];
  const auditBad = audit.find((a) => a.outcome !== "success");
  const at = s?.at ?? t.lines[0]?.at ?? null;

  const cells: { key: string; label: string; value: ReactNode; sub: ReactNode; warn?: boolean }[] = [
    {
      key: "ms",
      label: ut("ops.trace.duration"),
      value: fmtMs(s?.ms ?? null, loc),
      sub: s?.sqlMs != null && s.ms ? fill(ut("opx.tr.sqlShare"), { v: fmtShare(s.sqlMs / s.ms, loc) }) : ut("opx.tr.noSql"),
      warn: failed,
    },
    {
      key: "sql",
      label: ut("ops.trace.sql"),
      value: s?.sqlCount != null ? count(["opx.tr.queries.one", "opx.tr.queries.few", "opx.tr.queries.many"], s.sqlCount) : "—",
      sub: s?.sqlMs != null ? fill(ut("opx.tr.sqlTotal"), { ms: fmtMs(s.sqlMs, loc) }) : "—",
    },
    {
      key: "role",
      label: ut("adm.role"),
      value: s?.role ? ut(ROLE_KEY[s.role]) : "—",
      sub: ut("opx.tr.noPeople"),
    },
    {
      key: "lines",
      label: ut("ops.trace.lines"),
      value: fmtInt(t.lines.length, loc),
      sub: errorsInLog ? fill(ut("opx.tr.linesErrors"), { n: fmtInt(errorsInLog, loc) }) : ut("opx.tr.linesClean"),
    },
    {
      key: "audit",
      label: ut("ops.trace.audit"),
      value: t.audit === null ? "—" : count(["opx.tr.records.one", "opx.tr.records.few", "opx.tr.records.many"], audit.length),
      sub: auditBad
        ? fill(ut("opx.tr.auditBad"), { outcome: OUTCOME_KEY[auditBad.outcome] ? ut(OUTCOME_KEY[auditBad.outcome]!) : auditBad.outcome })
        : audit.length
          ? ut("opx.tr.auditOk")
          : ut("opx.tr.auditNone"),
    },
  ];

  return (
    <section aria-label={ut("ops.trace.summary")} className="rounded-panel border border-border bg-panel shadow-panel">
      <div className="flex flex-wrap items-start gap-3 px-4 pb-3.5 pt-4">
        <IconTile
          size={40}
          tone={failed ? "warn" : s ? "good" : "neutral"}
          icon={<OpsIcon name={failed ? "octagon-x" : s ? "circle-check" : "circle-dashed"} />}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {s ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <MethodRoute
              method={s?.method ?? null}
              route={s?.route ?? null}
              className="[&_span.font-mono]:text-[15px] [&_span.font-mono]:font-bold [&_span.font-mono]:leading-5"
            />
            <HttpCode code={s?.status ?? null} />
          </div>
          ) : (
            <b className="text-[15px] font-extrabold text-text">{ut("opx.tr.noSummaryTitle")}</b>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-2">
            {at ? <span className="tabular-nums">{fullStamp(at, loc)}</span> : null}
            <span aria-hidden className="h-3 w-px bg-border" />
            <Mono className="break-all text-text-2">{t.requestId}</Mono>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={ut("ops.copyId")}
              title={ut("ops.copyId")}
              icon={<OpsIcon name="copy" />}
              onClick={() =>
                void navigator.clipboard?.writeText(t.requestId).then(
                  () => toast(ut("ops.idCopied"), "ok"),
                  () => toast(ut("ops.copyFailed"), "err"),
                )
              }
            />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {t.errors[0] ? (
            <ButtonLink to={`/ops/errors?window=90d&open=${encodeURIComponent(t.errors[0].fingerprint)}`}>
              <OpsIcon name="bug" size={15} />
              {ut("opx.tr.toGroup")}
            </ButtonLink>
          ) : null}
          <ButtonLink to={`/ops/logs?window=24h&rid=${encodeURIComponent(t.requestId)}`}>
            <OpsIcon name="scroll-text" size={15} />
            {ut("opx.tr.feed")}
          </ButtonLink>
        </div>
      </div>
      {s ? null : (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.trace.noSummary")}</Quiet>
        </div>
      )}
      <dl className="m-0 grid grid-cols-5 border-t border-divider max-[1000px]:grid-cols-3">
        {cells.map((c, i) => (
          <div key={c.key} className={cx("min-w-0 px-4 pb-3.5 pt-3", i > 0 && "border-l border-divider")}>
            <dt className="text-caption font-bold text-muted">{c.label}</dt>
            <dd className={cx("m-0 mt-0.5 truncate text-[16px] font-extrabold leading-[22px] tabular-nums", c.warn ? "text-warn" : "text-text")}>
              {c.value}
            </dd>
            <dd className="m-0 truncate text-caption leading-4 text-muted">{c.sub}</dd>
          </div>
        ))}
      </dl>
      {s && traceMeasured(s) ? (
        <div className="border-t border-divider px-4 py-3.5">
          <TraceTime summary={s} />
        </div>
      ) : null}
    </section>
  );
}

const traceMeasured = (s: NonNullable<OpsTrace["summary"]>) => s.sqlMs !== null && s.ms !== null && s.ms > 0;

/** Момент до миллисекунды с днём недели: «чт, 08.10.2026, 16:42:07.318» */
function fullStamp(iso: string, loc: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(loc, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  return `${date}, ${clock(iso, loc)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/* ─────────── строки лога ─────────── */

const LINE_COLS = "grid-cols-[76px_96px_150px_minmax(0,1fr)]";

function LevelTag({ level }: { level: OpsLevel }) {
  const { ut } = useLang();
  if (level === "error")
    return (
      <Tag tone="attention" icon={<OpsIcon name="octagon-x" />}>
        {ut(LEVEL_KEY.error)}
      </Tag>
    );
  if (level === "warn")
    return (
      <Tag tone="attention" icon={<OpsIcon name="triangle-alert" />}>
        {ut(LEVEL_KEY.warn)}
      </Tag>
    );
  if (level === "info")
    return (
      <Tag tone="info" icon={<OpsIcon name="info" />}>
        {ut(LEVEL_KEY.info)}
      </Tag>
    );
  return <Tag tone="plain">{ut(LEVEL_KEY.debug)}</Tag>;
}

function LinesPanel({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const loc = locale();
  const offs = offsets(t.lines);
  return (
    <Panel
      title={ut("ops.trace.lines")}
      icon={<OpsIcon name="scroll-text" />}
      sub={fill(ut("opx.tr.linesSub"), { n: fmtInt(t.lines.length, loc) })}
      actions={
        <ButtonLink to={`/ops/logs?window=24h&rid=${encodeURIComponent(t.requestId)}`} variant="ghost" size="xs">
          <OpsIcon name="arrow-up-right" size={14} />
          {ut("opx.tr.inFeed")}
        </ButtonLink>
      }
      flush
    >
      {t.lines.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("opx.tr.noLines")}</Quiet>
        </div>
      ) : (
        <div role="table" aria-label={ut("ops.trace.lines")} className="overflow-x-auto">
          <div className="min-w-[620px]">
            <div
              role="row"
              className={cx("grid h-[38px] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted", LINE_COLS)}
            >
              <span role="columnheader" className="text-right">
                {ut("opx.tr.fromStart")}
              </span>
              <span role="columnheader">{ut("ops.col.time")}</span>
              <span role="columnheader">{ut("ops.logs.level")}</span>
              <span role="columnheader">{ut("opx.lg.colMessage")}</span>
            </div>
            {t.lines.map((l, i) => (
              <div
                key={`${l.instance ?? ""}:${l.seq}`}
                role="row"
                className={cx("grid min-h-11 items-center gap-3 border-b border-divider px-4 py-1.5 last:border-b-0", LINE_COLS, l.level === "error" && "bg-warn-tint")}
              >
                {/* смещение от первой строки: «что за чем и через сколько» */}
                <span role="cell" className="text-right text-small tabular-nums text-text-2">
                  +{fmtInt(Math.round(offs[i] ?? 0), loc)}
                </span>
                <Mono className="tabular-nums text-text" title={dateTime(l.at)}>
                  {clock(l.at, loc)}
                </Mono>
                <span role="cell">
                  <LevelTag level={l.level} />
                </span>
                <span role="cell" className="min-w-0 break-words font-mono text-[12px] leading-[18px]">
                  <b className="font-bold text-text">{l.message}</b>
                  {Object.keys(l.fields).length ? <span className="text-text-2"> {fieldsText(l.fields)}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ─────────── ошибка ─────────── */

function ErrorPanel({ g }: { g: OpsErrorGroup }) {
  const { ut } = useLang();
  const loc = locale();
  const toast = useToast();
  const head = `${g.name}: ${g.message}`;
  const when = (iso: string) => new Date(iso).toLocaleString(loc, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <Panel
      title={ut("ops.trace.errors")}
      icon={<OpsIcon name="circle-alert" />}
      tone="warn"
      sub={ut(g.origin === "request" ? "opx.tr.unhandled" : "opx.er.originLog")}
      actions={
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={ut("opx.er.copy")}
          icon={<OpsIcon name="copy" />}
          onClick={() =>
            void navigator.clipboard?.writeText([head, ...g.frames].join("\n")).then(
              () => toast(ut("opx.er.stackCopied"), "ok"),
              () => toast(ut("ops.copyFailed"), "err"),
            )
          }
        />
      }
      footer={
        <ButtonLink to={`/ops/errors?window=90d&open=${encodeURIComponent(g.fingerprint)}`} variant="ghost" size="xs">
          {ut("opx.tr.openGroup")}
          <OpsIcon name="arrow-up-right" size={14} />
        </ButtonLink>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Mono className="text-[13px] font-bold text-warn">{g.name}</Mono>
      </div>
      <p className="m-0 mt-1 font-mono text-[12.5px] leading-[19px] text-text [overflow-wrap:anywhere]">{g.message || "—"}</p>
      <p className="m-0 mt-1 text-caption text-muted">{ut("opx.tr.scrubbed")}</p>
      {g.frames.length ? (
        <pre className="m-0 mt-3 overflow-x-auto whitespace-pre-wrap rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text [overflow-wrap:anywhere]">
          {g.frames.map((f, i) => (
            <span key={i} className="block">
              <span className="mr-2.5 inline-block w-[18px] text-right text-muted">{i + 1}</span>
              {f}
            </span>
          ))}
        </pre>
      ) : (
        <Quiet>{ut("ops.errors.noStack")}</Quiet>
      )}
      <dl className="m-0 mt-3 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-caption font-bold text-muted">{ut("opx.tr.inGroup")}</dt>
          <dd className="m-0 font-extrabold tabular-nums">{fmtInt(g.totalCount ?? g.count, loc)}</dd>
        </div>
        <div>
          <dt className="text-caption font-bold text-muted">{ut("opx.tr.first")}</dt>
          <dd className="m-0 font-extrabold tabular-nums">{when(g.firstAt)}</dd>
        </div>
        <div>
          <dt className="text-caption font-bold text-muted">{ut("opx.tr.last")}</dt>
          <dd className="m-0 font-extrabold tabular-nums">{when(g.lastAt)}</dd>
        </div>
      </dl>
    </Panel>
  );
}

/* ─────────── SQL ─────────── */

function SqlPanel({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const loc = locale();
  const sql = t.sql;
  const columns: Column<OpsSqlTop>[] = [
    {
      key: "query",
      header: ut("ops.col.query"),
      required: true,
      sort: (q) => q.query,
      render: (q) => (
        <Mono className="block truncate text-text" title={q.query}>
          {q.query}
        </Mono>
      ),
    },
    {
      key: "calls",
      header: ut("ops.trace.calls"),
      num: true,
      width: 96,
      required: true,
      sort: (q) => q.calls,
      /* один текст много раз — признак N+1: янтарём */
      render: (q) => <span className={q.calls >= 10 ? "font-extrabold text-warn" : undefined}>{fmtInt(q.calls, loc)}</span>,
    },
    {
      key: "total",
      header: ut("ops.trace.totalMs"),
      num: true,
      width: 96,
      required: true,
      sort: (q) => q.totalMs,
      render: (q) => <b className="font-extrabold">{fmtMs(q.totalMs, loc)}</b>,
    },
    { key: "max", header: ut("ops.col.max"), num: true, width: 90, required: true, sort: (q) => q.maxMs, render: (q) => fmtMs(q.maxMs, loc) },
  ];
  return (
    <Panel
      title={ut("ops.trace.sqlTitle")}
      icon={<OpsIcon name="database" />}
      sub={
        sql
          ? fill(ut("ops.trace.sqlTotals"), { n: fmtInt(sql.count, loc), ms: fmtMs(sql.totalMs, loc), distinct: fmtInt(sql.distinct, loc) })
          : undefined
      }
      flush
      footer={sql ? <PanelNote>{ut(sql.source === "memory" ? "ops.trace.sqlMemory" : "ops.trace.sqlStored")}</PanelNote> : undefined}
    >
      {!sql ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.trace.sqlNone")}</Quiet>
        </div>
      ) : (
        <DataTable rows={sql.top} columns={columns} rowKey={(q) => q.query} initialSort={{ key: "total", desc: true }} dense sticky={false} label={ut("ops.trace.sqlTitle")} />
      )}
    </Panel>
  );
}

/* ─────────── журнал ─────────── */

function AuditPanel({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const count = useCount();
  const columns: Column<OpsTraceAudit>[] = [
    {
      key: "action",
      header: ut("opx.tr.actionResource"),
      required: true,
      render: (a) => (
        <span className="flex min-w-0 flex-col">
          <Mono className="break-all text-text">{a.action}</Mono>
          {a.resourceType ? <Mono className="break-all text-text-2">{a.resourceType}</Mono> : null}
        </span>
      ),
    },
    {
      key: "outcome",
      header: ut("ops.trace.outcome"),
      width: 110,
      required: true,
      /* отказ и сбой — то, ради чего журнал в трассе и смотрят */
      render: (a) => (
        <StatusMark tone={a.outcome === "success" ? "ok" : "fail"}>{OUTCOME_KEY[a.outcome] ? ut(OUTCOME_KEY[a.outcome]!) : a.outcome}</StatusMark>
      ),
    },
    {
      key: "role",
      header: ut("adm.role"),
      width: 110,
      required: true,
      render: (a) => (
        <span className="text-text-2">
          {a.actorRole && a.actorRole in ROLE_KEY ? ut(ROLE_KEY[a.actorRole as keyof typeof ROLE_KEY]) : (a.actorRole ?? ut("ops.trace.system"))}
        </span>
      ),
    },
  ];
  return (
    <Panel
      title={ut("ops.trace.audit")}
      icon={<OpsIcon name="file-search" />}
      sub={t.audit ? count(["opx.tr.records.one", "opx.tr.records.few", "opx.tr.records.many"], t.audit.length) : undefined}
      actions={
        <ButtonLink to="/ops/audit" variant="ghost" size="xs">
          <OpsIcon name="arrow-up-right" size={14} />
          {ut("opx.tr.toAudit")}
        </ButtonLink>
      }
      flush
      footer={<PanelNote>{ut("ops.trace.auditHint")}</PanelNote>}
    >
      {t.audit === null ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.trace.auditFailed")}</Quiet>
        </div>
      ) : t.audit.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.trace.auditEmpty")}</Quiet>
        </div>
      ) : (
        <DataTable rows={t.audit} columns={columns} rowKey={(a) => `${a.at}-${a.action}`} dense sticky={false} label={ut("ops.trace.audit")} />
      )}
    </Panel>
  );
}
