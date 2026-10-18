import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AlertCase, AppointmentView, Worklist } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dayFull } from "../format";
import { Screen, Tooltip, useAction, useUrlState } from "../ui";
import { cx } from "../ui/cx";
import { Ic } from "../ui/icons";
import { SideLayout } from "../ui/layout";
import { ButtonLink } from "../ui/primitives";
import { useLang } from "../lang";
import { useLiveReload } from "../events";
import { useResource } from "../useResource";
import { moveAndReload } from "./visitModel";
import { StartHead } from "./Start";
import { fill } from "./dashboard/model";
import { ActNow, reviewHref, unlessForbidden } from "./today/ActNow";
import { Agenda, useNow, useUntil } from "./today/Agenda";
import { Between } from "./today/Between";
import { useDayDrawer } from "./today/drawers";
import { Di } from "./today/icons";
import {
  betweenSessions,
  caseTimer,
  clashes,
  focusSession,
  hhmm,
  liveCases,
  localDate,
  overdueWork,
  prepAfterSelect,
  sessionStates,
  shiftDate,
  urgentCases,
} from "./today/model";
import { useCodeKeys } from "./today/keys";
import { Prep } from "./today/Prep";

export { AppointmentRow } from "./today/Agenda";
export { moveOf, rowActions } from "./today/actions";

/**
 * «Сьогодні» — приём дня (затверджений кадр vivid_today, Polypsy 2.0).
 *
 * Сверху — «Дія зараз»: случай риска с таймером нормы и всё открытое о
 * человеке, рядом — остальное срочное. Ниже — «Прийом сьогодні»: шкала дня
 * с «зараз» и сессии таймлайном с готовностью; справа липнет «Підготовка до
 * сесії». Под днём — «Між сесіями»: короткие дела из очереди. Ответ и
 * нотатка открываются в ящике справа, Esc оставляет черновик.
 *
 * Явка отмечается одним нажатием, как и прежде: столбец «Не прийшов /
 * Прийшов → Почати → Завершити» стоит в каждой строке на одном месте.
 */

/* отказ очереди или разбора не прячет день: пустая очередь полной формы */
const NO_WORK: Worklist = {
  items: [],
  total: 0,
  truncated: false,
  byKind: { noshow: 0, message: 0, dispensary: 0, followup: 0, referral: 0, assignment: 0 },
  mine: 0,
};

