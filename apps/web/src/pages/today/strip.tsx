import type { AppointmentView } from "@quizzy/shared";
import { Popover } from "../../ui";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { fill } from "../dashboard/model";
import { dayAxis, hhmm, lanes, minuteOfDay, type Clash, type SessionState } from "./model";

/**
 * Шкала дня: часы приёма, блоки сессий и «зараз».
 *
 * Пропорциональная по времени, пустые часы сжаты (dayAxis). Блок — кнопка:
 * нажатие выбирает сессию — строку ниже и панель подготовки справа; на
 * наведении и фокусе — подробности приёма. Один и тот же компонент стоит на
 * «Сьогодні» и в віджете «Прийом сьогодні» зведення.
 */
export function DayStrip({
  items,
  states,
  clash,
  now,
  selectedId,
  onSelect,
}: {
  items: readonly AppointmentView[];
  states: ReadonlyMap<string, SessionState>;
  clash: ReadonlyMap<string, Clash>;
  /** Момент «зараз», если показан сегодняшний день */
  now: number | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { ut } = useLang();
  const shown = items.filter((a) => a.status !== "cancelled");
  const spans = shown.map((a) => ({ id: a.id, start: minuteOfDay(a.startsAt), end: Math.max(minuteOfDay(a.startsAt) + 10, minuteOfDay(a.endsAt)) }));
  const nowMin = now === null ? null : minuteOfDay(now);
  const axis = dayAxis(spans, nowMin);
  if (!axis) return null;
  const lane = lanes(spans);
  const label = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:00`;

  return (
    <div
      role="group"
      aria-label={fill(ut("dayA.stripLabel"), { from: label(axis.from), to: label(axis.to) })}
      className="relative mx-4 mb-1.5 mt-0.5 h-[84px]"
    >
      {axis.ticks.map((t) => (
        <span key={`l${t.minute}`} aria-hidden className="absolute top-0 h-14 w-px bg-divider" style={{ left: `${t.pct}%` }} />
      ))}
      {axis.ticks.filter((t) => nowMin === null || Math.abs(t.pct - axis.at(nowMin)) > 6).map((t) => (
        <span
          key={`t${t.minute}`}
          aria-hidden
          className="absolute top-[62px] -translate-x-1/2 whitespace-nowrap text-micro font-bold leading-4 text-muted tabular-nums"
          style={{ left: `${t.pct}%` }}
        >
          {label(t.minute)}
        </span>
      ))}
      {axis.gaps.map((g) => (
        <span
          key={`g${g.from}`}
          className="absolute top-1.5 grid h-11 place-items-center overflow-hidden whitespace-nowrap rounded-control border-[1.5px] border-dashed border-control bg-panel text-[11.5px] font-semibold text-muted"
          style={{ left: `calc(${g.leftPct}% + 4px)`, width: `calc(${g.widthPct}% - 8px)` }}
        >
          {ut("dayA.noSessions")}
        </span>
      ))}
      {shown.map((a) => {
        const s = spans.find((x) => x.id === a.id)!;
        const left = axis.at(s.start);
        const width = axis.at(s.end) - left;
        const state = states.get(a.id) ?? "later";
        const where = lane.get(a.id) ?? "full";
        const conflict = clash.has(a.id) && state !== "done" && state !== "noshow";
        const surname = a.patientName.split(" ")[0] ?? a.patientName;
        const sub = state === "done" ? fill(ut("dayA.blkDone"), { t: hhmm(a.startsAt) }) : hhmm(a.startsAt);
        const selected = selectedId === a.id;
        return (
          <Popover
            key={a.id}
            title={a.patientName}
            content={
              <span className="block">
                <span className="block font-bold text-text tabular-nums">
                  {hhmm(a.startsAt)}–{hhmm(a.endsAt)}
                </span>
                <span className="block">
                  {ut(a.kind === "primary" ? "day.primary" : "day.repeat")}
                  {", "}
                  {a.mode === "remote" ? ut("day.remote") : a.room ? `${ut("day.room")} ${a.room}` : ut("dayA.onsite")}
                </span>
                {conflict ? (
                  <span className="mt-1 block font-bold text-warn">
                    {fill(ut("dayA.clashWith"), { name: clash.get(a.id)!.withName })}
                  </span>
                ) : null}
              </span>
            }
          >
            <button
              type="button"
              onClick={() => onSelect?.(a.id)}
              aria-pressed={onSelect ? selected : undefined}
              aria-label={`${hhmm(a.startsAt)}, ${a.patientName}`}
              className={cx(
                "absolute flex min-h-0 cursor-pointer overflow-hidden whitespace-nowrap border-0 px-2 text-left text-caption font-extrabold leading-[14px]",
                "transition-shadow duration-[var(--dur-fast)] ease-[var(--ease)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                where === "full"
                  ? "top-1.5 h-11 flex-col justify-center gap-px rounded-control"
                  : cx("h-[21px] flex-row items-center gap-[5px] rounded-[7px]", where === "top" ? "top-1.5" : "top-[29px]"),
                state === "done" && "bg-good-tint text-good",
                (state === "next" || state === "here") && "bg-violet text-onfill",
                state === "later" && !conflict && "bg-panel text-text shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                state === "late" && "bg-panel text-warn shadow-[inset_0_0_0_1.5px_var(--warnline)]",
                (state === "noshow" || (conflict && state === "later")) && "bg-warn-tint text-warn",
                conflict && state === "later" && "shadow-[inset_0_0_0_1.5px_var(--warnline)]",
                selected && "ring-[1.5px] ring-violet-ring ring-offset-2 ring-offset-panel",
                !selected && "hover:shadow-[inset_0_0_0_1.5px_var(--vring)]",
              )}
              style={{ left: `${left}%`, width: `calc(${Math.max(width, 2)}% - 3px)` }}
            >
              <span className="truncate">{surname}</span>
              {where === "full" ? (
                <small
                  className={cx(
                    "truncate text-[11px] font-semibold leading-[13px]",
                    state === "next" || state === "here" ? "text-onfill-muted" : state === "done" ? "text-good" : "text-muted",
                  )}
                >
                  {sub}
                </small>
              ) : null}
            </button>
          </Popover>
        );
      })}
      {nowMin !== null ? (
        <>
          <span aria-hidden className="absolute top-0 -ml-px h-[58px] w-0.5 rounded-[1px] bg-text" style={{ left: `${axis.at(nowMin)}%` }} />
          <span
            className={cx(
              "absolute top-[60px] h-5 whitespace-nowrap rounded-[10px] bg-text px-2 text-micro font-extrabold leading-5 text-panel tabular-nums",
              /* у края шкалы подпись прижимается внутрь, а не уходит за обрез панели */
              axis.at(nowMin) > 92 ? "-translate-x-full" : axis.at(nowMin) < 8 ? "" : "-translate-x-1/2",
            )}
            style={{ left: `${axis.at(nowMin)}%` }}
          >
            {fill(ut("dayA.nowAt"), { t: hhmm(now!) })}
          </span>
        </>
      ) : null}
    </div>
  );
}
