import type { OpsStatement, OpsStatementSort, OpsStatements } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useUrlState } from "../../../ui";
import { IconDisclosure } from "../../../ui/glyphs";
import { Button, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { PeriodSwitch } from "../../dashboard/parts";
import { fmtInt, fmtMs, fmtShare } from "../model";
import { Quiet, Stamp, StatusMark, useOpsResource } from "../parts";
import { StatementCharts } from "./charts";
import { PLAN_STATE_KEY, STATEMENTS_STATE_KEY, enableSteps, parseStatementSort, statementMetric } from "./model";

/*
 * Повільні SQL: что стоит базе дороже всего — по накопленной статистике
 * pg_stat_statements, а не по тому, что висит прямо сейчас (это «База»).
 *
 * Порядок (?sort=total|calls|mean) — в адресе: суммарное время отвечает
 * «что съедает базу», число вызовов — «что зовут чаще всего» (N+1 видно
 * здесь), среднее — «что медленное само по себе». Полоска под текстом —
 * величина, по которой отсортировано, от максимума списка.
 *
 * План — по кнопке, раскрытый — в адресе (?plan=<queryid>). EXPLAIN без
 * ANALYZE: чужой запрос не выполняется (apps/api/src/lib/opsStatements.ts).
 *
 * Расширение может быть не включено — раздел говорит об этом и как
 * включить, по шагам, кодом, который копируют в терминал. Включение стоит
 * перезапуска базы — это написано рядом, а не спрятано в RUNBOOK.
 *
 * Над списком (волна 11) — первые восемь по выбранному порядку полосами и
 * доля каждого из первых пяти в общем времени базы. Номер у полосы — тот
 * же, что у строки списка: текст запроса в подписи виден только началом.
 */

const POLL_MS = 60_000;

export default function OpsStatementsPage() {
  const { ut } = useLang();
  const loc = locale();
  const [rawSort, setSort] = useUrlState("sort", "total");
  const [plan, setPlan] = useUrlState("plan", "");
  const sort = parseStatementSort(rawSort);
  const res = useOpsResource(() => api.opsStatements(sort), [sort], POLL_MS);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const d = res.data;

  return (
    <div>
      <Stamp
        updatedAt={res.updatedAt}
        note={d.statsSince ? fill(ut("ops.sql.since"), { time: dateTime(d.statsSince) }) : ut("ops.sql.sinceUnknown")}
      />

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.sql.title")}
        hint={ut("ops.sql.hint")}
        actions={
          d.state === "ok" ? (
            <PeriodSwitch<OpsStatementSort>
              label={ut("ops.sql.sortLabel")}
              value={sort}
              onChange={(v) => setSort(v)}
              options={[
                ["total", ut("ops.sql.byTotal")],
                ["calls", ut("ops.sql.byCalls")],
                ["mean", ut("ops.sql.byMean")],
              ]}
            />
          ) : null
        }
      >
        {d.state !== "ok" ? (
          <NotEnabled d={d} />
        ) : d.items.length === 0 ? (
          <Quiet>{ut("ops.sql.empty")}</Quiet>
        ) : (
          <>
            <div className="mb-[28px]">
              <StatementCharts items={d.items} sort={sort} />
            </div>
            <ol aria-label={ut("ops.sql.title")} className="m-0 list-none p-0">
              {d.items.map((s, i) => (
                <StatementRow
                  key={s.id}
                  s={s}
                  n={i + 1}
                  sort={sort}
                  top={Math.max(...d.items.map((x) => statementMetric(x, sort)), 0)}
                  open={plan === s.id}
                  onToggle={() => setPlan(plan === s.id ? "" : s.id)}
                />
              ))}
            </ol>
          </>
        )}
        {d.state === "ok" && d.hidden > 0 ? (
          <Quiet>
            {fill(ut("ops.sql.hidden"), { n: fmtInt(d.hidden, loc) })} <Code>GRANT pg_read_all_stats TO quizzy_app;</Code>
          </Quiet>
        ) : null}
      </RuleSection>
    </div>
  );
}

/** Код, который копируют в терминал: моноширинно, на подложке, без переноса внутри слова */
function Code({ children }: { children: string }) {
  return <code className="rounded-[4px] bg-primary-soft px-[6px] py-[1px] font-mono text-[12px] text-text">{children}</code>;
}

function NotEnabled({ d }: { d: OpsStatements }) {
  const { ut } = useLang();
  if (d.state === "ok") return null;
  const steps = enableSteps(d.state);
  return (
    <div className="max-w-[760px]">
      <p className="m-0 mb-[12px] flex flex-wrap items-center gap-[10px] text-[15px] leading-[21px] text-text">
        <StatusMark tone="warn">{ut("ops.sql.notEnabled")}</StatusMark>
        <span>{ut(STATEMENTS_STATE_KEY[d.state])}</span>
      </p>
      {steps.length ? (
        <ol className="m-0 flex list-decimal flex-col gap-[10px] pl-[20px] text-[13px] leading-[19px] text-text-2">
          {steps.includes("preload") ? (
            <li>
              {ut("ops.sql.step.preload")}
              <pre className="m-0 mt-[6px] overflow-x-auto rounded-[5px] bg-primary-soft p-[10px] font-mono text-[12px] leading-[18px] text-text">
                {"  postgres:\n    command: [\"postgres\", \"-c\", \"shared_preload_libraries=pg_stat_statements\"]"}
              </pre>
              <span className="mt-[6px] block text-muted">{ut("ops.sql.step.restart")}</span>
            </li>
          ) : null}
          {steps.includes("create") ? (
            <li>
              {ut("ops.sql.step.create")} <Code>CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</Code>
            </li>
          ) : null}
          {steps.includes("grant") ? (
            <li>
              {ut("ops.sql.step.grant")} <Code>GRANT SELECT ON pg_stat_statements TO quizzy_app;</Code>
            </li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}

function StatementRow({
  s,
  n,
  sort,
  top,
  open,
  onToggle,
}: {
  s: OpsStatement;
  n: number;
  sort: OpsStatementSort;
  top: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const share = top > 0 ? statementMetric(s, sort) / top : 0;
  const planId = `ops-plan-${s.id}`;
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-[12px]">
        <Num className="pt-[1px] text-right text-[13px] text-muted">{n}</Num>
        <div className="min-w-0">
          <p className="m-0 break-words font-mono text-[12px] leading-[18px] text-text">{s.query}</p>
          <span aria-hidden className="mt-[6px] block h-[4px] rounded-[2px] bg-[var(--grid-fine)]">
            <span
              className="block h-full rounded-[2px] bg-primary opacity-70"
              style={{ width: `${Math.max(share > 0 ? 1.5 : 0, share * 100).toFixed(2)}%` }}
            />
          </span>
          <div className="mt-[8px] flex flex-wrap items-center gap-x-[18px] gap-y-[6px] text-[13px] leading-[18px] text-muted">
            <Num className={sort === "total" ? "font-bold text-primary" : "text-text"}>
              {fill(ut("ops.sql.total"), { v: fmtMs(s.totalMs, loc) })}
            </Num>
            <Num className={sort === "calls" ? "font-bold text-primary" : "text-text"}>
              {fill(ut("ops.sql.calls"), { v: fmtInt(s.calls, loc) })}
            </Num>
            <Num className={sort === "mean" ? "font-bold text-primary" : "text-text"}>
              {fill(ut("ops.sql.mean"), { v: fmtMs(s.meanMs, loc) })}
            </Num>
            <Num>{fill(ut("ops.sql.rows"), { v: fmtInt(s.rows, loc) })}</Num>
            {s.share !== null ? <Num>{fill(ut("ops.sql.share"), { v: fmtShare(s.share, loc) })}</Num> : null}
            <Button
              variant="ghost"
              aria-expanded={open}
              aria-controls={planId}
              onClick={onToggle}
              className="h-[28px] px-[8px] text-[13px]"
              icon={
                <span aria-hidden className={open ? "inline-block rotate-90" : "inline-block"}>
                  <IconDisclosure />
                </span>
              }
            >
              {open ? ut("ops.sql.hidePlan") : ut("ops.sql.showPlan")}
            </Button>
          </div>
          {open ? <Plan id={s.id} domId={planId} /> : null}
        </div>
      </div>
    </li>
  );
}

/** План — только когда раскрыт: EXPLAIN по каждому запросу списка был бы нагрузкой ради ничего */
function Plan({ id, domId }: { id: string; domId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.opsStatementPlan(id), [id]);
  return (
    <div id={domId} className="mt-[10px]">
      {res.error && !res.data ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={3} />
      ) : res.data.state !== "ok" || !res.data.plan ? (
        <Quiet>{ut(res.data.state === "ok" ? "ops.sql.plan.failed" : PLAN_STATE_KEY[res.data.state])}</Quiet>
      ) : (
        <>
          <span className="mb-[4px] block text-[12px] leading-[16px] text-muted">
            {ut(res.data.generic ? "ops.sql.plan.generic" : "ops.sql.plan.plain")}
          </span>
          <pre className="m-0 overflow-x-auto rounded-[5px] bg-primary-soft p-[12px] font-mono text-[12px] leading-[18px] text-text-2">
            {res.data.plan.join("\n")}
          </pre>
        </>
      )}
    </div>
  );
}
