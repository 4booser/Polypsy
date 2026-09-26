import type { OpsJob, OpsJobResult } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useAction } from "../../ui";
import { Button } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { JOB_KEY, RESULT_KEY, fmtAgo, fmtInt, fmtMs, fmtUptime } from "./model";
import { Cell, GridRow, GridTable, NumHead, Quiet, Stamp, StatusMark, type Tone, useOpsResource } from "./parts";
import { canRunNow } from "./obs2b/model";

/*
 * Фонові задачі: тикает ли то, что должно тикать.
 *
 * Планировщик расписаний, прибирание присутствия, неявки, рассыльщик
 * тревог, напоминания о приёме, пуши рассылок, чистка потока событий — все
 * отмечают свои проходы в реестре процесса (apps/api/src/lib/opsJobs.ts).
 * Строка — задача: чем кончился последний проход, когда он был и сколько
 * шёл, когда следующий, сколько было проходов и сбоев с момента запуска.
 *
 * Ниже — срабатывания расписаний из базы: они, в отличие от реестра,
 * переживают перезапуск и отвечают на «что планировщик сделал вчера».
 *
 * «Запустити зараз» (участок obs2b, решение заказчика 2026-09-26) — у
 * задач, которые безопасно запускать вне такта: пересчёт аналитики,
 * переиндексация поиска, установка каталога, ретенция, проверка правил
 * оповещений (apps/api/src/lib/opsManual.ts). Запуск — фоном, не в
 * запросе: строка задачи покажет «виконується», потом итог или ошибку.
 * Кнопку видит только ops.manage; кто и что запустил — в журнале.
 */

const POLL_MS = 15_000;

const RESULT_TONE: Record<OpsJobResult, Tone> = { ok: "ok", error: "fail", skipped: "warn", running: "quiet" };

const JOB_COLS = "grid-cols-[minmax(220px,1fr)_130px_150px_88px_150px_96px_150px]";
const RUN_COLS = "grid-cols-[minmax(170px,220px)_96px_96px_minmax(0,1fr)]";

export default function OpsJobs() {
  const { ut } = useLang();
  const loc = locale();
  const res = useOpsResource(() => api.opsJobs(), [], POLL_MS);
  const { can } = useAuth();
  const manage = can("ops.manage");

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={5} />;
  const d = res.data;
  const now = res.updatedAt ?? Date.now();

  return (
    <div>
      <Stamp since={d.since} updatedAt={res.updatedAt} />

      <RuleSection className="mt-[16px]" title={ut("ops.jobs.title")} hint={ut("ops.jobs.hint")}>
        {!d.schedulerEnabled ? <Quiet>{ut("ops.jobs.disabled")}</Quiet> : null}
        {d.items.length === 0 ? (
          d.schedulerEnabled ? <Quiet>{ut("ops.jobs.empty")}</Quiet> : null
        ) : (
          <GridTable
            label={ut("ops.jobs.title")}
            cols={JOB_COLS}
            minW="min-w-[1040px]"
            head={[
              ut("ops.col.job"),
              ut("ops.col.result"),
              ut("ops.col.lastRun"),
              <NumHead key="d">{ut("ops.col.took")}</NumHead>,
              ut("ops.col.next"),
              <NumHead key="r">{ut("ops.col.runs")}</NumHead>,
              "",
            ]}
          >
            {d.items.map((j) => (
              <JobRow key={j.name} j={j} now={now} loc={loc} manage={manage} onStarted={res.reload} />
            ))}
          </GridTable>
        )}
        {d.items.some((j) => j.manual) ? <Quiet>{ut(manage ? "o2b.jobs.manualHint" : "o2b.jobs.manualReadOnly")}</Quiet> : null}
        <Quiet>{ut("ops.jobs.transcriber")}</Quiet>
      </RuleSection>

      <RuleSection title={ut("ops.jobs.runsTitle")} hint={ut("ops.jobs.runsHint")}>
        {d.scheduleRuns === null ? (
          <Quiet>{ut("ops.jobs.runsFailed")}</Quiet>
        ) : d.scheduleRuns.length === 0 ? (
          <Quiet>{ut("ops.jobs.runsEmpty")}</Quiet>
        ) : (
          <GridTable
            label={ut("ops.jobs.runsTitle")}
            cols={RUN_COLS}
            minW="min-w-[560px]"
            head={[
              ut("ops.col.time"),
              <NumHead key="a">{ut("ops.col.assigned")}</NumHead>,
              <NumHead key="s">{ut("ops.col.skipped")}</NumHead>,
              ut("ops.col.note"),
            ]}
          >
            {d.scheduleRuns.map((r, i) => (
              <GridRow key={`${r.at}-${i}`} cols={RUN_COLS}>
                <Cell className="text-text-2">{dateTime(r.at)}</Cell>
                <Cell num>{fmtInt(r.assigned, loc)}</Cell>
                <Cell num className="text-muted">
                  {fmtInt(r.skipped, loc)}
                </Cell>
                <Cell className="break-words font-mono text-[12px] text-muted">{r.note ?? "—"}</Cell>
              </GridRow>
            ))}
          </GridTable>
        )}
      </RuleSection>
    </div>
  );
}

