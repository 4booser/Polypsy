import type { OpsRecordings, RecordingStatus } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { ShareBar } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, DataTable, Loading, useAction, type Column } from "../../../ui";
import { Panel } from "../../../ui/layout";
import { Button } from "../../../ui/primitives";
import { fill } from "../../dashboard/model";
import { RankBars } from "../charts";
import { OpsIcon } from "../icons";
import { fmtBytes, fmtInt, fmtUptime, shortId } from "../model";
import { CopyLinkButton, Facts, Live, Mono, OpsHead, PanelNote, Quiet, StatusMark, useCount, useOpsResource } from "../parts";
import { REC_STATUS_KEY, countOf, diskMismatch, diskParts, freeShare } from "./model";

/*
 * Записи прийомів в «Виразній»: том, состав записей по состоянию,
 * очередь расшифровки и упавшие задания — только числами.
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
 * проговаривает, а не делает вид, что знает больше. Истории очереди по
 * часам сервер не хранит — поэтому здесь «стан зараз», без графика за сутки.
 */

const POLL_MS = 30_000;

/** Путь записи сверху вниз: от согласия до расшифровки, затем сбой и удалённые */
const PATH: readonly RecordingStatus[] = ["consent_pending", "ready", "recording", "uploaded", "transcribing", "done", "failed", "discarded"];

export default function OpsRecordingsPage() {
  const { ut } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const count = useCount();
  const res = useOpsResource(() => api.opsRecordings(), [], POLL_MS);
  const d = res.data;

  const head = (
    <OpsHead
      meta={d ? [count(["opx.rc.storedN.one", "opx.rc.storedN.few", "opx.rc.storedN.many"], d.stored.count), ut("opx.rc.metaSub")] : null}
      actions={<CopyLinkButton />}
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className="m-0 min-w-0 flex-1 text-small text-text-2">{ut("opx.rc.lead")}</p>
        <Live pollSec={POLL_MS / 1000} updatedAt={res.updatedAt} />
      </div>
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-4 max-[1100px]:grid-cols-1">
        <DiskPanel d={d} />
        <StatusPanel d={d} />
      </div>
      <QueuePanel d={d} />
      <FailedPanel d={d} manage={manage} onRetried={res.reload} />
    </div>
  );
}

/* ─────────── том ─────────── */

function DiskPanel({ d }: { d: OpsRecordings }) {
  const { ut } = useLang();
  const loc = locale();
  const vol = diskParts(d);
  const free = freeShare(d);
  const mismatch = diskMismatch(d);
  const total = d.disk?.totalBytes ?? null;
  return (
    <Panel
      title={ut("o2b.rec.disk")}
      icon={<OpsIcon name="hard-drive" />}
      sub={total ? fill(ut("opx.rc.diskSub"), { total: fmtBytes(total, loc) }) : undefined}
      footer={<PanelNote>{ut("o2b.rec.disk.note")}</PanelNote>}
    >
      {vol && total ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <b className="text-big font-extrabold leading-none tabular-nums text-text">{fmtBytes(vol.free, loc)}</b>
            <span className="text-small text-muted">{fill(ut("opx.rc.freeOf"), { total: fmtBytes(total, loc) })}</span>
          </div>
          {/*
            Том целиком: записи, всё остальное на томе, свободно. Отвечает на
            вопрос, который одно «вільно» оставляет открытым: место съедают
            записи или что-то чужое на том же томе.
          */}
          <ShareBar
            className="mt-3"
            label={ut("sig.rec.volume")}
            format={(v) => fmtBytes(v, loc)}
            percent={false}
            parts={[
              { key: "records", label: ut("sig.rec.records"), value: vol.records, color: "var(--c1)" },
              { key: "other", label: ut("sig.rec.other"), value: vol.other, color: "var(--c3)" },
              { key: "free", label: ut("sig.rec.free"), value: vol.free, color: "var(--track)" },
            ]}
          />
          {free !== null && free < 0.1 ? (
            <Callout kind="warn" icon={<OpsIcon name="hard-drive" />} className="mt-3">
              {ut("opx.rc.lowSpace")}
            </Callout>
          ) : null}
        </>
      ) : (
        <Quiet>{d.disk ? ut("opx.rc.noVolume") : ut("o2b.rec.disk.unread")}</Quiet>
      )}
      <div className="mt-4 border-t border-divider pt-3.5">
        <Facts
          w={150}
          items={[
            [
              ut("o2b.rec.disk.files"),
              d.disk ? (
                <span className="tabular-nums">
                  {fmtInt(d.disk.files, loc)}
                  {d.disk.truncated ? "+" : ""}, {fmtBytes(d.disk.bytes, loc)}
                </span>
              ) : (
                <span className="text-muted">{ut("o2b.rec.disk.unread")}</span>
              ),
            ],
            [
              ut("o2b.rec.disk.db"),
              <span key="db" className="tabular-nums">
                {fmtInt(d.stored.count, loc)}, {fmtBytes(d.stored.bytes, loc)}
              </span>,
            ],
            [
              ut("o2b.rec.disk.match"),
              mismatch === null ? (
                <StatusMark tone="unk">{ut("o2b.rec.disk.noCompare")}</StatusMark>
              ) : mismatch.orphans || mismatch.missing ? (
                <StatusMark tone="warn">{fill(ut("o2b.rec.disk.mismatch"), { orphans: mismatch.orphans, missing: mismatch.missing })}</StatusMark>
              ) : (
                <StatusMark tone="ok">{ut("o2b.rec.disk.matches")}</StatusMark>
              ),
            ],
          ]}
        />
      </div>
    </Panel>
  );
}

