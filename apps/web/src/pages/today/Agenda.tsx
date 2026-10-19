import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AppointmentView } from "@quizzy/shared";
import { day } from "../../format";
import { KbdHints } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { TextAction } from "../../ui/records";
import { useLang } from "../../lang";
import { fill, withCount } from "../dashboard/model";
import { moveOf, rowActions, SLOTS, STATUS_KEY, type Move } from "./actions";
import { Di } from "./icons";
import { hhmm, nowIndex, readiness, splitDuration, type CellTone, type Clash, type SessionState } from "./model";
import { DayStrip } from "./strip";

/**
 * «Прийом сьогодні»: шкала дня и сессии таймлайном с готовностью.
 *
 * День показывается целиком, включая принятых: убери отработанных — и
 * специалист потеряет возможность вернуться к предыдущему приёму, а картина
 * дня превратится в убывающую очередь, по которой не видно, сколько сделано.
 * Строка «Зараз» стоит между прошедшим и будущим.
 */
export function Agenda({
  date,
  items,
  states,
  clash,
  now,
  selectedId,
  onSelect,
  busy,
  onStatus,
  onLead,
  nowNote,
  hints,
}: {
  date: string;
  items: AppointmentView[];
  states: ReadonlyMap<string, SessionState>;
  clash: ReadonlyMap<string, Clash>;
  now: number | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
  onStatus: (a: AppointmentView, to: Move) => void;
  onLead: (a: AppointmentView) => void;
  /** Что успеть до следующей сессии — строка «Зараз» */
  nowNote: ReactNode;
  hints: [string, string][];
}) {
  const { ut, lang } = useLang();
  const alive = items.filter((a) => a.status !== "cancelled");
  const done = alive.filter((a) => a.status === "done").length;
  const ahead = alive.filter((a) => states.get(a.id) === "next" || states.get(a.id) === "later" || states.get(a.id) === "here").length;
  const rooms = [...new Set(alive.filter((a) => a.mode !== "remote" && a.room).map((a) => `${ut("day.room")} ${a.room}`))];
  const remote = alive.some((a) => a.mode === "remote");
  const where = [...rooms, ...(remote ? [ut("dayA.online")] : [])].join(", ");
  const at = now === null ? -1 : nowIndex(items, now);
  const last = items.length ? items[items.length - 1]! : null;

  return (
    <Panel
      title={now === null ? fill(ut("dayA.dayOf"), { d: day(date) }) : ut("dayA.dayTitle")}
      icon={<Di.calendarClock />}
      sub={
        <>
          {withCount(ut("dayA.sessionsN"), alive.length, lang)}
          {where ? `, ${where}` : ""}
        </>
      }
      actions={<TextAction to="/my-schedule">{ut("dayA.inSchedule")}</TextAction>}
      flush
    >
      {items.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-small text-muted">{ut("day.nobody")}</p>
      ) : (
        <>
          <DayStrip items={items} states={states} clash={clash} now={now} selectedId={selectedId} onSelect={onSelect} />
          <div role="list" aria-label={ut("dayA.sessionsList")} className="border-t border-divider pb-1.5 pt-0.5">
            {items.map((a, i) => (
              <Fragment key={a.id}>
                {i === at ? <NowRow now={now!} note={nowNote} first={i === 0} /> : null}
                <AppointmentRow
                  a={a}
                  busy={busy}
                  state={states.get(a.id)}
                  clash={clash.get(a.id)}
                  now={now}
                  selected={selectedId === a.id}
                  onSelect={onSelect}
                  first={i === 0 && at !== 0}
                  onStatus={(to) => onStatus(a, to)}
                  onLead={() => onLead(a)}
                />
              </Fragment>
            ))}
            {at === items.length ? <NowRow now={now!} note={nowNote} first={false} /> : null}
            {last ? (
              <div role="listitem" className="relative mx-2 grid grid-cols-[52px_24px_minmax(0,1fr)] gap-x-2.5 gap-y-0 py-3 pl-2 pr-3">
                <span className="text-[15px] font-extrabold leading-5 text-muted tabular-nums">{hhmm(last.endsAt)}</span>
                <Node kind="end" last />
                <span className="text-small font-semibold text-muted">
                  {done || ahead ? fill(ut("dayA.endOfDay"), { done, ahead }) : ut("dayA.endOfDayPlain")}
                </span>
              </div>
            ) : null}
          </div>
        </>
      )}
      <KbdHints bar keys={hints} />
    </Panel>
  );
}

