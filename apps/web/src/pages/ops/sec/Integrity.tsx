import type { OpsAuditChainReport, OpsIntegrityCheck, OpsIntegrityState, OpsRlsReport, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, day } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Button } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { lastDays, localDay } from "../obs2b/model";
import { checkDays, fill } from "./model";
import { Caption, CheckStrip, Note, Verdict } from "./parts";

/*
 * Раздел «Цілісність» техпанели — только суперадмину.
 *
 * Решение заказчика 2026-09-26 (пункт 23): проверка политик строк одной
 * кнопкой и сверка цепочки журнала — кнопкой и по расписанию раз в сутки.
 * Обе проверки жили и раньше (rlsReport.ts, audit:verify, команды консоли),
 * но их надо было помнить; здесь у них есть кнопка, память результатов и
 * расписание. Отчёт RLS — карта мест, где в базе нет защиты, поэтому
 * раздел закрыт ролью, а не правом ops.read.
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
    <div className="pt-[8px]">
      <Note className="mb-[24px]">
        {ut("ops.sec.superOnly")} {ut("ops.sec.int.lead")}
      </Note>
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={5} />
      ) : (
        <>
          <RuleSection
            title={ut("ops.sec.int.rlsTitle")}
            actions={
              <Button disabled={busy} onClick={() => check(api.opsSecCheckRls)}>
                {ut("ops.sec.int.rlsRun")}
              </Button>
            }
          >
            <RlsResult check={res.data.rls} />
          </RuleSection>
          <RuleSection
            title={ut("ops.sec.int.auditTitle")}
            actions={
              <Button disabled={busy} onClick={() => check(api.opsSecCheckAudit)}>
                {ut("ops.sec.int.auditRun")}
              </Button>
            }
          >
            <AuditResult state={res.data} />
          </RuleSection>
        </>
      )}
    </div>
  );
}

function CheckedBy({ check }: { check: OpsIntegrityCheck<unknown> }) {
  const { ut } = useLang();
  return (
    <p className="m-0 mt-[8px] text-[13px] text-muted">
      {fill(ut("ops.sec.int.checkedBy"), {
        time: dateTime(check.at),
        who: check.trigger === "schedule" ? ut("ops.sec.int.scheduler") : (check.actorEmail ?? "—"),
      })}
    </p>
  );
}

/** Перечень таблиц под подписью; пустой — словом «немає», а не пустотой */
function TableList({ textKey, names, tone }: { textKey: UiKey; names: string[]; tone: "danger" | "attention" | "plain" }) {
  const { ut } = useLang();
  return (
    <div className="mt-[14px]">
      <Caption>{ut(textKey)}</Caption>
      {names.length ? (
        <ul className="m-0 mt-[4px] flex list-none flex-wrap gap-x-[14px] gap-y-[2px] p-0">
          {names.map((n) => (
            <li
              key={n}
              className={
                tone === "danger"
                  ? "font-mono text-[13px] font-bold text-danger"
                  : tone === "attention"
                    ? "font-mono text-[13px] text-accent"
                    : "font-mono text-[13px] text-text-2"
              }
            >
              {n}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-[4px] text-[13px] text-muted">{ut("ops.sec.none")}</p>
      )}
    </div>
  );
}

export function RlsResult({ check }: { check: OpsIntegrityCheck<OpsRlsReport> | null }) {
  const { ut } = useLang();
  if (!check) return <Note>{ut("ops.sec.int.never")}</Note>;
  const r = check.summary;
  return (
    <>
      {r.bypasses ? (
        <Verdict tone="danger">{fill(ut("ops.sec.int.rlsBypass"), { role: r.role, reason: r.reason ?? "—" })}</Verdict>
      ) : r.policiesWithoutRls.length ? (
        <Verdict tone="danger">{ut("ops.sec.int.rlsBroken")}</Verdict>
      ) : (
        <Verdict tone="plain">{fill(ut("ops.sec.int.rlsOk"), { role: r.role })}</Verdict>
      )}
      <p className="m-0 mt-[6px] font-mono text-[13px] tabular-nums text-text-2">
        {fill(ut("ops.sec.int.rlsCounts"), { tables: r.tables, rls: r.rlsTables, policies: r.policies })}
      </p>
      <CheckedBy check={check} />
      {r.auditWritable ? (
        <Verdict tone="attention" className="mt-[10px] text-[13px]">
          {ut("ops.sec.int.auditWritable")}
        </Verdict>
      ) : null}
      <TableList textKey="ops.sec.int.policiesWithoutRls" names={r.policiesWithoutRls} tone="danger" />
      <TableList textKey="ops.sec.int.personTables" names={r.personTablesWithoutRls} tone="attention" />
      <TableList textKey="ops.sec.int.rlsWithoutPolicies" names={r.rlsWithoutPolicies} tone="attention" />
      {r.forced.length ? <TableList textKey="ops.sec.int.forced" names={r.forced} tone="plain" /> : null}
    </>
  );
}

function ChainVerdict({ report }: { report: OpsAuditChainReport }) {
  const { ut } = useLang();
  if (!report.ok) {
    return (
      <Verdict tone="danger">
        {fill(ut("ops.sec.int.auditBroken"), { seq: report.brokenAtSeq, n: report.checked })}
      </Verdict>
    );
  }
  return (
    <>
      <Verdict tone="plain">
        {fill(ut("ops.sec.int.auditOk"), {
          n: report.checked,
          hash: report.headHash ? report.headHash.slice(0, 16) : "—",
          seq: report.headSeq,
        })}
      </Verdict>
      {report.legacy > 0 ? <Note className="mt-[4px]">{fill(ut("ops.sec.int.auditLegacy"), { n: report.legacy })}</Note> : null}
    </>
  );
}

export function AuditResult({ state }: { state: OpsIntegrityState }) {
  const { ut } = useLang();
  const last = state.audit;
  const scheduled = state.auditScheduled;
  return (
    <>
      {last ? (
        <>
          <ChainVerdict report={last.summary} />
          <CheckedBy check={last} />
        </>
      ) : (
        <Note>{ut("ops.sec.int.never")}</Note>
      )}
      <div className="mt-[16px] border-t border-hairline pt-[12px]">
        <Note>{ut("ops.sec.int.schedule")}</Note>
        {scheduled ? (
          <p className={scheduled.ok ? "m-0 mt-[4px] text-[13px] text-text-2" : "m-0 mt-[4px] text-[13px] font-bold text-danger"}>
            {fill(ut("ops.sec.int.lastScheduled"), {
              time: dateTime(scheduled.at),
              verdict: scheduled.ok ? ut("ops.sec.int.intact") : ut("ops.sec.int.broken"),
            })}
          </p>
        ) : (
          <Note className="mt-[4px]">{ut("ops.sec.int.noScheduled")}</Note>
        )}
        {scheduled ? (
          <Note className="mt-[4px]">{fill(ut("ops.sec.int.nextAfter"), { time: dateTime(state.nextScheduledAfter) })}</Note>
        ) : null}
      </div>
      <ChainHistory state={state} />
    </>
  );
}

/**
 * Сверки цепочки за месяц — полосой дней (волна 11).
 *
 * Последняя сверка выше говорит, цела ли цепочка сейчас; полоса — была ли
 * она цела всё это время и сверяли ли её вообще: плановая сверка раз в
 * сутки, и пропуск в полосе — это день, когда планировщик не дошёл до
 * проверки. Дни с разрывом ещё и перечислены словами: их ищут глазами,
 * и по цвету ромба искать их не должен никто.
 */
export function ChainHistory({ state, now = Date.now() }: { state: OpsIntegrityState; now?: number }) {
  const { ut } = useLang();
  const history = state.auditHistory ?? [];
  if (!history.length) return null;
  const days = checkDays(history, lastDays(now, state.historyDays), localDay);
  const broken = days.filter((d) => d.state === "broken");
  return (
    <div className="mt-[20px] border-t border-hairline pt-[12px]">
      <Caption className="mb-[4px]">{fill(ut("sig.int.history"), { days: state.historyDays })}</Caption>
      <Note className="mb-[10px]">{ut("sig.int.historyCaption")}</Note>
      <CheckStrip
        days={days}
        label={fill(ut("sig.int.history"), { days: state.historyDays })}
        words={{ ok: ut("ops.sec.int.intact"), broken: ut("ops.sec.int.broken"), none: ut("sig.int.notChecked") }}
        dayLabel={day}
      />
      {broken.length ? (
        <p className="m-0 mt-[8px] max-w-[760px] text-[13px] font-bold leading-[18px] text-danger">
          {fill(ut("sig.int.brokenDays"), { days: broken.map((d) => day(d.key)).join(", ") })}
        </p>
      ) : null}
    </div>
  );
}
