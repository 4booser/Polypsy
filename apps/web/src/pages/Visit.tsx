import { type ReactNode, type RefObject, useEffect, useReducer, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { SurveyListItem, UiKey } from "@quizzy/shared";
import { api, type NoteState, openInTab } from "../api";
import { useAuth } from "../auth";
import { day } from "../format";
import {
  AlertChip,
  AlertStrip,
  Callout,
  Drawer,
  DrawerPane,
  DrawerSection,
  KV,
  Modal,
  NotLoaded,
  Screen,
  useAction,
} from "../ui";
import { cx } from "../ui/cx";
import { ActionMenu, type MenuEntry } from "../ui/menu";
import { Ic } from "../ui/icons";
import { IconTile, Page, Panel } from "../ui/layout";
import { Button, ButtonLink, Field, Input, Segmented, Select, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { type Resource, useResource } from "../useResource";
import { TemplatePicker } from "../components/TemplatePicker";
import { TranscriptBlock, VisitRecorder, useVisitRecording } from "../components/VisitRecorder";
import { V } from "../components/recorder/glyphs";
import { Episodes } from "../components/Episodes";
import { today } from "../components/deadline";
import { staleMessage } from "../components/versioned";
import { type FreeSlot, MoveSlots } from "./schedule/MoveSlots";
import { clock, wallOf, weekdayOf } from "./schedule/model";
import { dayMonth } from "./schedule/WeekCalendar";
import { SHORT_KEY } from "./schedule/WeekEdit";
import {
  ATTEMPTS_MAX,
  type AssignDraft,
  EMPTY_PROTOCOL,
  NEW_ASSIGN,
  type Protocol,
  type ProtocolEvent,
  STATUS_KEY,
  assignBody,
  assignProblems,
  assignReady,
  assignable,
  canMarkNoShow,
  cancellable,
  certificateAvailable,
  moveAndReload,
  protocolSavable,
  protocolStep,
  startPath,
  undoStep,
} from "./visitModel";

const SOURCE_KEY: Record<string, UiKey> = {
  self: "visit.sourceSelf",
  assigned: "visit.sourceAssigned",
  intake: "visit.sourceIntake",
  kiosk: "visit.sourceKiosk",
  clinician: "visit.sourceClinician",
  informant: "visit.sourceInformant",
};

const CHANGE_KEY: Record<string, UiKey> = {
  response: "visit.changeResponse",
  alert: "visit.changeAlert",
  noShow: "visit.changeNoShow",
};

type Destination = "psychiatrist" | "inpatient" | "outpatient" | "commander" | "other";
type Urgency = "routine" | "urgent" | "immediate";
const DESTINATIONS: Destination[] = ["psychiatrist", "inpatient", "outpatient", "commander", "other"];
const URGENCIES: Urgency[] = ["routine", "urgent", "immediate"];
const DEST_KEY: Record<Destination, UiKey> = {
  psychiatrist: "dest.psychiatrist",
  inpatient: "dest.inpatient",
  outpatient: "dest.outpatient",
  commander: "dest.commander",
  other: "dest.other",
};
const URG_KEY: Record<Urgency, UiKey> = { routine: "urg.routine", urgent: "urg.urgent", immediate: "urg.immediate" };

const capital = (s: string) => (s ? s[0]!.toLocaleUpperCase() + s.slice(1) : s);

/**
 * Экран приёма.
 *
 * Три колонки без переходов между вкладками: слева что было, в центре
 * протокол, справа запись и действия. Специалист открывает этот экран, когда
 * человек уже сидит перед ним, и любой переход отсюда стоит либо набранного
 * текста, либо внимания пациента. Поэтому направление и запись на следующую
 * сессию — в панели справа, а не на других экранах.
 *
 * Колонки именно в этом порядке. Слева — то, что читают до разговора; в
 * центре — то, что пишут во время; справа — то, что делают в начале (запись)
 * и в конце (назначить, направить, записать дальше).
 */
export default function VisitPage() {
  const { id = "" } = useParams();
  /*
   * Другой приём — другой экран целиком, а не тот же с новым адресом
   * (w14:webtails). Переход между приёмами (палитра, «назад» браузера)
   * оставлял компонент на месте, и с ним — набранный протокол и его базу:
   * текст о прежнем человеке стоял в поле нового и по «Зберегти» ложился в
   * его записи. Ключ по приёму начинает всё с чистого листа.
   */
  return <VisitScreen key={id} id={id} />;
}

type Ctx = Awaited<ReturnType<typeof api.visitContext>>;
type Pane = "refer" | "next";

function VisitScreen({ id }: { id: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.visitContext(id), [id]);
  const reload = res.reload;
  const rec = useVisitRecording(id);

  /*
   * Запись о человеке — только когда известно, о ком: прежде до ответа о
   * приёме здесь «грузился» null, и он выглядел как «записей нет».
   */
  const patientId = res.data?.patient.id ?? "";
  const notes = useResource(() => api.notes(patientId), [patientId], { enabled: !!patientId });

  /*
   * Протокол — текст поля вместе с базой, поверх которой он набран
   * (visitModel.ts): поле открывается только ответом сервера, а база —
   * то, что видел человек, а не то, что пришло последним.
   */
  const [protocol, dispatch] = useReducer(protocolStep, EMPTY_PROTOCOL);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (notes.data) dispatch({ type: "loaded", state: notes.data });
  }, [notes.data]);
  /* отказ 409 — запись переписали, пока протокол был открыт: строкой у кнопок, с «перечитати» (как в NotesEditor) */
  const [stale, setStale] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("refer");
  const show = (p: Pane) => {
    setPane(p);
    setOpen(true);
  };
  const [refer, setRefer] = useState<{ destination: Destination; urgency: Urgency; reason: string }>({
    destination: "psychiatrist",
    urgency: "routine",
    reason: "",
  });
  const [slot, setSlot] = useState<FreeSlot | null>(null);
  const [asking, setAsking] = useState<"cancel" | "undo" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const canBook = useAuth().can("appointments.manage");

  /* «через 30 хв» и «іде 12 хв» сдвигаются раз в минуту */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Screen res={res} rows={6}>
      {(data) => {
        const a = data.appointment;
        const move = (to: "booked" | "arrived" | "in_progress" | "done" | "no_show", ok?: string) =>
          run(() => moveAndReload(() => api.appointmentStatus(a.id, to), reload), ok);
        const undo = undoStep(a.status);
        const s = wallOf(a.startsAt, a.tz);
        const e = wallOf(a.endsAt, a.tz);
        const todayLocal = wallOf(new Date(now).toISOString(), a.tz).date;
        /*
         * «Почати» и «Неявка» — только в день приёма и позже. Сервер
         * переход разрешает в любой день, но приём следующей недели,
         * открытый из календаря, начатым или неявкой быть не может: такое
         * нажатие — промах, и исправлять его пришлось бы шагом назад.
         */
        const due = s.date <= todayLocal;
        const steps = due ? startPath(a.status) : [];
        const when = capital(
          `${s.date === todayLocal ? ut("v2v.today") : `${ut(SHORT_KEY[weekdayOf(s.date)]!)} ${dayMonth(s.date)}`}, ${clock(s.minutes)}–${clock(e.minutes)}`,
        );
        const place = a.mode === "remote" ? ut("day.remote") : a.room ? `${ut("day.room")} ${a.room}` : ut("v2v.onsite");
        const details = [ut(a.kind === "primary" ? "day.primary" : "day.repeat"), place, ut(STATUS_KEY[a.status])].join(", ");
        /*
         * Меню: печать (справка, если человек пришёл, и карта целиком),
         * снятие ошибочной отметки, отмена приёма. «Друк картки повністю»
         * переехал сюда из панели «Звернення»: печать карты — действие над
         * человеком, а не над обращением.
         */
        const menu: MenuEntry[] = [
          ...(certificateAvailable(a.status)
            ? [{ label: ut("visit.certificate"), icon: <V.fileBadge />, onSelect: () => openInTab(`/api/reports/visits/${a.id}`) }]
            : []),
          {
            label: ut("ep.chart"),
            icon: <Ic.file />,
            onSelect: () => openInTab(`/api/reports/patients/${data.patient.id}/chart`),
          },
          ...(undo ? [{ label: ut(undo.label), icon: <Ic.undo />, ruled: true, onSelect: () => setAsking("undo") }] : []),
          ...(cancellable(a.status)
            ? [{ label: ut("v2v.cancelVisit"), icon: <V.calendarX />, danger: true, ruled: true, onSelect: () => setAsking("cancel") }]
            : []),
        ];

        return (
          <Page
            back={{ to: "/today", label: ut("v2v.backToday") }}
            title={data.patient.fullName}
            meta={[when, details]}
            actions={
              <>
                {due && canMarkNoShow(a.status) ? (
                  <Button icon={<V.userX />} disabled={busy} onClick={() => void move("no_show", ut("v2v.noShowDone"))}>
                    {ut("day.noShow")}
                  </Button>
                ) : null}
                {a.status === "no_show" ? (
                  /* неявку ставит и фоновый проход — исправляется той же «Явка», что на «Сьогодні» */
                  <Button icon={<V.userCheck />} disabled={busy} onClick={() => void move("arrived")}>
                    {ut("day.came")}
                  </Button>
                ) : null}
                <ButtonLink
                  to={`/patients/${data.patient.id}`}
                  size="icon"
                  aria-label={ut("visit.openCard")}
                  title={ut("visit.openCard")}
                >
                  <Ic.external />
                </ButtonLink>
                <ActionMenu entries={menu} />
                {steps.length ? (
                  <Button
                    variant="primary"
                    icon={<V.play />}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        /* «Почати» — два шага сервера по очереди: пришёл, затем начали (visitModel.ts, startPath) */
                        () =>
                          moveAndReload(async () => {
                            for (const to of steps) await api.appointmentStatus(a.id, to);
                          }, reload),
                        ut("v2v.started"),
                      )
                    }
                  >
                    {ut("v2v.start")}
                  </Button>
                ) : a.status === "in_progress" ? (
                  <Button variant="primary" icon={<Ic.check />} disabled={busy} onClick={() => void move("done", ut("v2v.finished"))}>
                    {ut("visit.finish")}
                  </Button>
                ) : null}
              </>
            }
          >
            <OpenItems data={data} rec={rec} now={now} />

            {/*
              Три колонки на широком экране, одна на узком. Порядок при
              схлопывании тот же: что было → протокол → запись и действия.
              Колонки кончаются каждая на своей высоте: тянуть панель до
              общего низа значило бы оставлять в ней пустоту.
            */}
            <div className="grid items-start gap-4 grid-cols-[300px_minmax(0,1fr)_320px] max-[1360px]:grid-cols-[280px_minmax(0,1fr)_300px] max-[1100px]:grid-cols-1">
              <div className="flex min-w-0 flex-col gap-4">
                <History data={data} busy={busy} onTakeLead={() => run(() => api.takeLead(data.patient.id, true).then(reload))} />
                <Changes data={data} />
              </div>

              <Panel title={ut("visit.protocol")} icon={<V.notebookPen />} flush>
                <ProtocolBody
                  notes={notes}
                  protocol={protocol}
                  template={ut(a.kind === "primary" ? "visit.tplIntake" : "visit.tplSession")}
                  busy={busy}
                  stale={stale}
                  areaRef={areaRef}
                  onEvent={dispatch}
                  onSave={() =>
                    run(async () => {
                      try {
                        const saved = await api.saveNote(
                          data.patient.id,
                          protocol.text ?? "",
                          // база — то, поверх чего набран текст (null — записей не было): сервер сверит
                          protocol.seen,
                          a.kind === "primary" ? "intake" : "session",
                          a.id,
                        );
                        // ответ сервера ложится сразу: следующее «Зберегти» уйдёт с его редакцией, а не с прежней
                        notes.patch(saved);
                        dispatch({ type: "saved", state: saved });
                        setStale(null);
                        reload();
                      } catch (err) {
                        const message = staleMessage(err);
                        if (message === null) throw err;
                        setStale(message);
                        return false;
                      }
                    }, ut("visit.saved"))
                  }
                  onReread={() =>
                    run(async () => {
                      const fresh = await api.notes(data.patient.id);
                      notes.patch(fresh);
                      dispatch({ type: "reread", state: fresh });
                      setStale(null);
                    })
                  }
                />
                {/*
                  Стенограмма — под протоколом и вставляется в него по
                  нажатию; сама она в протокол не попадает: стенограмма — то,
                  что было сказано, а протокол — то, что из этого вынесли.
                */}
                <TranscriptBlock rec={rec} onInsert={(t) => dispatch({ type: "append", text: t })} />
              </Panel>

              <div className="flex min-w-0 flex-col gap-4">
                {/*
                  Запись — первая в колонке: её включают на первой минуте
                  приёма, когда человек уже сел и разговор пошёл, и искать её
                  ниже сгиба некогда. Действия под ней: назначить, направить,
                  записать дальше — это конец приёма, а не начало.
                */}
                <VisitRecorder rec={rec} />
                <Actions
                  data={data}
                  busy={busy}
                  run={run}
                  canBook={canBook}
                  onRefer={() => show("refer")}
                  onNext={() => {
                    setSlot(null);
                    show("next");
                  }}
                />
                {/* обращение — здесь же: приём относят к нему тогда, когда он идёт, а не вспоминают потом */}
                <Episodes patientId={data.patient.id} appointmentId={a.id} />
              </div>
            </div>

            <Drawer open={open} mode={pane} onClose={() => setOpen(false)} onReturn={(m) => show((m as Pane) ?? "refer")}>
              <DrawerPane
                mode="refer"
                title={ut("v2v.referTitle")}
                sub={data.patient.fullName}
                icon={<V.arrowLeftRight />}
                dirty={refer.reason.trim() !== ""}
                draftName={ut("v2v.draftRefer")}
                footer={
                  <>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.createReferral({
                            userId: data.patient.id,
                            destination: refer.destination,
                            urgency: refer.urgency,
                            reason: refer.reason || null,
                          });
                          setRefer({ destination: "psychiatrist", urgency: "routine", reason: "" });
                          setOpen(false);
                        }, ut("visit.referred"))
                      }
                    >
                      {ut("visit.refer")}
                    </Button>
                    <Button onClick={() => setOpen(false)}>{ut("visit.cancel")}</Button>
                  </>
                }
              >
                <DrawerSection>
                  <Field label={ut("visit.referDest")}>
                    <Select
                      data-autofocus
                      value={refer.destination}
                      onChange={(ev) => setRefer((r) => ({ ...r, destination: ev.target.value as Destination }))}
                    >
                      {DESTINATIONS.map((d) => (
                        <option key={d} value={d}>
                          {capital(ut(DEST_KEY[d]))}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={ut("visit.referUrgency")}>
                    <Segmented
                      wide
                      label={ut("visit.referUrgency")}
                      value={refer.urgency}
                      onChange={(urgency) => setRefer((r) => ({ ...r, urgency }))}
                      items={URGENCIES.map((u) => ({ key: u, label: capital(ut(URG_KEY[u])) }))}
                    />
                  </Field>
                  <Field label={ut("visit.referReason")} hint={ut("v2v.referReasonHint")}>
                    <Textarea rows={4} value={refer.reason} onChange={(ev) => setRefer((r) => ({ ...r, reason: ev.target.value }))} />
                  </Field>
                </DrawerSection>
              </DrawerPane>

              <DrawerPane
                mode="next"
                title={ut("v2v.nextTitle")}
                sub={data.patient.fullName}
                icon={<V.calendarPlus />}
                note={ut(a.mode === "remote" ? "v2v.nextRemote" : "v2v.nextOnsite")}
                noteIcon={a.mode === "remote" ? <V.video /> : <Ic.calendar />}
                footer={
                  <>
                    <Button
                      variant="primary"
                      icon={<Ic.check />}
                      disabled={busy || !slot}
                      onClick={() => {
                        if (!slot) return;
                        const w = wallOf(slot.startsAt, a.tz);
                        const label = `${ut(SHORT_KEY[weekdayOf(w.date)]!)} ${dayMonth(w.date)}, ${clock(w.minutes)}`;
                        void run(async () => {
                          await api.book({ slotId: slot.id, patientId: data.patient.id, mode: a.mode });
                          setSlot(null);
                          setOpen(false);
                        }, ut("v2v.booked").replace("{when}", label));
                      }}
                    >
                      {ut("v2v.book")}
                    </Button>
                    <Button onClick={() => setOpen(false)}>{ut("visit.cancel")}</Button>
                  </>
                }
              >
                <DrawerSection title={ut("v2v.nextWhen")} sub={ut("v2s.moveNewSub")}>
                  {open && pane === "next" ? (
                    <MoveSlots specialistId={a.specialistId} tz={a.tz} picked={slot} onPick={setSlot} />
                  ) : null}
                </DrawerSection>
              </DrawerPane>
            </Drawer>

            {asking === "cancel" ? (
              <Modal
                title={ut("v2v.cancelAsk")}
                sub={`${data.patient.fullName}, ${when}`}
                icon={<V.calendarX />}
                tone="warn"
                width={480}
                onClose={() => setAsking(null)}
                footer={
                  <>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await moveAndReload(() => api.cancelAppointment(a.id, cancelReason.trim() || undefined), reload);
                          setAsking(null);
                          setCancelReason("");
                          return r;
                        }, ut("v2v.cancelled"))
                      }
                    >
                      {ut("v2v.cancelVisit")}
                    </Button>
                    <Button onClick={() => setAsking(null)}>{ut("v2v.keep")}</Button>
                  </>
                }
              >
                <p className="m-0 mb-3.5 text-body text-text-2">{ut("v2v.cancelBody")}</p>
                <Field label={ut("v2v.cancelReason")} optional>
                  <Input data-autofocus value={cancelReason} onChange={(ev) => setCancelReason(ev.target.value)} />
                </Field>
              </Modal>
            ) : null}

            {asking === "undo" && undo ? (
              <Modal
                title={`${ut(undo.label)}?`}
                icon={<Ic.undo />}
                width={460}
                onClose={() => setAsking(null)}
                footer={
                  <>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => {
                        setAsking(null);
                        void move(undo.to);
                      }}
                    >
                      {ut(undo.label)}
                    </Button>
                    <Button onClick={() => setAsking(null)}>{ut("v2v.keep")}</Button>
                  </>
                }
              >
                <p className="m-0 text-body text-text-2">{ut(undo.confirm)}</p>
              </Modal>
            ) : null}
          </Page>
        );
      }}
    </Screen>
  );
}

