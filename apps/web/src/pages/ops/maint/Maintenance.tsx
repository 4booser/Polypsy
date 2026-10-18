import { useState, type ReactNode } from "react";
import type { OpsJob, OpsServiceStatus, ServiceStatus } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime, locale, timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { refreshServiceStatus } from "../../../service/status";
import { minutesLeft } from "../../../service/model";
import { DataTable, Loading, Modal, useAction, type Column } from "../../../ui";
import { IconTile, Panel } from "../../../ui/layout";
import { Button, ButtonLink, CheckLabel, Checkbox, Field, Input, Select, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon, type OpsIconName } from "../icons";
import { JOB_KEY, RESULT_KEY } from "../model";
import { canRunNow } from "../obs2b/model";
import { CopyLinkButton, OpsHead, PanelNote, Quiet, StatusMark, type Tone } from "../parts";
import { localInputToIso } from "./model";

/**
 * Раздел «Обслуговування» техпанели: режим обслуживания с предпросмотром
 * баннера, объявления о сбоях, служебные действия и история объявлений с
 * авторами.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункты 8 и 10).
 *
 * Смотрит ops.read, меняет ops.manage. Без права на изменение формы не
 * рисуются вовсе, а не рисуются выключенными: выключенная кнопка обещает,
 * что её можно включить, и человек ищет, чего не хватает. Вместо формы —
 * строка, какое право нужно.
 *
 * Включение режима спрашивает подтверждение окном: оно закрывает запись
 * всем сразу, включая пациентов посреди методики. Выключение — нет:
 * возвращать работу людям незачем переспрашивать.
 *
 * Служебные действия — задачи, которые безопасно запускать вне такта
 * (lib/opsManual.ts): тот же реестр и та же кнопка, что в «Фонових
 * задачах», здесь — рядом с режимом, ради которого их и запускают.
 */

const STATUS_TONE: Record<ServiceStatus, Tone> = { ok: "ok", degraded: "fail", maintenance: "warn" };

/** Значки служебных действий по задаче; незнакомая задача — шестерня */
const JOB_ICON: Record<string, OpsIconName> = {
  "search.reindex": "search",
  "catalog.install": "library",
  "data.quality": "badge-check",
  retention: "archive",
  "ops.alerts": "bell-ring",
};

export default function OpsMaintenance() {
  const { ut } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const res = useResource(() => api.opsStatus(), []);
  const jobs = useResource(() => api.opsJobs(), []);
  const d = res.data;
  const cur = d?.current.status ?? "ok";

  const head = (
    <OpsHead
      meta={d ? [ut(cur === "ok" ? "opx.mt.metaOk" : cur === "maintenance" ? "opx.mt.metaOn" : "opx.mt.metaDegraded"), ut("opx.mt.metaRights")] : null}
      actions={
        <>
          <ButtonLink to="/status">
            <OpsIcon name="external-link" size={15} />
            {ut("opx.mt.statusPage")}
          </ButtonLink>
          <CopyLinkButton />
        </>
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

  const manual = jobs.data?.items.filter((j) => j.manual) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {head}
      <ModeAndPreview data={d} manage={manage} onChanged={res.reload} />
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <h2 className="m-0 text-[20px] font-extrabold leading-[26px] tracking-[-0.02em] text-text">{ut("opx.mt.service")}</h2>
        <span className="text-[13px] text-muted">{ut("opx.mt.serviceSub")}</span>
      </div>
      <Panel title={ut("opx.mt.actions")} icon={<OpsIcon name="wrench" />} flush>
        {jobs.error && !jobs.data ? (
          <div className="px-4 pb-3">
            <Loading bare error={jobs.error} onRetry={jobs.reload} />
          </div>
        ) : !manual ? (
          <div className="px-4 pb-3">
            <Loading bare rows={3} />
          </div>
        ) : manual.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("opx.mt.noActions")}</Quiet>
          </div>
        ) : (
          <ServiceActions items={manual} manage={manage} onStarted={jobs.reload} />
        )}
      </Panel>
      <HistoryPanel d={d} />
    </div>
  );
}

/* ─────────── режим, объявление, предпросмотр ─────────── */