export default function TodayPage() {
  const [dateParam, setDate] = useUrlState("date");
  const { ut } = useLang();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const wall = useNow();

  const res = useResource(() => api.today(dateParam ? { date: dateParam } : {}), [dateParam]);
  /*
   * Случаи и очередь — своими загрузками: их отказ не должен гасить день, а
   * листание дней — перезапрашивать их. Случаи — отдельно от очереди: «разбор
   * не положен» (403, null) и «не загрузились» (отказ со словами) — разные
   * ответы, и второй не вправе звучать как «нічого термінового».
   */
  const casesRes = useResource(
    () => unlessForbidden(api.alertCases({ status: "open", limit: "20" }).then((p) => p.items)),
    [],
  );
  const workRes = useResource(() => api.worklist().catch((): Worklist => NO_WORK), []);
  const reloadDay = res.reload;
  const reloadCases = casesRes.reload;
  const reloadWork = workRes.reload;
  const reloadSide = useCallback(() => {
    reloadCases();
    reloadWork();
  }, [reloadCases, reloadWork]);
  const reloadAll = useCallback(() => {
    reloadDay();
    reloadSide();
  }, [reloadDay, reloadSide]);
  useLiveReload(["alert.created", "case.changed", "schedule.run"], reloadAll);
  useLiveReload(["response.submitted"], reloadSide);

  const { drawer, openReply, openNote, isOpen } = useDayDrawer(reloadSide);
  const [picked, setPicked] = useState<string | null>(null);

  const data = res.data;
  const items = useMemo(
    () => [...(data?.items ?? [])].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [data?.items],
  );
  const isToday = !!data && data.date === localDate(new Date(wall));
  const now = isToday ? wall : null;
  const states = useMemo(() => sessionStates(items, now), [items, now]);
  const clash = useMemo(() => clashes(items), [items]);
  const focus = focusSession(items, now);
  const selected = items.find((a) => a.id === picked) ?? focus ?? null;
  /*
   * Подготовка открывается только явно (кнопка или P): её открытие сервер
   * пишет в журнал доступа. Смена выбранной сессии её закрывает.
   */
  const [prepFor, setPrepFor] = useState<string | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => setPrepFor((p) => prepAfterSelect(p, selectedId)), [selectedId]);
  const prepOpen = selectedId !== null && prepFor === selectedId;
  const openPrep = () => {
    if (selectedId) setPrepFor(selectedId);
  };

  /* минуты случаев идут по часам экрана: таймер нормы не стоит между перечитываниями (liveCases) */
  const cases = casesRes.data ? urgentCases(liveCases(casesRes.data, wall, casesRes.updatedAt), user?.id ?? null) : null;
  /* случаи ещё в пути (или связи нет, а прежнего ответа не было) — «нічого термінового» сказать нельзя */
  const casesPending = casesRes.data === null && (casesRes.loading || casesRes.offline);
  const hero = cases?.[0] ?? null;
  const work = workRes.data ?? NO_WORK;
  const heroMsg = hero ? work.items.find((w) => w.userId === hero.userId && w.kind === "message") : undefined;
  /* то, что уже стоит плитками в «Дія зараз», ниже не повторяется */
  const sideCases = Math.max(0, Math.min(2, (cases?.length ?? 0) - 1));
  const shownAbove = new Set(
    overdueWork(work.items)
      .filter((w) => w.userId !== hero?.userId)
      .slice(0, Math.max(0, (hero ? 2 : 4) - sideCases))
      .map((w) => `${w.kind}-${w.id}`),
  );
  const between = betweenSessions(work.items, hero?.userId ?? null, shownAbove);

  const sessions = items.filter((a) => a.status !== "cancelled");
  const movable = sessions.map((a) => a.id);
  const step = (dir: 1 | -1) => {
    if (!movable.length) return;
    const at = selected ? movable.indexOf(selected.id) : -1;
    const next = movable[Math.max(0, Math.min(movable.length - 1, at === -1 ? 0 : at + dir))]!;
    setPicked(next);
    document.querySelector(`[data-appointment="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const note = (a: AppointmentView | null) => {
    if (a) openNote({ patientId: a.patientId, patientName: a.patientName, appointmentId: a.id, appointmentAt: a.startsAt });
  };
  const replyHero = () => {
    if (hero && heroMsg) openReply({ patientId: hero.userId, patientName: hero.userName, threadId: heroMsg.id });
  };
  useCodeKeys(
    {
      KeyJ: () => step(1),
      KeyK: () => step(-1),
      KeyN: () => note(selected),
      KeyP: selected ? openPrep : undefined,
      KeyR: hero ? () => navigate(reviewHref(hero.userId)) : undefined,
      KeyM: heroMsg ? replyHero : undefined,
    },
    !isOpen,
  );

  /* Enter без фокуса на кнопке или ссылке — карта выбранного */
  useEffect(() => {
    if (isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      if (selected) navigate(`/patients/${selected.patientId}`);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, selected, navigate]);

  return (
    <>
      {/* шапка — до ответа: дата и листание дней не ждут загрузки списка */}
      <DayHead
        date={data?.date ?? (dateParam || localDate(new Date(wall)))}
        items={items}
        loading={!data}
        isToday={data ? isToday : !dateParam}
        onDate={(d) => {
          setPicked(null);
          setDate(d);
        }}
      />
      <Screen res={res} rows={5}>
        {(day) => (
          <>
            <div className="flex flex-col gap-4">
              <ActNow
                cases={cases}
                work={work.items}
                appointments={isToday ? items : []}
                meId={user?.id ?? null}
                onReply={openReply}
                loading={!workRes.data || casesPending}
                casesError={casesRes.error}
                onRetryCases={reloadCases}
              />
              <SideLayout
                side={
                  <Prep
                  a={selected}
                  state={selected ? states.get(selected.id) : undefined}
                  clash={selected ? clash.get(selected.id) : undefined}
                  now={now}
                  open={prepOpen}
                  onOpen={openPrep}
                  onNote={note}
                />
                }
              >
                <Agenda
                  date={day.date}
                  items={items}
                  states={states}
                  clash={clash}
                  now={now}
                  selectedId={selected?.id ?? null}
                  onSelect={setPicked}
                  busy={busy}
                  /* перечитывается и на отказе: 409/400 значит, что строка устарела (visitModel.ts, #178) */
                  onStatus={(a, to) => run(() => moveAndReload(() => api.appointmentStatus(a.id, to), reloadDay))}
                  onLead={(a) => run(() => api.takeLead(a.patientId, true).then(reloadDay))}
                  nowNote={<NowNote items={items} now={now} hero={hero} />}
                  hints={[
                    ["J K", ut("dayA.hintSessions")],
                    ["N", ut("dayA.hintNote")],
                  ["P", ut("dayA.hintPrep")],
                    ...(hero ? ([["R", ut("dayA.hintReview")]] as [string, string][]) : []),
                    ...(heroMsg && hero ? ([["M", fill(ut("dayA.hintReply"), { name: hero.userName.split(" ")[1] ?? hero.userName })]] as [string, string][]) : []),
                    ["Enter", ut("dayA.hintCard")],
                    ["Esc", ut("dayA.hintEsc")],
                  ]}
                />
                <Between items={between} total={work.total} onReply={openReply} />
              </SideLayout>
            </div>
            {drawer}
          </>
        )}
      </Screen>
    </>
  );
}

/** «Зараз. До сесії Оксани 30 хв. Устигніть розібрати сигнал до 18:12.» */
function NowNote({ items, now, hero }: { items: AppointmentView[]; now: number | null; hero: AlertCase | null }) {
  const { ut } = useLang();
  const until = useUntil();
  if (now === null) return null;
  const next = items.find((a) => (a.status === "booked" || a.status === "confirmed") && Date.parse(a.startsAt) > now);
  const timer = hero ? caseTimer(hero) : null;
  return (
    <>
      <b className="font-extrabold text-text">{ut("dayA.nowWord")}</b>{" "}
      {next
        ? fill(ut("dayA.untilNext"), { name: next.patientName, t: until((Date.parse(next.startsAt) - now) / 60_000) })
        : ut("dayA.dayOver")}
      {hero ? (
        <>
          {" "}
          <Link to={reviewHref(hero.userId)} className="font-bold text-violet-ink">
            {timer && timer.left > 0 ? fill(ut("dayA.reviewSignalBy"), { t: hhmm(timer.due) }) : ut("dayA.reviewSignal")}
          </Link>
        </>
      ) : null}
    </>
  );
}

/** Мета-строка и листание дней — в шапку «Зведення» */
function DayHead({
  date,
  items,
  loading,
  isToday,
  onDate,
}: {
  date: string;
  items: AppointmentView[];
  loading: boolean;
  isToday: boolean;
  onDate: (d: string) => void;
}) {
  const { ut } = useLang();
  const alive = items.filter((a) => a.status !== "cancelled");
  const done = alive.filter((a) => a.status === "done").length;
  const ahead = alive.filter((a) => a.status === "booked" || a.status === "confirmed" || a.status === "arrived" || a.status === "in_progress").length;
  const end = alive.length ? hhmm([...alive.map((a) => a.endsAt)].sort().pop()!) : null;
  const sum = loading
    ? ut("common.loading")
    : alive.length
      ? fill(ut("dayA.daySum"), { n: alive.length, done, ahead, end: end ?? "" })
      : ut("day.nobody");
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, 1);
  return (
    <StartHead
      meta={
        <>
          <b className="font-extrabold text-text">{dayFull(date)}</b>
          <span>{sum}</span>
        </>
      }
      actions={
        <>
          <div role="group" aria-label={ut("dayA.dayNav")} className="inline-flex h-10 items-center gap-0.5 rounded-[12px] bg-sunk p-[3px]">
            <Tooltip label={dayFull(prev)}>
              <button
                type="button"
                aria-label={ut("day.prev")}
                onClick={() => onDate(prev)}
                className="inline-grid size-[34px] min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 bg-transparent p-0 text-text-2 hover:bg-panel hover:text-text"
              >
                <Ic.chevronLeft size={16} />
              </button>
            </Tooltip>
            <button
              type="button"
              aria-current={isToday ? "date" : undefined}
              onClick={() => onDate("")}
              className={cx(
                "inline-grid h-[34px] min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 px-3 text-small font-extrabold",
                isToday ? "bg-panel text-violet-ink shadow-tile" : "bg-transparent text-text-2 hover:bg-panel",
              )}
            >
              {ut("day.today")}
            </button>
            <Tooltip label={dayFull(next)}>
              <button
                type="button"
                aria-label={ut("day.next")}
                onClick={() => onDate(next)}
                className="inline-grid size-[34px] min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 bg-transparent p-0 text-text-2 hover:bg-panel hover:text-text"
              >
                <Ic.chevronRight size={16} />
              </button>
            </Tooltip>
          </div>
          <ButtonLink to="/my-schedule">
            <Di.calendarDays />
            {ut("dayA.weekSchedule")}
          </ButtonLink>
        </>
      }
    />
  );
}
