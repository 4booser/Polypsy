import { useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Callout, Ic, KV, Modal, initialsOf, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Button, ButtonLink, Field, Tag, Textarea } from "../ui/primitives";
import { useResource } from "../useResource";
import { freeCancelUntil } from "./Home";
import { Glyph, type GlyphName } from "./icons";
import { BandCard, Body, FactList, Hero, HelpLink, PtPanel, SideGrid } from "./parts";
import { chosenSlot, moveTarget, slotsView } from "./slots";
import { dayPart, dm, hm, localDayKey, shortDay, visitWhen, weekdayLong, weekdayShort, type DayPart } from "./when";

type Slot = Awaited<ReturnType<typeof api.freeSlots>>["items"][number];
type Visit = Awaited<ReturnType<typeof api.myAppointments>>["items"][number];

/**
 * Запись на приём в три шага: к кому, когда, с чем (pt-booking «Виразної»).
 *
 * Специалист выбирается первым и необязателен: «будь-хто вільний» стоит
 * первым в списке, потому что человеку, который записывается впервые, имя
 * специалиста ничего не говорит, а требование выбрать останавливает. Свой
 * специалист помечен звездой: преемственность важнее ближайшего времени.
 *
 * Время — днями недели с числом свободного и часами по времени суток:
 * сорок одинаковых строк «дата, время» читались списком без опоры.
 *
 * Причина обращения — последняя и необязательная. Заставлять формулировать
 * проблему до встречи неверно: половина не запишется вовсе, а вторая
 * половина напишет «не знаю». Но кто написал — тому специалист успеет
 * подготовиться, и ради этого поле стоит.
 *
 * `?move=<id>` — перенос своего приёма: тот же выбор, но сервер переносит
 * одним действием (POST /appointments/:id/reschedule) — между отменой и
 * записью двумя запросами слот успел бы занять кто-то другой. Перед записью
 * и переносом — окно проверки: было и стане, где, правило отмены.
 */