function ModeAndPreview({ data, manage, onChanged }: { data: OpsServiceStatus; manage: boolean; onChanged: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const on = data.current.status === "maintenance";
  const [message, setMessage] = useState("");
  const [until, setUntil] = useState("");
  const [kind, setKind] = useState<"ok" | "degraded">("degraded");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);

  async function publish(input: Parameters<typeof api.opsAnnounce>[0]) {
    await api.opsAnnounce(input);
    onChanged();
    // баннер этой же вкладки — сразу, а не через две минуты опроса
    await refreshServiceStatus();
  }

  /* предпросмотр: работы уже идут — то, что видят люди; нет — то, что увидят после включения */
  const preview = on
    ? { message: data.current.message, until: data.current.expectedEnd }
    : { message: message.trim() || null, until: localInputToIso(until) };

  return (
    <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-start gap-4 max-[1100px]:grid-cols-1">
      <div className="flex min-w-0 flex-col gap-4">
        <Panel
          title={ut("mt.mode")}
          icon={<OpsIcon name="construction" />}
          tone={on ? "warn" : "violet"}
          actions={
            <StatusMark tone={on ? "warn" : "ok"}>{on ? ut("opx.mt.modeOn") : ut("opx.mt.modeOff")}</StatusMark>
          }
        >
          <p className="m-0 text-[13.5px] leading-5 text-text-2">{ut("mt.modeHint")}</p>
          {on && data.current.since ? (
            <p className="m-0 mt-2 text-small text-text-2">
              {fill(ut("opx.mt.onSince"), { time: dateTime(data.current.since), by: data.history[0]?.by ?? "—" })}
              {data.current.expectedEnd ? ` ${fill(ut("opx.mt.onUntil"), { time: dateTime(data.current.expectedEnd) })}` : ""}
            </p>
          ) : null}
          {data.current.auto === "db" ? <StatusMark tone="warn" className="mt-2">{ut("svc.autoDb")}</StatusMark> : null}
          {manage ? (
            on ? (
              <div className="mt-4">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<OpsIcon name="power" />}
                  disabled={busy}
                  onClick={() => void run(() => publish({ status: "ok", message: null, expectedEnd: null }), ut("mt.done"))}
                >
                  {ut("mt.off")}
                </Button>
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                <Field label={ut("mt.message")} hint={ut("opx.mt.messageHint")}>
                  <Textarea rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={ut("opx.ov.messagePh")} />
                </Field>
                <div className="flex flex-wrap items-end gap-4">
                  <Field label={ut("mt.until")}>
                    <Input
                      type="datetime-local"
                      value={until}
                      onChange={(e) => setUntil(e.target.value)}
                      icon={<OpsIcon name="calendar-clock" />}
                      className="w-[240px]"
                    />
                  </Field>
                  <span className="max-w-[320px] pb-2 text-caption leading-4 text-muted">{ut("opx.mt.countdownNote")}</span>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <Button variant="primary" icon={<OpsIcon name="construction" />} disabled={busy} onClick={() => setConfirm(true)}>
                    {ut("mt.on")}
                  </Button>
                  <span className="max-w-[320px] text-caption leading-4 text-muted">{ut("opx.mt.confirmNote")}</span>
                </div>
              </div>
            )
          ) : (
            <p className="m-0 mt-3 text-small text-muted">{ut("mt.needManage")}</p>
          )}
        </Panel>
        {manage ? (
          <Panel title={ut("mt.announce")} icon={<OpsIcon name="megaphone" />} sub={ut("opx.mt.announceSub")} footer={<PanelNote>{ut("mt.announceHint")}</PanelNote>}>
            <div className="grid grid-cols-[180px_minmax(0,1fr)_auto] items-end gap-3 max-[700px]:grid-cols-1">
              <Field label={ut("mt.status")}>
                <Select value={kind} onChange={(e) => setKind(e.target.value as "ok" | "degraded")}>
                  <option value="degraded">{ut("svc.status.degraded")}</option>
                  <option value="ok">{ut("svc.status.ok")}</option>
                </Select>
              </Field>
              <Field label={ut("mt.message")}>
                <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={ut("opx.mt.notePh")} />
              </Field>
              <Button
                icon={<OpsIcon name="megaphone" />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await publish({ status: kind, message: note.trim() || null, expectedEnd: null });
                    setNote("");
                  }, ut("mt.done"))
                }
              >
                {ut("mt.publish")}
              </Button>
            </div>
          </Panel>
        ) : null}
      </div>
      <Panel
        title={ut("opx.mt.preview")}
        icon={<OpsIcon name="eye" />}
        sub={ut("opx.mt.previewSub")}
        footer={<PanelNote>{ut("opx.mt.offNote")}</PanelNote>}
      >
        <div className="flex flex-col gap-3">
          <PreviewFrame icon="monitor" title={ut("opx.mt.inConsole")}>
            <BannerPreview message={preview.message} until={preview.until} />
          </PreviewFrame>
          <PreviewFrame icon="user-round" title={ut("opx.mt.inPatient")}>
            <BannerPreview message={preview.message} until={preview.until} />
          </PreviewFrame>
        </div>
      </Panel>
      {confirm ? (
        <MaintenanceConfirm
          message={message.trim() || null}
          until={localInputToIso(until)}
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() =>
            void run(async () => {
              await publish({ status: "maintenance", message: message.trim() || null, expectedEnd: localInputToIso(until) });
              setMessage("");
              setUntil("");
              setConfirm(false);
            }, ut("mt.done"))
          }
        />
      ) : null}
    </div>
  );
}