function JobRow({ j, now, loc, manage, onStarted }: { j: OpsJob; now: number; loc: string; manage: boolean; onStarted: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const key = JOB_KEY[j.name];
  return (
    <>
      <GridRow cols={JOB_COLS} className={j.lastError ? "border-b-0" : undefined}>
        <Cell>
          <span className="block truncate text-[15px] font-bold leading-[19px] text-primary">{key ? ut(key) : j.name}</span>
          <span className="block truncate text-[12px] text-muted">
            <span className="font-mono">{j.name}</span>
            {j.intervalSec > 0 ? ` · ${fill(ut("ops.jobs.every"), { t: fmtUptime(j.intervalSec, loc) })}` : ""}
          </span>
        </Cell>
        <Cell>
          {j.lastResult ? (
            <StatusMark tone={RESULT_TONE[j.lastResult]}>{ut(RESULT_KEY[j.lastResult])}</StatusMark>
          ) : (
            <StatusMark tone="quiet">{ut("ops.never")}</StatusMark>
          )}
          {j.lastByHand ? <span className="block text-[12px] text-muted">{ut("o2b.jobs.byHand")}</span> : null}
        </Cell>
        <Cell className="text-text-2">
          <span title={j.lastStartAt ? dateTime(j.lastStartAt) : undefined}>{fmtAgo(j.lastStartAt, now, loc)}</span>
        </Cell>
        <Cell num>{fmtMs(j.lastDurationMs, loc)}</Cell>
        <Cell className="text-muted">
          <span title={j.nextAt ? dateTime(j.nextAt) : undefined}>{fmtAgo(j.nextAt, now, loc)}</span>
        </Cell>
        <Cell num>
          {fmtInt(j.runs, loc)}
          {j.failures ? <span className="text-accent"> / {fmtInt(j.failures, loc)}</span> : null}
        </Cell>
        <Cell className="text-right">
          {manage && j.manual ? (
            <Button
              variant="ghost"
              disabled={busy || !canRunNow(j)}
              onClick={() =>
                void run(async () => {
                  await api.opsRunJob(j.name);
                  onStarted();
                }, ut("o2b.jobs.started"))
              }
            >
              {ut("o2b.jobs.runNow")}
            </Button>
          ) : null}
        </Cell>
      </GridRow>
      {j.lastError ? (
        <GridRow cols={JOB_COLS} className="min-h-0 pt-0">
          <Cell className="col-span-full">
            <span className="text-[13px] font-bold text-accent">
              {fill(ut("ops.jobs.lastError"), { time: j.lastErrorAt ? dateTime(j.lastErrorAt) : "—" })}
            </span>{" "}
            <span className="break-words font-mono text-[12px] text-text-2">{j.lastError}</span>
          </Cell>
        </GridRow>
      ) : null}
    </>
  );
}
