import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { OpsErrorWindow, OpsLogWindow, OpsStoreState } from "@quizzy/shared";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Button, Input } from "../../../ui/primitives";
import { fill } from "../../dashboard/model";
import { PERIOD_KEY, clock, fmtInt, hhmm, storeNote } from "../model";
import { StatusMark } from "../parts";
import { parseRequestId } from "./model";

/**
 * Общие части истории техпанели (участок obs2a): строка о периоде и
 * записи в базу, поле «открыть трассу по номеру».
 */

/**
 * «За останню добу — з 25 вересня 14:02. Зберігається 14 днів.» и, если
 * запись истории не идёт, — почему. Заменяет «з моменту запуску» на
 * вкладках с историей: память процесса перестала быть границей того, что
 * экран знает, и говорить о ней было бы неправдой в другую сторону.
 */
export function HistoryNote({
  window,
  from,
  retentionDays,
  store,
  unavailable,
}: {
  window: OpsLogWindow | OpsErrorWindow;
  from?: string;
  retentionDays?: number;
  store?: OpsStoreState;
  unavailable?: boolean;
}) {
  const { ut } = useLang();
  const loc = locale();
  if (unavailable) {
    return <StatusMark tone="warn">{ut("ops.history.unavailable")}</StatusMark>;
  }
  const note = storeNote(store);
  const since = from
    ? `${new Date(from).toLocaleDateString(loc, { day: "numeric", month: "long" })} ${hhmm(from, loc)}`
    : "—";
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px]">
      <span>
        {fill(ut("ops.history.period"), { period: ut(PERIOD_KEY[window]), time: since })}
        {retentionDays ? ` ${fill(ut("ops.history.keep"), { n: retentionDays })}` : ""}
      </span>
      {note.kind === "failing" ? (
        <StatusMark tone="warn">
          {fill(ut("ops.history.failing"), { time: clock(note.since, loc), n: fmtInt(note.pending, loc) })}
        </StatusMark>
      ) : note.kind === "dropped" ? (
        <StatusMark tone="warn">{fill(ut("ops.history.dropped"), { n: fmtInt(note.n, loc) })}</StatusMark>
      ) : note.kind === "off" ? (
        <span>{ut("ops.history.off")}</span>
      ) : null}
    </span>
  );
}

/**
 * Поле «номер запиту → траса». Отдельной формой, а не фильтром ленты:
 * номер из экрана ошибки у человека — это вопрос «что случилось с этим
 * обращением», и ответ на него — трасса целиком (/ops/trace/:id).
 */
export function TraceSearch({ className }: { className?: string }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      role="search"
      aria-label={ut("ops.trace.search")}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const id = parseRequestId(value);
        setBad(!id);
        if (id) navigate(`/ops/trace/${encodeURIComponent(id)}`);
      }}
    >
      <span className="flex flex-wrap items-center gap-[8px]">
        <Input
          look="fill"
          ph="plain"
          aria-label={ut("ops.trace.search")}
          aria-invalid={bad || undefined}
          placeholder={ut("ops.trace.search")}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          className="w-[260px] px-[10px] font-mono max-[600px]:w-full"
          autoComplete="off"
          maxLength={64}
        />
        <Button type="submit" variant="ghost">
          {ut("ops.trace.go")}
        </Button>
      </span>
      {bad ? <span className="mt-[4px] block text-[12px] leading-[16px] text-danger">{ut("ops.trace.badId")}</span> : null}
    </form>
  );
}
