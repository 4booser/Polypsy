import { useState } from "react";
import { api } from "../../api";
import { NotLoaded } from "../../ui";
import { cx } from "../../ui/cx";
import { Segmented } from "../../ui/primitives";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { clock, wallOf } from "./model";
import { useDayLabel } from "./Exceptions";

/** Сколько дней со свободными окнами предлагать: дальше — уже не «перенести», а «записать заново» */
const DAYS = 5;

export type FreeSlot = Awaited<ReturnType<typeof api.freeSlots>>["items"][number];

/**
 * Свободные окна специалиста по дням — для переноса приёма.
 *
 * Только то, что сервер отдаёт как свободное (GET /slots): открытое, в
 * расписании, ещё не наступившее и никем не занятое. Занять иное перенос не
 * даст — тот же takeSlot, что при записи, — и кнопка, которая всегда
 * кончается отказом, на экране не стоит.
 */
export function MoveSlots({
  specialistId,
  tz,
  picked,
  onPick,
}: {
  specialistId: string;
  tz: string;
  picked: FreeSlot | null;
  onPick: (slot: FreeSlot) => void;
}) {
  const { ut } = useLang();
  const label = useDayLabel();
  const res = useResource(() => api.freeSlots({ specialistId }), [specialistId]);
  const [day, setDay] = useState<string | null>(null);

  if (!res.data) return <NotLoaded res={res} rows={2} />;

  const byDay = new Map<string, FreeSlot[]>();
  for (const s of res.data.items) {
    const d = wallOf(s.startsAt, tz).date;
    if (!byDay.has(d) && byDay.size >= DAYS) break;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const days = [...byDay.keys()];
  if (!days.length) return <p className="m-0 text-small text-muted">{ut("v2s.noFree")}</p>;
  const current = day && byDay.has(day) ? day : days[0]!;

  return (
    <>
      <Segmented
        wide
        label={ut("v2s.moveDay")}
        value={current}
        onChange={setDay}
        items={days.map((d) => ({ key: d, label: label(d) }))}
      />
      <div role="group" aria-label={ut("v2s.moveTime")} className="mt-2 grid grid-cols-4 gap-1.5">
        {byDay.get(current)!.map((s) => {
          const on = picked?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(s)}
              className={cx(
                "h-10 cursor-pointer rounded-control border-0 text-body font-bold tabular-nums",
                "transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                on
                  ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--vring)]"
                  : "bg-sunk text-text hover:bg-sunk-2",
              )}
            >
              {clock(wallOf(s.startsAt, tz).minutes)}
            </button>
          );
        })}
      </div>
    </>
  );
}
