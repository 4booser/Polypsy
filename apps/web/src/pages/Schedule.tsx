import { useEffect, useRef, useState } from "react";
import type { AppointmentView } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dayKey, locale } from "../format";
import { Callout, Drawer, DrawerPane, DrawerSection, Loading, Screen, useAction, useToast } from "../ui";
import { Ic } from "../ui/icons";
import { Page, Panel } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useBookingPane } from "./schedule/Booking";
import { ExceptionFields, ExceptionsPanel, useDayLabel } from "./schedule/Exceptions";
import { G } from "./schedule/glyphs";
import { GoogleSync } from "./schedule/GoogleSync";
import {
  EMPTY_EXCEPTION,
  type ExceptionForm,
  addDays,
  afterAdd,
  clock,
  exceptionProblem,
  mondayOf,
  planDay,
  wallOf,
  weekDates,
  weekProblems,
  weekStats,
} from "./schedule/model";
import { type FreeSlot, MoveSlots } from "./schedule/MoveSlots";
import { QuickWeek, RegularWeek } from "./schedule/RegularWeek";
import { WeekCalendar, type WeekData, weekRange } from "./schedule/WeekCalendar";
import type { BookSlot } from "./schedule/Booking";
import { moveAndReload } from "./visitModel";
import { type Row, WeekEdit } from "./schedule/WeekEdit";

type Pane = "week" | "exception" | "move" | "book";

/** Итог сохранения недели или исключения: числа, а не слово «збережено» */
interface Saved {
  added: number;
  removed: number;
  flagged: number;
  at: number;
}

