import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsKeysReport, OpsPhoneReindexReport, OpsReencryptJob, OpsSecretName, OpsSecretStatus, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Num, Tag } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
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
import { Caption, Commands, NUM, Note, TD, TH, Verdict } from "./parts";

/*
 * Раздел «Ключі й секрети» техпанели — только суперадмину (сервер отвечает
 * 403 всем остальным, пункт навигации — role: "superadmin").
 *
 * Решение заказчика 2026-09-26 (пункт 22): ротация ключей шифрования и
 * секретов с мастером и проверкой. Экран отвечает на три вопроса по порядку:
 * какими ключами зашифровано то, что лежит сейчас (и нет ли потери); как
 * провести ротацию по шагам RUNBOOK и где мы в ней; что будет, если сменить
 * каждый из остальных секретов. Самих ключей и секретов экран не получает
 * вовсе — сервер отдаёт версии, «задан / не задан» и даты.
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

  return (
    <div className="pt-[8px]">
      <Note className="mb-[24px]">
        {ut("ops.sec.superOnly")} {ut("ops.sec.keys.lead")}
      </Note>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : (
        <>
          <KeySection report={res.data} />
          <RotationSection report={res.data} job={job} onStarted={res.reload} />
          <SecretsSection report={res.data} />
        </>
      )}
    </div>
  );
}

/* ─────────── ключ шифрования полей ─────────── */

