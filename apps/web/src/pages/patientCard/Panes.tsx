import { useEffect, useMemo, useRef, useState } from "react";
import { instrumentCode, type PatientCard, type ResponseContext, type ResponseContextSignal, type UiKey } from "@quizzy/shared";
import { Link } from "react-router-dom";
import { api, type ConclusionState, type NoteVersion } from "../../api";
import { useAuth } from "../../auth";
import { dateTime, day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { Callout, DrawerSection, Ic, Loading, useAction, type DrawerPaneProps } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, ErrorText, Field, Segmented, Select, SeverityTag, Textarea } from "../../ui/primitives";
import { draftOf, draftSavable, saveThenSign, signPlan, staleMessage } from "../../components/versioned";
import { Episodes, type EpisodeItem } from "../../components/Episodes";
import { SafetyPlanBody } from "../../components/SafetyPlanEditor";
import { useSafetyPlans } from "../../components/RiskReview";
import { ShellIcon } from "../../shell/icons";
import { relDay } from "./Banner";
import { dm, wdm } from "./format";
import { Pi } from "./icons";
import type { CardView } from "./types";
import { signGate, signalStrip, signalTimer, type SignGate } from "../response/context";
import { initialsName, shownNumber, shownValue } from "../patients/model";

/*
 * Виды ящика карточки, кроме разбора сигнала (он общий — components/RiskReview):
 * переписка с переносом приёма, заключение, нотатка и запись на приём.
 *
 * Каждый — хуком, который отдаёт свойства DrawerPane вместе с телом: Drawer
 * узнаёт виды по типу ребёнка, поэтому сами <DrawerPane> стоят в карточке, а
 * здесь — их содержимое и состояние. Набранное живёт, пока карточка открыта:
 * ящик не размонтируется, а Esc говорит «Чернетку … збережено».
 */

type Slot = { id: string; startsAt: string; endsAt: string; room: string | null };

