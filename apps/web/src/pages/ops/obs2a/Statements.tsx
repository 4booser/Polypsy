import { useMemo, useState } from "react";
import type { OpsStatement, OpsStatementSort, OpsStatements } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, Loading, SearchField, Tooltip, useToast, useUrlState } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, ButtonLink, Segmented } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { clock, fmtInt, fmtMs } from "../model";
import { CopyLinkButton, Mono, OpsHead, OpsToolbar, PanelNote, Quiet, useOpsResource } from "../parts";
import { StatementCharts } from "./charts";
import { PLAN_STATE_KEY, STATEMENTS_STATE_KEY, enableSteps, parseStatementSort } from "./model";

/*
 * Повільні SQL: что стоит базе дороже всего — по накопленной статистике
 * pg_stat_statements, а не по тому, что висит прямо сейчас (это «База»).
 *
 * Порядок (?sort=total|calls|mean) — в адресе: суммарное время отвечает
 * «что съедает базу», число вызовов — «что зовут чаще всего» (N+1 видно
 * здесь), среднее — «что медленное само по себе».
 *
 * План — по нажатию строки, раскрытый — в адресе (?plan=<queryid>). EXPLAIN
 * без ANALYZE: чужой запрос не выполняется (apps/api/src/lib/opsStatements.ts).
 * В плане «Seq Scan» выделен, и рядом сказано, что это значит: полное
 * чтение таблицы на каждый вызов.
 *
 * Расширение может быть не включено — раздел говорит об этом и как
 * включить, по шагам, кодом, который копируют в терминал. Включение стоит
 * перезапуска базы — это написано рядом, а не спрятано в RUNBOOK.
 */

const POLL_MS = 60_000;
/* среднее, от которого запрос «медленный сам по себе» — янтарём в колонке */
const SLOW_MEAN_MS = 20;