/** Узел на линии таймлайна */
function Node({
  kind,
  first,
  last,
  className,
}: {
  kind: SessionState | "end" | "now";
  first?: boolean;
  last?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={cx("relative flex justify-center", className)}>
      <span
        className={cx(
          "absolute left-[11px] w-0.5 bg-divider",
          first ? "top-2.5" : "-top-3",
          last ? "h-[22px]" : "-bottom-3",
        )}
      />
      {kind === "end" ? (
        <i className="relative mt-[5px] size-2.5 rounded-full bg-control" />
      ) : kind === "now" ? (
        <i className="relative mt-0 size-3 rounded-full bg-text shadow-[0_0_0_3px_var(--panel)]" />
      ) : (
        <i
          className={cx(
            "relative mt-px grid size-[18px] place-items-center rounded-full",
            kind === "done" && "bg-good-tint text-good",
            (kind === "next" || kind === "here") && "bg-violet shadow-[0_0_0_3px_var(--vtint2)]",
            kind === "noshow" && "bg-warn-tint text-warn",
            kind === "late" && "bg-panel shadow-[inset_0_0_0_2px_var(--warn)]",
            kind === "later" && "bg-panel shadow-[inset_0_0_0_2px_var(--ctl)]",
          )}
        >
          {kind === "done" ? <Ic.check size={12} /> : kind === "noshow" ? <Di.userX size={11} /> : null}
        </i>
      )}
    </span>
  );
}

function NowRow({ now, note, first }: { now: number; note: ReactNode; first: boolean }) {
  return (
    <div role="listitem" className="relative mx-2 grid grid-cols-[52px_24px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0 py-1.5 pl-2 pr-3">
      <span className="inline-grid h-6 w-[50px] place-items-center rounded-[12px] bg-text text-caption font-extrabold leading-none text-panel tabular-nums">
        {hhmm(now)}
      </span>
      <Node kind="now" first={first} />
      <div className="flex min-h-10 items-center gap-2.5 rounded-[12px] px-3 py-2 text-small text-text-2 shadow-[inset_0_0_0_1.5px_var(--ctl)]">
        <Di.clock size={15} className="text-muted" />
        <span className="min-w-0">{note}</span>
      </div>
    </div>
  );
}

const CELL_ICON: Record<CellTone, string> = {
  ok: "text-good",
  new: "text-violet-ink",
  miss: "text-warn",
  none: "text-muted",
  risk: "text-risk-ink",
};

/**
 * Готовность к сессии клетками: заміри, запис, привід — из данных дня, без
 * запросов. Та же разметка в строке таймлайна и в закрытой подготовке.
 */
