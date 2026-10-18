import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { OpsSqlResult } from "@quizzy/shared";
import { api } from "../../../api";
import { timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, Loading, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Count, IconTile, Panel } from "../../../ui/layout";
import { Button, ButtonLink, Field, Input, Tag, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { OpsIcon, type OpsIconName } from "../icons";
import { OpsHead, PanelNote, Quiet } from "../parts";
import { fill, looksMultiple, pushHistory, REFUSAL_TEXT, toCsv, type HistoryEntry } from "./model";
import { Note, SuperOnly, TD, TH } from "./parts";

/*
 * Раздел «SQL (читання)» техпанели — только суперадмину, на сервере.
 *
 * Решение заказчика 2026-09-26 (пункт 28): консоль только на чтение, с
 * обязательной причиной и строкой журнала на каждый запрос. Что держит её
 * «только на чтение» — три пояса на сервере (lib/sqlConsole.ts): разбор
 * текста, расширенный протокол в транзакции READ ONLY с откатом и своё
 * соединение на запрос. Экран о поясах не спорит и ничего не решает сам:
 * подсказка «похоже на несколько операторов» — подсказка, а отказ даёт
 * сервер.
 *
 * Под какой ролью идёт запрос и что видно через политики строк — экран
 * говорит прямо, до первого запроса: роль приходит с сервера. Справа —
 * межі консолі, свои запросы за сессию и то, чего консоль не выполнит.
 *
 * Никаких «шаблонных запросов с ПДн» (решение заказчика): поле пустое, и
 * подсказок-образцов вида «select * from users» здесь нет намеренно.
 */

/*
 * История своих запросов — в памяти вкладки, а не в sessionStorage.
 *
 * Текст запроса бывает с персональными литералами (where email = '…'), а
 * хранилище сессии браузер при восстановлении вкладок кладёт на диск.
 * Модульная переменная живёт, пока открыта консоль, и переживает переходы
 * между разделами техпанели — ровно «за сессию», без следа на диске.
 * Полная история и так есть: журнал, sec.sql_query.
 */
let sessionHistory: HistoryEntry[] = [];

/** Чего консоль не выполнит — те же отказы разбора, что на сервере, коротко */
const REFUSALS: { icon: OpsIconName; key: "opx.sq.no.multiple" | "opx.sq.no.write" | "opx.sq.no.lock" | "opx.sq.no.side" | "opx.sq.no.params" | "opx.sq.no.size" }[] = [
  { icon: "list-ordered", key: "opx.sq.no.multiple" },
  { icon: "pencil", key: "opx.sq.no.write" },
  { icon: "lock", key: "opx.sq.no.lock" },
  { icon: "zap", key: "opx.sq.no.side" },
  { icon: "braces", key: "opx.sq.no.params" },
  { icon: "ruler", key: "opx.sq.no.size" },
];

export default function OpsSecSql() {
  const { ut } = useLang();
  const toast = useToast();
  const info = useResource(() => api.opsSecSqlInfo(), []);
  const { run, busy } = useAction();

  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<OpsSqlResult | null>(null);
  const [resultAt, setResultAt] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(sessionHistory);
  const [tried, setTried] = useState(false);

  const reasonMissing = reason.trim().length < 3;

  const execute = () => {
    setTried(true);
    if (reasonMissing || !query.trim()) return;
    void run(async () => {
      const out = await api.opsSecSql(query, reason.trim());
      const at = new Date().toISOString();
      setResult(out);
      setResultAt(at);
      const next = pushHistory(sessionHistory, {
        query,
        reason: reason.trim(),
        at,
        outcome:
          out.status === "ok"
            ? { kind: "ok", rows: out.rowCount, truncated: out.truncated }
            : out.status === "refused"
              ? { kind: "refused" }
              : { kind: "error" },
      });
      sessionHistory = next;
      setHistory(next);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      execute();
    }
  };

  const copy = async (columns: string[], rows: (string | null)[][]) => {
    try {
      await navigator.clipboard.writeText(toCsv(columns, rows));
      toast(ut("ops.sec.sql.copied"), "ok");
    } catch {
      toast(ut("ui.actionFailed"), "err");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <OpsHead
        meta={[ut("opx.sq.metaBold"), ut("opx.sq.metaSub")]}
        actions={
          <>
            <SuperOnly />
            <ButtonLink to="/ops/statements">
              <OpsIcon name="turtle" size={15} />
              {ut("ops.tab.statements")}
            </ButtonLink>
          </>
        }
      />
      <Note className="max-w-none">{ut("opx.sq.lead")}</Note>
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("ops.sec.sql.query")} icon={<OpsIcon name="square-terminal" />} sub={ut("opx.sq.readOnly")}>
            <div className="flex flex-col gap-3">
              <Field label={ut("ops.sec.sql.reason")} hint={ut("opx.sq.reasonHint")} error={tried && reasonMissing ? ut("ops.sec.sql.reasonNeeded") : null}>
                <Input value={reason} maxLength={500} placeholder={ut("opx.sq.reasonPh")} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Field
                label={ut("opx.sq.text")}
                hint={looksMultiple(query) ? ut("ops.sec.sql.multipleHint") : ut("opx.sq.oneStatement")}
              >
                {/* моноширинное поле без внешних редакторов: подсветка синтаксиса не стоит зависимости */}
                <Textarea
                  value={query}
                  rows={6}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKey}
                  className="resize-y font-mono text-[13px] leading-[22px]"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={<OpsIcon name="play" />} disabled={busy || !query.trim()} onClick={execute}>
                  {ut("ops.sec.sql.run")}
                </Button>
                <Button
                  variant="ghost"
                  icon={<OpsIcon name="x" />}
                  disabled={!query && !reason}
                  onClick={() => {
                    setQuery("");
                    setReason("");
                    setTried(false);
                  }}
                >
                  {ut("opx.sq.clear")}
                </Button>
                <span className="ml-auto inline-flex items-center gap-1.5 text-small text-muted">
                  <OpsIcon name="timer" size={14} />
                  {info.data ? fill(ut("opx.sq.limits"), { rows: info.data.maxRows, sec: Math.round(info.data.timeoutMs / 1000) }) : ut("ops.sec.sql.hotkey")}
                </span>
              </div>
            </div>
          </Panel>
          {result ? <Result result={result} at={resultAt} onCopy={copy} /> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("opx.sq.limitsTitle")} icon={<OpsIcon name="shield-check" />}>
            {info.error ? (
              <Loading bare error={info.error} onRetry={info.reload} />
            ) : !info.data ? (
              <Loading bare rows={3} />
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                <LimitItem icon="database" title={ut("opx.sq.role")}>
                  {fill(ut("ops.sec.sql.role"), { role: info.data.role })}
                  {info.data.bypassesRls ? (
                    <span className="mt-1 block font-semibold text-warn">
                      {fill(ut("ops.sec.sql.bypass"), { role: info.data.role, reason: info.data.rlsReason ?? "—" })}
                    </span>
                  ) : null}
                </LimitItem>
                <LimitItem icon="lock" title={ut("opx.sq.cipherTitle")}>
                  {ut("ops.sec.sql.encrypted")}
                </LimitItem>
                <LimitItem icon="file-search" title={ut("opx.sq.auditTitle")}>
                  {ut("opx.sq.auditText")}
                </LimitItem>
              </ul>
            )}
          </Panel>
          <Panel title={ut("ops.sec.sql.history")} icon={<OpsIcon name="history" />} actions={history.length ? <Count n={history.length} /> : null} flush>
            {history.length === 0 ? (
              <div className="px-4 pb-3">
                <Quiet>{ut("ops.sec.sql.historyEmpty")}</Quiet>
              </div>
            ) : (
              <ul className="m-0 list-none border-t border-divider p-0">
                {history.map((h) => (
                  <li key={`${h.at}:${h.query}`} className="border-b border-divider px-4 py-3 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <span className="text-small font-bold tabular-nums text-text-2">{timeOfDay(h.at)}</span>
                      {h.outcome.kind === "ok" ? (
                        <Tag tone="good" icon={<OpsIcon name="check" />}>
                          {fill(ut("ops.sec.sql.historyRows"), { n: h.outcome.rows })}
                        </Tag>
                      ) : h.outcome.kind === "refused" ? (
                        <Tag tone="attention" icon={<OpsIcon name="ban" />}>
                          {ut("ops.sec.sql.historyRefused")}
                        </Tag>
                      ) : (
                        <Tag tone="attention" icon={<OpsIcon name="circle-x" />}>
                          {ut("ops.sec.sql.historyError")}
                        </Tag>
                      )}
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        className="ml-auto"
                        aria-label={ut("ops.sec.sql.historyUse")}
                        title={ut("ops.sec.sql.historyUse")}
                        icon={<OpsIcon name="undo-2" />}
                        onClick={() => {
                          setQuery(h.query);
                          setReason(h.reason);
                        }}
                      />
                    </div>
                    <b className="mt-1 block truncate text-[13px] font-bold text-text">{h.reason}</b>
                    <span className="block truncate font-mono text-[12px] text-text-2">{h.query}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={ut("opx.sq.wontRun")} icon={<OpsIcon name="ban" />}>
            <p className="m-0 mb-2 text-small text-text-2">{ut("opx.sq.wontRunSub")}</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {REFUSALS.map((r) => (
                <li key={r.key} className="flex items-center gap-2 text-[13px] text-text">
                  <OpsIcon name={r.icon} size={15} className="text-muted" />
                  {ut(r.key)}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function LimitItem({ icon, title, children }: { icon: OpsIconName; title: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-t border-divider py-3 first:border-t-0 first:pt-0">
      <IconTile size={28} tone="neutral" icon={<OpsIcon name={icon} />} />
      <div className="min-w-0">
        <b className="block text-[13px] font-extrabold text-text">{title}</b>
        <span className="block text-small leading-[18px] text-text-2">{children}</span>
      </div>
    </li>
  );
}

export function Result({
  result,
  at,
  onCopy,
}: {
  result: OpsSqlResult;
  /** Когда выполнен — «записано в журнал о …» */
  at?: string | null;
  onCopy: (columns: string[], rows: (string | null)[][]) => void;
}) {
  const { ut } = useLang();
  const sub = at ? fill(ut("opx.sq.logged"), { time: timeOfDay(at) }) : undefined;

  if (result.status === "refused") {
    return (
      <Panel title={ut("opx.sq.result")} icon={<OpsIcon name="table-2" />} sub={sub}>
        <Callout kind="warn" icon={<OpsIcon name="ban" />} title={ut("ops.sec.sql.refused")}>
          {fill(ut(REFUSAL_TEXT[result.code]), { detail: result.detail })}
        </Callout>
      </Panel>
    );
  }
  if (result.status === "error") {
    return (
      <Panel title={ut("opx.sq.result")} icon={<OpsIcon name="table-2" />} sub={sub}>
        <Callout
          kind="warn"
          icon={<OpsIcon name="circle-x" />}
          title={
            <>
              {ut("ops.sec.sql.error")}
              {result.code ? <span className="font-mono">{` (${result.code})`}</span> : null}
            </>
          }
        >
          <pre className="m-0 mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-text">{result.message}</pre>
        </Callout>
      </Panel>
    );
  }

  const columns = result.columns.map((c) => c.name);
  return (
    <Panel
      title={ut("opx.sq.result")}
      icon={<OpsIcon name="table-2" />}
      sub={sub}
      actions={
        <>
          <Tag tone="good" icon={<OpsIcon name="check" />}>
            {fill(ut("opx.sq.meta"), { n: result.rowCount, ms: result.ms })}
          </Tag>
          {result.truncated ? <Tag tone="attention">{fill(ut("ops.sec.sql.truncated"), { n: result.rowCount })}</Tag> : null}
          {result.rowCount > 0 ? (
            <Button size="xs" icon={<OpsIcon name="copy" />} onClick={() => onCopy(columns, result.rows)}>
              {ut("ops.sec.sql.copyCsv")}
            </Button>
          ) : null}
        </>
      }
      flush
      footer={<PanelNote>{ut("ops.sec.sql.encrypted")}</PanelNote>}
    >
      {result.rowCount === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("ops.sec.sql.empty")}</Quiet>
        </div>
      ) : (
        /*
          Широкая таблица прокручивается внутри своей рамки, а не страницей:
          горизонтальной прокрутки страницы нет ни при какой ширине. Высота
          тоже ограничена — пятьсот строк не должны отодвигать историю на
          километр вниз.
        */
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full border-separate border-spacing-0 font-mono text-[12px] tabular-nums">
            <thead className="sticky top-0 z-[1]">
              <tr>
                {result.columns.map((c, i) => (
                  <th key={`${c.name}-${i}`} scope="col" className={cx(TH, "font-mono font-semibold normal-case")}>
                    {/* тип колонки — имя типа Postgres как есть; скрытая колонка помечена значком уже в шапке */}
                    <span className="text-text-2">{c.name}</span>{" "}
                    <span className="inline-flex items-center gap-1 font-medium text-muted">
                      {c.type}
                      {c.masked ? <OpsIcon name="eye-off" size={12} /> : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="hover:bg-panel-2">
                  {row.map((v, i) => (
                    /* короткое значение (номер, дата, почта) — одной строкой; длинное текстом переносится в пределах колонки */
                    <td
                      key={i}
                      className={cx(
                        TD,
                        "max-w-[420px] font-mono text-[12px]",
                        v !== null && v.length > 64 ? "whitespace-pre-wrap break-words" : "whitespace-nowrap",
                        v === null && "text-muted",
                      )}
                    >
                      {result.columns[i]?.masked ? (
                        <Tag icon={<OpsIcon name="eye-off" />}>{ut("ops.sec.sql.masked")}</Tag>
                      ) : v === null ? (
                        "NULL"
                      ) : (
                        v
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