/* ─────────── по состоянию ─────────── */

function StatusPanel({ d }: { d: OpsRecordings }) {
  const { ut } = useLang();
  const loc = locale();
  const total = d.byStatus.reduce((s, x) => s + x.count, 0);
  const bytesOf = (s: RecordingStatus) => d.byStatus.find((x) => x.status === s)?.bytes ?? 0;
  return (
    <Panel title={ut("o2b.rec.byStatus")} icon={<OpsIcon name="layers" />} sub={fill(ut("opx.rc.allTime"), { n: fmtInt(total, loc) })}>
      {total === 0 ? (
        <Quiet>{ut("o2b.rec.none")}</Quiet>
      ) : (
        /* путь записи сверху вниз; сбой — янтарём, удалённые — серым: их больше нет, и внимания они не требуют */
        <RankBars
          labelW={150}
          items={PATH.map((s) => {
            const n = countOf(d, s);
            const word = ut(REC_STATUS_KEY[s]);
            const bytes = bytesOf(s);
            return {
              key: s,
              title: word,
              label: <span className={s === "failed" && n ? "text-small font-extrabold text-warn" : "text-small font-semibold text-text-2"}>{word}</span>,
              value: n,
              text: fmtInt(n, loc),
              extra: s === "discarded" ? (n ? ut("o2b.rec.noFile") : undefined) : bytes ? fmtBytes(bytes, loc) : undefined,
              attention: s === "failed",
              muted: s === "discarded",
            };
          })}
        />
      )}
    </Panel>
  );
}

/* ─────────── очередь расшифровки ─────────── */

