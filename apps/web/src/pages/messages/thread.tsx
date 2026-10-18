import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PatientCard, RiskAlert, SafetyPlan } from "@quizzy/shared";
import { api } from "../../api";
import { day, dayKey, locale, severityKey, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { AlertChip, AlertStrip, Avatar, Callout, Drawer, DrawerSection, Empty, Ic, Loading, RiskChip, Tooltip, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, buttonClass, Field, Input, SeverityTag, Tag, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Mi } from "./icons";
import { daysFrom, slotsByDay, type FreeSlot, type NextVisit, type ThreadRow } from "./model";

/*
 * Запись в «Листуванні» (консоль 2.0, comms-messages): то, что стоит вокруг
 * самой переписки, — карточка человека на тонированной полосе со строкой
 * открытого, боковые панели (ближайший приём, заміри, план безпеки, что
 * видит пациент) и два ящика: перенос приёма с ответом и новое сообщение.
 *
 * Лента и поле ответа живут в Messages.tsx: черновики ответа держит экран,
 * по разговору (#177), и ящик переноса пишет в тот же черновик.
 */

/** «сб» — день недели коротко, по языку консоли */
const weekday = (iso: string) => new Date(iso).toLocaleDateString(locale(), { weekday: "short" });
/** «сб 10.10» — дата приёма в строке списка */
export const visitShort = (iso: string) =>
  `${weekday(iso)} ${new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" })}`;
/** «10:30–11:20» */
const timeRange = (v: Pick<NextVisit, "startsAt" | "endsAt">) => `${timeOfDay(v.startsAt)}–${timeOfDay(v.endsAt)}`;
const minutesOf = (v: Pick<NextVisit, "startsAt" | "endsAt">) => Math.round((Date.parse(v.endsAt) - Date.parse(v.startsAt)) / 60_000);

/** Полных лет на сегодня; без даты рождения — null */
export function ageOf(birthDate: string | null, now = Date.now()): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  const n = new Date(now);
  let years = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) years -= 1;
  return years >= 0 ? years : null;
}

/**
 * Сколько сигнал открыт: «2:48» — часы и минуты в первые сутки, дальше —
 * дни. «216:19» читается как время суток, а не как девять дней.
 */
export function openFor(minutes: number, daysWord: string): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m >= 24 * 60) return daysWord.replace("{n}", String(Math.floor(m / (24 * 60))));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** «сьогодні» / «завтра» / «через 3 дн.» */
function useWhenWord() {
  const { ut } = useLang();
  return (iso: string) => {
    const d = daysFrom(iso, Date.now());
    if (d <= 0) return ut("msx.today");
    if (d === 1) return ut("msx.tomorrow");
    return ut("msx.inDays").replace("{n}", String(d));
  };
}

/* ─────────── карточка человека на полосе ─────────── */

