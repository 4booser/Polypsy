import { Link, useParams } from "react-router-dom";
import type { OpsErrorGroup, OpsTrace } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { LEVEL_KEY, ROLE_KEY, clock, fieldsText, fmtInt, fmtMs } from "../model";
import { Cell, Facts, GridRow, GridTable, NumHead, Quiet, RequestId, StatusMark } from "../parts";
import { TraceTime } from "./charts";
import { OUTCOME_KEY, offsets } from "./model";
import { TraceSearch } from "./parts";

/*
 * Траса запиту — всё о одном обращении на одной странице (/ops/trace/:id).
 *
 * Решение заказчика 2026-09-26: человек называет номер с экрана ошибки,
 * разработчик открывает одну страницу — итог (маршрут, код, время, роль,
 * SQL), ошибка, если была, все строки лога по порядку, записи журнала и
 * самые долгие SQL. Собирает сервер (apps/api/src/lib/opsTrace.ts) из
 * истории в базе и памяти процесса; строгое правило — только этот номер.
 *
 * Трасса не опрашивается: запрос уже кончился, и новых строк у него не
 * будет. «Оновити» — на случай, когда открыли раньше, чем история успела
 * записаться (такт записи — десять секунд).
 *
 * Из журнала — действие, исход, вид ресурса и роль, без людей: право
 * ops.read не открывает ни почт, ни адресатов, подробности записи — во
 * вкладке «Аудит» по праву audit.read. Чтение трассы само пишется в журнал.
 */

const LEVEL_TEXT = {
  error: "text-danger",
  warn: "text-accent",
  info: "text-text-2",
  debug: "text-muted",
} as const;

const AUDIT_COLS = "grid-cols-[110px_minmax(180px,1fr)_110px_minmax(120px,1fr)_130px]";
const SQL_COLS = "grid-cols-[72px_88px_88px_minmax(0,1fr)]";

