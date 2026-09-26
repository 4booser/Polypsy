import type { OpsRecordings } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Kpi } from "../../../charts/clinical";
import { Button, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { fill } from "../../dashboard/model";
import { fmtBytes, fmtInt, fmtShare, fmtUptime, shortId } from "../model";
import { Cell, Facts, GridRow, GridTable, NumHead, Quiet, Stamp, StatusMark, useOpsResource } from "../parts";
import { REC_STATUS_KEY, countOf, diskMismatch, freeShare } from "./model";

/*
 * Записи прийомів: хранилище и очередь расшифровки — только числами.
 *
 * Решение заказчика 2026-09-26: объём, число записей, очередь расшифровки,
 * упавшие задания с кнопкой «Повторити» (ops.manage). Самые чувствительные
 * данные системы — разговор человека о себе целиком, — поэтому ни одного
 * имени и ни одного пути к файлу: номер задания, возраст, текст ошибки
 * (пути и данные из него вычищены сервером, lib/opsRecordings.ts).
 *
 * Воркер расшифровки — отдельный процесс (transcriber.ts), и сервер не
 * видит, жив ли он: он видит очередь. Если «чекає» растёт, а
 * «розшифровується» стоит на месте, — воркер встал; экран это
 * проговаривает, а не делает вид, что знает больше.
 */

const POLL_MS = 30_000;

const STATUS_COLS = "grid-cols-[minmax(200px,1fr)_110px_130px]";
const FAILED_COLS = "grid-cols-[110px_110px_minmax(240px,1fr)_150px]";

export default function OpsRecordingsPage() {
  const { ut } = useLang();
  const loc = locale();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const res = useOpsResource(() => api.opsRecordings(), [], POLL_MS);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const d = res.data;
  const free = freeShare(d);
  const failed = countOf(d, "failed");

  return (
    <div>
      <Stamp updatedAt={res.updatedAt} note={ut("o2b.rec.stamp")} />

      <div className="mt-[16px] grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-[16px]">
        <Kpi label={ut("o2b.rec.kpi.stored")} value={fmtInt(d.stored.count, loc)} hint={fmtBytes(d.stored.bytes, loc)} />
        <Kpi
          label={ut("o2b.rec.kpi.waiting")}
          value={fmtInt(d.queue.waiting, loc)}
          hint={
            d.queue.oldestWaitingSec !== null
              ? fill(ut("o2b.rec.kpi.oldest"), { t: fmtUptime(d.queue.oldestWaitingSec, loc) })
              : ut("o2b.rec.kpi.queueEmpty")
          }
        />
        <Kpi
          label={ut("o2b.rec.kpi.transcribing")}
          value={fmtInt(d.queue.transcribing, loc)}
          tone={d.queue.stuck ? "attention" : "plain"}
          hint={d.queue.stuck ? fill(ut("o2b.rec.kpi.stuck"), { n: d.queue.stuck }) : undefined}
        />
        {/* янтарь — только когда есть упавшие: их надо разобрать */}
        <Kpi label={ut("o2b.rec.kpi.failed")} value={fmtInt(failed, loc)} tone={failed ? "attention" : "plain"} />
        <Kpi
          label={ut("o2b.rec.kpi.free")}
          value={fmtShare(free, loc)}
          tone={free !== null && free < 0.1 ? "attention" : "plain"}
          hint={d.disk?.totalBytes ? fill(ut("o2b.rec.kpi.of"), { total: fmtBytes(d.disk.totalBytes, loc) }) : undefined}
        />
      </div>

      <div className="mt-[32px] grid grid-cols-1 gap-x-[45px] min-[900px]:grid-cols-2">
        <RuleSection title={ut("o2b.rec.byStatus")}>
          {d.byStatus.length === 0 ? (
            <Quiet>{ut("o2b.rec.none")}</Quiet>
          ) : (
            <GridTable
              label={ut("o2b.rec.byStatus")}
              cols={STATUS_COLS}
              minW="min-w-[440px]"
              head={[ut("o2b.rec.col.status"), <NumHead key="n">{ut("o2b.rec.col.count")}</NumHead>, <NumHead key="b">{ut("o2b.rec.col.bytes")}</NumHead>]}
            >
              {d.byStatus.map((s) => (
                <GridRow key={s.status} cols={STATUS_COLS}>
                  <Cell className="text-text">{ut(REC_STATUS_KEY[s.status])}</Cell>
                  <Cell num>{fmtInt(s.count, loc)}</Cell>
                  <Cell num className="text-muted">
                    {s.bytes ? fmtBytes(s.bytes, loc) : "—"}
                  </Cell>
                </GridRow>
              ))}
            </GridTable>
          )}
        </RuleSection>
        <RuleSection title={ut("o2b.rec.disk")}>
          <Disk d={d} />
        </RuleSection>
      </div>

      <RuleSection title={ut("o2b.rec.failed")} hint={ut("o2b.rec.failedHint")}>
        {d.failed.length === 0 ? (
          <Quiet>{ut("o2b.rec.failedNone")}</Quiet>
        ) : (
          <GridTable
            label={ut("o2b.rec.failed")}
            cols={FAILED_COLS}
            minW="min-w-[720px]"
            head={[ut("o2b.rec.col.job"), <NumHead key="a">{ut("o2b.rec.col.age")}</NumHead>, ut("o2b.rec.col.error"), ""]}
          >
            {d.failed.map((f) => (
              <FailedRow key={f.id} f={f} manage={manage} onRetried={res.reload} />
            ))}
          </GridTable>
        )}
      </RuleSection>
    </div>
  );
}

function Disk({ d }: { d: OpsRecordings }) {
  const { ut } = useLang();
  const loc = locale();
  const mismatch = diskMismatch(d);
  return (
    <>
      <Facts
        items={[
          [
            ut("o2b.rec.disk.files"),
            d.disk ? (
              <Num key="f">
                {fmtInt(d.disk.files, loc)}
                {d.disk.truncated ? "+" : ""} · {fmtBytes(d.disk.bytes, loc)}
              </Num>
            ) : (
              <span key="f" className="text-muted">
                {ut("o2b.rec.disk.unread")}
              </span>
            ),
          ],
          [ut("o2b.rec.disk.db"), <Num key="db">{`${fmtInt(d.stored.count, loc)} · ${fmtBytes(d.stored.bytes, loc)}`}</Num>],
          [
            ut("o2b.rec.disk.match"),
            mismatch === null ? (
              <span key="m" className="text-muted">
                {ut("o2b.rec.disk.noCompare")}
              </span>
            ) : mismatch.orphans || mismatch.missing ? (
              <StatusMark key="m" tone="warn">
                {fill(ut("o2b.rec.disk.mismatch"), { orphans: mismatch.orphans, missing: mismatch.missing })}
              </StatusMark>
            ) : (
              <StatusMark key="m" tone="ok">
                {ut("o2b.rec.disk.matches")}
              </StatusMark>
            ),
          ],
          [
            ut("o2b.rec.transcriber"),
            <span key="t" className="text-text-2">
              {ut(d.transcriberHere ? "o2b.rec.transcriber.here" : "o2b.rec.transcriber.elsewhere")}
            </span>,
          ],
        ]}
      />
      <Quiet>{ut("o2b.rec.disk.note")}</Quiet>
    </>
  );
}

function FailedRow({ f, manage, onRetried }: { f: OpsRecordings["failed"][number]; manage: boolean; onRetried: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  return (
    <GridRow cols={FAILED_COLS} className="items-start">
      <Cell>
        <span title={f.id} className="font-mono text-[12px] text-text-2">
          {shortId(f.id)}
        </span>
      </Cell>
      <Cell num>{f.ageSec === null ? "—" : fmtUptime(f.ageSec, loc)}</Cell>
      <Cell className="break-words font-mono text-[12px] text-text-2">{f.error ?? "—"}</Cell>
      <Cell className="text-right">
        {!f.retryable ? (
          <span className="text-[13px] text-muted">{ut("o2b.rec.noFile")}</span>
        ) : manage ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.opsRetryRecording(f.id);
                onRetried();
              }, ut("o2b.rec.retried"))
            }
          >
            {ut("common.retry")}
          </Button>
        ) : null}
      </Cell>
    </GridRow>
  );
}