/** Свободные окна ближе всего ко времени приёма (сначала тот же день), по времени */
export function nearSlots<T extends { startsAt: string }>(slots: readonly T[], at: string | null, count = 3): T[] {
  if (!at) return [];
  const t = Date.parse(at);
  const sameDay = (s: T) => new Date(s.startsAt).toDateString() === new Date(t).toDateString();
  return [...slots]
    .filter((s) => Date.parse(s.startsAt) > Date.now())
    .sort((a, b) => Number(sameDay(b)) - Number(sameDay(a)) || Math.abs(Date.parse(a.startsAt) - t) - Math.abs(Date.parse(b.startsAt) - t))
    .slice(0, count)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** Вид ящика, открытый хоть раз: его тело грузит своё только тогда, а дальше живёт с черновиком */
function useOpenedOnce(active: boolean): boolean {
  const [seen, setSeen] = useState(active);
  useEffect(() => {
    if (active) setSeen(true);
  }, [active]);
  return seen || active;
}

function useMySlots(enabled: boolean) {
  const { user } = useAuth();
  return useResource(
    () => (user ? api.freeSlots({ specialistId: user.id }).then((r) => r.items as Slot[]).catch(() => [] as Slot[]) : Promise.resolve([] as Slot[])),
    [user?.id],
    { enabled: enabled && !!user },
  );
}

/* ─────────── переписка ─────────── */

const TEMPLATES = [
  { key: "card.tplThanks", text: "card.tplThanksText" },
  { key: "card.tplHow", text: "card.tplHowText" },
] as const;

export function useThreadPane(v: CardView, active: boolean): DrawerPaneProps {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  /*
   * Пациент в переписке — фамилией с инициалами («Петров Д. А.»), как в
   * пилюлях «Кому» реестра: по одному имени («Листування: Дмитрий») в
   * отделении, где Дмитриев десяток, не понять, с кем разговор.
   */
  const who = initialsName(v.card.fullName);
  /* поле — «Відповідь», когда есть на что отвечать; первое письмо — «Повідомлення» */
  const replying = !!v.messages?.some((m) => !m.mine);
  const canMove = !!v.next && v.nextIsMine && v.can("appointments.manage");
  const slots = useMySlots(active && canMove);
  /* шесть окон ближе всего ко времени приёма — сначала тот же день, по порядку времени */
  const choice = useMemo(() => nearSlots(slots.data ?? [], v.next?.at ?? null, 6), [slots.data, v.next?.at]);

  const picked = choice.find((s) => s.id === v.slotId) ?? null;

  useEffect(() => setText(""), [v.id]);

  /* прочитано — когда ящик с письмами открыт, а не когда письма пришли */
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !v.thread || !v.messages) return;
    const ids = v.messages.filter((m) => !m.mine && !m.readAt).map((m) => m.id);
    const key = `${v.thread.id}:${ids.join(",")}`;
    if (!ids.length || marked.current === key) return;
    marked.current = key;
    void api
      .markRead(v.thread.id, ids)
      .then(() => v.refresh.messages())
      .catch(() => {});
  }, [active, v.thread, v.messages, v]);

  const send = (move: boolean) =>
    void run(async () => {
      const moving = !!(move && picked && v.next);
      if (moving) {
        await api.rescheduleAppointment(v.next!.id, picked!.id);
        v.setSlotId(null);
      }
      const sending = !!text.trim();
      if (sending) await api.sendMessage({ patientId: v.id, text: text.trim() });
      setText("");
      /* перенос — приём в хронологии; письмо — разговор */
      if (moving) v.refresh.timeline();
      if (sending) v.refresh.messages();
    }, ut(move && picked ? (text.trim() ? "card.movedAndSent" : "card.moved") : "card.sent"));

  const body = (
    <>
      <DrawerSection>
        {!v.messages ? (
          v.thread ? (
            <Loading rows={3} bare />
          ) : (
            <p className="m-0 text-small text-muted">{ut("card.noMessages")}</p>
          )
        ) : v.messages.length ? (
          <div className="flex flex-col gap-2">
            {v.messages.slice(-8).map((m) => (
              <div
                key={m.id}
                className={cx(
                  "max-w-[84%] rounded-[16px] px-[13px] py-[9px] text-[13px] leading-[19px] text-text",
                  m.mine ? "self-end rounded-br-[6px] bg-violet-tint" : "self-start rounded-bl-[6px] bg-sunk",
                  !m.mine && !m.readAt && "shadow-[inset_0_0_0_1.5px_var(--warnline)]",
                )}
              >
                <span className="whitespace-pre-wrap">{m.text}</span>
                <small className={cx("mt-[3px] block text-[11.5px] leading-[15px] text-muted", m.mine && "text-right")}>
                  {m.mine ? ut("card.me") : who}, {relDay(m.sentAt, v.now, ut)}, {timeOfDay(m.sentAt)}
                  {!m.mine && !m.readAt ? `, ${ut("card.noReply")}` : ""}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 text-small text-muted">{ut("card.noMessages")}</p>
        )}
      </DrawerSection>
      {canMove ? (
        <DrawerSection title={ut("card.moveVisit")} sub={`${wdm(v.next!.at)}, ${timeOfDay(v.next!.at)}`}>
          {picked ? (
            <div className="mb-2.5 flex items-center gap-2 text-[13px] text-text-2">
              <s className="text-muted">{timeOfDay(v.next!.at)}</s>
              <Ic.arrowRight size={14} />
              <b className="text-[16px] font-extrabold text-text">
                {wdm(picked.startsAt)}, {timeOfDay(picked.startsAt)}
              </b>
            </div>
          ) : null}
          {slots.data ? (
            choice.length ? (
              <div className="grid grid-cols-3 gap-2" role="group" aria-label={ut("card.freeNear")}>
                {choice.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={v.slotId === s.id}
                    onClick={() => v.setSlotId(v.slotId === s.id ? null : s.id)}
                    className={cx(
                      "grid h-11 min-h-0 cursor-pointer place-items-center rounded-control border-0 text-body font-extrabold leading-none",
                      "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                      v.slotId === s.id ? "bg-violet text-onfill shadow-primary" : "bg-sunk text-text hover:bg-sunk-2",
                    )}
                  >
                    <span>
                      {timeOfDay(s.startsAt)}
                      <small className="block text-[11px] font-semibold opacity-80">{dm(s.startsAt)}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="m-0 text-small text-muted">{ut("card.noFree")}</p>
            )
          ) : (
            <Loading rows={1} bare />
          )}
          <p className="m-0 mt-2 text-small text-muted">
            {ut("card.freeHint")}{" "}
            <Link to="/my-schedule" className="font-bold text-violet-ink">
              {ut("card.otherDay")}
            </Link>
          </p>
        </DrawerSection>
      ) : null}
      <DrawerSection>
        <Field label={ut(replying ? "card.replyLabel" : "card.messageLabel")}>
          <Textarea data-autofocus rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setText((x) => (x.trim() ? `${x.replace(/\s+$/, "")} ${ut(t.text)}` : ut(t.text)))}
              className="inline-flex h-8 min-h-0 cursor-pointer items-center rounded-pill border-0 bg-violet-tint px-3 text-caption font-bold text-violet-ink hover:bg-violet-tint-2"
            >
              {ut(t.key)}
            </button>
          ))}
        </div>
      </DrawerSection>
    </>
  );

  return {
    mode: "thread",
    title: ut("card.threadWith").replace("{n}", who),
    sub: v.card.phone ? `${ut("card.inApp")}, ${v.card.phone}` : ut("card.inApp"),
    icon: <Pi.messageSquare />,
    tone: "info",
    kbd: "M",
    dirty: text.trim() !== "",
    draftName: ut("card.draftReply"),
    note: ut("card.willSee"),
    noteIcon: <Ic.bell />,
    footer: picked ? (
      <>
        <Button variant="primary" icon={<Ic.calendar />} disabled={busy} onClick={() => send(true)}>
          {ut(text.trim() ? "card.moveAndReply" : "card.moveOnly")}
        </Button>
        <Button disabled={busy || !text.trim()} onClick={() => send(false)}>
          {ut("card.replyOnly")}
        </Button>
      </>
    ) : (
      <Button variant="primary" icon={<Pi.send />} disabled={busy || !text.trim()} onClick={() => send(false)}>
        {ut("card.send")}
      </Button>
    ),
    children: body,
  };
}