export default function OpsStatementsPage() {
  const { ut } = useLang();
  const loc = locale();
  const [rawSort, setSort] = useUrlState("sort", "total");
  const [plan, setPlan] = useUrlState("plan", "");
  const sort = parseStatementSort(rawSort);
  const res = useOpsResource(() => api.opsStatements(sort), [sort], POLL_MS);
  const d = res.data;

  /* время всей базы — по доле любого запроса: share = его время / время всех */
  const dbTotal = useMemo(() => {
    if (!d || d.state !== "ok") return null;
    const any = d.items.find((s) => s.share !== null && s.share > 0);
    return any ? any.totalMs / any.share! : d.items.reduce((s, x) => s + x.totalMs, 0);
  }, [d]);

  const head = (
    <OpsHead
      meta={
        !d
          ? null
          : d.state === "ok"
            ? [fill(ut("opx.st.metaTime"), { t: fmtLong(dbTotal ?? 0, loc) }), ut("opx.st.metaSub")]
            : [ut("opx.st.offTitle"), ut(STATEMENTS_STATE_KEY[d.state])]
      }
      actions={
        <>
          <ButtonLink to="/ops/db">
            <OpsIcon name="database" size={15} />
            {ut("ops.tab.db")}
          </ButtonLink>
          <CopyLinkButton />
        </>
      }
      toolbar={
        d?.state === "ok" ? (
          <OpsToolbar
            right={
              <span className="inline-flex items-center gap-1.5 text-small text-muted">
                <OpsIcon name="history" size={14} />
                {d.statsSince ? fill(ut("ops.sql.since"), { time: dateTime(d.statsSince) }) : ut("ops.sql.sinceUnknown")}
              </span>
            }
          >
            <span className="text-small text-muted">{ut("ops.sql.sortLabel")}</span>
            <Segmented
              label={ut("ops.sql.sortLabel")}
              value={sort}
              onChange={(v) => setSort(v)}
              items={[
                { key: "total", label: ut("ops.sql.byTotal") },
                { key: "calls", label: ut("ops.sql.byCalls") },
                { key: "mean", label: ut("ops.sql.byMean") },
              ]}
            />
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
        <Loading rows={6} />
      </>
    );
  }

  if (d.state !== "ok") {
    return (
      <div className="flex flex-col gap-4">
        {head}
        <NotEnabled d={d} onCheck={res.reload} checkedAt={res.updatedAt} />
      </div>
    );
  }

  const calls = d.items.reduce((s, x) => s + x.calls, 0);
  const days = d.statsSince ? Math.max(1, Math.round((Date.now() - Date.parse(d.statsSince)) / 86_400_000)) : null;

  return (
    <div className="flex flex-col gap-4">
      {head}
      {d.items.length ? (
        <Panel
          title={ut("opx.st.where")}
          icon={<OpsIcon name="chart-gantt" />}
          sub={
            days
              ? fill(ut("opx.st.whereSub"), { t: fmtLong(dbTotal ?? 0, loc), days: fmtInt(days, loc), calls: fmtInt(calls, loc) })
              : fill(ut("opx.st.whereSubNoDays"), { t: fmtLong(dbTotal ?? 0, loc), calls: fmtInt(calls, loc) })
          }
        >
          <StatementCharts items={d.items} sort={sort} />
        </Panel>
      ) : null}
      <StatementsPanel d={d} sort={sort} plan={plan} onPlan={setPlan} />
    </div>
  );
}

/** Долгое время по-человечески: «74 хв 30 с», «2,4 с», «310 мс» */
function fmtLong(ms: number, loc: string): string {
  if (ms < 1000) return fmtMs(ms, loc);
  const sec = ms / 1000;
  if (sec < 60) return new Intl.NumberFormat(loc, { style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 1 }).format(sec);
  const unit = (v: number, u: string) => new Intl.NumberFormat(loc, { style: "unit", unit: u, unitDisplay: "short", maximumFractionDigits: 0 }).format(v);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return m ? `${unit(h, "hour")} ${unit(m, "minute")}` : unit(h, "hour");
  return s ? `${unit(m, "minute")} ${unit(s, "second")}` : unit(m, "minute");
}

/* ─────────── список ─────────── */

const ROW_COLS = "grid-cols-[44px_minmax(0,1fr)_110px_96px_116px_88px_44px]";

function StatementsPanel({
  d,
  sort,
  plan,
  onPlan,
}: {
  d: OpsStatements;
  sort: OpsStatementSort;
  plan: string;
  onPlan: (id: string) => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const rows = d.items.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => !needle || s.query.toLowerCase().includes(needle));
  const head = (label: string, key: OpsStatementSort | null, right?: boolean) => (
    <span role="columnheader" className={cx("whitespace-nowrap", right && "text-right", key === sort && "text-text")}>
      {label}
      {key === sort ? <OpsIcon name="arrow-down" size={12} className="ml-1 inline text-violet-ink" /> : null}
    </span>
  );
  return (
    <Panel
      title={ut("ops.sql.title")}
      icon={<OpsIcon name="turtle" />}
      sub={ut("opx.st.listSub")}
      actions={<SearchField value={q} onChange={setQ} placeholder={ut("opx.st.search")} slash width={240} />}
      flush
      footer={
        d.hidden > 0 ? (
          <PanelNote icon="eye-off">
            {fill(ut("ops.sql.hidden"), { n: fmtInt(d.hidden, loc) })} <Mono className="text-text">GRANT pg_read_all_stats TO quizzy_app;</Mono>
          </PanelNote>
        ) : (
          <PanelNote>{ut("ops.sql.hint")}</PanelNote>
        )
      }
    >
      {d.items.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.sql.empty")}</Quiet>
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("opx.st.noMatch")}</Quiet>
        </div>
      ) : (
        <div role="table" aria-label={ut("ops.sql.title")} className="overflow-x-auto">
          <div className="min-w-[860px]">
            <div
              role="row"
              className={cx("grid h-[38px] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted", ROW_COLS)}
            >
              {head(ut("ops.col.number"), null)}
              {head(ut("ops.col.query"), null)}
              {head(ut("opx.st.colTotal"), "total", true)}
              {head(ut("ops.sql.byCalls"), "calls", true)}
              {head(ut("opx.st.colMean"), "mean", true)}
              {head(ut("opx.st.colRows"), null, true)}
              {head(ut("ops.sql.showPlan"), null, true)}
            </div>
            {rows.map(({ s, n }) => (
              <StatementRow key={s.id} s={s} n={n} open={plan === s.id} onToggle={() => onPlan(plan === s.id ? "" : s.id)} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function StatementRow({ s, n, open, onToggle }: { s: OpsStatement; n: number; open: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const planId = `ops-plan-${s.id}`;
  return (
    <div className={cx("border-b border-divider last:border-b-0", open && "bg-panel-2")}>
      <div role="row" className={cx("grid min-h-12 items-center gap-3 px-4 py-1.5 text-body", ROW_COLS)}>
        <span role="cell">
          <span
            className={cx(
              "inline-grid size-7 place-items-center rounded-[8px] text-small font-extrabold tabular-nums",
              open ? "bg-violet text-onfill" : "bg-sunk text-text-2",
            )}
          >
            {n}
          </span>
        </span>
        <span role="cell" className="min-w-0">
          <Mono className="line-clamp-2 break-words text-text" title={s.query}>
            {s.query}
          </Mono>
        </span>
        <b role="cell" className="text-right font-extrabold tabular-nums">
          {fmtLong(s.totalMs, loc)}
        </b>
        <span role="cell" className="text-right tabular-nums text-text-2">
          {fmtInt(s.calls, loc)}
        </span>
        <span role="cell" className={cx("text-right tabular-nums", s.meanMs >= SLOW_MEAN_MS ? "font-extrabold text-warn" : "text-text-2")}>
          {fmtMs(s.meanMs, loc)}
        </span>
        <span role="cell" className="text-right tabular-nums text-text-2">
          {fmtInt(s.rows, loc)}
        </span>
        <span role="cell" className="flex justify-end">
          <Tooltip label={open ? ut("ops.sql.hidePlan") : ut("ops.sql.showPlan")}>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-expanded={open}
              aria-controls={planId}
              aria-label={open ? ut("ops.sql.hidePlan") : ut("ops.sql.showPlan")}
              icon={<OpsIcon name={open ? "chevron-down" : "chevron-right"} />}
              onClick={onToggle}
            />
          </Tooltip>
        </span>
      </div>
      {open ? <Plan s={s} domId={planId} /> : null}
    </div>
  );
}

/** План — только когда раскрыт: EXPLAIN по каждому запросу списка был бы нагрузкой ради ничего */
function Plan({ s, domId }: { s: OpsStatement; domId: string }) {
  const { ut } = useLang();
  const toast = useToast();
  const res = useResource(() => api.opsStatementPlan(s.id), [s.id]);
  const copy = (text: string, ok: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast(ok, "ok"),
      () => toast(ut("ops.copyFailed"), "err"),
    );
  const lines = res.data?.plan ?? null;
  const seq = lines?.some((l) => /Seq Scan/.test(l)) ?? false;
  return (
    <div id={domId} className="grid grid-cols-[minmax(0,1fr)_360px] gap-4 px-4 pb-4 pl-[60px] max-[1100px]:grid-cols-1">
      <div className="min-w-0">
        {res.error && !res.data ? (
          <Loading bare error={res.error} onRetry={res.reload} />
        ) : !res.data ? (
          <Loading bare rows={3} />
        ) : res.data.state !== "ok" || !lines ? (
          <Quiet>{ut(res.data.state === "ok" ? "ops.sql.plan.failed" : PLAN_STATE_KEY[res.data.state])}</Quiet>
        ) : (
          <>
            <span className="block text-small font-bold text-text-2">{ut(res.data.generic ? "ops.sql.plan.generic" : "ops.sql.plan.plain")}</span>
            <pre className="m-0 mt-2 overflow-x-auto rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text">
              {lines.map((l, i) => (
                <span key={i} className={cx("block", /Seq Scan/.test(l) && "font-bold text-warn")}>
                  {l}
                </span>
              ))}
            </pre>
          </>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {seq ? (
          <Callout kind="warn" icon={<OpsIcon name="scan-search" />} title={ut("opx.st.seqTitle")}>
            {ut("opx.st.seqText")}
          </Callout>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="xs" icon={<OpsIcon name="copy" />} onClick={() => copy(s.query, ut("opx.st.textCopied"))}>
            {ut("opx.st.copyText")}
          </Button>
          {lines ? (
            <Button size="xs" variant="ghost" icon={<OpsIcon name="copy" />} onClick={() => copy(lines.join("\n"), ut("opx.st.planCopied"))}>
              {ut("opx.st.copyPlan")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ─────────── не включено ─────────── */

const CODE = {
  preload: "command: postgres -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top",
  create: "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;",
  grant: "GRANT pg_read_all_stats TO quizzy_app;",
} as const;

function CodeStep({ n, text, code }: { n: number; text: string; code: string }) {
  const { ut } = useLang();
  const toast = useToast();
  return (
    <li className="flex gap-3 border-t border-divider py-3 first:border-t-0">
      <span className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-sunk text-caption font-extrabold text-text-2">{n}</span>
      <div className="min-w-0 flex-1">
        <span className="block text-[13px] leading-[19px] text-text">{text}</span>
        <div className="mt-2 flex items-start gap-2">
          <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text [overflow-wrap:anywhere]">
            {code}
          </pre>
          <Tooltip label={ut("opx.st.copyCode")}>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={ut("opx.st.copyCode")}
              icon={<OpsIcon name="copy" />}
              onClick={() =>
                void navigator.clipboard?.writeText(code).then(
                  () => toast(ut("opx.st.codeCopied"), "ok"),
                  () => toast(ut("ops.copyFailed"), "err"),
                )
              }
            />
          </Tooltip>
        </div>
      </div>
    </li>
  );
}

function NotEnabled({ d, onCheck, checkedAt }: { d: OpsStatements; onCheck: () => void; checkedAt: number | null }) {
  const { ut } = useLang();
  const loc = locale();
  if (d.state === "ok") return null;
  const steps = enableSteps(d.state);
  let n = 0;
  const others = (["notInstalled", "denied", "failed"] as const).filter((s) => s !== d.state);
  const OTHER_ICON = { notInstalled: "circle-dashed", denied: "lock", failed: "circle-x" } as const;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1100px]:grid-cols-1">
      <Panel
        title={ut("opx.st.offTitle")}
        icon={<OpsIcon name="plug-zap" />}
        tone="warn"
        footer={
          <div className="flex w-full flex-wrap items-center gap-3">
            <Button size="xs" icon={<OpsIcon name="refresh-cw" />} onClick={onCheck}>
              {ut("opx.st.checkAgain")}
            </Button>
            {checkedAt ? (
              <span className="ml-auto text-small text-muted">{fill(ut("opx.st.lastCheck"), { time: clock(checkedAt, loc) })}</span>
            ) : null}
          </div>
        }
      >
        <p className="m-0 text-[13.5px] leading-5 text-text">{ut(STATEMENTS_STATE_KEY[d.state])}</p>
        {steps.length ? (
          <ol className="m-0 mt-3 list-none border-t border-divider p-0">
            {steps.includes("preload") ? (
              <>
                <CodeStep n={++n} text={ut("ops.sql.step.preload")} code={CODE.preload} />
                <li className="flex items-start gap-3 border-t border-divider py-3">
                  <OpsIcon name="triangle-alert" size={16} className="mt-0.5 shrink-0 text-warn" />
                  <span className="text-[13px] font-bold leading-[19px] text-warn">{ut("ops.sql.step.restart")}</span>
                </li>
              </>
            ) : null}
            {steps.includes("create") ? <CodeStep n={++n} text={ut("ops.sql.step.create")} code={CODE.create} /> : null}
            {steps.includes("grant") ? <CodeStep n={++n} text={ut("ops.sql.step.grant")} code={CODE.grant} /> : null}
          </ol>
        ) : null}
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel title={ut("opx.st.otherStates")} icon={<OpsIcon name="list-tree" />}>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {others.map((s) => (
              <li key={s} className="flex items-start gap-2 text-[13px] leading-[19px] text-text-2">
                <OpsIcon name={OTHER_ICON[s]} size={15} className="mt-0.5 shrink-0 text-muted" />
                {ut(STATEMENTS_STATE_KEY[s])}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={ut("opx.st.meanwhile")} icon={<OpsIcon name="route" />}>
          <p className="m-0 text-[13px] leading-[19px] text-text-2">{ut("opx.st.meanwhileText")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink to="/ops/db" size="xs">
              <OpsIcon name="database" size={14} />
              {ut("ops.tab.db")}
            </ButtonLink>
            <ButtonLink to="/ops/requests" size="xs">
              <OpsIcon name="arrow-left-right" size={14} />
              {ut("ops.tab.requests")}
            </ButtonLink>
          </div>
        </Panel>
      </div>
    </div>
  );
}
