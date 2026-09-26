import { useState, type KeyboardEvent } from "react";
import type { OpsSqlResult } from "@quizzy/shared";
import { api } from "../../../api";
import { timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Field, Input, Textarea } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill, looksMultiple, pushHistory, REFUSAL_TEXT, toCsv, type HistoryEntry } from "./model";
import { Caption, Note, TD, TH, Verdict } from "./parts";

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
 * говорит прямо, до первого запроса: роль приходит с сервера.
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

export default function OpsSecSql() {
  const { ut } = useLang();
  const toast = useToast();
  const info = useResource(() => api.opsSecSqlInfo(), []);
  const { run, busy } = useAction();

  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<OpsSqlResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(sessionHistory);
  const [tried, setTried] = useState(false);

  const reasonMissing = reason.trim().length < 3;

  const execute = () => {
    setTried(true);
    if (reasonMissing || !query.trim()) return;
    void run(async () => {
      const out = await api.opsSecSql(query, reason.trim());
      setResult(out);
      const next = pushHistory(sessionHistory, {
        query,
        reason: reason.trim(),
        at: new Date().toISOString(),
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
    <div className="pt-[8px]">
      <Note className="mb-[16px]">{ut("ops.sec.superOnly")}</Note>

      {info.error ? (
        <Loading error={info.error} onRetry={info.reload} />
      ) : !info.data ? (
        <Loading rows={2} />
      ) : (
        <div className="mb-[24px] flex flex-col gap-[6px]">
          <Note>{fill(ut("ops.sec.sql.role"), { role: info.data.role })}</Note>
          {info.data.bypassesRls ? (
            <Verdict tone="attention" className="text-[13px]">
              {fill(ut("ops.sec.sql.bypass"), { role: info.data.role, reason: info.data.rlsReason ?? "—" })}
            </Verdict>
          ) : null}
          <Note>{ut("ops.sec.sql.encrypted")}</Note>
          <Note>
            {fill(ut("ops.sec.sql.limits"), { rows: info.data.maxRows, sec: Math.round(info.data.timeoutMs / 1000) })}
          </Note>
        </div>
      )}

      <div className="max-w-[1200px]">
        <Field
          label={ut("ops.sec.sql.reason")}
          labelClassName="mb-[6px] block text-[13px] font-bold text-muted"
          error={tried && reasonMissing ? ut("ops.sec.sql.reasonNeeded") : null}
        >
          <Input
            look="outline"
            value={reason}
            maxLength={500}
            placeholder={ut("ops.sec.sql.reasonHint")}
            onChange={(e) => setReason(e.target.value)}
            className="w-full"
          />
        </Field>
        <Field
          label={ut("ops.sec.sql.query")}
          labelClassName="mb-[6px] block text-[13px] font-bold text-muted"
          hint={looksMultiple(query) ? ut("ops.sec.sql.multipleHint") : ut("ops.sec.sql.hotkey")}
        >
          {/* моноширинное поле без внешних редакторов: подсветка синтаксиса не стоит зависимости */}
          <Textarea
            look="outline"
            value={query}
            rows={8}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            className="w-full resize-y font-mono text-[14px] leading-[20px]"
          />
        </Field>
        <Button size="md" disabled={busy || !query.trim()} onClick={execute}>
          {ut("ops.sec.sql.run")}
        </Button>
      </div>

      {result ? <Result result={result} onCopy={copy} /> : null}

      <RuleSection title={ut("ops.sec.sql.history")} className="mt-[32px]">
        {history.length === 0 ? (
          <Note>{ut("ops.sec.sql.historyEmpty")}</Note>
        ) : (
          <ul className="m-0 list-none p-0">
            {history.map((h) => (
              <li
                key={`${h.at}:${h.query}`}
                className="grid grid-cols-[1fr_auto] items-start gap-x-[24px] border-b border-hairline py-[10px] last:border-b-0 max-[900px]:grid-cols-1"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-bold leading-[18px] text-text">{h.reason}</div>
                  <pre className="m-0 mt-[2px] max-h-[60px] overflow-hidden whitespace-pre-wrap break-all font-mono text-[12px] leading-[17px] text-text-2">
                    {h.query}
                  </pre>
                  <div className="mt-[2px] text-[11px] text-muted">
                    {timeOfDay(h.at)} ·{" "}
                    {h.outcome.kind === "ok"
                      ? fill(ut("ops.sec.sql.historyRows"), { n: h.outcome.rows })
                      : h.outcome.kind === "refused"
                        ? ut("ops.sec.sql.historyRefused")
                        : ut("ops.sec.sql.historyError")}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setQuery(h.query);
                    setReason(h.reason);
                  }}
                >
                  {ut("ops.sec.sql.historyUse")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </RuleSection>
    </div>
  );
}

export function Result({
  result,
  onCopy,
}: {
  result: OpsSqlResult;
  onCopy: (columns: string[], rows: (string | null)[][]) => void;
}) {
  const { ut } = useLang();

  if (result.status === "refused") {
    return (
      <div className="mt-[24px]">
        <Verdict tone="danger">
          {ut("ops.sec.sql.refused")}: {fill(ut(REFUSAL_TEXT[result.code]), { detail: result.detail })}
        </Verdict>
      </div>
    );
  }
  if (result.status === "error") {
    return (
      <div className="mt-[24px]">
        <Verdict tone="danger">
          {ut("ops.sec.sql.error")}
          {result.code ? <span className="font-mono"> ({result.code})</span> : null}
        </Verdict>
        <pre className="m-0 mt-[6px] overflow-x-auto whitespace-pre-wrap rounded-[5px] bg-primary-soft px-[12px] py-[10px] font-mono text-[13px] leading-[19px] text-text">
          {result.message}
        </pre>
      </div>
    );
  }

  const columns = result.columns.map((c) => c.name);
  return (
    <div className="mt-[24px]">
      <div className="mb-[8px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px]">
        <span className="font-mono text-[13px] tabular-nums text-text-2">
          {fill(ut("ops.sec.sql.meta"), { n: result.rowCount, ms: result.ms })}
        </span>
        {result.truncated ? (
          <span className="text-[13px] font-bold text-accent">
            {fill(ut("ops.sec.sql.truncated"), { n: result.rowCount })}
          </span>
        ) : null}
        {result.rowCount > 0 ? (
          <Button variant="quiet" onClick={() => onCopy(columns, result.rows)}>
            {ut("ops.sec.sql.copyCsv")}
          </Button>
        ) : null}
      </div>
      {result.rowCount === 0 ? (
        <Note>{ut("ops.sec.sql.empty")}</Note>
      ) : (
        /*
          Широкая таблица прокручивается внутри своей рамки, а не страницей:
          горизонтальной прокрутки страницы нет ни при какой ширине. Высота
          тоже ограничена — пятьсот строк не должны отодвигать историю на
          километр вниз.
        */
        <div className="max-h-[560px] overflow-auto rounded-[5px] border border-hairline">
          <table className="border-collapse font-mono text-[13px] tabular-nums">
            <thead className="sticky top-0 bg-[var(--bg)]">
              <tr>
                {result.columns.map((c, i) => (
                  <th key={`${c.name}-${i}`} scope="col" className={cx(TH, "whitespace-nowrap pl-[10px] font-sans")}>
                    {c.name}
                    <Caption className="font-mono text-[11px] font-normal">
                      {c.type}
                      {c.masked ? ` · ${ut("ops.sec.sql.masked")}` : ""}
                    </Caption>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="hover:bg-primary-tint">
                  {row.map((v, i) => (
                    <td
                      key={i}
                      className={cx(TD, "max-w-[420px] whitespace-pre-wrap break-words pl-[10px] font-mono", v === null && "text-muted")}
                    >
                      {v === null ? "NULL" : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