/* ─────────── заключення ─────────── */

/**
 * Замок подписи заключения в ящике карточки — тем же правилом, что
 * страница заключения (pages/response/context.ts, signGate): подпись закрыта,
 * пока не разобран сигнал, поднятый этим прохождением; пока обстановка
 * прохождения едет — ждёт; не пришла — закрыта, и ящик говорит «не вдалося
 * перевірити» с «Повторити». Прежде ящик подписывал мимо замка, который
 * держит полная страница.
 */
export function conclusionLock(
  ctx: Pick<ResponseContext, "signals"> | null,
  failed: boolean,
  reviewer: boolean,
): { gate: SignGate; open: ResponseContextSignal[] } {
  const gate = signGate(ctx, failed, reviewer);
  return { gate, open: gate === "locked" ? signalStrip(ctx?.signals ?? null).openHere : [] };
}

/** Подпись замка: какие сигналы и сколько висят — словами страницы заключения */
function lockText(open: readonly ResponseContextSignal[], ut: ReturnType<typeof useLang>["ut"]): string {
  const oldest = [...open].sort((a, b) => b.minutesOpen - a.minutesOpen)[0];
  if (!oldest) return "";
  const timer = signalTimer(oldest, ut("rp.hours"), (n) => shownNumber(n));
  const since = timer
    ? ut("cnx.lockTimer").replace("{t}", ut("kit.timerOf").replace("{elapsed}", timer.elapsed).replace("{of}", timer.of))
    : ut("cnx.lockSince").replace("{t}", timeOfDay(oldest.at));
  return `${open.map((s) => s.label).join("; ")}. ${since}.`;
}