/** Рамка предпросмотра: подпись места и сам баннер над пустым экраном */
function PreviewFrame({ icon, title, children }: { icon: OpsIconName; title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[12px] bg-ground shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex h-7 items-center gap-1.5 bg-sunk px-3 text-caption font-bold text-muted">
        <OpsIcon name={icon} size={13} />
        {title}
      </div>
      {children}
      <div aria-hidden className="flex flex-col gap-2 p-3">
        <i className="block h-2.5 w-[55%] rounded-[5px] bg-sunk" />
        <i className="block h-2.5 w-[80%] rounded-[5px] bg-sunk" />
      </div>
    </div>
  );
}

/** Баннер, каким его увидят люди: тот же текст, что у MaintenanceBanner, без живой области — это образец */
function BannerPreview({ message, until }: { message: string | null; until: string | null }) {
  const { ut } = useLang();
  const now = Date.now();
  const left = minutesLeft(until, now);
  return (
    <div className="flex items-start gap-2.5 bg-warn-tint px-3 py-2.5 text-small leading-[18px] text-text-2 shadow-[inset_0_-1px_0_var(--warnline)]">
      <OpsIcon name="construction" size={16} className="mt-px shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <b className="font-extrabold text-warn">{ut("svc.banner.maintenance")}.</b> {message ?? ut("svc.banner.maintenanceHint")}
      </span>
      {until ? (
        <span className="shrink-0 whitespace-nowrap font-semibold text-text-2">
          {fill(ut("opx.mt.bannerUntil"), { time: timeOfDay(until) })}
          {left !== null ? ` ${fill(ut("opx.mt.bannerLeft"), { n: left })}` : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Подтверждение включения: что произойдёт, как будет выглядеть баннер и
 * отметка «команду попереджено» — без неё кнопка не нажимается: режим
 * закрывает запись всем, и об этом должны знать до, а не после.
 */
function MaintenanceConfirm({
  message,
  until,
  busy,
  onClose,
  onConfirm,
}: {
  message: string | null;
  until: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { ut } = useLang();
  const [told, setTold] = useState(false);
  const left = minutesLeft(until, Date.now());
  return (
    <Modal
      title={ut("opx.mt.confirmTitle")}
      sub={until ? `${fill(ut("opx.mt.bannerUntil"), { time: dateTime(until) })}${left !== null ? ` ${fill(ut("opx.mt.bannerLeft"), { n: left })}` : ""}` : undefined}
      icon={<OpsIcon name="construction" />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={<OpsIcon name="construction" />} disabled={busy || !told} onClick={onConfirm}>
            {ut("mt.on")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-[13.5px] leading-5 text-text">{ut("opx.mt.confirmText")}</p>
      <div className="mt-3 overflow-hidden rounded-[12px] bg-ground shadow-[inset_0_0_0_1px_var(--border)]">
        <div className="flex h-7 items-center gap-1.5 bg-sunk px-3 text-caption font-bold text-muted">
          <OpsIcon name="eye" size={13} />
          {ut("opx.mt.bannerWillBe")}
        </div>
        <BannerPreview message={message} until={until} />
      </div>
      <CheckLabel className="mt-3" label={ut("opx.mt.teamTold")} control={<Checkbox checked={told} onChange={(e) => setTold(e.target.checked)} />} />
    </Modal>
  );
}

/* ─────────── служебные действия ─────────── */

const RESULT_TONE: Record<NonNullable<OpsJob["lastResult"]>, Tone> = { ok: "ok", error: "fail", skipped: "warn", running: "run" };

function ServiceActions({ items, manage, onStarted }: { items: OpsJob[]; manage: boolean; onStarted: () => void }) {
  const { ut } = useLang();
  return (
    <div role="table" aria-label={ut("opx.mt.actions")}>
      <div
        role="row"
        className="grid h-[38px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted"
      >
        <span role="columnheader">{ut("opx.mt.action")}</span>
        <span role="columnheader">{ut("opx.mt.lastRun")}</span>
        <span role="columnheader" />
      </div>
      {items.map((j) => (
        <ActionRow key={j.name} j={j} manage={manage} onStarted={onStarted} />
      ))}
    </div>
  );
}

function ActionRow({ j, manage, onStarted }: { j: OpsJob; manage: boolean; onStarted: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  const key = JOB_KEY[j.name];
  const when = j.lastStartAt
    ? new Date(j.lastStartAt).toLocaleString(loc, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div role="row" className="grid min-h-14 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-b border-divider px-4 py-2 last:border-b-0">
      <span role="cell" className="flex min-w-0 items-center gap-3">
        <IconTile icon={<OpsIcon name={JOB_ICON[j.name] ?? "cog"} />} />
        <span className="min-w-0">
          <b className="block truncate text-[13.5px] font-bold text-text">{key ? ut(key) : j.name}</b>
          <span className="block truncate font-mono text-[12px] text-text-2">{j.name}</span>
        </span>
      </span>
      <span role="cell" className="min-w-0">
        {j.lastResult ? (
          <StatusMark tone={RESULT_TONE[j.lastResult]} className="whitespace-normal">
            {when ? fill(ut("opx.mt.resultAt"), { result: ut(RESULT_KEY[j.lastResult]), time: when }) : ut(RESULT_KEY[j.lastResult])}
          </StatusMark>
        ) : (
          <StatusMark tone="quiet">{ut("ops.never")}</StatusMark>
        )}
        {j.lastError ? <span className="mt-0.5 block truncate font-mono text-[12px] text-text-2">{j.lastError}</span> : null}
      </span>
      <span role="cell" className="flex items-center justify-end gap-1">
        {manage ? (
          <Button
            size="xs"
            icon={<OpsIcon name={j.lastResult === "running" ? "loader-circle" : "play"} />}
            disabled={busy || !canRunNow(j)}
            onClick={() =>
              void run(async () => {
                await api.opsRunJob(j.name);
                onStarted();
              }, ut("o2b.jobs.started"))
            }
          >
            {j.lastResult === "running" ? ut("ops.result.running") : ut("o2b.jobs.runNow")}
          </Button>
        ) : null}
        <ButtonLink to={`/ops/logs?window=24h&q=${encodeURIComponent(j.name)}`} variant="quiet" size="icon-sm" aria-label={ut("opx.rq.logs")}>
          <OpsIcon name="history" size={15} />
        </ButtonLink>
      </span>
    </div>
  );
}

/* ─────────── история ─────────── */

function HistoryPanel({ d }: { d: OpsServiceStatus }) {
  const { ut } = useLang();
  const columns: Column<OpsServiceStatus["history"][number]>[] = [
    { key: "at", header: ut("mt.when"), width: 160, required: true, render: (a) => <span className="tabular-nums text-text">{dateTime(a.at)}</span> },
    {
      key: "status",
      header: ut("mt.status"),
      width: 170,
      required: true,
      render: (a) => (
        <StatusMark tone={STATUS_TONE[a.status]}>
          {ut(`svc.status.${a.status}`)}
        </StatusMark>
      ),
    },
    {
      key: "message",
      header: ut("mt.message"),
      required: true,
      render: (a) =>
        a.message ? (
          <span className="whitespace-pre-line text-text [overflow-wrap:anywhere]">{a.message}</span>
        ) : (
          <span className="text-muted">{ut(a.status === "ok" ? "opx.mt.bannerRemoved" : "opx.mt.noText")}</span>
        ),
    },
    {
      key: "until",
      header: ut("svc.until"),
      width: 140,
      required: true,
      render: (a) => <span className="tabular-nums text-text-2">{a.expectedEnd ? dateTime(a.expectedEnd) : "—"}</span>,
    },
    { key: "by", header: ut("mt.by"), width: 170, required: true, render: (a) => <span className="text-text-2">{a.by ?? "—"}</span> },
  ];
  return (
    <Panel title={ut("svc.history")} icon={<OpsIcon name="history" />} sub={ut("opx.mt.withAuthors")} flush>
      {d.history.length ? (
        <DataTable rows={d.history} columns={columns} rowKey={(a) => a.id} dense sticky={false} label={ut("svc.history")} />
      ) : (
        <div className="px-4 pb-3">
          <Quiet>{ut("svc.noHistory")}</Quiet>
        </div>
      )}
    </Panel>
  );
}