const sameRows = (a: readonly Row[], b: readonly Row[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Расписание специалиста: неделя календарём, обычная неделя, исключения.
 *
 * Неделю читают картиной — «во вторник у меня трое, в пятницу один поза
 * розкладом», — поэтому главное место у календаря: часы приёма полосами,
 * исключения фоном, приёмы блоками с подробностями на наведении, свободные
 * окна — пунктиром. Главное действие экрана — записать пациента: нажатием на
 * свободное окно или кнопкой в шапке (ящик «Записати пацієнта»,
 * schedule/Booking.tsx; без права вести приёмы ни кнопки, ни окон).
 *
 * Правят расписание в ящике: обычную неделю — целиком и одним сохранением
 * (сервер принимает её только так: PUT стирает все шаблоны специалиста и
 * кладёт присланные заново, а сетка на восемь недель вперёд пересобирается
 * одним проходом) — по дням или одним рядком; исключение — одной формой.
 *
 * Правило, которое экран обязан донести до нажатия: занятое время, выпавшее
 * из часов, не исчезает — приём становится «поза розкладом», и перенести его
 * или оставить решает человек. Об этом сказано в ящике правки и в итоге
 * сохранения — с переходом к таким приёмам.
 */
export default function SchedulePage() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const toast = useToast();
  const { can, user } = useAuth();
  /* одно право на всё, что делается с чужой записью: перенести и записать */
  const canMove = can("appointments.manage");
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const res = useResource(() => api.schedule(), [], { manual: true });
  const server = res.data?.templates.map(({ id: _id, ...rest }) => rest) ?? null;

  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    if (res.data) setRows(res.data.templates.map(({ id: _id, ...rest }) => rest));
  }, [res.data]);

  const [from, setFrom] = useState(() => mondayOf(dayKey(new Date().toISOString())));
  const week = useResource(() => api.scheduleWeek(from), [from]);
  const thisWeek = week.data ? mondayOf(week.data.today) : mondayOf(dayKey(new Date().toISOString()));

  /* «сейчас» сдвигается раз в минуту: линия «зараз» и следующий приём */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("week");
  const show = (p: Pane) => {
    setPane(p);
    setOpen(true);
  };

  const [saved, setSaved] = useState<Saved | null>(null);
  /* «Скласти тиждень одним рядком» — раскрывается в ящике правки, нужен он редко */
  const [quick, setQuick] = useState(false);
  const [form, setForm] = useState<ExceptionForm>(EMPTY_EXCEPTION);
  const [moving, setMoving] = useState<AppointmentView | null>(null);
  const [slot, setSlot] = useState<FreeSlot | null>(null);
  /* окна переноса перечитываются заново после отказа: занятое окно не должно стоять выбранным */
  const [slotsRev, setSlotsRev] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const dayLabel = useDayLabel();

  const reloadAll = () => {
    res.reload();
    week.reload();
  };

  const booking = useBookingPane({
    specialistId: week.data?.specialistId ?? user?.id ?? "",
    tz: week.data?.tz ?? "Europe/Kyiv",
    onBooked: week.reload,
    onDone: () => setOpen(false),
  });
  const book = (slot: BookSlot | null) => {
    booking.start(slot);
    show("book");
  };

  /*
   * Итог показывается числами, а не словом «сохранено»: правка тихо
   * переписывает сетку на два месяца вперёд, и человеку важно ровно одно —
   * сколько занятого времени оказалось вне расписания. Без этого числа он
   * узнает о чужом выпавшем приёме от пациента.
   */
  const saveWeek = (next: Row[]) =>
    run(async () => {
      const r = await api.saveSchedule(next);
      setSaved({ ...r, at: Date.now() });
      setOpen(false);
      reloadAll();
      return r;
    }, ut("sched.saved"));

  /* «Показати поза розкладом»: неделя первого такого приёма впереди, сам приём — обведён */
  const showOff = () =>
    run(async () => {
      const today = week.data?.today ?? dayKey(new Date().toISOString());
      /* весь горизонт записи: дальше него приёмов нет, ближе — может не найтись */
      const ahead = await api.scheduleWeek(today, (res.data?.horizonWeeks ?? 8) * 7);
      const first = ahead.appointments.find(
        (a) => a.offSchedule && ["booked", "confirmed", "arrived", "in_progress"].includes(a.status),
      );
      if (!first) {
        toast(ut("v2s.noOff"), "info");
        return false;
      }
      setFrom(mondayOf(wallOf(first.startsAt, ahead.tz).date));
      setFocusId(first.id);
      calendarRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });

  const rowsDirty = rows !== null && server !== null && !sameRows(rows, server);
  const invalid = rows !== null && weekProblems(rows).size > 0;
  const formDirty = form.date !== "" || form.from !== "" || form.to !== "" || form.note !== "";
  const formProblem = exceptionProblem(form);

  return (
    <Screen res={res} rows={6}>
      {(data) => (
        <Page
          title={ut("sched.title")}
          meta={[
            ut("v2s.weekOf").replace("{range}", weekRange(from, addDays(from, 6), false)),
            ut("sched.horizon").replace("{weeks}", String(data.horizonWeeks)),
          ]}
          /*
            В шапке — запись и правка недели; исключение заводится из своей
            панели («Додати»): третья кнопка не помещалась в строку на 1280.
          */
          actions={
            <>
              <Button
                variant={canMove ? "secondary" : "primary"}
                icon={<Ic.pen />}
                onClick={() => show("week")}
                aria-expanded={open && pane === "week"}
              >
                {ut("sched.edit")}
              </Button>
              {canMove ? (
                <Button variant="primary" icon={<G.calendarPlus />} onClick={() => book(null)} aria-expanded={open && pane === "book"}>
                  {ut("v2s.book")}
                </Button>
              ) : null}
            </>
          }
        >
          {saved ? (
            <Callout
              kind="good"
              role="status"
              className="mb-4"
              title={ut("v2s.savedAt").replace(
                "{time}",
                new Date(saved.at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
              )}
              actions={
                saved.flagged > 0 ? (
                  <Button size="xs" disabled={busy} onClick={() => void showOff()}>
                    {ut("v2s.showOff")}
                  </Button>
                ) : undefined
              }
            >
              {ut("sched.result")
                .replace("{added}", String(saved.added))
                .replace("{removed}", String(saved.removed))
                .replace("{flagged}", String(saved.flagged))}
              {". "}
              {ut("sched.offNote")}
            </Callout>
          ) : null}

          <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_360px] max-[1360px]:grid-cols-[minmax(0,1fr)_330px] max-[1100px]:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-4" ref={calendarRef}>
              <Panel title={ut("v2s.week")} icon={<Ic.calendar />} sub={canMove ? ut("v2s.weekHint") : undefined} flush>
                <WeekNav
                  from={from}
                  current={from === thisWeek}
                  onStep={(d) => {
                    setFocusId(null);
                    setFrom(addDays(from, d * 7));
                  }}
                  onToday={() => {
                    setFocusId(null);
                    setFrom(thisWeek);
                  }}
                />
                {week.data && week.data.from === from ? (
                  <WeekBody
                    week={week.data}
                    /* календарь — по сохранённой неделе: несохранённая правка в панели его не двигает */
                    templates={server ?? []}
                    now={now}
                    focusId={focusId}
                    canMove={canMove}
                    onMove={(a) => {
                      setMoving(a);
                      setSlot(null);
                      show("move");
                    }}
                    onBook={book}
                  />
                ) : (
                  <div className="px-4 pb-4">
                    <Loading rows={6} error={week.error} onRetry={week.reload} busy={week.loading} />
                  </div>
                )}
              </Panel>
              <GoogleSync />
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <RegularWeek rows={server ?? []} onEdit={() => show("week")} />
              <ExceptionsPanel
                items={data.exceptions}
                busy={busy}
                onAdd={() => show("exception")}
                onRemove={(e) =>
                  void run(async () => {
                    await api.removeScheduleException(e.id);
                    reloadAll();
                  }, ut("v2s.excRemoved").replace("{day}", dayLabel(e.date)))
                }
              />
            </div>
          </div>

          <Drawer
            open={open}
            mode={pane}
            wide={pane === "week"}
            onClose={() => setOpen(false)}
            onReturn={(m) => show((m as Pane) ?? "week")}
          >
            <DrawerPane
              mode="week"
              title={ut("sched.week")}
              icon={<G.calendarRange />}
              dirty={rowsDirty}
              draftName={ut("v2s.draftWeek")}
              note={ut("v2s.weekSaveNote")}
              noteIcon={<Ic.users />}
              footer={
                <>
                  <Button
                    variant="primary"
                    disabled={busy || rows === null || invalid}
                    onClick={() => void saveWeek(rows ?? [])}
                  >
                    {ut("sched.save")}
                  </Button>
                  <Button
                    onClick={() => {
                      // отказ возвращает то, что на сервере, а не то, что успели натыкать
                      setRows(server ?? []);
                      setOpen(false);
                    }}
                  >
                    {ut("sched.cancelEdit")}
                  </Button>
                </>
              }
            >
              <DrawerSection>
                {/*
                  Занятое время вне расписания не исчезает при сужении часов, и
                  написано это здесь, до кнопки, а не в справке: сузить часы
                  задним числом — самый вероятный способ молча отменить чужой
                  приём, и человек должен знать, что этого не произойдёт.
                */}
                <Callout kind="info" className="mb-4">
                  {ut("sched.offNote")}
                </Callout>
                <div className="mb-4">
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={quick}
                    iconEnd={<Ic.chevronDown className={quick ? "rotate-180" : undefined} />}
                    onClick={() => setQuick((v) => !v)}
                  >
                    {ut("sched.simple")}
                  </Button>
                  {quick ? (
                    <div className="mt-2">
                      {/* рядок заполняет правку ниже, а не сохраняет: сохраняет «Зберегти тиждень» */}
                      <QuickWeek
                        onBuild={(next) => {
                          setRows(next);
                          setQuick(false);
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                {rows ? <WeekEdit rows={rows} onChange={setRows} /> : null}
              </DrawerSection>
            </DrawerPane>

            <DrawerPane
              mode="exception"
              title={ut("v2s.newException")}
              sub={ut("v2s.newExceptionSub")}
              icon={<G.calendarX />}
              dirty={formDirty}
              draftName={ut("v2s.draftException")}
              note={ut(form.kind === "off" ? "v2s.excNoteOff" : "v2s.excNoteExtra")}
              noteIcon={<Ic.lock />}
              footer={
                <>
                  <Button
                    variant="primary"
                    disabled={busy || formProblem !== null}
                    onClick={async () => {
                      const sent = form;
                      const ok = await run(async () => {
                        const r = await api.addScheduleException({
                          date: sent.date,
                          kind: sent.kind,
                          startsAt: sent.from || null,
                          endsAt: sent.to || null,
                          note: sent.note || null,
                        });
                        setSaved({ added: r.added, removed: r.removed, flagged: r.flagged, at: Date.now() });
                        reloadAll();
                      }, ut("v2s.excAdded").replace("{day}", dayLabel(sent.date)));
                      /* стирается только принятое: отказ оставляет набранное для правки и повтора */
                      setForm((f) => (f === sent ? afterAdd(f, ok) : f));
                      if (ok) setOpen(false);
                    }}
                  >
                    {ut("sched.addException")}
                  </Button>
                  <Button onClick={() => setOpen(false)}>{ut("visit.cancel")}</Button>
                </>
              }
            >
              <DrawerSection>
                <ExceptionFields form={form} set={(patch) => setForm((f) => ({ ...f, ...patch }))} />
              </DrawerSection>
            </DrawerPane>

            <DrawerPane
              mode="move"
              title={moving ? ut("v2s.moveTitle").replace("{name}", moving.patientName) : ut("v2s.move")}
              sub={moving && week.data ? moveSub(moving, week.data.tz, ut, dayLabel) : undefined}
              icon={<G.calendarClock />}
              tone={moving?.offSchedule ? "warn" : "violet"}
              footer={
                <>
                  <Button
                    variant="primary"
                    icon={<G.calendarCheck />}
                    disabled={busy || !moving || !slot}
                    onClick={() => {
                      if (!moving || !slot || !week.data) return;
                      const tz = week.data.tz;
                      const w = wallOf(slot.startsAt, tz);
                      void run(
                        async () => {
                          try {
                            /*
                             * Перечитывается и на отказе (#178): приём уже перенёс
                             * коллега (409), он начался или окно заняли — неделя на
                             * экране устарела, а окна переноса — тоже.
                             */
                            await moveAndReload(() => api.rescheduleAppointment(moving.id, slot.id), week.reload);
                          } catch (e) {
                            setSlot(null);
                            setSlotsRev((n) => n + 1);
                            throw e;
                          }
                          setOpen(false);
                          setMoving(null);
                          setSlot(null);
                          setFocusId(null);
                        },
                        ut("v2s.moved").replace("{when}", `${dayLabel(w.date)}, ${clock(w.minutes)}`),
                      );
                    }}
                  >
                    {ut("v2s.moveDo")}
                  </Button>
                  <Button onClick={() => setOpen(false)}>{ut("visit.cancel")}</Button>
                </>
              }
            >
              {moving && week.data ? (
                <>
                  <DrawerSection title={ut("v2s.moveWhat")}>
                    <p className="m-0 text-small text-text-2">
                      {ut(moving.offSchedule ? "v2s.moveWhyOff" : "v2s.moveWhy")}
                    </p>
                  </DrawerSection>
                  <DrawerSection title={ut("v2s.moveNew")} sub={ut("v2s.moveNewSub")}>
                    <MoveSlots key={slotsRev} specialistId={moving.specialistId} tz={week.data.tz} picked={slot} onPick={setSlot} />
                  </DrawerSection>
                </>
              ) : null}
            </DrawerPane>

            <DrawerPane {...booking.pane} />
          </Drawer>

        </Page>
      )}
    </Screen>
  );
}

type Ut = ReturnType<typeof useLang>["ut"];

function moveSub(a: AppointmentView, tz: string, ut: Ut, dayLabel: (d: string) => string): string {
  const w = wallOf(a.startsAt, tz);
  const when = `${dayLabel(w.date)}, ${clock(w.minutes)}`;
  return a.offSchedule ? `${when}, ${ut("v2s.offShort")}` : when;
}

/** Строка навигации: назад, неделя, вперёд, «Цей тиждень» */
function WeekNav({
  from,
  current,
  onStep,
  onToday,
}: {
  from: string;
  current: boolean;
  onStep: (d: -1 | 1) => void;
  onToday: () => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <Button size="icon-sm" icon={<Ic.chevronLeft />} aria-label={ut("v2s.prevWeek")} title={ut("v2s.prevWeek")} onClick={() => onStep(-1)} />
      <span className="px-1 text-[16px] font-extrabold leading-5 tracking-[-0.015em] text-text">
        {weekRange(from, addDays(from, 6), true)}
      </span>
      <Button size="icon-sm" icon={<Ic.chevronRight />} aria-label={ut("v2s.nextWeek")} title={ut("v2s.nextWeek")} onClick={() => onStep(1)} />
      <Button size="xs" variant="ghost" disabled={current} onClick={onToday}>
        {ut("v2s.thisWeek")}
      </Button>
    </div>
  );
}

/** Строка чисел недели, сам календарь и легенда */
function WeekBody({
  week,
  templates,
  now,
  focusId,
  canMove,
  onMove,
  onBook,
}: {
  week: WeekData;
  templates: Row[];
  now: number;
  focusId: string | null;
  canMove: boolean;
  onMove: (a: AppointmentView) => void;
  /** Записать пациента в свободное окно — нажатием в календаре */
  onBook: (slot: BookSlot) => void;
}) {
  const { ut } = useLang();
  const plans = weekDates(week.from).map((d) => planDay(d, templates, week.exceptions));
  const st = weekStats(plans, week.appointments, week.slots, week.to, now, week.tz);
  const num = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 });
  const firstOff = week.appointments.find(
    (a) => a.offSchedule && ["booked", "confirmed", "arrived", "in_progress"].includes(a.status),
  );
  const part = (key: Parameters<Ut>[0], values: Record<string, string | number>) => {
    const text = ut(key);
    return text.split(/(\{\w+\})/).map((piece, i) => {
      const m = /^\{(\w+)\}$/.exec(piece);
      return m && m[1]! in values ? (
        <b key={i} className="text-[15px] font-extrabold tabular-nums text-text">
          {values[m[1]!]}
        </b>
      ) : (
        piece
      );
    });
  };

  return (
    <>
      <div className="flex flex-wrap gap-x-[22px] gap-y-1.5 border-t border-divider px-4 py-3 text-small text-text-2">
        <span>{part("v2s.statHours", { n: num.format(st.hours) })}</span>
        {st.windows ? (
          <span>
            {part("v2s.statTaken", { n: st.taken, m: st.windows, p: Math.round((st.taken / st.windows) * 100) })}
          </span>
        ) : null}
        {st.ahead ? <span>{part("v2s.statFree", { n: st.free })}</span> : null}
        {st.off && firstOff ? (
          <button
            type="button"
            disabled={!canMove}
            onClick={() => onMove(firstOff)}
            className="cursor-pointer border-0 bg-transparent p-0 text-small font-semibold text-warn hover:underline disabled:cursor-default disabled:no-underline [&_b]:text-warn"
          >
            {part("v2s.statOff", { n: st.off })}
          </button>
        ) : null}
      </div>
      <WeekCalendar week={week} plans={plans} now={now} focusId={focusId} onMove={canMove ? onMove : null} onBook={canMove ? onBook : null} />
      <Legend free={canMove} />
    </>
  );
}

/** Легенда: каждый вид блока словом — цвет не единственный признак */
function Legend({ free }: { free: boolean }) {
  const { ut } = useLang();
  const items: [string, string][] = [
    ["bg-sunk shadow-[inset_0_0_0_1px_var(--border)]", ut("v2s.lgHours")],
    ...(free ? ([["border border-dashed border-violet-line", ut("v2s.lgFree")]] as [string, string][]) : []),
    ["bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]", ut("v2s.lgBooked")],
    ["bg-panel shadow-[inset_0_0_0_1px_var(--border)]", ut("v2s.lgDone")],
    ["bg-warn-tint", ut("v2s.lgNoShow")],
    ["bg-panel shadow-[inset_0_0_0_1.5px_var(--warn)]", ut("v2s.lgOff")],
    ["bg-good-tint shadow-[inset_0_0_0_1.5px_var(--goodline)]", ut("sched.excExtra")],
    ["bg-panel shadow-[inset_0_0_0_1.5px_var(--ctl)]", ut("sched.excOff")],
  ];
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-divider px-4 pb-3.5 pt-2.5 text-caption font-semibold text-text-2">
      {items.map(([swatch, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <i aria-hidden className={`block h-3 w-3.5 rounded ${swatch}`} />
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <G.video size={13} />
        {ut("v2s.lgOnline")}
      </span>
    </div>
  );
}