export function useConclusionPane(v: CardView, active: boolean, wantResponse: string | null): DrawerPaneProps {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const responses = v.card.responses;
  const ownDraft = v.card.conclusions.find((c) => c.status === "draft");
  const [responseId, setResponseId] = useState<string | null>(null);
  useEffect(() => {
    if (wantResponse) setResponseId(wantResponse);
  }, [wantResponse]);
  useEffect(() => setResponseId(null), [v.id]);
  const rid = responseId ?? ownDraft?.responseId ?? responses[0]?.responseId ?? null;
  const resp = responses.find((r) => r.responseId === rid) ?? null;

  const res = useResource(() => (rid ? api.conclusion(rid) : Promise.resolve(null)), [rid], {
    enabled: active && !!rid,
    manual: true,
    keep: false,
  });
  const state = res.data as ConclusionState | null;
  /* обстановка прохождения — для замка подписи; читается, когда ящик заключения открыт */
  const ctxRes = useResource(() => api.responseContext(rid!), [rid], { enabled: active && !!rid, keep: false });
  const lock = conclusionLock(ctxRes.data ?? null, !!ctxRes.error, v.can("alerts.review"));
  const locked = lock.gate !== "open";
  const [text, setText] = useState("");
  const touched = useRef(false);
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    touched.current = false;
    setStale(null);
  }, [rid]);
  useEffect(() => {
    if (touched.current || !state) return;
    setText(draftOf(state)?.text ?? "");
  }, [state]);

  const draft = state ? draftOf(state) : null;
  const plan = signPlan(text, draft);
  const signed = state?.versions.find((x) => x.status === "signed") ?? null;
  const main = resp?.scales[0] ?? null;

  /* ответ сохранения или подписи — и состояние ящика, и строка «Заключення» карточки; хронологию — по итогу действия */
  const apply = (next: ConclusionState) => {
    res.patch(next);
    if (rid) v.refresh.conclusion(rid, next);
  };
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setStale(null);
    } catch (e) {
      const m = staleMessage(e);
      if (m === null) throw e;
      setStale(m);
      return false;
    }
  };

  const body = !responses.length ? (
    <p className="py-6 text-small text-muted">{ut("pcard.noTests")}</p>
  ) : (
    <>
      <DrawerSection>
        <Field label={ut("card.byResponse")}>
          <Select value={rid ?? ""} onChange={(e) => setResponseId(e.target.value)}>
            {responses.map((r) => (
              <option key={r.responseId} value={r.responseId}>
                {`${instrumentCode(r.surveyTitle)}, ${r.submittedAt ? dm(r.submittedAt) : "—"}`}
              </option>
            ))}
          </Select>
        </Field>
        {main ? (
          <div className="flex items-center gap-3.5 rounded-panel bg-sunk px-3.5 py-3 text-[13px] text-text-2">
            {/* доля — процентом («57%», а не «0.571»), дробь — запятой языка */}
            <span className="text-stat font-extrabold leading-none tracking-[-0.03em] text-text">
              {shownValue(main.value, main.normalization).text}
              {shownValue(main.value, main.normalization).unit}
            </span>
            <span className="min-w-0">
              <b className="block font-extrabold text-text">{main.title}</b>
              {main.severity && main.bandLabel ? (
                <SeverityTag level={main.severity} small className="mt-1">
                  {main.bandLabel}
                </SeverityTag>
              ) : main.bandLabel ? (
                <span>{main.bandLabel}</span>
              ) : null}
            </span>
            <span className="ml-auto whitespace-nowrap text-caption text-muted">{resp?.submittedAt ? day(resp.submittedAt) : ""}</span>
          </div>
        ) : null}
        {!resp?.reliable && resp ? <ErrorText tone="warn" className="mt-2">{ut("pcard.unreliable")}</ErrorText> : null}
      </DrawerSection>
      <DrawerSection title={ut("card.conclText")}>
        {!state && res.loading ? (
          <Loading rows={3} bare />
        ) : (
          <>
            {signed && !draft ? (
              <p className="m-0 mb-2.5 text-small text-muted">
                {ut("card.signedVersion")
                  .replace("{v}", String(signed.version))
                  .replace("{d}", signed.signedAt ? day(signed.signedAt) : "")}
              </p>
            ) : null}
            <Textarea
              data-autofocus
              rows={8}
              aria-label={ut("card.conclText")}
              value={text}
              onChange={(e) => {
                touched.current = true;
                setText(e.target.value);
              }}
            />
            {stale ? (
              <Callout kind="warn" className="mt-2.5" role="alert" title={stale}
                actions={
                  <Button
                    variant="quiet"
                    size="xs"
                    onClick={() => {
                      setStale(null);
                      touched.current = false;
                      res.reload();
                    }}
                  >
                    {ut("integrity.reread")}
                  </Button>
                }
              >
                {ut("integrity.rereadHint")}
              </Callout>
            ) : null}
          </>
        )}
        {lock.gate === "locked" ? (
          <Callout
            kind="risk"
            className="mt-2.5"
            icon={<Ic.lock />}
            title={ut("cnx.lockTitle")}
            actions={
              v.can("alerts.review") ? (
                <Button variant="risk" size="xs" icon={<Ic.alert />} onClick={() => v.open("signal")}>
                  {ut("rp.reviewSignal")}
                </Button>
              ) : undefined
            }
          >
            {lockText(lock.open, ut)} {ut("cnx.lockDraftOk")}
          </Callout>
        ) : lock.gate === "unknown" ? (
          <Callout
            kind="warn"
            className="mt-2.5"
            icon={<Ic.circleAlert />}
            title={ut("cnx.lockUnknownTitle")}
            actions={
              <Button variant="secondary" size="xs" onClick={() => ctxRes.reload()}>
                {ut("common.retry")}
              </Button>
            }
          >
            {ut("cnx.lockUnknownBody")} {ut("cnx.lockDraftOk")}
          </Callout>
        ) : v.cases?.length ? (
          <Callout kind="neutral" className="mt-2.5" icon={<Ic.info />}>
            {ut("card.signalOpenNote")}{" "}
            {v.can("alerts.review") ? (
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-bold text-violet-ink" onClick={() => v.open("signal")}>
                {ut("card.review")}
              </button>
            ) : null}
          </Callout>
        ) : null}
        {rid ? (
          <Link to={`/responses/${rid}/conclusion`} className="mt-3 inline-flex items-center gap-1.5 text-small font-bold text-violet-ink">
            <Ic.external size={13} />
            {ut("card.fullEditor")}
          </Link>
        ) : null}
      </DrawerSection>
    </>
  );

  return {
    mode: "concl",
    title: resp ? ut("card.conclusionOf").replace("{s}", instrumentCode(resp.surveyTitle)) : ut("pcard.conclusions"),
    sub: resp?.submittedAt ? `${resp.surveyTitle}, ${dateTime(resp.submittedAt)}` : undefined,
    icon: <Pi.filePen />,
    dirty: touched.current && !!draftSavable(text) && text !== (draft?.text ?? ""),
    draftName: ut("card.draftConcl"),
    note: v.can("conclusions.sign")
      ? lock.gate === "locked"
        ? ut("rp.signLocked")
        : lock.gate === "unknown"
          ? ut("cnx.lockUnknownBody")
          : ut("card.signsAs")
      : undefined,
    noteIcon: lock.gate === "locked" || lock.gate === "unknown" ? <Ic.lock /> : <Pi.signature />,
    footer:
      rid && state ? (
        <>
          {v.can("conclusions.sign") ? (
            <Button
              variant="primary"
              icon={<Pi.signature />}
              /* замок сигнала — как на странице заключения: неразобран, неизвестен или ещё едет — подписи нет */
              disabled={busy || !plan.canSign || locked}
              onClick={() =>
                void run(
                  () =>
                    guard(async () => {
                      await saveThenSign(state, plan, {
                        save: () => api.saveConclusion(rid, text, state.current),
                        sign: (seen) => api.signConclusion(rid, seen),
                        apply,
                      });
                      touched.current = false;
                      v.refresh.timeline();
                    }),
                  ut("cn.signed"),
                )
              }
            >
              {ut("note.sign")}
            </Button>
          ) : null}
          <Button
            disabled={busy || !draftSavable(text)}
            onClick={() =>
              void run(
                () =>
                  guard(async () => {
                    apply(await api.saveConclusion(rid, text, state.current));
                    touched.current = false;
                    v.refresh.timeline();
                  }),
                ut("cn.draftSaved"),
              )
            }
          >
            {ut("note.saveDraft")}
          </Button>
        </>
      ) : undefined,
    children: body,
  };
}