export function KeySection({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const lostKeys = report.keys.filter((k) => !k.loaded && k.values + k.files > 0).map((k) => k.id);
  const mark = report.secrets.find((s) => s.name === "ENCRYPTION_KEY");

  return (
    <RuleSection title={ut("ops.sec.keys.title")}>
      {/* три колонки сведений — сетка формы макета (370 с зазором 45), ниже 900 столбиком */}
      <div className="mb-[18px] grid grid-cols-3 gap-x-[45px] gap-y-[12px] max-[900px]:grid-cols-1">
        <div>
          <Caption>{ut("ops.sec.keys.active")}</Caption>
          <div className="mt-[4px] font-mono text-[17px] font-bold text-primary">{report.activeKey ?? "—"}</div>
          {mark?.seenSince ? (
            <div className="text-[13px] text-muted">
              {fill(ut("ops.sec.keys.activeSince"), { date: dateTime(mark.seenSince) })}
            </div>
          ) : null}
        </div>
        <div>
          <Caption>{ut("ops.sec.keys.loaded")}</Caption>
          <div className="mt-[4px] font-mono text-[17px] text-text">
            {report.loadedKeys.length ? report.loadedKeys.join(", ") : "—"}
          </div>
        </div>
        <div>
          <Caption>{ut("ops.sec.checkedAt")}</Caption>
          <div className="mt-[4px] text-[15px] text-text">{dateTime(report.countedAt)}</div>
        </div>
      </div>

      <div className="mb-[18px] flex flex-col gap-[8px]">
        {!report.encryption ? <Verdict tone="danger">{ut("ops.sec.keys.off")}</Verdict> : null}
        {report.lostTotal > 0 ? (
          <Verdict tone="danger">
            {fill(ut("ops.sec.keys.lost"), { n: report.lostTotal, keys: lostKeys.join(", ") })}
          </Verdict>
        ) : null}
        {report.encryption && report.plainTotal > 0 ? (
          <Verdict tone="attention">{fill(ut("ops.sec.keys.plain"), { n: report.plainTotal })}</Verdict>
        ) : null}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr>
              <th scope="col" className={TH}>{ut("ops.sec.keys.colVersion")}</th>
              <th scope="col" className={TH}>{ut("ops.sec.keys.colState")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("ops.sec.keys.colValues")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("ops.sec.keys.colFiles")}</th>
              <th scope="col" className={TH}>{ut("ops.sec.keys.colOpens")}</th>
            </tr>
          </thead>
          <tbody>
            {report.keys.map((k) => (
              <tr key={k.id}>
                <td className={cx(TD, "font-mono font-bold text-primary")}>{k.id}</td>
                <td className={cx(TD, !k.loaded && k.values + k.files > 0 && "font-bold text-danger")}>
                  {k.active
                    ? ut("ops.sec.keys.stateActive")
                    : k.loaded
                      ? ut("ops.sec.keys.stateOld")
                      : ut("ops.sec.keys.stateMissing")}
                </td>
                <td className={cx(TD, NUM)}>{k.values}</td>
                <td className={cx(TD, NUM)}>{k.files}</td>
                <td className={cx(TD, k.opens === false && "font-bold text-danger")}>
                  {k.opens === null ? "—" : k.opens ? ut("ops.sec.keys.opensYes") : ut("ops.sec.keys.opensNo")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="m-0 mt-[14px] text-[13px] leading-[18px] text-text-2">
        <span className="font-bold text-muted">{ut("ops.sec.keys.files")}: </span>
        {Object.entries(report.files.byKey).length
          ? Object.entries(report.files.byKey).map(([id, n]) => (
              <span key={id} className="mr-[12px] font-mono tabular-nums">
                {id} — {n}
              </span>
            ))
          : <span className="mr-[12px]">{ut("ops.sec.none")}</span>}
        {report.files.legacy > 0 ? (
          <span className="block text-accent">{fill(ut("ops.sec.keys.filesLegacy"), { n: report.files.legacy })}</span>
        ) : null}
        {report.files.missing > 0 ? (
          <span className="block text-muted">{fill(ut("ops.sec.keys.filesMissing"), { n: report.files.missing })}</span>
        ) : null}
      </p>

      <ColumnsTable report={report} />
    </RuleSection>
  );
}

/**
 * Разбивка по колонкам — под раскрытием: нужна тому, кто ищет, где именно
 * осталось старое, а не каждому, кто открыл раздел.
 */
function ColumnsTable({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const ids = report.keys.map((k) => k.id);
  return (
    <details className="mt-[14px]">
      <summary className="cursor-pointer text-[13px] font-bold text-primary">{ut("ops.sec.keys.byColumn")}</summary>
      <div className="mt-[8px] overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse">
          <thead>
            <tr>
              <th scope="col" className={TH}>{ut("ops.sec.keys.colColumn")}</th>
              {ids.map((id) => (
                <th key={id} scope="col" className={cx(TH, "text-right font-mono")}>{id}</th>
              ))}
              <th scope="col" className={cx(TH, "text-right")}>{ut("ops.sec.keys.colPlain")}</th>
            </tr>
          </thead>
          <tbody>
            {report.columns.map((c) => (
              <tr key={`${c.table}.${c.column}`}>
                <td className={cx(TD, "font-mono")}>
                  {c.table}.{c.column}
                  {!c.rewrappable ? <span className="block font-sans text-accent">{ut("ops.sec.keys.noPk")}</span> : null}
                </td>
                {ids.map((id) => (
                  <td key={id} className={cx(TD, NUM, !(c.byKey[id] ?? 0) && "text-muted")}>{c.byKey[id] ?? 0}</td>
                ))}
                <td className={cx(TD, NUM, c.plain > 0 ? "text-accent" : "text-muted")}>{c.plain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ─────────── мастер ротации ─────────── */

function StepMark({ state }: { state: StepState }) {
  const { ut } = useLang();
  if (state === "current") return <Tag tone="primary">{ut(STEP_STATE[state])}</Tag>;
  if (state === "blocked") return <Tag tone="danger">{ut(STEP_STATE[state])}</Tag>;
  return <span className="text-[13px] text-muted">{ut(STEP_STATE[state])}</span>;
}

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

  const commands = [
    `echo "${next}:$(head -c 32 /dev/urandom | base64)"`,
    envLine([next, ...report.loadedKeys], placeholder),
  ].join("\n");

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
    add: addDone ? (
      <Note>{ut("ops.sec.rot.addCheck")}</Note>
    ) : (
      <>
        <Note>{ut("ops.sec.rot.addBody")}</Note>
        <Caption className="mt-[10px]">{ut("ops.sec.rot.commands")}</Caption>
        <Commands>{commands}</Commands>
        <Note className="mt-[8px]">{ut("ops.sec.rot.addCheck")}</Note>
      </>
    ),
    restart: <Note>{fill(ut("ops.sec.rot.restartBody"), { key: report.activeKey ?? "—" })}</Note>,
    reencrypt: (
      <>
        <Note>{ut("ops.sec.rot.reencryptBody")}</Note>
        <div className="mt-[10px] flex flex-wrap items-center gap-[16px]">
          <Button
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
          {report.encryption && report.staleTotal === 0 && !running ? (
            <span className="text-[13px] text-muted">{ut("ops.sec.rot.nothing")}</span>
          ) : null}
        </div>
        {job ? <JobLine job={job} /> : null}
      </>
    ),
    verify: (
      <div className="flex flex-col gap-[6px]">
        {report.lostTotal > 0 ? <Verdict tone="danger">{ut("ops.sec.rot.blocked")}</Verdict> : null}
        {report.loadedKeys.length <= 1 ? <Note>{ut("ops.sec.rot.idle")}</Note> : null}
        {busyKeys.length ? (
          <Verdict tone="attention">{fill(ut("ops.sec.rot.busy"), { keys: busyKeys.join(", ") })}</Verdict>
        ) : null}
        {removable.length && report.lostTotal === 0 ? (
          <>
            <Verdict tone="plain">{fill(ut("ops.sec.rot.removable"), { keys: removable.join(", ") })}</Verdict>
            <Commands>{envLine(keep, placeholder)}</Commands>
          </>
        ) : null}
      </div>
    ),
  };

  return (
    <RuleSection title={ut("ops.sec.rot.title")}>
      <ol className="m-0 list-none p-0">
        {steps.map((step, i) => (
          <li
            key={step.key}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cx(
              "grid grid-cols-[36px_1fr] gap-x-[12px] border-b border-hairline py-[14px] last:border-b-0",
              step.state === "todo" && "opacity-80",
            )}
          >
            <span className="font-mono text-[17px] font-bold tabular-nums text-primary">{i + 1}</span>
            <div className="min-w-0">
              <div className="mb-[6px] flex flex-wrap items-center gap-[12px]">
                <h3 className="m-0 text-[17px] font-bold leading-[22px] text-primary">{ut(STEP_TITLE[step.key])}</h3>
                <StepMark state={step.state} />
              </div>
              {body[step.key]}
            </div>
          </li>
        ))}
      </ol>
    </RuleSection>
  );
}

/** Ход прохода: полоса и числа; итог прошлого прохода — строкой */
function JobLine({ job }: { job: OpsReencryptJob }) {
  const { ut } = useLang();
  const share = jobShare(job);
  return (
    <div className="mt-[12px] max-w-[560px]">
      {job.status === "running" ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={job.processed}
          aria-label={ut("ops.sec.rot.running")}
          className="h-[6px] overflow-hidden rounded-[3px] bg-primary-soft"
        >
          {/* ширина — значение из рантайма, единственный законный инлайновый стиль */}
          <div className="h-full bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      ) : null}
      <p className="m-0 mt-[6px] text-[13px] leading-[18px] text-text-2">
        {job.status === "done" && job.finishedAt ? `${fill(ut("ops.sec.rot.jobDone"), { time: dateTime(job.finishedAt) })} · ` : null}
        <Num>{fill(ut("ops.sec.rot.progress"), { done: job.processed, total: job.total })}</Num>
        {job.targetKey ? <span className="font-mono"> → {job.targetKey}</span> : null}
      </p>
      {job.skipped > 0 ? (
        <p className="m-0 text-[13px] text-accent">{fill(ut("ops.sec.rot.skipped"), { n: job.skipped })}</p>
      ) : null}
      {job.status === "failed" ? (
        <Verdict tone="danger" className="mt-[4px] text-[13px]">
          {fill(ut("ops.sec.rot.jobFailed"), { error: job.error ?? "—" })}
        </Verdict>
      ) : null}
      {job.status === "interrupted" ? (
        <Verdict tone="attention" className="mt-[4px] text-[13px]">{ut("ops.sec.rot.jobInterrupted")}</Verdict>
      ) : null}
    </div>
  );
}

/* ─────────── другие секреты ─────────── */

function AgeText({ status }: { status: OpsSecretStatus }) {
  const { ut } = useLang();
  const age = secretAge(status);
  if (age.kind === "unknown") return <>{ut("ops.sec.secrets.unknown")}</>;
  if (age.kind === "changed") return <>{fill(ut("ops.sec.secrets.changed"), { n: age.days })}</>;
  return (
    <>{fill(ut("ops.sec.secrets.tracked"), { n: age.days, date: status.trackedSince ? dateTime(status.trackedSince) : "—" })}</>
  );
}

export function SecretsSection({ report }: { report: OpsKeysReport }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [phones, setPhones] = useState<OpsPhoneReindexReport | null>(null);

  return (
    <RuleSection title={ut("ops.sec.secrets.title")}>
      <ul className="m-0 list-none p-0">
        {OTHER_SECRETS.map(({ name, gives, risks }) => {
          const status = report.secrets.find((s) => s.name === name);
          return (
            <li
              key={name}
              className={cx(
                "grid grid-cols-[220px_1fr_1fr] gap-x-[36px] border-b border-hairline py-[14px] last:border-b-0",
                "max-[900px]:grid-cols-1 max-[900px]:gap-y-[8px]",
              )}
            >
              <div className="min-w-0">
                <div className="break-all font-mono text-[15px] font-bold leading-[20px] text-primary">{name}</div>
                {status ? (
                  <>
                    <div
                      className={cx(
                        "mt-[4px] text-[13px]",
                        status.state === "set" ? "text-text-2" : "font-bold text-accent",
                      )}
                    >
                      {ut(SECRET_STATE[status.state])}
                    </div>
                    <div className="text-[13px] text-muted">
                      <AgeText status={status} />
                    </div>
                  </>
                ) : null}
              </div>
              <div>
                <Caption>{ut("ops.sec.secrets.gives")}</Caption>
                <p className="m-0 mt-[4px] text-[13px] leading-[18px] text-text-2">{ut(gives)}</p>
              </div>
              <div>
                <Caption>{ut("ops.sec.secrets.risks")}</Caption>
                {/* выгрузки ломаются необратимо — это не «внимание», а поломка */}
                <p
                  className={cx(
                    "m-0 mt-[4px] text-[13px] leading-[18px]",
                    name === "EXPORT_SECRET" ? "font-bold text-danger" : "text-text-2",
                  )}
                >
                  {ut(risks)}
                </p>
                {name === "PHONE_INDEX_SECRET" ? (
                  <div className="mt-[10px]">
                    <Button
                      variant="ghost"
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
                      <p className="m-0 mt-[6px] font-mono text-[13px] tabular-nums text-text-2">
                        {fill(ut("ops.sec.phones.done"), { ...phones })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </RuleSection>
  );
}
