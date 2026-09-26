import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SuspiciousFinding, SuspiciousRule } from "@quizzy/shared";
import { api } from "../../../api";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, Modal, useAction } from "../../../ui";
import { Button, Field, Tag, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { Cell, ColumnHead, FilterSelect, metaClass, rowClass } from "../controls";
import { RULES, findingFacts, journalLink, ruleExplanation, ruleKey } from "./model";
import { Empty } from "./parts";

/*
 * Техпанель → «Підозріла активність» (people2, пункт 18).
 *
 * Список срабатываний правил над журналом: что сработало, почему (числами —
 * пороги приходят с сервера), кто, когда, ссылка на строки журнала и
 * отметка «розібрано» с комментарием. Правила — чистые функции на сервере
 * (lib/suspicious.ts), проверка идёт задачей раз в пять минут; «Перевірити
 * зараз» — не ждать такта.
 *
 * «Нове» — янтарём: это ровно «требует внимания», и больше янтаря на экране
 * нет. Разобранное — словами и серым: оно уже не просит ничего.
 *
 * Отбор — в адресе (?status=, ?rule=), как у журнала: «нерозібрані
 * невдалі входи» пересылают коллеге ссылкой.
 */

const GRID = "grid grid-cols-[minmax(0,2.6fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.6fr)] gap-x-[20px]";

export default function OpsSuspicious() {
  const { ut } = useLang();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const rule = params.get("rule") ?? "";
  const { run, busy } = useAction();
  const [resolving, setResolving] = useState<SuspiciousFinding | null>(null);

  const update = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const res = useResource(() => api.suspicious({ status, rule: rule || undefined }), [status, rule]);

  return (
    <>
      <div className="mb-[12px] grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-[12px] max-[900px]:grid-cols-1">
        <FilterSelect
          label={ut("ops.users.state")}
          value={status}
          onChange={(v) => update({ status: v === "open" ? null : v })}
          options={[
            { value: "open", label: ut("ops.susp.open") },
            { value: "resolved", label: ut("ops.susp.resolvedMany") },
            { value: "all", label: ut("ops.susp.all") },
          ]}
        />
        <FilterSelect
          label={ut("ops.susp.rule")}
          value={rule}
          onChange={(v) => update({ rule: v })}
          options={[{ value: "", label: ut("ops.susp.allRules") }, ...RULES.map((r) => ({ value: r, label: ut(ruleKey(r)) }))]}
        />
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.scanSuspicious();
              res.reload();
            }, ut("ops.susp.scanned"))
          }
        >
          {ut("ops.susp.scan")}
        </Button>
      </div>

      <div className="mb-[18px] flex flex-wrap items-center gap-x-[16px] gap-y-[4px] font-mono text-[13px] text-muted tabular-nums" aria-live="polite">
        {res.data ? (
          <>
            <span>
              {ut("ops.susp.openCount")}: {res.data.open}
            </span>
            <span>
              {ut("ops.susp.lastScan")}: {res.data.lastScanAt ? dateTime(res.data.lastScanAt) : ut("ops.susp.neverScanned")}
            </span>
          </>
        ) : null}
      </div>

      {res.data ? <RulesExplained thresholds={res.data.thresholds} /> : null}

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={5} />
      ) : res.data.items.length === 0 ? (
        <Empty>{ut("ops.susp.none")}</Empty>
      ) : (
        <>
          <ColumnHead grid={GRID} labels={[ut("ops.susp.rule"), ut("ops.susp.who"), ut("ops.susp.when"), ut("ops.users.state")]} />
          <ul className="m-0 list-none p-0" aria-label={ut("ops.tab.suspicious")}>
            {res.data.items.map((f) => (
              <FindingRow key={f.id} f={f} explain={ruleExplanation(f.rule, res.data!.thresholds, ut)} onResolve={() => setResolving(f)} />
            ))}
          </ul>
        </>
      )}

      {resolving ? (
        <ResolveDialog
          finding={resolving}
          onClose={() => setResolving(null)}
          onDone={() => {
            setResolving(null);
            res.reload();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Как работают правила — раскрываемым блоком над списком: объяснение
 * нужно при первом разборе и мешает на сотом. Каждое правило — своими
 * числами с сервера.
 */
function RulesExplained({ thresholds }: { thresholds: Parameters<typeof ruleExplanation>[1] }) {
  const { ut } = useLang();
  return (
    <details className="mb-[18px] border-b border-hairline pb-[10px]">
      <summary className="cursor-pointer text-[15px] font-bold leading-[20px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]">
        {ut("ops.susp.rulesTitle")}
      </summary>
      <dl className="m-0 mt-[10px] grid grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)] gap-x-[20px] gap-y-[8px] max-[900px]:grid-cols-1">
        {RULES.map((r: SuspiciousRule) => (
          <div key={r} className="contents">
            <dt className="text-[15px] font-bold leading-[20px] text-text">{ut(ruleKey(r))}</dt>
            <dd className="m-0 text-[13px] leading-[18px] text-muted">{ruleExplanation(r, thresholds, ut)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function FindingRow({ f, explain, onResolve }: { f: SuspiciousFinding; explain: string; onResolve: () => void }) {
  const { ut } = useLang();
  const who = f.actorName || f.actorEmail || f.ip || "—";
  return (
    <li className={rowClass(GRID)}>
      <div className="min-w-0">
        <span className="block text-[17px] font-bold leading-[22px] text-primary">{ut(ruleKey(f.rule))}</span>
        <span className="block text-[15px] leading-[20px] text-text-2 [overflow-wrap:anywhere]">{findingFacts(f, ut)}</span>
        <span className={metaClass}>{explain}</span>
      </div>
      <Cell label={ut("ops.susp.who")}>
        <span className="block [overflow-wrap:anywhere]">{who}</span>
        {f.actorName && f.actorEmail ? <span className={metaClass}>{f.actorEmail}</span> : null}
        {f.subjectName ? (
          <span className={metaClass}>
            {ut("ops.who.as")} {f.subjectName}
          </span>
        ) : null}
      </Cell>
      <Cell label={ut("ops.susp.when")}>
        <span className="block">{dateTime(f.windowTo)}</span>
        {f.windowFrom !== f.windowTo ? <span className={metaClass}>{dateTime(f.windowFrom)} —</span> : null}
      </Cell>
      <Cell label={ut("ops.users.state")}>
        {f.resolvedAt ? (
          <>
            <span className="block">{ut("ops.susp.resolvedOne")}</span>
            <span className={metaClass}>
              {dateTime(f.resolvedAt)}
              {f.resolvedByEmail ? ` · ${f.resolvedByEmail}` : ""}
            </span>
            {f.resolution ? <span className="block text-[13px] leading-[18px] text-text-2 [overflow-wrap:anywhere]">{f.resolution}</span> : null}
          </>
        ) : (
          /* «нове» — янтарём: единственное на экране, что просит внимания */
          <Tag tone="attention">{ut("ops.susp.new")}</Tag>
        )}
        <span className="mt-[6px] flex flex-wrap items-center gap-x-[14px] gap-y-[4px] print:hidden">
          <Link to={journalLink(f)} className="text-[13px] font-bold text-primary no-underline hover:underline">
            {ut("ops.susp.inLog")}
          </Link>
          {f.resolvedAt ? null : (
            <Button variant="quiet" onClick={onResolve}>
              {ut("ops.susp.resolve")}
            </Button>
          )}
        </span>
      </Cell>
    </li>
  );
}

/** «Розібрано» — с комментарием словами: через год разбирают по журналу, а «ок» там не отвечает ни на что */
function ResolveDialog({ finding, onClose, onDone }: { finding: SuspiciousFinding; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [comment, setComment] = useState("");
  return (
    <Modal title={`${ut("ops.susp.resolve")} · ${ut(ruleKey(finding.rule))}`} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (comment.trim().length < 3) return;
          void run(async () => {
            await api.resolveFinding(finding.id, comment.trim());
            onDone();
          }, ut("ops.susp.resolvedDone"));
        }}
      >
        <Field label={ut("ops.susp.comment")}>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={1000} autoFocus required />
        </Field>
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || comment.trim().length < 3}>
            {ut("ops.susp.resolve")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
