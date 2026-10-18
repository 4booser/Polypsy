import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsKeysReport, OpsPhoneReindexReport, OpsReencryptJob, OpsSecretName, OpsSecretStatus, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, KV, Loading, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { OpsIcon } from "../icons";
import { OpsHead, Quiet, RefreshButton } from "../parts";
import {
  busyOldKeys,
  envLine,
  fill,
  jobShare,
  nextKeyId,
  removableKeys,
  rotationSteps,
  secretAge,
  type StepKey,
  type StepState,
} from "./model";
import { Caption, CodeChip, Commands, NUM, Note, SuperOnly, TD, TH, Verdict } from "./parts";

/*
 * Раздел «Ключі й секрети» техпанели — только суперадмину (сервер отвечает
 * 403 всем остальным, пункт навигации — role: "superadmin").
 *
 * Решение заказчика 2026-09-26 (пункт 22): ротация ключей шифрования и
 * секретов с мастером и проверкой. Экран отвечает на три вопроса по порядку:
 * включено ли шифрование и нет ли потери; как провести ротацию по шагам
 * RUNBOOK и где мы в ней (шаги карточками, ход перешифровки, команды для
 * сервера); какими ключами зашифровано то, что лежит сейчас, по версиям и
 * по колонкам; что будет, если сменить каждый из остальных секретов. Самих
 * ключей и секретов экран не получает вовсе — сервер отдаёт версии, «задан
 * / не задан» и даты.
 */

const STEP_TITLE: Record<StepKey, UiKey> = {
  add: "ops.sec.rot.step.add",
  restart: "ops.sec.rot.step.restart",
  reencrypt: "ops.sec.rot.step.reencrypt",
  verify: "ops.sec.rot.step.verify",
};

const STEP_STATE: Record<StepState, UiKey> = {
  done: "ops.sec.rot.state.done",
  current: "ops.sec.rot.state.current",
  todo: "ops.sec.rot.state.todo",
  blocked: "ops.sec.rot.state.blocked",
};

/** Секреты, кроме ключа шифрования: у него свой раздел выше */
const OTHER_SECRETS: { name: Exclude<OpsSecretName, "ENCRYPTION_KEY">; gives: UiKey; risks: UiKey }[] = [
  { name: "JWT_SECRET", gives: "ops.sec.secrets.JWT_SECRET.gives", risks: "ops.sec.secrets.JWT_SECRET.risks" },
  {
    name: "PHONE_INDEX_SECRET",
    gives: "ops.sec.secrets.PHONE_INDEX_SECRET.gives",
    risks: "ops.sec.secrets.PHONE_INDEX_SECRET.risks",
  },
  { name: "EXPORT_SECRET", gives: "ops.sec.secrets.EXPORT_SECRET.gives", risks: "ops.sec.secrets.EXPORT_SECRET.risks" },
  {
    name: "SEARCH_INDEX_SECRET",
    gives: "ops.sec.secrets.SEARCH_INDEX_SECRET.gives",
    risks: "ops.sec.secrets.SEARCH_INDEX_SECRET.risks",
  },
  { name: "METRICS_TOKEN", gives: "ops.sec.secrets.METRICS_TOKEN.gives", risks: "ops.sec.secrets.METRICS_TOKEN.risks" },
];

const SECRET_STATE: Record<OpsSecretStatus["state"], UiKey> = {
  set: "ops.sec.secrets.state.set",
  unset: "ops.sec.secrets.state.unset",
  default: "ops.sec.secrets.state.default",
};