/**
 * Строка открытого по человеку: время, подтверждение, что нового с прошлого
 * раза, формат и согласие на запись — одной строкой пилюль, подробности в
 * поповерах.
 */
function OpenItems({ data, rec, now }: { data: Ctx; rec: ReturnType<typeof useVisitRecording>; now: number }) {
  const { ut } = useLang();
  const a = data.appointment;
  const start = Date.parse(a.startsAt);
  const end = Date.parse(a.endsAt);
  const minutes = Math.round((start - now) / 60_000);
  const timing =
    a.status === "in_progress" || (now >= start && now < end && a.status === "arrived")
      ? ut("v2v.going").replace("{n}", String(Math.max(0, Math.round((now - start) / 60_000))))
      : minutes > 0 && minutes <= 180
        ? ut("v2v.inMin").replace("{n}", String(minutes))
        : undefined;
  const responses = data.changes.filter((c) => c.kind === "response");
  const alerts = data.changes.filter((c) => c.kind === "alert");
  const missed = data.changes.filter((c) => c.kind === "noShow");
  const s = wallOf(a.startsAt, a.tz);
  const list = (items: Ctx["changes"]) => (
    <ul className="m-0 list-none p-0">
      {items.map((c, i) => (
        <li key={i} className="flex gap-2 text-small">
          <span className="w-[54px] shrink-0 text-muted">{day(c.at)}</span>
          <span className="min-w-0 text-text">{c.title || ut(CHANGE_KEY[c.kind] ?? "visit.changeResponse")}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <AlertStrip label={ut("v2v.openItems")} className="mb-4">
      <AlertChip icon={<V.clock />} label={ut("v2v.startsAt").replace("{time}", clock(s.minutes))} detail={timing} />
      {a.confirmedAt ? (
        <AlertChip kind="message" icon={<Ic.message />} label={capital(ut("day.statusConfirmed"))} detail={clock(wallOf(a.confirmedAt, a.tz).minutes)} />
      ) : null}
      {alerts.length ? (
        <AlertChip
          kind="warn"
          icon={<Ic.alert />}
          label={ut("v2v.alertsSince").replace("{n}", String(alerts.length))}
          pop={list(alerts)}
          popTitle={ut("v2v.alertsSinceTitle")}
        />
      ) : null}
      {missed.length ? (
        <AlertChip kind="warn" icon={<V.userX />} label={ut("v2v.missedSince").replace("{n}", String(missed.length))} pop={list(missed)} />
      ) : null}
      {responses.length ? (
        <AlertChip
          icon={<Ic.clipboard />}
          label={ut("v2v.responsesSince").replace("{n}", String(responses.length))}
          pop={list(responses)}
          popTitle={ut("v2v.responsesSinceTitle")}
        />
      ) : null}
      {a.mode === "remote" ? (
        <AlertChip
          kind="message"
          icon={<V.video />}
          label={ut("v2s.lgOnline")}
          detail={a.meetingUrl ? undefined : ut("v2v.noLink")}
          pop={
            a.meetingUrl ? (
              <a href={a.meetingUrl} target="_blank" rel="noreferrer" className="break-all text-small font-semibold text-violet-ink">
                {a.meetingUrl}
              </a>
            ) : undefined
          }
          popTitle={ut("v2v.meetingLink")}
        />
      ) : null}
      {rec.state?.consentAt ? (
        <AlertChip
          kind="good"
          icon={<V.mic />}
          label={ut("v2v.consentChip")}
          pop={
            <p className="m-0 text-small text-text-2">
              {rec.state.consentBySelf ? ut("rec.consentBySelf") : ut("rec.consentByStaff")}, {day(rec.state.consentAt)}
            </p>
          }
        />
      ) : null}
    </AlertStrip>
  );
}

/** Что было: у кого человек был, с какого времени здесь, кто ведёт, сколько приёмов, повод его словами */
function History({ data, busy, onTakeLead }: { data: Ctx; busy: boolean; onTakeLead: () => void }) {
  const { ut } = useLang();
  const rows: [string, ReactNode][] = [];
  /*
   * Первой строкой — у кого человек был до этого. Записаться можно к любому
   * свободному специалисту, и человек легко попадает к третьему подряд.
   * Принимающий сегодня должен видеть, что он не первый, ДО того как начнёт
   * задавать вопросы, которые человеку уже задавали дважды.
   */
  if (data.previous) rows.push([ut("visit.wasWith"), `${data.previous.specialistName}, ${day(data.previous.at)}`]);
  if (data.followedSince) rows.push([ut("visit.followedSince"), ut("v2v.since").replace("{date}", day(data.followedSince))]);
  rows.push([
    ut("visit.lead"),
    data.patient.leadName ?? <span className="font-semibold text-warn">{ut("visit.noLead")}</span>,
  ]);
  rows.push([
    ut("v2v.visits"),
    data.visits.noShow
      ? ut("v2v.visitsMissed").replace("{done}", String(data.visits.done)).replace("{missed}", String(data.visits.noShow))
      : ut("v2v.visitsNoMiss").replace("{done}", String(data.visits.done)),
  ]);

  return (
    <Panel title={ut("visit.history")} icon={<Ic.history />}>
      {data.previous ? null : <p className="m-0 mb-2.5 text-small font-semibold text-text-2">{ut("visit.firstVisit")}</p>}
      <KV rows={rows} w={112} />
      {data.patient.leadSpecialistId === null ? (
        /*
          Закрепление — явное действие, а не следствие приёма: иначе один
          визит к коллеге на замене молча переназначал бы ведущего.
        */
        <Button size="xs" className="mt-2.5" disabled={busy} onClick={onTakeLead}>
          {ut("visit.takeLead")}
        </Button>
      ) : null}
      {data.appointment.reason ? (
        <Callout kind="neutral" icon={<Ic.message />} className="mt-3">
          <span className="text-muted">{ut("visit.reason")}: </span>
          {data.appointment.reason}
        </Callout>
      ) : null}
    </Panel>
  );
}

/** Что изменилось с прошлого приёма: заміри, тривоги, неявки — фактами */
function Changes({ data }: { data: Ctx }) {
  const { ut } = useLang();
  return (
    <Panel
      title={ut("visit.changes")}
      icon={<V.gitCompare />}
      sub={data.previous ? ut("v2v.since").replace("{date}", day(data.previous.at)) : undefined}
    >
      {data.changes.length === 0 ? (
        /*
          Отсутствие новостей — не заголовок: «с прошлого приёма ничего не
          произошло» — пустая строка списка, а не событие, о котором надо
          сообщить крупно.
        */
        <p className="m-0 text-small text-muted">{ut("visit.noChanges")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {data.changes.map((ch, i) => (
            <li
              key={i}
              className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0"
            >
              <IconTile
                size={28}
                tone={ch.kind === "alert" ? "risk" : ch.kind === "noShow" ? "warn" : "violet"}
                icon={ch.kind === "alert" ? <Ic.alert /> : ch.kind === "noShow" ? <V.userX /> : <Ic.clipboard />}
              />
              <span className="min-w-0 text-small leading-[17px] text-text">
                <b className={cx("font-bold", ch.kind === "alert" && "text-risk-ink")}>
                  {ch.kind === "response" && ch.title ? ch.title : ut(CHANGE_KEY[ch.kind] ?? "visit.changeResponse")}
                </b>
                <small className="block truncate text-caption text-muted">
                  {ch.kind === "response"
                    ? [ut("visit.changeResponse"), ch.detail && SOURCE_KEY[ch.detail] ? ut(SOURCE_KEY[ch.detail]!) : null]
                        .filter(Boolean)
                        .join(", ")
                    : ch.title || null}
                </small>
              </span>
              <span className="whitespace-nowrap text-caption font-bold text-muted">{day(ch.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Протокол приёма: поле, шаблоны и «Зберегти» — всё из состояния, без
 * своих решений и без сети, поэтому проверяется без браузера
 * (test/visitProtocol.test.tsx).
 *
 * Пока ответа о записи нет, поля нет: на его месте скелет, а при отказе —
 * отказ с «повторити». Прежде здесь стояло пустое поле, и отказ загрузки
 * выглядел как «записей о человеке нет»: специалист писал протокол с нуля
 * поверх черновика, которого не видел.
 */
export function ProtocolBody({
  notes,
  protocol,
  template,
  busy,
  stale,
  areaRef,
  onEvent,
  onSave,
  onReread,
}: {
  notes: Pick<Resource<NoteState>, "error" | "loading" | "reload">;
  protocol: Protocol;
  /** Заготовка протокола по виду приёма: плейсхолдер и кнопка «Шаблон» */
  template: string;
  busy: boolean;
  stale: string | null;
  areaRef: RefObject<HTMLTextAreaElement | null>;
  onEvent: (e: ProtocolEvent) => void;
  onSave: () => void;
  onReread: () => void;
}) {
  const { ut } = useLang();
  if (protocol.text === null) {
    return (
      <div className="px-4 pb-4">
        <NotLoaded res={notes} rows={6} />
      </div>
    );
  }
  const text = protocol.text;
  const edit = (next: string) => onEvent({ type: "edit", text: next });
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {/*
          Шаблон подставляется по нажатию, а не сам. Автоподстановка в пустое
          поле выглядит удобной ровно до первого раза, когда специалист начал
          писать своими словами и получил поверх заготовку.
        */}
        <Button size="xs" variant="ghost" icon={<Ic.file />} disabled={!!text} onClick={() => edit(template)}>
          {ut("visit.template")}
        </Button>
        <TemplatePicker kind="note" value={text} onChange={edit} textareaRef={areaRef} />
      </div>
      <Textarea
        ref={areaRef}
        rows={16}
        value={text}
        aria-label={ut("visit.protocol")}
        onChange={(e) => edit(e.target.value)}
        placeholder={template}
      />
      {stale ? (
        <div role="alert" className="rounded-panel bg-warn-tint px-3.5 py-3 text-small text-text-2">
          <p className="m-0 font-bold text-text">{stale}</p>
          <p className="m-0 mt-1">{ut("integrity.rereadHint")}</p>
          <Button size="xs" className="mt-2" disabled={busy} onClick={onReread}>
            {ut("integrity.reread")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button disabled={busy || !protocolSavable(protocol)} onClick={onSave}>
          {ut("visit.save")}
        </Button>
        <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
          <Ic.lock size={12} />
          {ut("v2v.protocolDraft")}
        </span>
      </div>
    </div>
  );
}

/** Строка-действие панели «Дії»: значок, подпись, пояснение справа, шеврон */
function ActionRow({ icon, label, note, onClick }: { icon: ReactNode; label: string; note?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "-mx-2 grid min-h-[42px] w-[calc(100%+16px)] cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-2.5 rounded-control border-0 bg-transparent px-2 text-left text-[13px] font-semibold text-text",
        "hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
      )}
    >
      <span className="inline-flex text-muted">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      <small className="whitespace-nowrap text-caption font-semibold text-muted">{note}</small>
      <Ic.chevronRight size={14} className="text-muted" />
    </button>
  );
}

function Actions({
  data,
  busy,
  run,
  canBook,
  onRefer,
  onNext,
}: {
  data: Ctx;
  busy: boolean;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  canBook: boolean;
  onRefer: () => void;
  onNext: () => void;
}) {
  const { ut } = useLang();
  const [assigning, setAssigning] = useState(false);
  const [draft, setDraft] = useState<AssignDraft>(NEW_ASSIGN);
  const surveys = useResource(() => api.surveys(), [], { enabled: assigning });
  const todayKey = today();
  const status = data.appointment.status;

  return (
    <Panel title={ut("visit.actions")} icon={<V.zap />}>
      {/*
        Назначение — здесь же, раскрытием на месте: уход с экрана стоит
        набранного протокола. Срок и число попыток задаются явно: одна
        попытка по умолчанию потому, что вторая портит измерение — человек
        помнит вопросы.
      */}
      {assigning ? (
        <AssignForm
          surveys={surveys}
          draft={draft}
          todayKey={todayKey}
          busy={busy}
          onEdit={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          onSubmit={() => {
            if (!assignReady(draft, todayKey)) return;
            const body = assignBody(draft);
            void run(
              () =>
                api.grant(body.surveyId, data.patient.id, undefined, body.expiresAt, body.attempts).then(() => {
                  // следующее назначение начинается с чистой формы: прежняя методика в выборе — путь к повторной выдаче
                  setDraft(NEW_ASSIGN);
                  setAssigning(false);
                }),
              ut("visit.assigned"),
            );
          }}
          onCancel={() => setAssigning(false)}
        />
      ) : (
        <ActionRow icon={<V.clipboardPlus />} label={ut("visit.assign")} onClick={() => setAssigning(true)} />
      )}
      <ActionRow icon={<V.arrowLeftRight />} label={ut("visit.refer")} onClick={onRefer} />
      {canBook ? <ActionRow icon={<V.calendarPlus />} label={ut("v2v.nextTitle")} onClick={onNext} /> : null}
      {/*
        Справка выдаётся о состоявшемся приёме, поэтому строка появляется
        только тогда, когда человек уже пришёл: предложить её раньше значило
        бы предложить документ о том, чего не было.
      */}
      {certificateAvailable(status) ? (
        <ActionRow
          icon={<V.fileBadge />}
          label={ut("visit.certificate")}
          onClick={() => openInTab(`/api/reports/visits/${data.appointment.id}`)}
        />
      ) : null}
    </Panel>
  );
}

/**
 * Форма назначения — всё из состояния, проверяется без браузера
 * (test/visitProtocol.test.tsx). Правила полей — visitModel.ts
 * (assignProblems): срок в прошлом и попытки вне 1…10 называются у поля и
 * гасят кнопку, а не уходят на сервер.
 */
export function AssignForm({
  surveys,
  draft,
  todayKey,
  busy,
  onEdit,
  onSubmit,
  onCancel,
}: {
  surveys: Pick<Resource<SurveyListItem[]>, "data" | "error" | "loading" | "reload">;
  draft: AssignDraft;
  todayKey: string;
  busy: boolean;
  onEdit: (patch: Partial<AssignDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { ut } = useLang();
  const problems = assignProblems(draft, todayKey);
  return (
    <div className="mb-1.5 rounded-[12px] bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="mb-2.5 flex items-center gap-2 text-[13px] font-extrabold leading-[18px] text-text">
        <V.clipboardPlus size={15} className="text-violet-ink" />
        {ut("v2v.assignHead")}
      </div>
      {/* методики не пришли — отказ с «повторити» на месте выбора, а не пустой выбор, будто назначать нечего */}
      {surveys.data === null ? (
        <div className="mb-3">
          <NotLoaded res={surveys} rows={1} />
        </div>
      ) : (
        <Field label={ut("visit.assignPick")}>
          <Select value={draft.surveyId} onChange={(e) => onEdit({ surveyId: e.target.value })}>
            <option value="" />
            {assignable(surveys.data).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
        <div>
          <Field label={ut("visit.assignDue")} error={problems.due ? ut(problems.due) : null}>
            <Input
              type="date"
              value={draft.due}
              min={todayKey}
              aria-invalid={problems.due ? true : undefined}
              onChange={(e) => onEdit({ due: e.target.value })}
            />
          </Field>
        </div>
        <div>
          <Field label={ut("visit.assignAttempts")} error={problems.attempts ? ut(problems.attempts) : null}>
            <Input
              type="number"
              min={1}
              max={ATTEMPTS_MAX}
              value={draft.attempts}
              aria-invalid={problems.attempts ? true : undefined}
              onChange={(e) => onEdit({ attempts: e.target.value })}
            />
          </Field>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button size="xs" disabled={busy || !assignReady(draft, todayKey)} onClick={onSubmit}>
          {ut("visit.assign")}
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          {ut("visit.cancel")}
        </Button>
      </div>
    </div>
  );
}