/* ─────────── запис прийому ─────────── */

const KIND_KEY = { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" } as const;

/**
 * Виды записи — в одном порядке везде, где их выбирают (здесь и протокол
 * приёма): первичный, прием, наблюдение, консультация.
 */
export const NOTE_KINDS: readonly NoteVersion["kind"][] = ["intake", "session", "observation", "consult"];

/**
 * Заготовка текста по виду записи — та же, что «Підставити шаблон» протокола
 * приёма (Visit.tsx): первичный — жалобы, анамнез, состояние, вывод, план;
 * прием — состояние, что изменилось, работа, договорённости. У наблюдения и
 * консультации заготовки нет.
 */
const NOTE_TEMPLATE: Partial<Record<NoteVersion["kind"], UiKey>> = {
  intake: "visit.tplIntake",
  session: "visit.tplSession",
};

export function useNotePane(v: CardView, active: boolean): DrawerPaneProps {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const state = v.notes;
  const [text, setText] = useState("");
  const [kind, setKind] = useState<NoteVersion["kind"]>("session");
  const touched = useRef(false);
  const [stale, setStale] = useState<string | null>(null);
  useEffect(() => {
    touched.current = false;
    setText("");
    setStale(null);
  }, [v.id]);
  useEffect(() => {
    if (touched.current || !state) return;
    const d = draftOf(state);
    setText(d?.text ?? "");
    if (d) setKind(d.kind);
  }, [state]);

  const draft = state ? draftOf(state) : null;
  const plan = signPlan(text, draft, !draft || draft.kind === kind);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setStale(null);
    } catch (e) {
      const m = staleMessage(e);
      if (m === null) throw e;
      setStale(m);
      return false;
    }
  };

  const body = !state ? (
    <Loading rows={3} bare />
  ) : (
    <>
      <DrawerSection>
        {/* виды — в том же порядке, что протокол приёма (NOTE_KINDS) */}
        <Segmented
          wide
          label={ut("card.noteKind")}
          value={kind}
          onChange={setKind}
          items={NOTE_KINDS.map((k) => ({ key: k, label: ut(KIND_KEY[k]) }))}
        />
        {NOTE_TEMPLATE[kind] ? (
          <Button
            size="xs"
            variant="ghost"
            className="mt-2"
            icon={<Ic.file />}
            disabled={!!text.trim()}
            onClick={() => {
              touched.current = true;
              setText(ut(NOTE_TEMPLATE[kind]!));
            }}
          >
            {ut("visit.template")}
          </Button>
        ) : null}
        <Field label={ut("card.noteText")} className="mt-3.5">
          <Textarea
            data-autofocus
            rows={6}
            value={text}
            placeholder={ut("note.placeholder")}
            onChange={(e) => {
              touched.current = true;
              setText(e.target.value);
            }}
          />
        </Field>
        {stale ? (
          <Callout kind="warn" role="alert" title={stale}
            actions={
              <Button
                variant="quiet"
                size="xs"
                onClick={() => {
                  setStale(null);
                  touched.current = false;
                  v.refresh.notes();
                }}
              >
                {ut("integrity.reread")}
              </Button>
            }
          >
            {ut("integrity.rereadHint")}
          </Callout>
        ) : null}
      </DrawerSection>
      {state.versions.length ? (
        <DrawerSection title={ut("card.prevNotes")} right={<button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-small font-bold text-violet-ink" onClick={() => v.goTab("records", { kind: "notes" })}>{ut("card.allN").replace("{n}", String(state.versions.length))}</button>}>
          {state.versions.slice(0, 3).map((n) => (
            <div key={n.id} className="border-t border-divider py-2.5 text-small text-text-2 first:border-t-0 first:pt-0">
              <div className="mb-0.5 flex items-baseline gap-2">
                <b className="text-[13px] font-extrabold text-text">{ut(KIND_KEY[n.kind])}</b>
                <span className="text-caption text-muted">
                  {day(n.signedAt ?? n.createdAt)}, {n.authorName}
                  {n.status === "draft" ? `, ${ut("card.draft").toLowerCase()}` : ""}
                </span>
              </div>
              <p className="m-0 line-clamp-3 whitespace-pre-wrap">{n.text}</p>
            </div>
          ))}
        </DrawerSection>
      ) : null}
    </>
  );

  return {
    mode: "note",
    title: ut("card.noteTitle"),
    sub: ut("card.noteSub"),
    icon: <Pi.notebookPen />,
    kbd: "N",
    dirty: touched.current && text.trim() !== "" && text !== (draft?.text ?? ""),
    draftName: ut("card.draftNote"),
    note: ut("card.noteWho"),
    noteIcon: <Ic.users />,
    footer: state ? (
      <>
        <Button
          variant="primary"
          disabled={busy || !plan.canSign}
          onClick={() =>
            void run(
              () =>
                guard(async () => {
                  await saveThenSign(state, plan, {
                    save: () => api.saveNote(v.id, text, state.current, kind),
                    sign: (seen) => api.signNote(v.id, seen),
                    apply: (next) => v.refresh.notes(next),
                  });
                  touched.current = false;
                  setText("");
                }),
              ut("note.signed"),
            )
          }
        >
          {ut("note.sign")}
        </Button>
        <Button
          disabled={busy || !draftSavable(text)}
          onClick={() =>
            void run(
              () =>
                guard(async () => {
                  const saved = await api.saveNote(v.id, text, state.current, kind);
                  touched.current = false;
                  v.refresh.notes(saved);
                }),
              ut("cn.draftSaved"),
            )
          }
        >
          {ut("note.saveDraft")}
        </Button>
      </>
    ) : undefined,
    children: body,
  };
}

