import type { OpsAuditChainReport, OpsIntegrityCheck, OpsIntegrityState, OpsRlsReport, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, KV, Loading, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, ButtonLink } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { OpsIcon } from "../icons";
import { lastDays, localDay } from "../obs2b/model";
import { CopyLinkButton, OpsHead, Quiet, StatusMark, sinceText } from "../parts";
import { checkDays, fill } from "./model";
import { Caption, CheckStrip, CodeChip, Note, Verdict } from "./parts";

/** Момент коротко, как во всей техпанели: «18.10, 20:44» */
const stamp = (iso: string) => sinceText(iso, locale());

/*
 * Раздел «Цілісність» техпанели — только суперадмину.
 *
 * Решение заказчика 2026-09-26 (пункт 23): проверка политик строк одной
 * кнопкой и сверка цепочки журнала — кнопкой и по расписанию раз в сутки.
 * Обе проверки жили и раньше (rlsReport.ts, audit:verify, команды консоли),
 * но их надо было помнить; здесь у них есть кнопка, память результатов и
 * расписание. Отчёт RLS — карта мест, где в базе нет защиты, поэтому
 * раздел закрыт ролью, а не правом ops.read.
 *
 * Отчёт RLS называет места без защиты — три вида, каждый своей карточкой;
 * полной карты всех таблиц сервер не отдаёт, и экран её не рисует.
 */

export default function OpsSecIntegrity() {
  const { ut } = useLang();
  const res = useResource(() => api.opsSecIntegrity(), []);
  const { run, busy } = useAction();

  const check = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      res.reload();
    });

  return (
    <div className="flex flex-col gap-4">
      <OpsHead meta={[ut("opx.sc.superOnlyMeta"), ut("opx.in.metaSub")]} actions={<CopyLinkButton />} />
      <Note className="max-w-none">{ut("ops.sec.int.lead")}</Note>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={5} />
      ) : (
        <>
          <Panel
            title={ut("ops.sec.int.rlsTitle")}
            icon={<OpsIcon name="shield-check" />}
            sub={ut("opx.in.rlsSub")}
            actions={
              <Button variant="primary" size="xs" icon={<OpsIcon name="shield-check" />} disabled={busy} onClick={() => check(api.opsSecCheckRls)}>
                {ut("ops.sec.int.rlsRun")}
              </Button>
            }
          >
            <RlsResult check={res.data.rls} />
          </Panel>
          <Panel
            title={ut("ops.sec.int.auditTitle")}
            icon={<OpsIcon name="link" />}
            sub={ut("opx.in.auditSub")}
            actions={
              <Button size="xs" icon={<OpsIcon name="link" />} disabled={busy} onClick={() => check(api.opsSecCheckAudit)}>
                {ut("ops.sec.int.auditRun")}
              </Button>
            }
          >
            <AuditResult state={res.data} />
          </Panel>
          <HistoryPanel state={res.data} />
        </>
      )}
    </div>
  );
}

/** Кто и когда проверял — строкой в шапке панели */
function CheckedBy({ check }: { check: OpsIntegrityCheck<unknown> }) {
  const { ut } = useLang();
  return (
    <span className="text-small text-text-2">
      {fill(ut("ops.sec.int.checkedBy"), {
        time: stamp(check.at),
        who: check.trigger === "schedule" ? ut("ops.sec.int.scheduler") : (check.actorEmail ?? "—"),
      })}
    </span>
  );
}