export function ReadinessCells({ a, selected = false, stacked = false }: { a: AppointmentView; selected?: boolean; stacked?: boolean }) {
  const { ut } = useLang();
  return (
    <div className={cx("grid gap-1.5", stacked ? "grid-cols-1" : "grid-cols-3 max-[760px]:grid-cols-1")}>
      {readiness(a).map((c) => (
        <div
          key={c.key}
          className={cx("flex min-w-0 items-start gap-2 rounded-control px-2.5 pb-[9px] pt-2 text-small leading-[17px] text-text-2", selected ? "bg-panel" : "bg-sunk")}
        >
          <span className={cx("mt-px inline-flex", CELL_ICON[c.tone])}>
            {c.key === "measures" ? <Di.clipboardCheck size={14} /> : c.key === "booking" ? <Di.calendarClock size={14} /> : <Ic.message size={14} />}
          </span>
          <span className="min-w-0">
            <span className="block text-[11.5px] font-bold leading-[15px] text-muted">
              {ut(c.key === "measures" ? "dayA.cellMeasures" : c.key === "booking" ? "dayA.cellBooking" : "day.reason")}
            </span>
            {c.key === "reason" && a.reason ? (
              <span className="line-clamp-2 text-text">{a.reason}</span>
            ) : c.text.key === "day.pending" ? (
              <>
                {ut("day.pending")} <b className="font-extrabold text-text">{c.text.n}</b>
              </>
            ) : c.text.at ? (
              fill(ut(c.text.key as never), { t: hhmm(c.text.at), d: day(c.text.at) })
            ) : (
              ut(c.text.key as never)
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Часы стены: минута — достаточно для «через 30 хв» и таймера нормы */
export function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

/** «через 30 хв», «через 2 год» — до начала сессии */
export function useUntil() {
  const { ut } = useLang();
  return (minutes: number) => {
    const { h, m } = splitDuration(minutes);
    if (h === 0) return fill(ut("dayA.inMin"), { m: Math.max(1, m) });
    return m === 0 || h >= 3 ? fill(ut("dayA.inHours"), { h }) : fill(ut("dayA.inHoursMin"), { h, m });
  };
}

/**
 * Строка сессии.
 *
 * Признак data-appointment — опора смоука (e2e/helpers.ts dayRow): день
 * общий, и проверке нужна СВОЯ строка, а искать её по имени нельзя — тёзки
 * в списке обычное дело. Классы менять можно, признак — нет.
 *
 * Время ведёт на экран приёма (с него начинается работа), имя — в карту.
 * Справа — столбец действий с закреплёнными местами (actions.ts, SLOTS):
 * «Прийшов» у записанного и у неявки стоят на одном отступе.
 */
export function AppointmentRow({
  a,
  busy,
  onStatus,
  onLead,
  state,
  clash,
  now = null,
  selected = false,
  onSelect,
  first = false,
}: {
  a: AppointmentView;
  busy: boolean;
  onStatus: (to: Move) => void;
  onLead: () => void;
  state?: SessionState;
  clash?: Clash;
  now?: number | null;
  selected?: boolean;
  onSelect?: (id: string) => void;
  first?: boolean;
}) {
  const { ut } = useLang();
  const until = useUntil();
  const acts = rowActions(a.status);
  const s: SessionState = state ?? (a.status === "done" ? "done" : a.status === "no_show" ? "noshow" : "later");
  const past = s === "done" || s === "noshow";
  const start = Date.parse(a.startsAt);
  const conflict = clash && !past;

  /* что сказать о сессии справа: состояние словом, а у ждущей — сколько до неё */
  const pill =
    s === "done" ? (
      <Tag tone="good" icon={<Ic.check />}>
        {ut(STATUS_KEY.done)}
      </Tag>
    ) : s === "noshow" ? (
      <Tag tone="attention" icon={<Di.userX />}>
        {ut(STATUS_KEY[a.status])}
      </Tag>
    ) : s === "here" ? (
      <Tag tone="primary" icon={<Di.logIn />}>
        {ut(STATUS_KEY[a.status])}
      </Tag>
    ) : s === "late" ? (
      <Tag tone="attention" icon={<Di.clockAlert />}>
        {ut("dayA.notMarked")}
      </Tag>
    ) : now !== null && start > now ? (
      <Tag tone={s === "next" ? "primary" : "done"} icon={<Di.clock />}>
        {until((start - now) / 60_000)}
      </Tag>
    ) : (
      <Tag tone="done">{ut(STATUS_KEY[a.status])}</Tag>
    );

  return (
    <div
      data-appointment={a.id}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("a,button")) onSelect?.(a.id);
      }}
      className={cx(
        "relative mx-2 grid grid-cols-[52px_24px_minmax(0,1fr)_auto] content-start gap-x-2.5 gap-y-0 rounded-[14px] py-3 pl-2 pr-3 max-[1100px]:grid-cols-[52px_24px_minmax(0,1fr)]",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
        onSelect && "cursor-pointer",
        selected ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-panel-2",
      )}
    >
      <Link
        to={`/visit/${a.id}`}
        className="row-span-4 block self-start rounded-[6px] text-[15px] font-extrabold leading-5 tracking-[-0.01em] text-text no-underline hover:underline"
      >
        <span className={past ? "text-text-2" : undefined}>{hhmm(a.startsAt)}</span>
        <small className="block text-caption font-semibold leading-4 text-muted">{hhmm(a.endsAt)}</small>
      </Link>
      <Node kind={conflict && s === "later" ? "late" : s} first={first} className="row-span-4" />
      <div className="col-start-3 row-start-1 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          to={`/patients/${a.patientId}`}
          className={cx(
            "truncate text-[14.5px] leading-5 tracking-[-0.01em] no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]",
            past ? "font-bold text-text-2" : "font-extrabold text-text",
          )}
        >
          {a.patientName}
        </Link>
        <span className="text-small font-semibold text-text-2">{ut(a.kind === "primary" ? "day.primary" : "day.repeat")}</span>
        {a.mode === "remote" ? (
          <span className="inline-flex h-6 items-center gap-[5px] rounded-[12px] bg-info-tint pl-[7px] pr-[9px] text-[11.5px] font-bold text-info">
            <Di.video size={12} />
            {ut("dayA.online")}
          </span>
        ) : a.room ? (
          <span className={cx("inline-flex h-6 items-center gap-[5px] rounded-[12px] pl-[7px] pr-[9px] text-[11.5px] font-bold text-text-2", selected ? "bg-panel" : "bg-sunk")}>
            <Di.door size={12} className="text-muted" />
            {ut("day.room")} {a.room}
          </span>
        ) : null}
      </div>

      {/*
        Пометки, которые требуют действия до приёма. «Не підтвердив» — не
        упрёк, а рабочий признак: по нему видно, кому стоит позвонить до
        того, как слот пропадёт впустую. Без ведущего — факт, который иначе
        пришлось бы искать; кнопка рядом закрывает его.
      */}
      <div className="col-[3/5] row-start-2 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small text-text-2 max-[1100px]:col-[3/4]">
          {pill}
          {a.status === "booked" ? <Tag tone="attention">{ut("day.unconfirmed")}</Tag> : null}
          {a.offSchedule ? <Tag tone="attention">{ut("day.offSchedule")}</Tag> : null}
          {conflict ? (
            <Tag tone="attention" icon={<Di.calendarClock />}>
              {fill(ut("dayA.clashTag"), { from: hhmm(clash!.from), to: hhmm(clash!.to) })}
            </Tag>
          ) : null}
          {a.leadSpecialistId === null ? (
            <span className="inline-flex items-center gap-1.5">
              <Tag>{ut("day.noLead")}</Tag>
              <Button size="xs" variant="ghost" onClick={onLead} disabled={busy}>
                {ut("day.takeLead")}
              </Button>
            </span>
          ) : null}
      </div>

      <div className="col-[3/5] row-start-3 mt-2.5 max-[1100px]:col-[3/4]">
        <ReadinessCells a={a} selected={selected} />
      </div>

      {/*
        Места столбца действий: слева — уход с хода («Не прийшов», шаг
        назад), справа — ход дальше. Место остаётся и пустым: именно оно
        делает столбец столбцом. Ширина задана числом, а не надписью —
        иначе «Завершити» и «Прийшов» разъехались бы по строкам.
      */}
      <div className="col-start-4 row-start-1 flex shrink-0 items-start gap-2 max-[1100px]:col-start-3 max-[1100px]:row-start-4 max-[1100px]:mt-2.5">
        {SLOTS.map((slot) => {
          const act = acts[slot];
          return (
            /* data-slot — опора для проверки: классы менять можно, признак мест нет */
            <div key={slot} data-slot={slot} className="w-[96px]">
              {act ? (
                <Button
                  size="xs"
                  variant={act.quiet ? "ghost" : slot === "step" ? "secondary" : "ghost"}
                  className="w-full"
                  onClick={() => {
                    const to = moveOf(act, (question) => window.confirm(ut(question)));
                    if (to) onStatus(to);
                  }}
                  disabled={busy}
                >
                  {ut(act.key)}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