export default function OpsSecKeys() {
  const { ut } = useLang();
  const res = useResource(() => api.opsSecKeys(), []);

  /*
   * Пока идёт перешифровка, опрашивается лёгкий маршрут хода, а не опись:
   * опись считает все шифрованные колонки проходом по таблицам, и дёргать её
   * раз в полторы секунды на боевой базе незачем. Опись перечитывается один
   * раз — когда проход закончился.
   */
  const running = res.data?.job?.status === "running";
  const jobRes = useResource(() => api.opsSecJob(), [], { enabled: running, pollMs: 1500 });
  const job: OpsReencryptJob | null = (running ? jobRes.data?.job : null) ?? res.data?.job ?? null;
  const wasRunning = useRef(false);
  const reload = res.reload;
  useEffect(() => {
    const now = jobRes.data?.job?.status === "running";
    if (wasRunning.current && jobRes.data && !now) reload();
    wasRunning.current = now;
  }, [jobRes.data, reload]);

  const r = res.data;
  const rotating = r ? r.loadedKeys.length > 1 : false;
  const meta: [ReactNode, ReactNode] | null = r
    ? [
        rotating
          ? fill(ut("opx.ky.metaRotation"), { from: r.loadedKeys.slice(1).join(", "), to: r.activeKey ?? "—" })
          : fill(ut("opx.ky.metaKey"), { key: r.activeKey ?? "—" }),
        job?.status === "running"
          ? fill(ut("opx.ky.metaProgress"), { pct: Math.round(jobShare(job) * 100) })
          : r.staleTotal > 0
            ? fill(ut("opx.ky.metaStale"), { n: r.staleTotal.toLocaleString(locale()) })
            : ut("opx.ky.metaClean"),
      ]
    : null;

  return (
    <div className="flex flex-col gap-4">
      <OpsHead
        meta={meta}
        actions={
          <>
            <SuperOnly />
            <RefreshButton onRefresh={res.reload} busy={res.loading} />
          </>
        }
      />
      <Note className="max-w-none">{ut("ops.sec.keys.lead")}</Note>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !r ? (
        <Loading rows={6} />
      ) : (
        <>
          <EncryptionPanel report={r} />
          <RotationSection report={r} job={job} onStarted={res.reload} />
          <KeySection report={r} />
          <SecretsSection report={r} />
        </>
      )}
    </div>
  );
}

/* ─────────── шифрование: итог ─────────── */

