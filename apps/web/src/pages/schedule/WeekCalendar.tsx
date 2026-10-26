import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { AppointmentView } from "@quizzy/shared";
import type { api } from "../../api";
import { locale } from "../../format";
import { Popover } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { useLang } from "../../lang";
import { STATUS_KEY } from "../visitModel";
import type { BookSlot } from "./Booking";
import { G } from "./glyphs";
import {
  type ApptLook,
  type DayPlan,
  apptLook,
  clock,
  hourRange,
  movable,
  nextToday,
  placeDay,
  wallOf,
  weekdayOf,
} from "./model";
import { SHORT_KEY } from "./WeekEdit";

export type WeekData = Awaited<ReturnType<typeof api.scheduleWeek>>;

/** Высота часа, px: 50-минутный приём — две строки, время и фамилия */
const PH = 42;
/** Столбец часов слева */
const AXIS = 52;

/**
 * «Гончаренко Т.І.» — фамилия и инициалы для блока приёма: в колонке дня на
 * 1280 полное имя обрезалось до «Гончаренко …». Инициалы — без пробела между
 * ними, как в табличной записи: с пробелами десятибуквенная фамилия в блок
 * не входит. Полное имя — в поповере и в подписи для диктора.
 */
export function calendarName(full: string): string {
  const [last = "", ...rest] = full.trim().split(/\s+/);
  const initials = rest.map((w) => `${w[0]}.`).join("");
  return initials ? `${last} ${initials}` : last;
}