export default function OpsTracePage() {
  const { requestId = "" } = useParams();
  const { ut } = useLang();
  const res = useResource(() => api.opsTrace(requestId), [requestId]);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-[12px] pt-[20px]">
        <span className="min-w-0 text-[13px] leading-[18px] text-muted">
          {ut("ops.trace.lead")}{" "}
          <span className="break-all font-mono text-[12px] text-text">{requestId}</span>
        </span>
        <TraceSearch />
      </div>

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
  const loc = locale();

  if (t.candidates.length) {
    return (
      <RuleSection className="mt-[16px]" title={ut("ops.trace.ambiguous")} hint={ut("ops.trace.ambiguousHint")}>
        <ul className="m-0 list-none p-0">
          {t.candidates.map((id) => (
            <li key={id} className="border-b border-hairline py-[8px]">
              <Link to={`/ops/trace/${encodeURIComponent(id)}`} className="break-all font-mono text-[13px] text-primary no-underline hover:underline">
                {id}
              </Link>
            </li>
          ))}
        </ul>
      </RuleSection>
    );
  }

  if (!t.lines.length && !t.summary) {
    return (
      <RuleSection className="mt-[16px]" title={ut("ops.trace.notFound")}>
        <Quiet>{fill(ut("ops.trace.notFoundHint"), { n: t.retentionDays })}</Quiet>
        <Button variant="ghost" onClick={onReload}>
          {ut("ops.trace.reload")}
        </Button>
        {t.audit && t.audit.length ? <AuditPart t={t} /> : null}
      </RuleSection>
    );
  }

  const s = t.summary;
  const offs = offsets(t.lines);
  return (
    <div>
      <RuleSection
        className="mt-[16px]"
        title={ut("ops.trace.summary")}
        actions={
          <Button variant="ghost" onClick={onReload}>
            {ut("ops.trace.reload")}
          </Button>
        }
      >
        {s ? (
          <>
            <Facts
              items={[
                [
                  ut("ops.col.route"),
                  <span key="r" className="break-all font-mono text-[12px]">
                    {s.method ?? "—"} {s.route ?? "—"}
                  </span>,
                ],
                [
                  ut("ops.col.code"),
                  <Num key="c" className={cx(s.status !== null && s.status >= 500 && "font-bold text-accent")}>
                    {s.status ?? "—"}
                  </Num>,
                ],
                [ut("ops.trace.duration"), <Num key="d">{fmtMs(s.ms, loc)}</Num>],
                [ut("adm.role"), s.role ? ut(ROLE_KEY[s.role]) : "—"],
                [
                  ut("ops.trace.sql"),
                  s.sqlCount !== null ? (
                    <Num key="s">{fill(ut("ops.trace.sqlSummary"), { n: fmtInt(s.sqlCount, loc), ms: fmtMs(s.sqlMs, loc) })}</Num>
                  ) : (
                    "—"
                  ),
                ],
                [ut("ops.col.time"), dateTime(s.at)],
                [ut("ops.col.requestId"), <RequestId key="id" id={t.requestId} linked={false} />],
              ]}
            />
            {/* волна 11: время запроса — база и всё остальное одной полосой; без SQL-замера полосы нет */}
            <TraceTime summary={s} />
          </>
        ) : (
          <Quiet>{ut("ops.trace.noSummary")}</Quiet>
        )}
      </RuleSection>

      {t.errors.length ? (
        <RuleSection title={ut("ops.trace.errors")}>
          <ul className="m-0 list-none p-0">
            {t.errors.map((g) => (
              <TraceError key={g.fingerprint} g={g} />
            ))}
          </ul>
        </RuleSection>
      ) : null}

      <RuleSection
        title={ut("ops.trace.lines")}
        actions={<Num className="text-[13px] text-muted">{fmtInt(t.lines.length, loc)}</Num>}
      >
        <ol aria-label={ut("ops.trace.lines")} className="m-0 list-none overflow-x-auto p-0 font-mono text-[12px] leading-[18px]">
          {t.lines.map((l, i) => (
            <li
              key={`${l.instance ?? ""}:${l.seq}`}
              className="grid grid-cols-[76px_64px_84px_minmax(0,1fr)] gap-x-[12px] border-b border-hairline py-[4px] max-[700px]:grid-cols-[76px_minmax(0,1fr)]"
            >
              <span className="text-muted tabular-nums" title={dateTime(l.at)}>
                {clock(l.at, loc)}
              </span>
              {/* смещение от первой строки: «что за чем и через сколько» */}
              <span className="text-right text-muted tabular-nums max-[700px]:hidden">+{fmtMs(offs[i] ?? 0, loc)}</span>
              <span className={cx("truncate", LEVEL_TEXT[l.level], l.level === "error" && "font-bold")}>{ut(LEVEL_KEY[l.level])}</span>
              <span className="min-w-0 break-words max-[700px]:col-span-2">
                <span className="font-bold text-text">{l.message}</span>
                {Object.keys(l.fields).length ? <span className="text-muted"> {fieldsText(l.fields)}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </RuleSection>

      <AuditPart t={t} />
      <SqlPart t={t} />
    </div>
  );
}

function TraceError({ g }: { g: OpsErrorGroup }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px]">
        <span className="min-w-0 break-all font-mono text-[15px] font-bold leading-[20px] text-primary">{g.name}</span>
        <span className="min-w-0 flex-1 basis-[280px] break-words font-mono text-[13px] leading-[18px] text-text-2">
          {g.message || "—"}
        </span>
      </div>
      <div className="mt-[6px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px] text-[13px] leading-[18px] text-muted">
        {g.route ? (
          <span className="font-mono text-[12px] text-text">
            {g.method} {g.route}
          </span>
        ) : (
          <span>{ut("ops.errors.outside")}</span>
        )}
        {/* сколько раз эта ошибка была вообще — отвечает на «это разовое или повторяется» */}
        <Num>{fill(ut("ops.history.total"), { n: fmtInt(g.totalCount ?? g.count, loc) })}</Num>
        <span>{fill(ut("ops.errors.first"), { time: dateTime(g.firstAt) })}</span>
        <Link
          to={`/ops/errors?window=90d&open=${encodeURIComponent(g.fingerprint)}`}
          className="text-primary no-underline hover:underline"
        >
          {ut("ops.trace.toGroup")}
        </Link>
      </div>
      {g.frames.length ? (
        <pre className="m-0 mt-[8px] overflow-x-auto rounded-[5px] bg-primary-soft p-[12px] font-mono text-[12px] leading-[18px] text-text-2">
          {g.frames.join("\n")}
        </pre>
      ) : null}
    </li>
  );
}

function AuditPart({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <RuleSection title={ut("ops.trace.audit")} hint={ut("ops.trace.auditHint")}>
      {t.audit === null ? (
        <Quiet>{ut("ops.trace.auditFailed")}</Quiet>
      ) : t.audit.length === 0 ? (
        <Quiet>{ut("ops.trace.auditEmpty")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.trace.audit")}
          cols={AUDIT_COLS}
          minW="min-w-[640px]"
          head={[ut("ops.col.time"), ut("ops.trace.action"), ut("ops.trace.outcome"), ut("ops.trace.resource"), ut("adm.role")]}
        >
          {t.audit.map((a, i) => (
            <GridRow key={`${a.at}-${i}`} cols={AUDIT_COLS}>
              <Cell className="font-mono text-[12px] text-muted tabular-nums">{clock(a.at, loc)}</Cell>
              <Cell className="break-all font-mono text-[12px] text-text">{a.action}</Cell>
              <Cell>
                {/* отказ и сбой — то, ради чего журнал в трассе и смотрят */}
                <StatusMark tone={a.outcome === "success" ? "quiet" : "warn"}>
                  {OUTCOME_KEY[a.outcome] ? ut(OUTCOME_KEY[a.outcome]!) : a.outcome}
                </StatusMark>
              </Cell>
              <Cell className="break-all font-mono text-[12px] text-text-2">{a.resourceType ?? "—"}</Cell>
              <Cell className="text-text-2">
                {a.actorRole && a.actorRole in ROLE_KEY ? ut(ROLE_KEY[a.actorRole as keyof typeof ROLE_KEY]) : (a.actorRole ?? ut("ops.trace.system"))}
              </Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </RuleSection>
  );
}

function SqlPart({ t }: { t: OpsTrace }) {
  const { ut } = useLang();
  const loc = locale();
  const sql = t.sql;
  return (
    <RuleSection
      title={ut("ops.trace.sqlTitle")}
      hint={sql ? ut(sql.source === "memory" ? "ops.trace.sqlMemory" : "ops.trace.sqlStored") : undefined}
      actions={
        sql ? (
          <Num className="text-[13px] text-muted">
            {fill(ut("ops.trace.sqlTotals"), {
              n: fmtInt(sql.count, loc),
              ms: fmtMs(sql.totalMs, loc),
              distinct: fmtInt(sql.distinct, loc),
            })}
          </Num>
        ) : null
      }
    >
      {!sql ? (
        <Quiet>{ut("ops.trace.sqlNone")}</Quiet>
      ) : (
        <GridTable
          label={ut("ops.trace.sqlTitle")}
          cols={SQL_COLS}
          minW="min-w-[620px]"
          head={[
            <NumHead key="c">{ut("ops.trace.calls")}</NumHead>,
            <NumHead key="t">{ut("ops.trace.totalMs")}</NumHead>,
            <NumHead key="m">{ut("ops.col.max")}</NumHead>,
            ut("ops.col.query"),
          ]}
        >
          {sql.top.map((q, i) => (
            <GridRow key={i} cols={SQL_COLS} className="items-start">
              {/* один текст много раз — признак N+1: число вызовов первым */}
              <Cell num className={q.calls >= 10 ? "font-bold text-accent" : undefined}>
                {fmtInt(q.calls, loc)}
              </Cell>
              <Cell num>{fmtMs(q.totalMs, loc)}</Cell>
              <Cell num className="text-muted">
                {fmtMs(q.maxMs, loc)}
              </Cell>
              <Cell className="break-words font-mono text-[12px] text-text">{q.query}</Cell>
            </GridRow>
          ))}
        </GridTable>
      )}
    </RuleSection>
  );
}
