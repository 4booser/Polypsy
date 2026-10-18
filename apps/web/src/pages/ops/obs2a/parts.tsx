import type { OpsErrorWindow, OpsLogWindow, OpsStoreState } from "@quizzy/shared";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { fill } from "../../dashboard/model";
import { clock, fmtInt, hhmm, storeNote } from "../model";
import { OpsIcon } from "../icons";
import { StatusMark } from "../parts";

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
  window: _window,
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
  const since = from ? `${new Date(from).toLocaleDateString(loc, { day: "2-digit", month: "2-digit" })}, ${hhmm(from, loc)}` : "—";
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-small text-muted">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <OpsIcon name="history" size={14} />
        {retentionDays
          ? fill(ut("opx.hist.note"), { time: since, n: retentionDays })
          : fill(ut("opx.hist.noteShort"), { time: since })}
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