function EncryptionPanel({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const mark = report.secrets.find((s) => s.name === "ENCRYPTION_KEY");
  const ok = report.encryption && report.lostTotal === 0 && report.plainTotal === 0;
  return (
    <Panel
      title={ut("opx.ky.encryption")}
      icon={<OpsIcon name="lock" />}
      actions={
        report.encryption ? (
          <Tag tone="good" icon={<OpsIcon name="check" />}>
            {ut("opx.ky.on")}
          </Tag>
        ) : (
          <Tag tone="attention" icon={<OpsIcon name="lock-open" />}>
            {ut("opx.ky.off")}
          </Tag>
        )
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] items-start gap-6 max-[1000px]:grid-cols-1">
        {!report.encryption ? (
          <Verdict tone="danger" title={ut("opx.ky.offTitle")} icon="lock-open">
            {ut("ops.sec.keys.off")}
          </Verdict>
        ) : (
          <Verdict tone={ok ? "plain" : "attention"} title={ut("opx.ky.onTitle")} icon={ok ? "lock" : "triangle-alert"}>
            {fill(ut("opx.ky.onText"), {
              plain: report.plainTotal.toLocaleString(locale()),
              lost: report.lostTotal.toLocaleString(locale()),
            })}
          </Verdict>
        )}
        <KV
          w={130}
          rows={[
            [
              ut("ops.sec.keys.active"),
              <span key="a" className="flex flex-wrap items-center gap-2">
                <CodeChip>{report.activeKey ?? "—"}</CodeChip>
                {mark?.seenSince ? <span className="text-text-2">{fill(ut("ops.sec.keys.activeSince"), { date: dateTime(mark.seenSince) })}</span> : null}
              </span>,
            ],
            [
              ut("ops.sec.keys.loaded"),
              <span key="l" className="flex flex-wrap items-center gap-1.5">
                {report.loadedKeys.length ? report.loadedKeys.map((k) => <CodeChip key={k}>{k}</CodeChip>) : "—"}
                {report.loadedKeys.length > 1 ? <span className="text-text-2">{ut("opx.ky.twoKeys")}</span> : null}
              </span>,
            ],
            [ut("ops.sec.checkedAt"), dateTime(report.countedAt)],
          ]}
        />
      </div>
    </Panel>
  );
}

/* ─────────── ключ шифрования полей: версии и колонки ─────────── */

export function KeySection({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const loc = locale();
  const lostKeys = report.keys.filter((k) => !k.loaded && k.values + k.files > 0).map((k) => k.id);
  const n = (v: number) => v.toLocaleString(loc);

  return (
    <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-4 max-[1100px]:grid-cols-1">
      <Panel title={ut("ops.sec.keys.title")} icon={<OpsIcon name="key-round" />} sub={fill(ut("opx.ky.counted"), { time: dateTime(report.countedAt) })} flush>
        {report.lostTotal > 0 ? (
          <div className="px-4 pb-3">
            <Verdict tone="danger">{fill(ut("ops.sec.keys.lost"), { n: report.lostTotal, keys: lostKeys.join(", ") })}</Verdict>
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-separate border-spacing-0">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  {ut("ops.sec.keys.colVersion")}
                </th>
                <th scope="col" className={TH}>
                  {ut("ops.sec.keys.colState")}
                </th>
                <th scope="col" className={cx(TH, "text-right")}>
                  {ut("ops.sec.keys.colValues")}
                </th>
                <th scope="col" className={cx(TH, "text-right")}>
                  {ut("ops.sec.keys.colFiles")}
                </th>
                <th scope="col" className={TH}>
                  {ut("ops.sec.keys.colOpens")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.keys.map((k) => (
                <tr key={k.id}>
                  <td className={cx(TD, "font-mono font-bold")}>{k.id}</td>
                  <td className={TD}>
                    {k.active ? (
                      <Tag tone="primary">{ut("ops.sec.keys.stateActive")}</Tag>
                    ) : k.loaded ? (
                      <Tag>{ut("ops.sec.keys.stateOld")}</Tag>
                    ) : (
                      <Tag tone={k.values + k.files > 0 ? "attention" : "done"} icon={<OpsIcon name="octagon-x" />}>
                        {ut("ops.sec.keys.stateMissing")}
                      </Tag>
                    )}
                  </td>
                  <td className={cx(TD, NUM)}>{n(k.values)}</td>
                  <td className={cx(TD, NUM)}>{n(k.files)}</td>
                  <td className={TD}>
                    {k.opens === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={cx("inline-flex items-center gap-1.5 font-semibold", k.opens ? "text-good" : "font-extrabold text-warn")}>
                        <OpsIcon name={k.opens ? "circle-check" : "octagon-x"} size={15} />
                        {k.opens ? ut("ops.sec.keys.opensYes") : ut("ops.sec.keys.opensNo")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 pb-4 pt-3">
          <Caption className="mb-1.5">{ut("ops.sec.keys.files")}</Caption>
          <ul className="m-0 list-none p-0 text-[13px] leading-[19px]">
            {Object.entries(report.files.byKey).length ? (
              Object.entries(report.files.byKey).map(([id, count]) => (
                <li key={id} className="flex justify-between border-b border-divider py-1.5">
                  <span className="text-text-2">{fill(ut("opx.ky.filesOn"), { key: id })}</span>
                  <b className="font-extrabold tabular-nums">{n(count)}</b>
                </li>
              ))
            ) : (
              <li className="py-1.5 text-muted">{ut("ops.sec.none")}</li>
            )}
          </ul>
          {report.files.legacy > 0 ? (
            <p className="m-0 mt-2 text-small font-semibold text-warn">{fill(ut("ops.sec.keys.filesLegacy"), { n: report.files.legacy })}</p>
          ) : null}
          {report.files.missing > 0 ? (
            <p className="m-0 mt-1 text-small text-text-2">{fill(ut("ops.sec.keys.filesMissing"), { n: report.files.missing })}</p>
          ) : null}
        </div>
      </Panel>
      <ColumnsTable report={report} />
    </div>
  );
}

/** Разбивка по колонкам: где именно ещё лежит старое и где открытый текст */
function ColumnsTable({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const loc = locale();
  const ids = report.keys.map((k) => k.id);
  return (
    <Panel title={ut("ops.sec.keys.byColumn")} icon={<OpsIcon name="table-2" />} sub={ut("opx.ky.byColumnSub")} flush>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-separate border-spacing-0">
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {ut("ops.sec.keys.colColumn")}
              </th>
              {ids.map((id) => (
                <th key={id} scope="col" className={cx(TH, "text-right font-mono")}>
                  {id}
                </th>
              ))}
              <th scope="col" className={cx(TH, "text-right")}>
                {ut("ops.sec.keys.colPlain")}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.columns.map((c) => (
              <tr key={`${c.table}.${c.column}`}>
                <td className={cx(TD, "font-mono text-[12px]")}>
                  {`${c.table}.${c.column}`}
                  {!c.rewrappable ? <span className="block font-sans text-caption font-semibold text-warn">{ut("ops.sec.keys.noPk")}</span> : null}
                </td>
                {ids.map((id) => (
                  <td key={id} className={cx(TD, NUM, !(c.byKey[id] ?? 0) ? "text-muted" : id === report.activeKey ? undefined : "font-extrabold")}>
                    {(c.byKey[id] ?? 0).toLocaleString(loc)}
                  </td>
                ))}
                <td className={cx(TD, NUM, c.plain > 0 ? "font-extrabold text-warn" : "text-muted")}>{c.plain.toLocaleString(loc)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ─────────── мастер ротации ─────────── */

const STEP_TAG: Record<StepState, { tone: "good" | "primary" | "plain" | "attention"; icon: Parameters<typeof OpsIcon>[0]["name"] }> = {
  done: { tone: "good", icon: "check" },
  current: { tone: "primary", icon: "loader-circle" },
  todo: { tone: "plain", icon: "circle-dashed" },
  blocked: { tone: "attention", icon: "octagon-x" },
};

export function RotationSection({
  report,
  job,
  onStarted,
}: {
  report: OpsKeysReport;
  job: OpsReencryptJob | null;
  onStarted: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const steps = rotationSteps(report);
  const next = nextKeyId(report);
  const placeholder = ut("ops.sec.rot.placeholder");
  const running = job?.status === "running";

  const commands = [`echo "${next}:$(head -c 32 /dev/urandom | base64)"`, envLine([next, ...report.loadedKeys], placeholder)].join("\n");

  const removable = removableKeys(report);
  const busyKeys = busyOldKeys(report);
  const keep = report.loadedKeys.filter((id) => !removable.includes(id));

  /*
   * Команды нового ключа — только пока шаг не сделан. Посреди ротации
   * (второй ключ уже загружен) они предлагали бы третий ключ поверх
   * незаконченной смены второго — ровно то, чего делать нельзя.
   */
  const addDone = steps.find((s) => s.key === "add")?.state === "done";
  const body: Record<StepKey, ReactNode> = {
    add: <Note>{addDone ? ut("ops.sec.rot.addCheck") : ut("ops.sec.rot.addBody")}</Note>,
    restart: <Note>{fill(ut("ops.sec.rot.restartBody"), { key: report.activeKey ?? "—" })}</Note>,
    reencrypt: <Note>{ut("ops.sec.rot.reencryptBody")}</Note>,
    verify: (
      <div className="flex flex-col gap-1.5">
        {report.lostTotal > 0 ? <p className="m-0 text-[13px] font-bold leading-[19px] text-warn">{ut("ops.sec.rot.blocked")}</p> : null}
        {report.loadedKeys.length <= 1 ? <Note>{ut("ops.sec.rot.idle")}</Note> : null}
        {busyKeys.length ? (
          <p className="m-0 text-[13px] font-bold leading-[19px] text-warn">{fill(ut("ops.sec.rot.busy"), { keys: busyKeys.join(", ") })}</p>
        ) : null}
        {removable.length && report.lostTotal === 0 ? (
          <p className="m-0 text-[13px] font-bold leading-[19px] text-good">{fill(ut("ops.sec.rot.removable"), { keys: removable.join(", ") })}</p>
        ) : null}
      </div>
    ),
  };

  /* какие команды показать справа: нового ключа — пока он не добавлен; без старого — когда его можно убрать */
  const shownCommands = !addDone ? commands : removable.length && report.lostTotal === 0 ? envLine(keep, placeholder) : null;

  return (
    <Panel
      title={ut("ops.sec.rot.title")}
      icon={<OpsIcon name="refresh-cw" />}
      sub={ut("opx.ky.rotSub")}
      actions={
        report.loadedKeys.length > 1 ? (
          <Tag tone="primary" icon={<OpsIcon name="arrow-left-right" />}>
            {fill(ut("opx.ky.fromTo"), { from: report.loadedKeys.slice(1).join(", "), to: report.activeKey ?? "—" })}
          </Tag>
        ) : null
      }
    >
      <ol className="m-0 grid list-none grid-cols-4 gap-3 p-0 max-[1180px]:grid-cols-2 max-[700px]:grid-cols-1">
        {steps.map((step, i) => {
          const tag = STEP_TAG[step.state];
          return (
            <li
              key={step.key}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cx(
                "flex min-w-0 flex-col gap-2 rounded-panel px-3.5 py-3",
                step.state === "current" ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-panel shadow-[inset_0_0_0_1px_var(--divider)]",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cx(
                    "inline-grid size-7 shrink-0 place-items-center rounded-full text-small font-extrabold tabular-nums",
                    step.state === "done" ? "bg-good text-onfill" : step.state === "current" ? "bg-violet text-onfill" : "bg-sunk text-text-2",
                  )}
                >
                  {step.state === "done" ? <OpsIcon name="check" size={15} /> : i + 1}
                </span>
                <Tag tone={tag.tone} icon={<OpsIcon name={tag.icon} />}>
                  {ut(STEP_STATE[step.state])}
                </Tag>
              </span>
              <b className="text-[14px] font-extrabold leading-5 text-text">{ut(STEP_TITLE[step.key])}</b>
              {body[step.key]}
            </li>
          );
        })}
      </ol>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1100px]:grid-cols-1">
        <div className="rounded-panel px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--divider)]">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="xs"
              icon={<OpsIcon name={running ? "loader-circle" : "play"} />}
              /* потерянное перешифровка не спасёт — ключа нет; запускать её ради него незачем */
              disabled={busy || running || !report.encryption || report.staleTotal === 0}
              onClick={() =>
                run(async () => {
                  await api.opsSecReencrypt();
                  onStarted();
                })
              }
            >
              {running ? ut("ops.sec.rot.running") : ut("ops.sec.rot.run")}
            </Button>
            {report.encryption && report.staleTotal === 0 && !running ? <span className="text-small text-muted">{ut("ops.sec.rot.nothing")}</span> : null}
          </div>
          {job ? <JobLine job={job} /> : <Quiet>{ut("opx.ky.noJob")}</Quiet>}
        </div>
        <div>
          {shownCommands ? (
            <>
              <Commands title={ut("ops.sec.rot.commands")}>{shownCommands}</Commands>
              <p className="m-0 mt-2 text-caption leading-4 text-muted">{ut("opx.ky.placeholderNote")}</p>
            </>
          ) : (
            <Callout kind="line" icon={<OpsIcon name="info" />}>
              {ut("opx.ky.noCommands")}
            </Callout>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Ход прохода: процент крупно, полоса и числа; итог прошлого прохода — строкой */
function JobLine({ job }: { job: OpsReencryptJob }) {
  const { ut } = useLang();
  const share = jobShare(job);
  const loc = locale();
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-[13px] font-bold text-text">
          {job.status === "running" ? <i aria-hidden className="size-2 rounded-full bg-violet" /> : null}
          {job.status === "running"
            ? ut("ops.sec.rot.running")
            : job.status === "done" && job.finishedAt
              ? fill(ut("ops.sec.rot.jobDone"), { time: dateTime(job.finishedAt) })
              : ut("opx.ky.lastJob")}
          {job.startedBy ? <span className="font-medium text-muted">{fill(ut("opx.ky.startedBy"), { who: job.startedBy, time: dateTime(job.startedAt) })}</span> : null}
        </span>
        <b className="text-[22px] font-extrabold leading-none tabular-nums text-text">{`${Math.round(share * 100)} %`}</b>
      </div>
      {job.status === "running" ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={job.processed}
          aria-label={ut("ops.sec.rot.running")}
          className="mt-2 h-2 overflow-hidden rounded-[4px] bg-track"
        >
          {/* ширина — значение из рантайма, единственный законный инлайновый стиль */}
          <div className="h-full rounded-[4px] bg-violet" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
      <dl className="m-0 mt-2 text-[13px]">
        <div className="flex justify-between border-b border-divider py-1.5">
          <dt className="text-text-2">{ut("opx.ky.values")}</dt>
          <dd className="m-0 font-extrabold tabular-nums">{fill(ut("ops.sec.rot.progress"), { done: job.processed.toLocaleString(loc), total: job.total.toLocaleString(loc) })}</dd>
        </div>
        {job.targetKey ? (
          <div className="flex justify-between border-b border-divider py-1.5">
            <dt className="text-text-2">{ut("opx.ky.target")}</dt>
            <dd className="m-0 font-mono font-bold">{job.targetKey}</dd>
          </div>
        ) : null}
        {job.skipped > 0 ? (
          <div className="flex justify-between py-1.5">
            <dt className="text-warn">{fill(ut("ops.sec.rot.skipped"), { n: job.skipped })}</dt>
          </div>
        ) : null}
      </dl>
      {job.status === "failed" ? (
        <p className="m-0 mt-2 text-[13px] font-bold text-warn">{fill(ut("ops.sec.rot.jobFailed"), { error: job.error ?? "—" })}</p>
      ) : null}
      {job.status === "interrupted" ? <p className="m-0 mt-2 text-[13px] text-warn">{ut("ops.sec.rot.jobInterrupted")}</p> : null}
    </div>
  );
}

/* ─────────── другие секреты ─────────── */

function AgeText({ status }: { status: OpsSecretStatus }) {
  const { ut } = useLang();
  const age = secretAge(status);
  if (age.kind === "unknown") return <>{ut("ops.sec.secrets.unknown")}</>;
  if (age.kind === "changed") return <>{fill(ut("ops.sec.secrets.changed"), { n: age.days })}</>;
  return <>{fill(ut("ops.sec.secrets.tracked"), { n: age.days, date: status.trackedSince ? dateTime(status.trackedSince) : "—" })}</>;
}

export function SecretsSection({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [phones, setPhones] = useState<OpsPhoneReindexReport | null>(null);

  return (
    <Panel title={ut("ops.sec.secrets.title")} icon={<OpsIcon name="key-round" />} sub={ut("opx.ky.secretsSub")} flush>
      <ul className="m-0 list-none border-t border-divider p-0">
        {OTHER_SECRETS.map(({ name, gives, risks }) => {
          const status = report.secrets.find((s) => s.name === name);
          return (
            <li
              key={name}
              className="grid grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-2 border-b border-divider px-4 py-3.5 last:border-b-0 max-[1000px]:grid-cols-1"
            >
              <div className="min-w-0">
                <div className="break-all font-mono text-[13px] font-bold leading-5 text-text">{name}</div>
                {status ? (
                  <>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Tag tone={status.state === "set" ? "good" : "attention"} icon={<OpsIcon name={status.state === "set" ? "check" : "eye-off"} />}>
                        {ut(SECRET_STATE[status.state])}
                      </Tag>
                      {name === "EXPORT_SECRET" ? <Tag tone="attention">{ut("opx.ky.dontRotate")}</Tag> : null}
                    </div>
                    <div className="mt-1 text-small text-muted">
                      <AgeText status={status} />
                    </div>
                  </>
                ) : null}
              </div>
              <div>
                <Caption>{ut("ops.sec.secrets.gives")}</Caption>
                <p className="m-0 mt-1 text-[13px] leading-[19px] text-text">{ut(gives)}</p>
              </div>
              <div>
                <Caption>{ut("ops.sec.secrets.risks")}</Caption>
                {/* выгрузки ломаются необратимо — это не «внимание», а поломка: жирно и янтарём */}
                <p className={cx("m-0 mt-1 text-[13px] leading-[19px]", name === "EXPORT_SECRET" ? "font-bold text-warn" : "text-text")}>{ut(risks)}</p>
                {name === "PHONE_INDEX_SECRET" ? (
                  <div className="mt-2">
                    <Button
                      size="xs"
                      icon={<OpsIcon name="list-filter" />}
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          setPhones(await api.opsSecReindexPhones());
                        })
                      }
                    >
                      {ut("ops.sec.phones.run")}
                    </Button>
                    {phones ? (
                      <p className="m-0 mt-1.5 text-small tabular-nums text-text-2">{fill(ut("ops.sec.phones.done"), { ...phones })}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