/* ─────────── запис на прийом ─────────── */

export function useBookPane(v: CardView, active: boolean): DrawerPaneProps {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const slots = useMySlots(active);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [mode, setMode] = useState<"onsite" | "remote">("onsite");
  useEffect(() => setSlotId(null), [v.id]);
  const byDay = useMemo(() => {
    const out = new Map<string, Slot[]>();
    for (const s of (slots.data ?? []).filter((x) => Date.parse(x.startsAt) > Date.now()).slice(0, 60)) {
      const k = new Date(s.startsAt).toDateString();
      out.set(k, [...(out.get(k) ?? []), s]);
    }
    return [...out.values()].slice(0, 7);
  }, [slots.data]);
  const picked = (slots.data ?? []).find((s) => s.id === slotId) ?? null;

  const body = (
    <>
      {v.next ? (
        <div className="pt-4">
          <Callout kind="info" title={ut("card.alreadyBooked").replace("{d}", `${wdm(v.next.at)}, ${timeOfDay(v.next.at)}`)}>
            {ut("card.alreadyBookedHint")}
          </Callout>
        </div>
      ) : null}
      <DrawerSection title={ut("card.mode")}>
        <Segmented
          wide
          label={ut("card.mode")}
          value={mode}
          onChange={setMode}
          items={[
            { key: "onsite", label: ut("card.onsite") },
            { key: "remote", label: ut("card.online") },
          ]}
        />
      </DrawerSection>
      <DrawerSection title={ut("card.mySlots")}>
        {!slots.data ? (
          <Loading rows={3} bare />
        ) : !byDay.length ? (
          <p className="m-0 text-small text-muted">{ut("card.noFree")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {byDay.map((list) => (
              <div key={list[0]!.id}>
                <div className="mb-1.5 text-caption font-bold text-muted">{wdm(list[0]!.startsAt)}</div>
                <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={wdm(list[0]!.startsAt)}>
                  {list.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={slotId === s.id}
                      onClick={() => setSlotId(slotId === s.id ? null : s.id)}
                      className={cx(
                        "h-10 min-h-0 cursor-pointer rounded-control border-0 text-body font-extrabold",
                        "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                        slotId === s.id ? "bg-violet text-onfill shadow-primary" : "bg-sunk text-text hover:bg-sunk-2",
                      )}
                    >
                      {timeOfDay(s.startsAt)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </DrawerSection>
    </>
  );

  return {
    mode: "book",
    title: ut("card.bookTip"),
    sub: v.card.fullName,
    icon: <Pi.calendarPlus />,
    note: picked ? `${wdm(picked.startsAt)}, ${timeOfDay(picked.startsAt)}${picked.room ? `, ${ut("card.room").replace("{r}", picked.room)}` : ""}` : undefined,
    noteIcon: <Ic.calendar />,
    footer: (
      <Button
        variant="primary"
        disabled={busy || !picked}
        onClick={() =>
          void run(async () => {
            await api.bookFor(v.id, picked!.id, mode);
            setSlotId(null);
            slots.reload();
            v.refresh.timeline();
          }, ut("card.booked"))
        }
      >
        {ut("card.book")}
      </Button>
    ),
    children: body,
  };
}

/* ─────────── план безпеки ─────────── */

/**
 * План безпеки — в ящике, как остальные действия рабочего места: прежде он
 * жил панелью «Огляду справи» клинической карты, и из карточки к нему вела
 * ссылка на другую страницу. Тот же запрос, что у шапки и ящика разбора
 * (useSafetyPlans, общее имя): сохранили — перечитался один раз, и шапка
 * видит новую версию сразу.
 */
export function usePlanPane(v: CardView, active: boolean): DrawerPaneProps {
  const { ut } = useLang();
  const plans = useSafetyPlans(v.id);
  const opened = useOpenedOnce(active);
  const current = plans.data?.versions.find((p) => p.active) ?? null;
  return {
    mode: "plan",
    title: ut("rr.safetyPlan"),
    sub: current
      ? `${ut("sp.version")} ${current.version}, ${day(current.reviewedAt ?? current.createdAt)}`
      : plans.data
        ? ut("sp.none")
        : undefined,
    icon: <Ic.shieldCheck />,
    tone: current ? "good" : "warn",
    children: opened ? <SafetyPlanBody userId={v.id} res={plans} /> : null,
  };
}

/* ─────────── звернення ─────────── */

/**
 * Обращения человека: повод, кто ведёт, приёмы и заключения по нему,
 * открыть новое, закрыть с исходом, выписка, диспансерный учёт — та же
 * панель, что на экране приёма (components/Episodes), без своей рамки.
 * Открыли или закрыли — шапка правится тем же перечитанным списком, без
 * нового чтения карточки.
 */
export function useEpisodePane(v: CardView, active: boolean): DrawerPaneProps {
  const { ut } = useLang();
  const opened = useOpenedOnce(active);
  const ep = v.card.episode ?? null;
  const { episode: onEpisode } = v.refresh;
  const onChange = useMemo(
    () => (items: EpisodeItem[]) => {
      const open = items.find((e) => !e.closedAt) ?? null;
      const next: PatientCard["episode"] = open
        ? { id: open.id, openedAt: open.openedAt, reason: open.reason, leadName: open.leadName }
        : null;
      if (next?.id !== ep?.id || next?.reason !== ep?.reason) onEpisode(next);
    },
    [ep?.id, ep?.reason, onEpisode],
  );
  const days = ep ? Math.max(0, Math.round((v.now - Date.parse(ep.openedAt)) / 86_400_000)) : 0;
  return {
    mode: "episode",
    title: ut("ep.title"),
    sub: ep ? ut("ws.episodeSince").replace("{d}", dm(ep.openedAt)).replace("{n}", String(days)) : ut("ws.episodeNone"),
    icon: <ShellIcon name="folder-tree" />,
    children: opened ? <Episodes patientId={v.id} bare onChange={onChange} /> : null,
  };
}
