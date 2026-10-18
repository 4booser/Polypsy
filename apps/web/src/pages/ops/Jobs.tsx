import { useState } from "react";
import type { OpsJob, OpsJobResult } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Callout, Loading, ViewPills, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { fill } from "../dashboard/model";
import { JobCharts, ScheduleCharts } from "./charts";
import { OpsIcon } from "./icons";
import { JOB_KEY, RESULT_KEY, fmtInt, fmtMs, fmtUptime } from "./model";
import { canRunNow } from "./obs2b/model";
import {
  CopyLinkButton,
  Live,
  Mono,
  OpsHead,
  OpsToolbar,
  PanelNote,
  Quiet,
  StatusMark,
  type Tone,
  sinceText,
  useCount,
  useOpsResource,
} from "./parts";

/*
 * Фонові задачі: тикает ли то, что должно тикать.
 *
 * Планировщик расписаний, прибирание присутствия, неявки, рассыльщик
 * тревог, напоминания о приёме, пуши рассылок, чистка потока событий — все
 * отмечают свои проходы в реестре процесса (apps/api/src/lib/opsJobs.ts).
 * Строка — задача: расписание, чем кончился последний проход, когда он был
 * и сколько шёл, когда следующий, сколько было проходов и сбоев с момента
 * запуска. Упавшая задача — строкой «внимания» и под ней последняя ошибка
 * с переходами в группы ошибок и ленту логов.
 *
 * «Запустити зараз» (участок obs2b, решение заказчика 2026-09-26) — у
 * задач, которые безопасно запускать вне такта: пересчёт аналитики,
 * переиндексация поиска, установка каталога, ретенция, проверка правил
 * оповещений (apps/api/src/lib/opsManual.ts). Запуск — фоном, не в
 * запросе: строка задачи покажет «виконується», потом итог или ошибку.
 * Кнопку видит только ops.manage; кто и что запустил — в журнале.
 *
 * Ниже — проходы и длительность по задачам, и срабатывания расписаний из
 * базы: они, в отличие от реестра, переживают перезапуск и отвечают на
 * «что планировщик сделал вчера».
 */

const DAY_MS = 86_400_000;
const POLL_MS = 15_000;
const RUNS_SHOWN = 6;

const RESULT_TONE: Record<OpsJobResult, Tone> = { ok: "ok", error: "fail", skipped: "warn", running: "run" };

const JOB_COLS = "grid-cols-[minmax(200px,1.3fr)_minmax(96px,0.6fr)_150px_110px_76px_96px_96px_minmax(150px,auto)]";

type View = "all" | "failing" | "manual";