/** «12.10» — день и месяц двумя цифрами */
export function dayMonth(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`;
}

/** «5–11 жовтня 2026»: неделя одной строкой по языку консоли */
export function weekRange(from: string, to: string, withYear: boolean): string {
  const at = (d: string) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  const f = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) });
  const a = at(from);
  const b = at(to);
  return typeof f.formatRange === "function" ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
}

const LOOK: Record<ApptLook, string> = {
  done: "bg-panel text-muted shadow-[inset_0_0_0_1px_var(--border)] [&_b]:text-text-2",
  booked: "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]",
  now: "bg-violet text-onfill",
  noShow: "bg-warn-tint text-warn",
  off: "bg-panel text-warn shadow-[inset_0_0_0_1.5px_var(--warn)]",
};

/**
 * Неделя календарём: часы приёма полосами, исключения — фоном, приёмы —
 * блоками; на наведении — подробности, нажатие открывает приём. Свободные
 * окна впереди — пунктиром: нажатие записывает в окно пациента (с правом
 * вести приёмы; без него окон не видно).
 *
 * Исключения стоят под приёмами, а не поверх: «не приймаю» с 14 до 16 —
 * это фон дня, а приём, оставшийся в этих часах, — то, что надо решить, и он
 * должен читаться целиком.
 */
export function WeekCalendar({
  week,
  plans,
  now,
  focusId,
  onMove,
  onBook,
}: {
  week: WeekData;
  plans: DayPlan[];
  now: number;
  /** Приём, к которому перешли «Показати поза розкладом»: обведён */
  focusId: string | null;
  /** Перенести приём; null — переносить нельзя (нет права вести приёмы) */
  onMove: ((a: AppointmentView) => void) | null;
  /** Записать пациента в свободное окно; null — записывать нельзя */
  onBook: ((slot: BookSlot) => void) | null;
}) {
  const { ut } = useLang();
  const tz = week.tz;
  const next = nextToday(week.appointments, tz, week.today, now);
  /* свободные окна впереди — те же, что «вільно до кінця тижня» (weekStats) */
  const taken = new Set(week.appointments.map((a) => a.slotId));
  const free = onBook
    ? week.slots
        .filter((s) => !s.offSchedule && !taken.has(s.id) && Date.parse(s.startsAt) > now)
        .map((s) => {
          const w = wallOf(s.startsAt, tz);
          return { slot: s, date: w.date, start: w.minutes, end: w.minutes + Math.round((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60_000) };
        })
    : [];

  const spans = week.appointments.map((a) => {
    const w = wallOf(a.startsAt, tz);
    const start = w.minutes;
    const end = start + Math.max(10, Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000));
    return { item: a, date: w.date, start, end };
  });
  const [h0, h1] = hourRange(plans, spans);
  const height = (h1 - h0) * PH;
  const y = (minutes: number) => ((minutes - h0 * 60) * PH) / 60;
  const nowWall = wallOf(new Date(now).toISOString(), tz);
  const hours = Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i);
  const cols = `${AXIS}px repeat(7, minmax(0, 1fr))`;

  return (
    <div className="min-w-0">
      {/* шапка дней: день недели, число, «записано з вікон» */}
      <div className="grid border-y border-divider" style={{ gridTemplateColumns: cols }}>
        <div />
        {plans.map((p) => {
          const today = p.date === week.today;
          const taken = spans.filter((s) => s.date === p.date).length;
          return (
            <div key={p.date} className="py-2 text-center text-caption text-muted">
              <span className={cx("block capitalize", today && "font-extrabold text-violet-ink")}>{ut(SHORT_KEY[p.weekday]!)}</span>
              <span
                className={cx(
                  "mx-auto my-0.5 grid size-8 place-items-center rounded-full text-[15px] font-extrabold tabular-nums",
                  today ? "bg-violet text-onfill" : "text-text",
                )}
              >
                {p.date.slice(8, 10)}
              </span>
              <span className={cx("block tabular-nums", today && "font-extrabold text-violet-ink")}>
                {p.windows
                  ? ut("v2s.dayTaken").replace("{n}", String(taken)).replace("{m}", String(p.windows))
                  : taken
                    ? /* приёмы в день без окон по сетке: не «1 з 0», а сколько записано */
                      ut("v2s.dayTakenOnly").replace("{n}", String(taken))
                    : ut("v2s.dayOffShort")}
              </span>
            </div>
          );
        })}
      </div>

      <div className="relative mx-0 mb-2 mt-2.5" style={{ height: height + 6 }}>
        {/* часы: линии через всю неделю и подписи слева */}
        {hours.map((h) => (
          <div key={h} aria-hidden>
            <span className="absolute right-0 h-px bg-divider" style={{ top: y(h * 60), left: AXIS }} />
            <span
              className="absolute left-0 w-11 text-right text-micro font-bold leading-none tabular-nums text-muted"
              style={{ top: y(h * 60) - 5 }}
            >
              {clock(h * 60)}
            </span>
          </div>
        ))}

        <div className="absolute inset-y-0 right-0 grid" style={{ left: AXIS, gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
          {plans.map((p) => {
            const today = p.date === week.today;
            const placed = placeDay(spans.filter((s) => s.date === p.date));
            const noHours = !p.bands.some((b) => b.kind !== "off");
            return (
              <div key={p.date} className={cx("relative border-l border-divider", today && "bg-violet-tint/45")}>
                {p.bands.map((b, i) =>
                  b.kind === "regular" ? (
                    <span
                      key={i}
                      aria-hidden
                      className="absolute inset-x-[3px] rounded-[8px] bg-sunk shadow-[inset_0_0_0_1px_var(--border)]"
                      style={{ top: y(b.from), height: y(b.to) - y(b.from) }}
                    />
                  ) : (
                    <span
                      key={i}
                      className={cx(
                        "absolute inset-x-[3px] overflow-hidden rounded-[8px] border-[1.5px] border-dashed px-1.5 py-1 text-[10.5px] font-bold leading-[13px]",
                        b.kind === "extra" ? "border-good-line bg-good-tint text-good" : "border-control text-muted",
                      )}
                      style={{ top: y(b.from), height: y(b.to) - y(b.from) }}
                    >
                      <span className="flex items-center gap-[3px] whitespace-nowrap">
                        {b.kind === "extra" ? <Ic.plus size={11} /> : <G.calendarX size={11} />}
                        {ut(b.kind === "extra" ? "sched.excExtra" : "sched.excOff")}
                      </span>
                      {b.note ? <span className="block truncate font-semibold">{b.note}</span> : null}
                    </span>
                  ),
                )}
                {noHours ? (
                  <span
                    className="absolute inset-x-1 text-center text-caption leading-[15px] text-muted"
                    style={{ top: Math.max(0, height / 2 - 14) }}
                  >
                    {ut("sched.dayOff")}
                    {p.offAllDay?.note ? <span className="block truncate text-micro">{p.offAllDay.note}</span> : null}
                  </span>
                ) : null}

                {free
                  .filter((f) => f.date === p.date)
                  .map((f) => {
                    const label = ut("v2s.bookAt").replace("{when}", `${ut(SHORT_KEY[p.weekday]!)} ${dayMonth(p.date)}, ${clock(f.start)}`);
                    return (
                      <button
                        key={f.slot.id}
                        type="button"
                        data-free-slot={f.slot.id}
                        aria-label={label}
                        title={label}
                        onClick={() => onBook?.(f.slot)}
                        className={cx(
                          "absolute z-[1] flex cursor-pointer items-start justify-start gap-[3px] overflow-hidden rounded-[7px] border border-dashed border-violet-line bg-transparent px-1 py-1 text-left text-[11px] font-bold leading-[13px] tabular-nums text-muted",
                          "transition-colors duration-[var(--dur-fast)] hover:border-solid hover:bg-violet-tint hover:text-violet-ink",
                          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                        )}
                        style={{ top: y(f.start) + 1.5, height: Math.max(16, y(f.end) - y(f.start) - 3), left: 2, width: "calc(100% - 4px)" }}
                      >
                        <Ic.plus size={11} />
                        {clock(f.start)}
                      </button>
                    );
                  })}

                {placed.map(({ item: a, start, end, col, cols: n }) => (
                  <Appointment
                    key={a.id}
                    a={a}
                    tz={tz}
                    look={apptLook(a, a.id === next)}
                    focused={a.id === focusId}
                    style={{
                      top: y(start) + 1.5,
                      height: Math.max(16, y(end) - y(start) - 3),
                      left: `calc(${(col / n) * 100}% + 2px)`,
                      width: `calc(${100 / n}% - 4px)`,
                    }}
                    compact={y(end) - y(start) < 30}
                    onMove={onMove}
                  />
                ))}

                {today && nowWall.minutes >= h0 * 60 && nowWall.minutes <= h1 * 60 ? (
                  <>
                    <span aria-hidden className="absolute inset-x-0 z-[2] h-0.5 rounded-[1px] bg-text" style={{ top: y(nowWall.minutes) }} />
                    <span aria-hidden className="absolute -left-1 z-[2] size-2 rounded-full bg-text" style={{ top: y(nowWall.minutes) - 3 }} />
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Appointment({
  a,
  tz,
  look,
  focused,
  style,
  compact,
  onMove,
}: {
  a: AppointmentView;
  tz: string;
  look: ApptLook;
  focused: boolean;
  style: CSSProperties;
  compact: boolean;
  onMove: ((a: AppointmentView) => void) | null;
}) {
  const { ut } = useLang();
  const s = wallOf(a.startsAt, tz);
  const e = wallOf(a.endsAt, tz);
  const when = `${ut(SHORT_KEY[weekdayOf(s.date)]!)} ${dayMonth(s.date)}, ${clock(s.minutes)}–${clock(e.minutes)}`;
  const remote = a.mode === "remote";
  const mark =
    look === "off" ? <Ic.alert size={11} /> : look === "noShow" ? <G.userX size={11} /> : remote ? <G.video size={11} /> : null;
  const status = ut(STATUS_KEY[a.status]);
  const details = [
    ut(a.kind === "primary" ? "day.primary" : "day.repeat"),
    remote ? ut("day.remote") : a.room ? `${ut("day.room")} ${a.room}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover
      title={a.patientName}
      note={when}
      width={320}
      side="right"
      content={
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone={look === "noShow" || look === "off" ? "attention" : look === "done" ? "done" : "primary"}>{status}</Tag>
            {details ? <span className="text-small text-text-2">{details}</span> : null}
          </div>
          {a.offSchedule ? <p className="m-0 text-small font-semibold text-warn">{ut("v2s.offScheduleNote")}</p> : null}
          {a.reason ? (
            <p className="m-0 text-small text-text-2">
              <span className="text-muted">{ut("day.reason")}: </span>
              {a.reason}
            </p>
          ) : null}
          {a.pendingAssignments > 0 ? (
            <p className="m-0 text-small text-text-2">{ut("v2s.pendingWork").replace("{n}", String(a.pendingAssignments))}</p>
          ) : null}
        </div>
      }
      actions={
        <>
          <ButtonLink to={`/visit/${a.id}`} size="xs">
            {ut("v2s.openVisit")}
          </ButtonLink>
          {onMove && movable(a) ? (
            <Button size="xs" variant="ghost" icon={<G.calendarClock />} onClick={() => onMove(a)}>
              {ut("v2s.move")}
            </Button>
          ) : null}
        </>
      }
    >
      <Link
        to={`/visit/${a.id}`}
        data-appointment={a.id}
        aria-label={`${a.patientName}, ${when}, ${status}`}
        className={cx(
          "absolute z-[1] block overflow-hidden rounded-[7px] px-1 py-1 text-left text-[11px] font-semibold leading-[13px] no-underline",
          "transition-shadow duration-[var(--dur-fast)] hover:no-underline hover:shadow-[inset_0_0_0_1.5px_var(--vring)]",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
          LOOK[look],
          focused && "outline-2 outline-offset-2 outline-warn",
        )}
        style={style}
      >
        <b className={cx("items-center gap-[3px] font-extrabold tabular-nums", compact ? "mr-1 inline-flex" : "flex")}>
          {clock(s.minutes)}
          {mark}
        </b>
        {/* фамилия с инициалами (calendarName): полное имя — в поповере */}
        <span className={cx("min-w-0 truncate text-[10.5px] font-medium tracking-[-0.02em]", compact ? "" : "block")}>
          {calendarName(a.patientName)}
        </span>
      </Link>
    </Popover>
  );
}