/** Карточка одного вида мест без защиты: счёт, что это значит, сами таблицы */
function PlaceCard({ textKey, names, warn }: { textKey: UiKey; names: string[]; warn?: boolean }) {
  const { ut } = useLang();
  const bad = names.length > 0;
  return (
    <div className={cx("min-w-0 rounded-panel px-3.5 py-3", bad && warn ? "bg-warn-tint" : "bg-panel-2 shadow-[inset_0_0_0_1px_var(--divider)]")}>
      {bad ? (
        <StatusMark tone={warn ? "warn" : "fail"}>{fill(ut("opx.in.tablesN"), { n: names.length })}</StatusMark>
      ) : (
        <StatusMark tone="ok">{ut("ops.sec.none")}</StatusMark>
      )}
      <p className="m-0 mt-1 text-small leading-[18px] text-text-2">{ut(textKey)}</p>
      {bad ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {names.map((n) => (
            <CodeChip key={n} tone={warn ? "warn" : "plain"}>
              {n}
            </CodeChip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RlsResult({ check }: { check: OpsIntegrityCheck<OpsRlsReport> | null }) {
  const { ut } = useLang();
  const loc = locale();
  if (!check) return <Quiet>{ut("ops.sec.int.never")}</Quiet>;
  const r = check.summary;
  const num = (v: number) => v.toLocaleString(loc);
  const stats = (
    <dl className="m-0 flex gap-6">
      {[
        [ut("opx.in.tables"), r.tables],
        [ut("opx.in.rls"), r.rlsTables],
        [ut("opx.in.force"), r.forced.length],
        [ut("opx.in.policies"), r.policies],
      ].map(([k, v]) => (
        <div key={String(k)} className="text-right">
          <dt className="text-caption font-bold text-muted">{k}</dt>
          <dd className="m-0 text-big font-extrabold leading-7 tabular-nums text-text">{num(Number(v))}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <div className="flex flex-col gap-3">
      {r.bypasses ? (
        <Verdict tone="danger" title={ut("opx.in.rlsBypassTitle")} aside={stats}>
          {fill(ut("ops.sec.int.rlsBypass"), { role: r.role, reason: r.reason ?? "—" })}
        </Verdict>
      ) : r.policiesWithoutRls.length ? (
        <Verdict tone="danger" title={ut("opx.in.rlsBrokenTitle")} aside={stats}>
          {ut("ops.sec.int.rlsBroken")}
        </Verdict>
      ) : (
        <Verdict tone="plain" title={ut("opx.in.rlsOkTitle")} icon="shield-check" aside={stats}>
          {fill(ut("ops.sec.int.rlsOk"), { role: r.role })}
        </Verdict>
      )}
      <CheckedBy check={check} />
      <div className="grid grid-cols-3 gap-3 max-[1100px]:grid-cols-1">
        <PlaceCard textKey="ops.sec.int.personTables" names={r.personTablesWithoutRls} warn />
        <PlaceCard textKey="ops.sec.int.policiesWithoutRls" names={r.policiesWithoutRls} />
        <PlaceCard textKey="ops.sec.int.rlsWithoutPolicies" names={r.rlsWithoutPolicies} warn />
      </div>
      {r.forced.length ? (
        <div>
          <Caption className="mb-1.5">{ut("ops.sec.int.forced")}</Caption>
          <div className="flex flex-wrap gap-1.5">
            {r.forced.map((n) => (
              <CodeChip key={n}>{n}</CodeChip>
            ))}
          </div>
        </div>
      ) : null}
      {r.auditWritable ? (
        <Callout kind="warn" icon={<OpsIcon name="lock-open" />}>
          {ut("ops.sec.int.auditWritable")}
        </Callout>
      ) : (
        <Callout kind="line" icon={<OpsIcon name="lock" />}>
          {ut("opx.in.auditLocked")}
        </Callout>
      )}
    </div>
  );
}

function ChainVerdict({ report }: { report: OpsAuditChainReport }) {
  const { ut } = useLang();
  if (!report.ok) {
    return (
      <Verdict tone="danger" title={ut("opx.in.chainBrokenTitle")} icon="link-2-off">
        {fill(ut("ops.sec.int.auditBroken"), { seq: report.brokenAtSeq, n: report.checked })}
      </Verdict>
    );
  }
  return (
    <Verdict tone="plain" title={ut("opx.in.chainOkTitle")} icon="link">
      {fill(ut("ops.sec.int.auditOk"), {
        n: report.checked,
        hash: report.headHash ? report.headHash.slice(0, 16) : "—",
        seq: report.headSeq,
      })}
      {report.legacy > 0 ? <span className="block">{fill(ut("ops.sec.int.auditLegacy"), { n: report.legacy })}</span> : null}
    </Verdict>
  );
}

export function AuditResult({ state }: { state: OpsIntegrityState }) {
  const { ut } = useLang();
  const last = state.audit;
  const scheduled = state.auditScheduled;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4 max-[1100px]:grid-cols-1">
        {last ? (
          <div className="flex flex-col gap-2">
            <ChainVerdict report={last.summary} />
            <CheckedBy check={last} />
          </div>
        ) : (
          <Quiet>{ut("ops.sec.int.never")}</Quiet>
        )}
        <div className="rounded-panel bg-panel-2 px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--divider)]">
          <KV
            w={110}
            rows={[
              [ut("opx.in.auto"), ut("opx.in.daily")],
              [
                ut("opx.in.last"),
                scheduled ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {stamp(scheduled.at)}
                    <StatusMark tone={scheduled.ok ? "ok" : "fail"}>{scheduled.ok ? ut("ops.sec.int.intact") : ut("ops.sec.int.broken")}</StatusMark>
                  </span>
                ) : (
                  ut("ops.sec.int.noScheduled")
                ),
              ],
              [ut("opx.in.next"), fill(ut("opx.in.notBefore"), { time: stamp(state.nextScheduledAfter) })],
            ]}
          />
        </div>
      </div>
      <ChainHistory state={state} />
    </div>
  );
}

/**
 * Сверки цепочки за месяц — полосой дней (волна 11).
 *
 * Последняя сверка выше говорит, цела ли цепочка сейчас; полоса — была ли
 * она цела всё это время и сверяли ли её вообще: плановая сверка раз в
 * сутки, и пропуск в полосе — это день, когда планировщик не дошёл до
 * проверки. Дни с разрывом ещё и перечислены словами: их ищут глазами,
 * и по цвету клетки искать их не должен никто.
 */
export function ChainHistory({ state, now = Date.now() }: { state: OpsIntegrityState; now?: number }) {
  const { ut } = useLang();
  const history = state.auditHistory ?? [];
  if (!history.length) return null;
  const days = checkDays(history, lastDays(now, state.historyDays), localDay);
  const broken = days.filter((d) => d.state === "broken");
  const shortDay = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <b className="text-[13.5px] font-extrabold text-text">{fill(ut("sig.int.history"), { days: state.historyDays })}</b>
        <span className="text-small text-muted">{ut("sig.int.historyCaption")}</span>
      </div>
      <CheckStrip
        days={days}
        label={fill(ut("sig.int.history"), { days: state.historyDays })}
        words={{ ok: ut("ops.sec.int.intact"), broken: ut("ops.sec.int.broken"), none: ut("sig.int.notChecked") }}
        dayLabel={shortDay}
      />
      {broken.length ? (
        <p className="m-0 mt-2 max-w-[760px] text-[13px] font-bold leading-[18px] text-warn">
          {fill(ut("sig.int.brokenDays"), { days: broken.map((d) => day(d.key)).join(", ") })}
        </p>
      ) : null}
    </div>
  );
}

/* ─────────── история сверок ─────────── */

function HistoryPanel({ state }: { state: OpsIntegrityState }) {
  const { ut } = useLang();
  const rows = [...(state.auditHistory ?? [])].reverse().slice(0, 10);
  return (
    <Panel
      title={ut("opx.in.history")}
      icon={<OpsIcon name="history" />}
      actions={
        <ButtonLink to="/ops/audit" variant="ghost" size="xs">
          <OpsIcon name="arrow-up-right" size={14} />
          {ut("ops.tab.audit")}
        </ButtonLink>
      }
      flush
    >
      {rows.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.sec.int.never")}</Quiet>
        </div>
      ) : (
        <div role="table" aria-label={ut("opx.in.history")}>
          <div
            role="row"
            className="grid h-[38px] grid-cols-[160px_120px_160px_minmax(0,1fr)] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted"
          >
            <span role="columnheader">{ut("mt.when")}</span>
            <span role="columnheader">{ut("opx.in.what")}</span>
            <span role="columnheader">{ut("mt.by")}</span>
            <span role="columnheader">{ut("ops.col.result")}</span>
          </div>
          {rows.map((h, i) => (
            <div
              key={`${h.at}-${i}`}
              role="row"
              className="grid min-h-11 grid-cols-[160px_120px_160px_minmax(0,1fr)] items-center gap-3 border-b border-divider px-4 py-1.5 text-body last:border-b-0"
            >
              <span role="cell" className="tabular-nums text-text">
                {stamp(h.at)}
              </span>
              <b role="cell" className="font-bold">
                {ut("ops.sec.int.auditTitle")}
              </b>
              <span role="cell" className="text-text-2">
                {h.trigger === "schedule" ? ut("ops.sec.int.scheduler") : ut("opx.in.byHand")}
              </span>
              <span role="cell">
                <StatusMark tone={h.ok ? "ok" : "fail"}>{h.ok ? ut("ops.sec.int.intact") : ut("ops.sec.int.broken")}</StatusMark>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