/** Время прохода: сегодняшнее — часами с секундами, давнее — с датой */
function when(iso: string | null, now: number, loc: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Math.abs(now - d.getTime()) < DAY_MS / 2) return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleString(loc, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function OpsJobs() {
  const { ut } = useLang();
  const loc = locale();
  const count = useCount();
  const res = useOpsResource(() => api.opsJobs(), [], POLL_MS);
  const { can } = useAuth();
  const manage = can("ops.manage");
  const [view, setView] = useState<View>("all");
  const [allRuns, setAllRuns] = useState(false);
  const d = res.data;
  const now = res.updatedAt ?? Date.now();

  const failures = d ? d.items.reduce((s, j) => s + j.failures, 0) : 0;
  const scheduled = d ? d.items.filter((j) => j.intervalSec > 0).length : 0;
  const running = d ? d.items.filter((j) => j.lastResult === "running").length : 0;

  const head = (
    <OpsHead
      meta={
        d
          ? [
              fill(ut("opx.jb.metaBold"), {
                jobs: count(["opx.jb.jobs.one", "opx.jb.jobs.few", "opx.jb.jobs.many"], d.items.length),
                n: fmtInt(failures, loc),
              }),
              fill(ut("opx.jb.metaSub"), {
                sched: fmtInt(scheduled, loc),
                manual: fmtInt(d.items.length - scheduled, loc),
                running: fmtInt(running, loc),
              }),
            ]
          : null
      }
      actions={<CopyLinkButton />}
      toolbar={
        d ? (
          <OpsToolbar right={<Live pollSec={POLL_MS / 1000} updatedAt={res.updatedAt} />}>
            {d.schedulerEnabled ? (
              <Tag tone="good" icon={<OpsIcon name="circle-check" />}>
                {ut("opx.jb.schedulerOn")}
              </Tag>
            ) : (
              <Tag tone="attention" icon={<OpsIcon name="circle-minus" />}>
                {ut("opx.jb.schedulerOff")}
              </Tag>
            )}
            <span className="text-small text-text-2">{fill(ut("opx.ov.metaSince"), { time: sinceText(d.since, loc) })}</span>
          </OpsToolbar>
        ) : null
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
        <Loading rows={5} />
      </>
    );
  }

  const failing = d.items.filter((j) => j.failures > 0 || j.lastResult === "error");
  const manualJobs = d.items.filter((j) => j.manual);
  const shown = view === "failing" ? failing : view === "manual" ? manualJobs : d.items;
  const runs = d.scheduleRuns ?? [];

  return (
    <div className="flex flex-col gap-4">
      {head}
      {!d.schedulerEnabled ? <Callout kind="warn">{ut("ops.jobs.disabled")}</Callout> : null}
      <Callout
        kind="info"
        actions={
          <ButtonLink to="/ops/recordings" variant="paper" size="xs">
            <OpsIcon name="mic" size={14} />
            {ut("o2b.tab.recordings")}
          </ButtonLink>
        }
      >
        {ut("opx.jb.transcriber")}
      </Callout>

      <Panel
        title={ut("ops.jobs.title")}
        icon={<OpsIcon name="cog" />}
        sub={ut("opx.jb.ticksSub")}
        flush
        footer={d.items.some((j) => j.manual) ? <PanelNote>{ut(manage ? "o2b.jobs.manualHint" : "o2b.jobs.manualReadOnly")}</PanelNote> : undefined}
      >
        <div className="px-4 pb-3">
          <ViewPills
            label={ut("opx.jb.views")}
            value={view}
            onChange={(k) => setView(k as View)}
            items={[
              { key: "all", label: ut("opx.jb.viewAll"), count: d.items.length },
              { key: "failing", label: ut("opx.jb.viewFailing"), count: failing.length },
              { key: "manual", label: ut("opx.jb.viewManual"), count: manualJobs.length },
            ]}
          />
        </div>
        {d.items.length === 0 ? (
          <div className="px-4 pb-3">{d.schedulerEnabled ? <Quiet>{ut("ops.jobs.empty")}</Quiet> : null}</div>
        ) : shown.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("opx.jb.viewEmpty")}</Quiet>
          </div>
        ) : (
          <div role="table" aria-label={ut("ops.jobs.title")} className="overflow-x-auto">
            <div className="min-w-[1000px]">
              <div
                role="row"
                className={cx("grid h-[38px] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted", JOB_COLS)}
              >
                <span role="columnheader">{ut("ops.col.job")}</span>
                <span role="columnheader">{ut("opx.jb.colSchedule")}</span>
                <span role="columnheader">{ut("ops.col.result")}</span>
                <span role="columnheader">{ut("ops.col.lastRun")}</span>
                <span role="columnheader" className="text-right">
                  {ut("ops.col.took")}
                </span>
                <span role="columnheader">{ut("ops.col.next")}</span>
                <span role="columnheader" className="text-right">
                  {ut("ops.col.runs")}
                </span>
                <span role="columnheader" />
              </div>
              {shown.map((j) => (
                <JobRow key={j.name} j={j} now={now} manage={manage} onStarted={res.reload} />
              ))}
            </div>
          </div>
        )}
      </Panel>

      {d.items.length ? (
        <Panel title={ut("opx.jb.chartsTitle")} icon={<OpsIcon name="chart-gantt" />}>
          <JobCharts items={d.items} />
        </Panel>
      ) : null}

      <Panel
        title={ut("ops.jobs.runsTitle")}
        icon={<OpsIcon name="calendar-clock" />}
        sub={ut("opx.jb.runsSub")}
        flush
        footer={
          runs.length ? (
            <div className="flex w-full flex-wrap items-center gap-3">
              <span className="text-small text-text-2">
                {fill(ut("opx.jb.runsShown"), { n: fmtInt(runs.length, loc), k: fmtInt(allRuns ? runs.length : Math.min(RUNS_SHOWN, runs.length), loc) })}
              </span>
              {runs.length > RUNS_SHOWN ? (
                <Button variant="ghost" size="xs" icon={<OpsIcon name={allRuns ? "chevron-up" : "chevron-down"} />} onClick={() => setAllRuns(!allRuns)}>
                  {allRuns ? ut("opx.rq.showLess") : ut("opx.jb.all")}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {d.scheduleActivity && runs.length ? (
          <div className="px-4 pb-4">
            <ScheduleCharts
              activity={d.scheduleActivity}
              days={Math.round((now - Date.parse(d.scheduleActivity.from)) / DAY_MS)}
              now={now}
            />
          </div>
        ) : null}
        {d.scheduleRuns === null ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.jobs.runsFailed")}</Quiet>
          </div>
        ) : runs.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.jobs.runsEmpty")}</Quiet>
          </div>
        ) : (
          <div role="table" aria-label={ut("ops.jobs.runsTitle")}>
            <div
              role="row"
              className="grid h-[38px] grid-cols-[160px_110px_110px_minmax(0,1fr)] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted"
            >
              <span role="columnheader">{ut("opx.jb.colWhen")}</span>
              <span role="columnheader" className="text-right">
                {ut("ops.col.assigned")}
              </span>
              <span role="columnheader" className="text-right">
                {ut("ops.col.skipped")}
              </span>
              <span role="columnheader">{ut("ops.col.note")}</span>
            </div>
            {(allRuns ? runs : runs.slice(0, RUNS_SHOWN)).map((r, i) => (
              <div
                key={`${r.at}-${i}`}
                role="row"
                className="grid min-h-11 grid-cols-[160px_110px_110px_minmax(0,1fr)] items-center gap-3 border-b border-divider px-4 py-1.5 text-body last:border-b-0"
              >
                <span role="cell" className="tabular-nums text-text-2">
                  {when(r.at, now, loc)}
                </span>
                <b role="cell" className="text-right font-extrabold tabular-nums">
                  {fmtInt(r.assigned, loc)}
                </b>
                <span role="cell" className="text-right tabular-nums text-text-2">
                  {fmtInt(r.skipped, loc)}
                </span>
                <span role="cell" className="min-w-0 break-words text-small text-text-2">
                  {r.note ?? "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function JobRow({ j, now, manage, onStarted }: { j: OpsJob; now: number; manage: boolean; onStarted: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  const key = JOB_KEY[j.name];
  const failed = j.lastResult === "error";
  const schedule = j.intervalSec > 0 ? fill(ut("ops.jobs.every"), { t: fmtUptime(j.intervalSec, loc) }) : ut("opx.jb.byHandOnly");
  return (
    <div className={cx("border-b border-divider last:border-b-0", failed && "bg-warn-tint", j.lastResult === "running" && "bg-violet-tint")}>
      <div role="row" className={cx("grid min-h-11 items-center gap-3 px-4 py-1.5 text-body", JOB_COLS)}>
        <span role="cell" className="min-w-0">
          <b className="block truncate text-[13.5px] font-bold leading-[18px] text-text">{key ? ut(key) : j.name}</b>
          <Mono className="block truncate text-text-2">{j.name}</Mono>
        </span>
        <span role="cell" className="text-text-2">
          {schedule}
        </span>
        <span role="cell" className="flex min-w-0 flex-col">
          {j.lastResult ? (
            <StatusMark tone={RESULT_TONE[j.lastResult]}>{ut(RESULT_KEY[j.lastResult])}</StatusMark>
          ) : (
            <StatusMark tone="quiet">{ut("ops.never")}</StatusMark>
          )}
        </span>
        <span role="cell" className="tabular-nums text-text" title={j.lastStartAt ? dateTime(j.lastStartAt) : undefined}>
          {when(j.lastStartAt, now, loc)}
        </span>
        <span role="cell" className="text-right tabular-nums text-text">
          {fmtMs(j.lastDurationMs, loc)}
        </span>
        <span role="cell" className="tabular-nums text-text-2" title={j.nextAt ? dateTime(j.nextAt) : undefined}>
          {when(j.nextAt, now, loc)}
        </span>
        <span role="cell" className="text-right tabular-nums text-text">
          {fmtInt(j.runs, loc)}
          <span className="text-muted"> / </span>
          <span className={j.failures ? "font-extrabold text-warn" : "text-muted"}>{fmtInt(j.failures, loc)}</span>
        </span>
        <span role="cell" className="flex justify-end">
          {manage && j.manual ? (
            <Button
              size="xs"
              icon={<OpsIcon name="play" />}
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
          ) : j.lastByHand ? (
            <span className="text-small text-muted">{ut("o2b.jobs.byHand")}</span>
          ) : null}
        </span>
      </div>
      {j.lastError ? (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 pb-3 pl-4">
          <OpsIcon name="octagon-x" size={15} className="mt-0.5 text-warn" />
          <span className="min-w-0 flex-1 text-small leading-[18px] text-text-2">
            <b className="font-bold text-text">{fill(ut("ops.jobs.lastError"), { time: j.lastErrorAt ? when(j.lastErrorAt, now, loc) : "—" })}</b>{" "}
            <Mono className="break-words text-text">{j.lastError}</Mono>
          </span>
          <span className="flex shrink-0 gap-2">
            <ButtonLink to={`/ops/errors?window=24h&q=${encodeURIComponent(j.name)}`} size="xs">
              <OpsIcon name="bug" size={14} />
              {ut("opx.jb.errorGroup")}
            </ButtonLink>
            <ButtonLink to={`/ops/logs?q=${encodeURIComponent(j.name)}`} size="xs" variant="ghost">
              <OpsIcon name="scroll-text" size={14} />
              {ut("opx.rq.logs")}
            </ButtonLink>
          </span>
        </div>
      ) : null}
    </div>
  );
}