export default function PatientBooking() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [params] = useSearchParams();
  const moveId = params.get("move");

  const visits = useResource(() => api.myAppointments(), []);
  const history = useResource(() => api.myAppointments(true), []);
  /* переносимый приём; пока список не пришёл, неизвестно, перенос это или запись (slots.ts, moveTarget) */
  const { moving, pending: moveUnknown } = moveTarget(moveId, visits.data?.items ?? null);

  const [specialistId, setSpecialistId] = useState<string | null | undefined>(undefined);
  /* перенос — по умолчанию к тому же специалисту: курс продолжается с ним */
  const who = specialistId === undefined ? (moving?.specialistId ?? null) : specialistId;
  const [slotId, setSlotId] = useState<string | null>(null);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [weekAt, setWeekAt] = useState(0);
  const [reason, setReason] = useState("");
  const [checking, setChecking] = useState(false);

  const specialists = useResource(() => api.specialists(), []);
  const slots = useResource(() => api.freeSlots(who ? { specialistId: who } : {}), [who]);

  const people = specialists.data?.items ?? [];
  /* грузится, не загрузилось, нет связи и «свободного нет» — разные ответы (slots.ts) */
  const view = slotsView(slots);
  const times = view.kind === "list" ? view.times : [];
  /* выбранным считается только время, которое есть в списке: занятое снимается само */
  const chosen = chosenSlot(slotId, times);
  const slot = times.find((t) => t.id === chosen) ?? null;

  /* дни со свободным временем; неделя — семь дней подряд от первого такого дня */
  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const t of times) {
      const k = localDayKey(t.startsAt);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return map;
  }, [times]);
  const firstDay = times[0] ? new Date(times[0].startsAt) : null;
  const week = firstDay
    ? Array.from({ length: 7 }, (_, i) => {
        const d = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + weekAt * 7 + i, 12);
        return { key: localDayKey(d.toISOString()), iso: d.toISOString() };
      })
    : [];
  const lastKey = times.length ? localDayKey(times[times.length - 1]!.startsAt) : null;
  const pickedDay = dayKey && week.some((w) => w.key === dayKey) ? dayKey : (week.find((w) => days.has(w.key))?.key ?? null);
  const daySlots = pickedDay ? (days.get(pickedDay) ?? []) : [];
  const parts: { key: DayPart; label: string; icon: GlyphName }[] = [
    { key: "morning", label: ut("ptw.morning"), icon: "sunrise" },
    { key: "day", label: ut("ptw.daytime"), icon: "sun" },
    { key: "evening", label: ut("ptw.evening"), icon: "sunset" },
  ];
  const lead = people.find((p) => p.isLead) ?? null;
  const whoName = who ? (people.find((p) => p.userId === who)?.fullName ?? null) : null;

  const submit = async () => {
    if (!chosen || moveUnknown) return;
    const ok = await run(
      async () => {
        if (moving) await api.rescheduleAppointment(moving.id, chosen);
        else await api.book({ slotId: chosen, reason: reason.trim() || null });
        setChecking(false);
        navigate("/me");
      },
      moving ? ut("ptw.moved") : ut("pt.booked"),
    );
    /*
     * Отказ записи почти всегда значит, что список устарел: время заняли,
     * закрыли или оно прошло, пока человек выбирал. Список перечитывается,
     * ушедшее время снимается с выбора (chosenSlot), причина остаётся во
     * всплывающем сообщении, а набранная причина обращения — в поле.
     */
    if (!ok) {
      setChecking(false);
      slots.reload();
    }
  };

  const aside = moving ? (
    <BandCard>
      <div className="flex items-center gap-2.5">
        <CardTile icon={<Glyph name="calendar-sync" size={17} />} />
        <b className="text-[16px] font-extrabold">{ut("ptw.moving")}</b>
      </div>
      <div className="mt-3 text-[24px] font-extrabold leading-[30px] tracking-[-0.02em] text-text-2 line-through decoration-control decoration-2">
        {visitWhen(moving.startsAt)}
      </div>
      <p className="m-0 mt-1 text-[15px] leading-[22px] text-text-2">
        {`${moving.specialistName}. ${ut("ptw.movingNote")}`}
      </p>
      <ButtonLink to="/me" size="md" className="mt-3">
        <Ic.undo size={18} />
        {ut("ptw.dontMove")}
      </ButtonLink>
    </BandCard>
  ) : null;

  return (
    <>
      <Hero title={ut("pt.titleBooking")} lead={moving ? ut("ptw.moveLead") : ut("ptw.bookLead")} aside={aside} />
      <Body>
        <SideGrid
          side={
            <>
              <PtPanel title={ut("ptw.myVisits")} icon={<Glyph name="calendar-clock" size={16} />}>
                <VisitList upcoming={visits.data?.items ?? null} past={history.data?.items ?? null} moveId={moving?.id ?? null} />
              </PtPanel>
              <PtPanel title={ut("ptw.howBooking")} icon={<ShellIcon name="circle-help" size={16} />}>
                <FactList
                  items={[
                    { key: "cancel", icon: <Glyph name="calendar-x" size={16} />, title: ut("ptw.ruleCancel"), text: ut("ptw.ruleCancelText") },
                    { key: "move", icon: <Glyph name="calendar-sync" size={16} />, title: ut("ptw.ruleMove"), text: ut("ptw.ruleMoveText") },
                    { key: "confirm", icon: <Glyph name="calendar-check" size={16} />, title: ut("ptw.ruleConfirm"), text: ut("ptw.ruleConfirmText") },
                  ]}
                />
              </PtPanel>
              <HelpLink title={ut("ptw.notEmergency")} sub={ut("ptw.notEmergencySub")} />
            </>
          }
        >
          <PtPanel
            title={ut("pt.pickSpecialist")}
            icon={<Glyph name="user-round" size={16} />}
            sub={lead ? ut("ptw.whoSub") : undefined}
          >
            {/*
              Размер значку задаёт подпись, а не сам значок: svg без размеров
              в потоке разворачивается до ширины колонки.
            */}
            <div role="group" aria-label={ut("pt.pickSpecialist")} className="grid grid-cols-2 gap-2.5 max-[600px]:grid-cols-1">
              <PersonChoice
                active={who === null}
                onClick={() => {
                  setSpecialistId(null);
                  setSlotId(null);
                  setDayKey(null);
                  setWeekAt(0);
                }}
                avatar={
                  <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-sunk text-muted">
                    <Glyph name="users-round" size={19} />
                  </span>
                }
                name={ut("ptw.anyone")}
                sub={ut("ptw.anyoneSub")}
              />
              {people.map((p) => (
                <PersonChoice
                  key={p.userId}
                  active={who === p.userId}
                  onClick={() => {
                    setSpecialistId(p.userId);
                    setSlotId(null);
                    setDayKey(null);
                    setWeekAt(0);
                  }}
                  avatar={
                    <span
                      aria-hidden
                      className={cx(
                        "grid size-11 shrink-0 place-items-center rounded-full text-[15px] font-extrabold",
                        who === p.userId ? "bg-violet text-onfill" : "bg-violet-tint text-violet-ink",
                      )}
                    >
                      {initialsOf(p.fullName)}
                    </span>
                  }
                  /* свой специалист помечен: преемственность важнее, чем ближайшее время */
                  name={p.fullName}
                  star={p.isLead}
                  sub={p.isLead ? ut("ptw.yourSpecialist") : (p.position ?? (p.room ? `${ut("pt.room")} ${p.room}` : ""))}
                />
              ))}
            </div>
          </PtPanel>

          <PtPanel
            title={ut("pt.pickTime")}
            icon={<ShellIcon name="calendar-days" size={16} />}
            sub={whoName ? `${ut("ptw.freeTimeOf")} ${whoName}` : ut("ptw.freeTimeAny")}
          >
            {view.kind === "loading" ? (
              <p className="m-0 text-muted">{ut("common.loading")}</p>
            ) : view.kind === "offline" ? (
              <p className="m-0 text-muted">{ut("conn.lost")}</p>
            ) : view.kind === "failed" ? (
              /* отказ загрузки — не «времени нет»: сказать и дать повторить */
              <div role="alert" className="flex flex-col items-start gap-2">
                <p className="m-0 text-[15px] text-risk-ink">
                  {ut("net.loadFailed")}: {view.error}
                </p>
                <Button variant="quiet" onClick={slots.reload}>
                  {ut("common.retry")}
                </Button>
              </div>
            ) : view.kind === "empty" ? (
              <p className="m-0 text-muted">{ut("pt.noSlots")}</p>
            ) : (
              <>
                <div className="grid grid-cols-[44px_repeat(7,minmax(0,1fr))_44px] gap-2 max-[600px]:grid-cols-[repeat(7,minmax(0,1fr))]">
                  <button
                    type="button"
                    aria-label={ut("ptw.prevWeek")}
                    className={weekArrow}
                    disabled={weekAt === 0}
                    onClick={() => setWeekAt(weekAt - 1)}
                  >
                    <Ic.chevronLeft size={18} />
                  </button>
                  {week.map((d) => {
                    const n = days.get(d.key)?.length ?? 0;
                    const on = d.key === pickedDay;
                    return n ? (
                      <button
                        key={d.key}
                        type="button"
                        aria-pressed={on}
                        aria-label={`${shortDay(d.iso)}, ${ut("ptw.freeN").replace("{n}", String(n))}`}
                        onClick={() => {
                          setDayKey(d.key);
                          setSlotId(null);
                        }}
                        className={cx(
                          "flex h-[76px] min-w-0 flex-col items-center justify-center gap-px rounded-[14px] text-[12.5px] font-semibold leading-[17px]",
                          "transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                          on
                            ? "bg-violet text-onfill shadow-primary"
                            : "bg-panel text-text-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)]",
                        )}
                      >
                        {weekdayShort(d.iso)}
                        <b className={cx("text-[21px] font-extrabold leading-[26px] tabular-nums", on ? "text-onfill" : "text-text")}>
                          {new Date(d.iso).getDate()}
                        </b>
                        <span className="truncate max-[600px]:hidden">{ut("ptw.freeN").replace("{n}", String(n))}</span>
                      </button>
                    ) : (
                      <span
                        key={d.key}
                        aria-hidden
                        className="flex h-[76px] min-w-0 flex-col items-center justify-center gap-px rounded-[14px] bg-sunk text-[12.5px] font-semibold leading-[17px] text-muted"
                      >
                        {weekdayShort(d.iso)}
                        <b className="text-[21px] font-extrabold leading-[26px] tabular-nums">{new Date(d.iso).getDate()}</b>
                        <span className="max-[600px]:hidden">{ut("ptw.noFree")}</span>
                      </span>
                    );
                  })}
                  <button
                    type="button"
                    aria-label={ut("ptw.nextWeek")}
                    className={weekArrow}
                    disabled={!lastKey || !week.length || week[week.length - 1]!.key >= lastKey}
                    onClick={() => setWeekAt(weekAt + 1)}
                  >
                    <Ic.chevronRight size={18} />
                  </button>
                </div>
                <div className="mt-[18px] flex flex-col gap-3">
                  {parts.map((part) => {
                    const here = daySlots.filter((t) => dayPart(t.startsAt) === part.key);
                    const current =
                      moving && pickedDay === localDayKey(moving.startsAt) && dayPart(moving.startsAt) === part.key ? moving : null;
                    if (!here.length && !current) return null;
                    return (
                      <div key={part.key} className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-4 max-[600px]:grid-cols-1 max-[600px]:gap-2">
                        <span className="flex items-center gap-1.5 text-[14px] font-bold text-muted">
                          <Glyph name={part.icon} size={16} />
                          {part.label}
                        </span>
                        <div role="group" aria-label={part.label} className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                          {current ? (
                            <span className="grid h-[60px] content-center justify-items-center gap-0.5 rounded-[14px] bg-sunk text-muted">
                              <s className="text-[18px] font-extrabold leading-none decoration-2">{hm(current.startsAt)}</s>
                              <small className="text-[12.5px] font-semibold leading-[15px]">{ut("ptw.currentTime")}</small>
                            </span>
                          ) : null}
                          {here.map((t) => {
                            const on = chosen === t.id;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setSlotId(t.id)}
                                className={cx(
                                  "grid h-[60px] content-center justify-items-center gap-0.5 rounded-[14px] text-[18px] font-extrabold leading-none tabular-nums",
                                  "transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                                  on ? "bg-violet text-onfill shadow-primary" : "bg-sunk text-text hover:bg-sunk-2",
                                )}
                              >
                                {hm(t.startsAt)}
                                <small className={cx("max-w-full truncate px-2 text-[12.5px] font-semibold leading-[15px]", on ? "text-onfill" : "text-muted")}>
                                  {who ? (t.room ? `${ut("pt.room")} ${t.room}` : hm(t.endsAt)) : surname(t.specialistName)}
                                </small>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </PtPanel>

          {moving ? null : (
            <PtPanel title={ut("pt.reason")} icon={<ShellIcon name="message-square-text" size={16} />} sub={ut("ptw.optional")}>
              {/*
                Подпись через Field, а не заголовок рядом с полем: заголовок с
                полем не связан, и диктор объявлял бы «поле ввода» (4.1.2).
              */}
              <Field label={ut("pt.reason")} hint={ut("pt.reasonHint")} inline>
                <Textarea rows={3} className="text-[16px]!" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </PtPanel>
          )}

          <div className="sticky bottom-4 z-10 flex items-center gap-3.5 rounded-drawer border border-border bg-panel py-3 pl-[18px] pr-3 shadow-pop max-[600px]:bottom-[88px] max-[600px]:flex-wrap">
            <CardTile icon={<Glyph name="calendar-check" size={18} />} />
            <span className="min-w-0 flex-1">
              <small className="block text-[13.5px] font-semibold leading-[18px] text-muted">
                {moving ? ut("ptw.newTime") : ut("ptw.chosenTime")}
              </small>
              <b className="block text-[18px] font-extrabold leading-6 tracking-[-0.01em] text-text">
                {slot ? slotLine(slot, ut) : ut("ptw.pickTimeFirst")}
              </b>
            </span>
            <Button
              variant="primary"
              size="lg"
              disabled={!chosen || busy || moveUnknown}
              aria-haspopup="dialog"
              onClick={() => setChecking(true)}
              iconEnd={<Ic.arrowRight size={18} />}
              className="max-[600px]:w-full"
            >
              {moving ? ut("ptw.reviewMove") : ut("ptw.reviewBook")}
            </Button>
          </div>
        </SideGrid>
      </Body>

      {checking && slot ? (
        <Modal
          title={moving ? ut("ptw.confirmMoveTitle") : ut("ptw.confirmBookTitle")}
          sub={ut("ptw.confirmSub")}
          icon={<Glyph name={moving ? "calendar-sync" : "calendar-check"} size={18} />}
          width={640}
          onClose={() => setChecking(false)}
          footer={
            <>
              <Button variant="primary" icon={<Glyph name="calendar-check" size={16} />} disabled={busy || moveUnknown} onClick={() => void submit()}>
                {moving ? ut("ptw.moveConfirm") : ut("pt.bookNow")}
              </Button>
              <Button variant="quiet" onClick={() => setChecking(false)}>
                {ut("ptw.goBack")}
              </Button>
            </>
          }
        >
          {moving ? (
            <div className="grid grid-cols-[minmax(0,1fr)_36px_minmax(0,1fr)] items-center gap-2.5">
              <WhenCard label={ut("ptw.was")} iso={moving.startsAt} end={moving.endsAt} was />
              <span aria-hidden className="grid size-9 place-items-center rounded-full bg-sunk text-violet-ink">
                <Ic.arrowRight size={18} />
              </span>
              <WhenCard label={ut("ptw.becomes")} iso={slot.startsAt} end={slot.endsAt} />
            </div>
          ) : (
            <WhenCard label={ut("ptw.chosenTime")} iso={slot.startsAt} end={slot.endsAt} />
          )}
          <KV
            className="mt-4 text-[15px] leading-[22px]"
            w={110}
            rows={[
              [ut("ptw.kvWho"), slot.specialistName],
              ...(slot.room ? ([[ut("ptw.kvWhere"), `${ut("pt.room")} ${slot.room}`]] as [ReactNode, ReactNode][]) : []),
              ...(!moving && reason.trim() ? ([[ut("pt.reason"), reason.trim()]] as [ReactNode, ReactNode][]) : []),
            ]}
          />
          <Callout kind="info" className="mt-4 text-[15px] leading-[22px]">
            {(moving ? `${ut("ptw.oldFrees").replace("{t}", hm(moving.startsAt))} ` : "") +
              ut("ptw.freeUntil").replace("{d}", `${shortDay(freeCancelUntil(slot.startsAt))}, ${hm(freeCancelUntil(slot.startsAt))}`)}
          </Callout>
        </Modal>
      ) : null}
    </>
  );
}

const weekArrow = cx(
  "grid h-[76px] w-11 place-items-center rounded-[14px] border-0 bg-sunk text-text-2 transition-colors hover:bg-sunk-2 max-[600px]:hidden",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-48",
);

/** «Ковальчук» из «Ковальчук Ярослав Богданович» — под временем помещается одно слово */
function surname(name: string): string {
  return name.split(" ")[0] ?? name;
}

function slotLine(slot: Slot, ut: (key: "pt.room") => string): string {
  return `${visitWhen(slot.startsAt, slot.endsAt)}${slot.room ? `, ${ut("pt.room")} ${slot.room}` : ""}`;
}

function CardTile({ icon }: { icon: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-violet-tint text-violet-ink supports-[corner-shape:squircle]:rounded-[18px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
    >
      {icon}
    </span>
  );
}

/** Карточка выбора специалиста: аватар, имя, кто он; выбранная — с кольцом */
function PersonChoice({
  active,
  onClick,
  avatar,
  name,
  sub,
  star,
}: {
  active: boolean;
  onClick: () => void;
  avatar: ReactNode;
  name: string;
  sub: string;
  star?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "flex min-h-[72px] items-center gap-3 rounded-[14px] px-3.5 py-3 text-left",
        "transition-[background-color,box-shadow] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        active
          ? "bg-violet-tint shadow-[inset_0_0_0_2px_var(--vring)]"
          : "bg-panel shadow-[inset_0_0_0_1px_var(--border)] hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)]",
      )}
    >
      {avatar}
      <span className="min-w-0">
        <b className={cx("flex items-center gap-1.5 text-[15px] font-extrabold leading-5", active ? "text-violet-ink" : "text-text")}>
          <span className="truncate">{name}</span>
          {star ? <Glyph name="star" size={14} className="shrink-0 text-violet-ink" /> : null}
        </b>
        {sub ? <small className="mt-0.5 block truncate text-[13.5px] font-semibold leading-[18px] text-muted">{sub}</small> : null}
      </span>
    </button>
  );
}

/** Было или стане: день и время крупно */
function WhenCard({ label, iso, end, was }: { label: string; iso: string; end?: string; was?: boolean }) {
  return (
    <div
      className={cx(
        "rounded-[14px] px-4 py-3.5",
        was ? "bg-sunk" : "bg-violet-tint shadow-[inset_0_0_0_2px_var(--vring)]",
      )}
    >
      <small className={cx("block text-[13px] font-bold", was ? "text-muted" : "text-violet-ink")}>{label}</small>
      <span className="mt-1 block text-[14.5px] text-text-2">{`${weekdayLongDm(iso)}`}</span>
      <b
        className={cx(
          "block text-[26px] font-extrabold leading-8 tracking-[-0.02em] tabular-nums",
          was ? "text-muted line-through decoration-control decoration-2" : "text-violet-ink",
        )}
      >
        {end ? `${hm(iso)}–${hm(end)}` : hm(iso)}
      </b>
    </div>
  );
}

function weekdayLongDm(iso: string): string {
  return `${weekdayLong(iso)}, ${dm(iso)}`;
}

/** «Мої прийоми»: ближайшие и прошедшие — день, время, чем закончился */
function VisitList({ upcoming, past, moveId }: { upcoming: Visit[] | null; past: Visit[] | null; moveId: string | null }) {
  const { ut } = useLang();
  if (upcoming === null && past === null) return <p className="m-0 text-muted">{ut("common.loading")}</p>;
  const now = Date.now();
  const ahead = (upcoming ?? []).filter((v) => new Date(v.startsAt).getTime() > now && v.status !== "cancelled");
  const behind = (past ?? [])
    .filter((v) => new Date(v.startsAt).getTime() <= now || v.status === "cancelled")
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, 4);
  if (!ahead.length && !behind.length) return <p className="m-0 text-[15px] text-muted">{ut("ptw.noVisitsYet")}</p>;
  const status = (v: Visit) => {
    if (v.id === moveId) return <Tag tone="primary" icon={<Glyph name="calendar-sync" size={12} />}>{ut("ptw.movingTag")}</Tag>;
    switch (v.status) {
      case "done":
        return <Tag tone="done" icon={<Ic.check size={12} />}>{ut("ptw.stDone")}</Tag>;
      case "no_show":
        return <Tag tone="attention" icon={<Glyph name="calendar-x" size={12} />}>{ut("ptw.stNoShow")}</Tag>;
      case "cancelled":
        return <Tag tone="done">{ut("ptw.stCancelled")}</Tag>;
      case "confirmed":
        return <Tag tone="good" icon={<Ic.check size={12} />}>{ut("ptw.confirmedTag")}</Tag>;
      default:
        return <Tag>{ut("ptw.stBooked")}</Tag>;
    }
  };
  const row = (v: Visit, up: boolean) => (
    <li
      key={v.id}
      className={cx(
        "grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 border-t border-divider py-[11px] text-[14.5px] leading-5 first:border-t-0",
        up && "-mx-2 mb-1 rounded-[12px] border-t-0 bg-violet-tint px-2",
      )}
    >
      <span className={cx("whitespace-nowrap font-extrabold", up ? "text-violet-ink" : "text-text-2")}>{shortDay(v.startsAt)}</span>
      <span className="min-w-0 text-text">
        <b className="font-extrabold">{`${hm(v.startsAt)}–${hm(v.endsAt)}`}</b>
        {`, ${v.specialistName}`}
      </span>
      {status(v)}
    </li>
  );
  return (
    <div>
      {ahead.length ? <ul className="m-0 list-none p-0">{ahead.map((v) => row(v, true))}</ul> : null}
      {behind.length ? (
        <>
          <div className="mb-1 mt-3.5 text-[13px] font-bold leading-[18px] text-muted">{ut("ptw.pastVisits")}</div>
          <ul className="m-0 list-none p-0">{behind.map((v) => row(v, false))}</ul>
        </>
      ) : null}
    </div>
  );
}