export function RecordBanner({
  row,
  card,
  risks,
  canMove,
  onMove,
  listHidden,
  onShowList,
}: {
  row: ThreadRow;
  card: PatientCard | null;
  risks: readonly RiskAlert[];
  canMove: boolean;
  onMove: () => void;
  /** Список спрятан («[») — в карточке кнопка вернуть его */
  listHidden: boolean;
  onShowList: () => void;
}) {
  const { ut } = useLang();
  const age = ageOf(card?.birthDate ?? null);
  const drafts = (card?.conclusions ?? []).filter((c) => c.status === "draft");
  const facts: [ReactNode, ReactNode][] = [];
  if (age !== null) facts.push([<Ic.user key="i" size={15} />, <b key="t">{ut("msx.age").replace("{n}", String(age))}</b>]);
  if (card?.unit) facts.push([<Ic.users key="i" size={15} />, <span key="t">{card.unit}</span>]);
  if (card?.phone) facts.push([<Mi.smartphone key="i" size={15} />, <b key="t">{card.phone}</b>]);
  const first = risks[0];
  /* таймер — по самому давнему открытому сигналу: столько человек уже ждёт разбора */
  const oldest = risks.reduce<RiskAlert | null>((a, b) => (!a || b.minutesOpen > a.minutesOpen ? b : a), null);
  const next = row.next ?? null;

  return (
    <section
      aria-label={ut("msx.patient")}
      className="border-b border-band-card-line bg-band px-4 pb-3.5 pt-3.5 max-[1023px]:px-3"
    >
      <div className="rounded-drawer border border-band-card-line bg-band-card py-3 pl-3.5 pr-3 shadow-panel">
        <div className="flex min-w-0 items-center gap-3">
          {listHidden ? (
            <Tooltip label={ut("msx.showList")} kbd="[">
              <Button variant="quiet" size="icon-sm" aria-label={ut("msx.showList")} onClick={onShowList} className="max-[1023px]:hidden">
                <Mi.panelOpen size={17} />
              </Button>
            </Tooltip>
          ) : null}
          <Link
            to="/messages"
            aria-label={ut("msx.backToList")}
            className="hidden size-9 shrink-0 place-items-center rounded-control text-muted hover:bg-sunk hover:text-text max-[1023px]:inline-grid"
          >
            <Ic.chevronLeft size={18} />
          </Link>
          <Avatar name={row.withName} size={56} className="max-[700px]:hidden" />
          <div className="flex min-w-0 flex-col gap-[5px]">
            <h2 className="m-0 truncate text-[26px] font-extrabold leading-[30px] tracking-[-0.03em] text-text max-[700px]:text-[20px] max-[700px]:leading-[26px]">
              {row.withName}
            </h2>
            {facts.length ? (
              <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold text-text-2">
                {facts.map(([icon, text], i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap [&>svg]:text-violet-ink">
                    {icon}
                    {text}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            {card?.phone ? (
              <a href={`tel:${card.phone.replace(/[^\d+]/g, "")}`} className={buttonClass("secondary", "sm", "gap-2 max-[1180px]:hidden")}>
                <Ic.phone size={15} />
                {ut("msx.call")}
              </a>
            ) : null}
            {row.patientId ? (
              <Tooltip label={ut("pt.openCard")} side="bottom" align="end">
                <ButtonLink to={`/patients/${row.patientId}`} size="icon" aria-label={ut("pt.openCard")}>
                  <Ic.external size={16} />
                </ButtonLink>
              </Tooltip>
            ) : null}
          </div>
        </div>
        {first || next || drafts.length ? (
          <AlertStrip className="mt-3">
            {first ? (
              <RiskChip
                title={risks.length > 1 ? ut("msx.signals").replace("{n}", String(risks.length)) : ut("msx.signal")}
                timer={
                  <span className="inline-flex items-center gap-[5px] text-caption font-semibold text-text-2">
                    <Ic.timer size={14} className="text-risk-ink" />
                    <b className="text-body font-extrabold leading-none text-risk-ink">
                      {openFor(oldest?.minutesOpen ?? first.minutesOpen, ut("msx.days"))}
                    </b>
                    {risks.some((r) => r.overdue) ? ut("msx.overdue") : null}
                  </span>
                }
                pop={<p className="m-0 text-small text-text-2">{first.label}</p>}
                popTitle={first.surveyTitle}
                popNote={`${day(first.at)}, ${timeOfDay(first.at)}`}
                action={
                  <ButtonLink to={`/alerts?patient=${row.patientId ?? ""}`} variant="risk" size="xs">
                    {ut("dash.review")}
                  </ButtonLink>
                }
              />
            ) : null}
            {next ? (
              <AlertChip
                icon={<Ic.calendar />}
                label={ut("msx.visitChip")}
                detail={`${visitShort(next.startsAt)}, ${timeOfDay(next.startsAt)}`}
                onClick={canMove ? onMove : undefined}
                pop={
                  <p className="m-0 text-small text-text-2">
                    {timeRange(next)}
                    {next.room ? `, ${ut("msx.room").replace("{room}", next.room)}` : ""}
                  </p>
                }
              />
            ) : null}
            {drafts.map((d) => (
              <AlertChip
                key={d.id}
                icon={<Mi.pencil />}
                label={ut("msx.draftConclusion")}
                detail={d.surveyTitle}
                draft
                to={`/responses/${d.responseId}/conclusion`}
              />
            ))}
          </AlertStrip>
        ) : null}
      </div>
    </section>
  );
}

/** Красная заметка над лентой: сигнал не разобран — разберите до ответа */
export function RiskCallout({ risks, patientId }: { risks: readonly RiskAlert[]; patientId: string | undefined }) {
  const { ut } = useLang();
  const first = risks[0];
  if (!first) return null;
  return (
    <Callout
      kind="risk"
      title={ut("msx.riskTitle")}
      actions={
        <ButtonLink to={`/alerts?patient=${patientId ?? ""}`} variant="risk" size="xs">
          {ut("dash.review")}
        </ButtonLink>
      }
    >
      <p className="m-0 mt-0.5">
        {first.label}, {day(first.at)}, {timeOfDay(first.at)}. {ut("msx.riskHint")}
      </p>
    </Callout>
  );
}

/* ─────────── боковые панели ─────────── */

/** Плитка даты приёма: день недели полосой, число, месяц */
function DateTile({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <span aria-hidden className="w-[50px] shrink-0 overflow-hidden rounded-[12px] text-center shadow-[inset_0_0_0_1px_var(--border)]">
      <small className="block bg-violet py-0.5 text-[11px] font-extrabold leading-[14px] text-onfill">{weekday(iso)}</small>
      <b className="block text-[20px] font-extrabold leading-6 tabular-nums text-text">{d.getDate()}</b>
      <span className="block pb-1 text-[10.5px] text-muted">{d.toLocaleDateString(locale(), { month: "short" })}</span>
    </span>
  );
}

/** Последний замер по каждой методике и его история по той же шкале */
export interface MeasureLine {
  surveyId: string;
  title: string;
  code: string;
  value: number;
  severity: PatientCard["responses"][number]["scales"][number]["severity"];
  word: string | null;
  history: number[];
  at: string | null;
}

/**
 * Заміри для боковой панели: по методике — последнее прохождение и одна
 * шкала (первая с тяжестью, иначе первая), история той же шкалы по
 * прохождениям этой методики — последние три. Свежие методики сверху.
 */
export function measuresOf(card: Pick<PatientCard, "responses">, limit = 4): MeasureLine[] {
  const bySurvey = new Map<string, PatientCard["responses"]>();
  for (const r of card.responses) {
    if (!r.scales.length) continue;
    const list = bySurvey.get(r.surveyId);
    if (list) list.push(r);
    else bySurvey.set(r.surveyId, [r]);
  }
  const out: MeasureLine[] = [];
  for (const [surveyId, list] of bySurvey) {
    const sorted = [...list].sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? -1 : 1));
    const last = sorted[sorted.length - 1]!;
    const scale = last.scales.find((s) => s.severity) ?? last.scales[0]!;
    const history = sorted
      .map((r) => r.scales.find((s) => s.code === scale.code)?.value)
      .filter((v): v is number => typeof v === "number")
      .slice(-3);
    out.push({
      surveyId,
      title: last.surveyTitle,
      code: scale.code,
      value: scale.value,
      severity: scale.severity,
      word: scale.bandLabel,
      history,
      at: last.submittedAt,
    });
  }
  return out.sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? 1 : -1)).slice(0, limit);
}

export function RecordSide({
  row,
  card,
  cardError,
  safety,
  canMove,
  onMove,
}: {
  row: ThreadRow;
  card: PatientCard | null;
  cardError: string | null;
  safety: SafetyPlan | null;
  canMove: boolean;
  onMove: () => void;
}) {
  const { ut } = useLang();
  const when = useWhenWord();
  const next = row.next ?? null;
  const measures = card ? measuresOf(card) : [];
  const latest = measures[0]?.at ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel
        title={ut("msx.nextVisit")}
        icon={<Ic.calendar />}
        sub={next ? when(next.startsAt) : undefined}
        footer={
          next && canMove ? (
            <Button size="xs" icon={<Mi.calendarSync />} onClick={onMove}>
              {ut("msx.move")}
            </Button>
          ) : null
        }
      >
        {next ? (
          <div className="flex items-center gap-3">
            <DateTile iso={next.startsAt} />
            <div className="min-w-0">
              <b className="block text-h3 font-extrabold text-text">{timeRange(next)}</b>
              <span className="block text-small text-text-2">
                {next.mode === "remote" ? ut("day.remote") : next.room ? ut("msx.room").replace("{room}", next.room) : ut("msx.onsite")}
                {", "}
                {ut("msx.minutes").replace("{n}", String(minutesOf(next)))}
              </span>
              {next.status === "confirmed" ? (
                <span className="block text-small font-bold text-good">{ut("msx.confirmedVisit")}</span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="m-0 text-small text-text-2">
            {ut("msx.noVisitLong")}{" "}
            <Link to="/my-schedule" className="font-bold text-violet-ink">
              {ut("msx.toSchedule")}
            </Link>
          </p>
        )}
      </Panel>

      <Panel
        title={ut("msx.measures")}
        icon={<Ic.clipboard />}
        sub={latest ? day(latest) : undefined}
        footer={
          row.patientId ? (
            <Link to={`/patients/${row.patientId}`} className="text-small font-bold text-violet-ink">
              {ut("msx.allMeasures")}
            </Link>
          ) : null
        }
      >
        {cardError ? (
          <p className="m-0 text-small text-muted">{cardError}</p>
        ) : !card ? (
          <Loading rows={2} bare />
        ) : measures.length === 0 ? (
          <p className="m-0 text-small text-muted">{ut("msx.noMeasures")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {measures.map((m) => (
              <li key={m.surveyId} className="border-t border-divider py-2 first:border-t-0 first:pt-0 last:pb-0">
                <span className="block truncate text-small font-bold text-text-2">{m.title}</span>
                <span className="mt-1 flex items-center gap-2">
                  <b className="text-[16px] font-extrabold leading-none tabular-nums text-text">{m.value}</b>
                  {m.severity ? (
                    <SeverityTag level={m.severity} small>
                      {m.word ?? ut(severityKey[m.severity])}
                    </SeverityTag>
                  ) : m.word ? (
                    <Tag>{m.word}</Tag>
                  ) : null}
                  {m.history.length > 1 ? (
                    <span className="ml-auto whitespace-nowrap text-small tabular-nums text-muted">{m.history.join(" → ")}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {safety && row.patientId ? (
        <Link
          to={`/patients/${row.patientId}/case`}
          className="flex items-center gap-3 rounded-panel bg-warn-tint px-4 py-3 text-text no-underline hover:no-underline hover:shadow-[inset_0_0_0_1px_var(--warnline)]"
        >
          <Ic.shieldCheck size={16} className="text-warn" />
          <span className="min-w-0 flex-1">
            <b className="block text-body font-extrabold">{ut("msx.safetyPlan").replace("{n}", String(safety.version))}</b>
            <span className="block text-small text-text-2">
              {ut("msx.safetyUpdated").replace("{d}", day(safety.reviewedAt ?? safety.createdAt))}
            </span>
          </span>
          <Ic.chevronRight size={15} className="text-muted" />
        </Link>
      ) : null}

      <Callout kind="line" title={ut("msx.patientSees")}>
        <p className="m-0 mt-0.5">{ut("ms.boundaries")}</p>
      </Callout>
    </div>
  );
}

/* ─────────── ящик: перенос приёма с ответом ─────────── */

/** Текст «новое время» для черновика ответа: «сб 10.10, 18:00, каб. 214» */
function slotWords(slot: FreeSlot, ut: (k: "msx.room") => string): string {
  return `${visitShort(slot.startsAt)}, ${timeOfDay(slot.startsAt)}${slot.room ? `, ${ut("msx.room").replace("{room}", slot.room)}` : ""}`;
}

export function MoveDrawer({
  open,
  onClose,
  onReturn,
  row,
  specialistId,
  reply,
  onReply,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  row: ThreadRow | null;
  specialistId: string | undefined;
  /** Черновик ответа этого разговора — общий с полем под лентой */
  reply: string;
  onReply: (text: string) => void;
  /** Перенесли (и, может быть, ответили) — экран перечитывает список и ленту */
  onDone: (sent: string | null) => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const next = row?.next ?? null;
  const free = useResource(() => api.freeSlots({ specialistId }), [specialistId, open], {
    enabled: open && !!specialistId && !!next,
    keep: false,
  });
  const days = useMemo(
    () => slotsByDay(free.data?.items ?? [], (iso) => dayKey(iso), Date.now(), next?.startsAt),
    [free.data, next?.startsAt],
  );
  const dayKeys = [...days.keys()].slice(0, 14);
  const [dayPick, setDayPick] = useState<string | null>(null);
  const [slotPick, setSlotPick] = useState<string | null>(null);

  /* другой разговор — другой приём: выбранное прежде к нему не относится */
  useEffect(() => {
    setDayPick(null);
    setSlotPick(null);
  }, [row?.id, next?.id]);

  const ownDay = next ? dayKey(next.startsAt) : null;
  const shownDay = dayPick ?? (ownDay && days.has(ownDay) ? ownDay : (dayKeys[0] ?? null));
  const slots = shownDay ? (days.get(shownDay) ?? []) : [];
  const picked = slotPick ? (free.data?.items ?? []).find((s) => s.id === slotPick) ?? null : null;

  const move = (withReply: boolean) => {
    if (!next || !picked || !row) return;
    const text = reply.trim();
    void run(async () => {
      await api.rescheduleAppointment(next.id, picked.id);
      if (withReply && text && row.patientId) await api.sendMessage({ patientId: row.patientId, text });
      setSlotPick(null);
      setDayPick(null);
      onDone(withReply && text ? reply : null);
      onClose();
    }, ut("msx.moved").replace("{when}", slotWords(picked, ut)));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={ut("msx.move")}
      sub={next ? `${row?.withName ?? ""}, ${visitShort(next.startsAt)}, ${timeRange(next)}` : row?.withName}
      icon={<Mi.calendarSync />}
      dirty={!!slotPick}
      draftName={ut("msx.moveDraft")}
      kbd="M"
      note={ut("msx.moveNote")}
      noteIcon={<Ic.calendar />}
      footer={
        <>
          <Button variant="primary" icon={<Mi.calendarSync />} disabled={busy || !picked || !reply.trim()} onClick={() => move(true)}>
            {ut("msx.moveAndReply")}
          </Button>
          <Button disabled={busy || !picked} onClick={() => move(false)}>
            {ut("msx.moveOnly")}
          </Button>
        </>
      }
    >
      {!next ? (
        <DrawerSection>
          <p className="m-0 text-small text-text-2">{ut("msx.noVisitLong")}</p>
        </DrawerSection>
      ) : (
        <>
          <DrawerSection title={ut("msx.newTime")}>
            <div className="mb-2.5 flex items-center gap-2 text-[13px] text-text-2">
              <s className="tabular-nums">{timeOfDay(next.startsAt)}</s>
              <Ic.arrowRight size={14} />
              <b className="text-[22px] font-extrabold tabular-nums text-text">{picked ? timeOfDay(picked.startsAt) : "—"}</b>
              <span className="text-muted">{picked ? visitShort(picked.startsAt) : ut("msx.pickTime")}</span>
            </div>
            {free.error ? (
              <Loading error={free.error} onRetry={free.reload} bare />
            ) : !free.data ? (
              <Loading rows={2} bare />
            ) : dayKeys.length === 0 ? (
              <p className="m-0 text-small text-text-2">{ut("msx.noSlots")}</p>
            ) : (
              <>
                <div role="group" aria-label={ut("msx.moveDay")} className="flex flex-wrap gap-1.5">
                  {dayKeys.map((k) => {
                    const first = days.get(k)![0]!;
                    const on = k === shownDay;
                    return (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setDayPick(k);
                          setSlotPick(null);
                        }}
                        className={cx(
                          "h-8 min-h-0 cursor-pointer rounded-2xl border-0 px-2.5 text-small font-semibold tabular-nums",
                          on ? "bg-violet font-bold text-onfill" : "bg-sunk text-text-2 hover:bg-sunk-2 hover:text-text",
                        )}
                      >
                        {visitShort(first.startsAt)}
                      </button>
                    );
                  })}
                </div>
                <div role="group" aria-label={ut("msx.newTime")} className="mt-3 grid grid-cols-3 gap-2">
                  {slots.map((s) => {
                    const on = s.id === slotPick;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSlotPick(on ? null : s.id)}
                        className={cx(
                          "grid h-10 min-h-0 cursor-pointer place-items-center rounded-control border-0 text-body font-extrabold tabular-nums",
                          "transition-colors duration-[var(--dur-fast)]",
                          on ? "bg-violet text-onfill shadow-primary" : "bg-sunk text-text hover:bg-sunk-2",
                        )}
                      >
                        {timeOfDay(s.startsAt)}
                      </button>
                    );
                  })}
                </div>
                <p className="m-0 mt-2 text-small text-muted">{ut("msx.slotsHint")}</p>
              </>
            )}
          </DrawerSection>
          <DrawerSection title={ut("msx.replyLabel")}>
            <Field label={ut("msx.replyLabel")} inline>
              <Textarea rows={4} value={reply} onChange={(e) => onReply(e.target.value)} placeholder={ut("ms.placeholder")} />
            </Field>
            {picked ? (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => onReply(`${reply.trim() ? `${reply.trim()} ` : ""}${ut("msx.moveTplText").replace("{when}", slotWords(picked, ut))}`)}
                  className="h-8 min-h-0 cursor-pointer rounded-2xl border-0 bg-violet-tint px-3 text-caption font-bold text-violet-ink hover:bg-violet-tint-2"
                >
                  {ut("msx.moveTpl")}
                </button>
              </div>
            ) : null}
          </DrawerSection>
        </>
      )}
    </Drawer>
  );
}

/* ─────────── ящик: новое сообщение ─────────── */

export function ComposeDrawer({
  open,
  onClose,
  onReturn,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  onReturn: () => void;
  onSent: (threadId: string) => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [to, setTo] = useState<{ id: string; fullName: string } | null>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const found = useResource(() => api.patients({ search: dq }), [dq], { enabled: open && !to && dq.length >= 2 });

  const send = () => {
    if (!to || !text.trim()) return;
    void run(async () => {
      const res = await api.sendMessage({ patientId: to.id, text: text.trim() });
      setTo(null);
      setQ("");
      setText("");
      onSent(res.threadId);
    }, ut("msx.sent"));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={ut("msx.compose")}
      sub={ut("msx.composeSub")}
      icon={<Mi.squarePen />}
      dirty={!!to || !!text.trim()}
      draftName={ut("msx.composeDraft")}
      kbd="C"
      note={ut("msx.channel")}
      noteIcon={<Mi.smartphone />}
      footer={
        <>
          <Button variant="primary" icon={<Mi.send />} disabled={busy || !to || !text.trim()} onClick={send}>
            {ut("msx.send")}
          </Button>
          <Button onClick={onClose}>{ut("common.cancel")}</Button>
        </>
      }
    >
      <DrawerSection>
        {to ? (
          <Field label={ut("msx.to")}>
            <span className="flex items-center gap-2.5 rounded-control bg-sunk px-3 py-2">
              <Avatar name={to.fullName} size={28} />
              <b className="min-w-0 flex-1 truncate text-body text-text">{to.fullName}</b>
              <Button variant="quiet" size="xs" onClick={() => setTo(null)}>
                {ut("msx.change")}
              </Button>
            </span>
          </Field>
        ) : (
          <Field label={ut("msx.to")} hint={ut("msx.toHint")}>
            <Input
              data-autofocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={ut("msx.toPh")}
              icon={<Ic.search />}
              autoComplete="off"
              maxLength={120}
            />
          </Field>
        )}
        {!to && dq.length >= 2 ? (
          found.error ? (
            <Loading error={found.error} onRetry={found.reload} bare />
          ) : !found.data ? (
            <Loading rows={2} bare />
          ) : found.data.items.length === 0 ? (
            <Empty compact title={ut("msx.nobody")} />
          ) : (
            <ul className="m-0 mt-1 list-none p-0">
              {found.data.items.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setTo({ id: p.id, fullName: p.fullName })}
                    className="flex w-full min-h-0 cursor-pointer items-center justify-start gap-2.5 rounded-control border-0 bg-transparent px-2 py-1.5 text-left hover:bg-sunk"
                  >
                    <Avatar name={p.fullName} size={28} />
                    <span className="min-w-0">
                      <b className="block truncate text-body text-text">{p.fullName}</b>
                      {p.unit ? <span className="block truncate text-caption text-muted">{p.unit}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
        <Field label={ut("msx.text")} className="mt-3.5">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={ut("ms.placeholder")} maxLength={4000} />
        </Field>
      </DrawerSection>
    </Drawer>
  );
}