function QueuePanel({ d }: { d: OpsRecordings }) {
  const { ut } = useLang();
  const loc = locale();
  const q = d.queue;
  const failed = countOf(d, "failed");
  return (
    <Panel title={ut("o2b.rec.transcriber")} icon={<OpsIcon name="audio-lines" />} sub={ut("opx.rc.queueSub")}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 max-[1000px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3">
          {q.stuck ? (
            <Callout kind="warn" icon={<OpsIcon name="triangle-alert" />} title={ut("opx.rc.stuckTitle")}>
              {fill(ut("o2b.rec.kpi.stuck"), { n: q.stuck })}
            </Callout>
          ) : q.waiting || q.transcribing ? (
            <Callout kind="info" icon={<OpsIcon name="loader-circle" />} title={ut("opx.rc.busyTitle")}>
              {ut("opx.rc.busyText")}
            </Callout>
          ) : (
            <Callout kind="good" icon={<OpsIcon name="circle-check" />} title={ut("opx.rc.idleTitle")}>
              {ut("opx.rc.idleText")}
            </Callout>
          )}
          <p className="m-0 text-small text-muted">{ut(d.transcriberHere ? "o2b.rec.transcriber.here" : "o2b.rec.transcriber.elsewhere")}</p>
        </div>
        <Facts
          w={170}
          items={[
            [
              ut("o2b.rec.kpi.transcribing"),
              <span key="t" className="tabular-nums">
                <b className="font-extrabold">{fmtInt(q.transcribing, loc)}</b>
                {q.stuck ? <span className="font-semibold text-warn">{fill(ut("opx.rc.stuckOf"), { n: q.stuck })}</span> : null}
              </span>,
            ],
            [
              ut("opx.rc.waiting"),
              <span key="w" className="tabular-nums">
                <b className="font-extrabold">{fmtInt(q.waiting, loc)}</b>
                {q.oldestWaitingSec !== null ? fill(ut("opx.rc.oldest"), { t: fmtUptime(q.oldestWaitingSec, loc) }) : null}
              </span>,
            ],
            [
              ut("o2b.rec.kpi.failed"),
              <b key="f" className={failed ? "font-extrabold tabular-nums text-warn" : "font-extrabold tabular-nums"}>
                {fmtInt(failed, loc)}
              </b>,
            ],
          ]}
        />
      </div>
    </Panel>
  );
}

/* ─────────── упавшие задания ─────────── */

type Failed = OpsRecordings["failed"][number];

function FailedPanel({ d, manage, onRetried }: { d: OpsRecordings; manage: boolean; onRetried: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  const retryable = d.failed.filter((f) => f.retryable);
  const retry = (ids: string[]) =>
    void run(async () => {
      for (const id of ids) await api.opsRetryRecording(id);
      onRetried();
    }, ut("o2b.rec.retried"));

  const columns: Column<Failed>[] = [
    {
      key: "id",
      header: ut("o2b.rec.col.job"),
      width: 130,
      required: true,
      render: (f) => (
        <Mono className="font-semibold text-text" title={f.id}>
          {shortId(f.id)}
        </Mono>
      ),
    },
    {
      key: "age",
      header: ut("o2b.rec.col.age"),
      width: 110,
      required: true,
      render: (f) => <span className="tabular-nums text-text-2">{f.ageSec === null ? "—" : fmtUptime(f.ageSec, loc)}</span>,
    },
    {
      key: "error",
      header: ut("o2b.rec.col.error"),
      required: true,
      render: (f) => <Mono className="break-words text-text-2">{f.error ?? "—"}</Mono>,
    },
    {
      key: "file",
      header: ut("opx.rc.colFile"),
      width: 150,
      required: true,
      render: (f) => (f.retryable ? <StatusMark tone="ok">{ut("opx.rc.fileHere")}</StatusMark> : <StatusMark tone="quiet">{ut("o2b.rec.noFile")}</StatusMark>),
    },
    {
      key: "retry",
      header: "",
      width: 140,
      required: true,
      render: (f) =>
        manage && f.retryable ? (
          <Button size="sm" icon={<OpsIcon name="rotate-ccw" />} disabled={busy} onClick={() => retry([f.id])}>
            {ut("common.retry")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Panel
      title={ut("o2b.rec.failed")}
      icon={<OpsIcon name="circle-alert" />}
      tone={d.failed.length ? "warn" : undefined}
      sub={ut("opx.rc.failedSub")}
      actions={
        manage && retryable.length > 1 ? (
          <Button size="sm" icon={<OpsIcon name="rotate-ccw" />} disabled={busy} onClick={() => retry(retryable.map((f) => f.id))}>
            {fill(ut("opx.rc.retryAll"), { n: retryable.length })}
          </Button>
        ) : null
      }
      flush
      footer={<PanelNote icon="history">{ut("opx.rc.retryNote")}</PanelNote>}
    >
      {d.failed.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("o2b.rec.failedNone")}</Quiet>
        </div>
      ) : (
        <DataTable rows={d.failed} columns={columns} rowKey={(f) => f.id} dense sticky={false} label={ut("o2b.rec.failed")} />
      )}
    </Panel>
  );
}
