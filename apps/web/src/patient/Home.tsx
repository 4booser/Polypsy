import { useRef, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { SafetyPlan, SurveyListItem, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { moveAndReload } from "../pages/visitModel";
import { ShellIcon } from "../shell/icons";
import { Callout, Ic, Modal, loadView, useAction } from "../ui";
import { cx } from "../ui/cx";
import { ActionMenu } from "../ui/menu";
import { Button, ButtonLink, Field, SeverityTag, Tag, Textarea, type Severity } from "../ui/primitives";
import { useResource, type Resource } from "../useResource";
import { Glyph } from "./icons";
import { drafts, type RunnerDraft } from "./outbox";
import type { PatientOutlet } from "./PatientApp";
import { BandCard, Body, CallRows, CodeTile, Hero, MetaLine, Pending, PtPanel, SideGrid, instrumentCode, instrumentName } from "./parts";
import { SafetyPlanDrawer } from "./SafetyPlan";
import { dm, greetingKey, hm, shortDay, visitWhen, whenSaid } from "./when";

type Visits = Awaited<ReturnType<typeof api.myAppointments>>;
type Visit = Visits["items"][number];
type Surveys = Awaited<ReturnType<typeof api.surveys>>;
type Dynamics = { surveys: { surveyId: string; title: string; scales: DynScale[] }[] };
type DynScale = {
  code: string;
  title: string;
  points: { submittedAt: string; value: number; bandLabel: string | null; severity: string | null }[];
};
/** Что блоку нужно от загрузки: данные, отказ, время ответа и «повторить» */
type Loaded<T> = Pick<Resource<T>, "data" | "error" | "loading" | "reload" | "updatedAt">;

/**
 * Поздняя отмена — правило сервера (routes/clinic.ts, POST
 * /appointments/:id/cancel): до приёма меньше LATE_CANCEL_HOURS часов, но он
 * ещё не начался, — сервер ставит cancelledLate, и специалист видит отмену
 * так же, как неявку. Здесь то же число и то же условие; совпадение с
 * сервером сторожит test/cabinetCancel.test.ts.
 */
export const LATE_CANCEL_HOURS = 24;

export function lateCancel(startsAt: string, now = Date.now()): boolean {
  const hoursLeft = (new Date(startsAt).getTime() - now) / 3600000;
  return hoursLeft < LATE_CANCEL_HOURS && hoursLeft > 0;
}

/** До какого момента отмена ещё без последствий: за LATE_CANCEL_HOURS до начала */
export function freeCancelUntil(startsAt: string): string {
  return new Date(new Date(startsAt).getTime() - LATE_CANCEL_HOURS * 3600000).toISOString();
}

/** Вопрос перед отменой; поздней — с предупреждением, что специалист это увидит */
export function cancelQuestion(startsAt: string, ut: (key: UiKey) => string, now = Date.now()): string {
  return lateCancel(startsAt, now) ? `${ut("pt.cancelSure")}\n\n${ut("pt.cancelLate")}` : ut("pt.cancelSure");
}

/**
 * «Скасувати» в кабинете (#178): сначала вопрос — окном с последствием
 * поздней отмены (мобилка тоже спрашивает и предупреждает). Отказался —
 * ничего не уходит (false: useAction не покажет «скасовано»). Согласился —
 * отмена, и экран перечитывается и на отказе сервера: 409/400 значит, что
 * приём уже изменили или закрыли.
 */
export async function cancelVisit(
  visit: { id: string; startsAt: string },
  deps: {
    ask: (question: string) => boolean | Promise<boolean>;
    cancel: (id: string) => Promise<unknown>;
    reload: () => void;
    ut: (key: UiKey) => string;
    now?: number;
  },
): Promise<boolean> {
  if (!(await deps.ask(cancelQuestion(visit.startsAt, deps.ut, deps.now)))) return false;
  await moveAndReload(() => deps.cancel(visit.id), deps.reload);
  return true;
}

/**
 * Главная кабинета (pt-home «Виразної»): ближайший приём с подтверждением на
 * полосе, строка открытого, что пройти, помощь, когда важко, и самочувствие —
 * только по методикам, которые отделение разрешает показывать.
 *
 * Самочувствие — плитками последних замеров, без графика: главный экран
 * открывают по дороге на приём, и нужно «когда и куда», а кривая тревоги за
 * полгода, которую человек видит каждый день, — уже вмешательство, а не
 * наблюдение. Баллы приходят лишь там, где их показ включён
 * (GET /me/dynamics, showResultsToPatient).
 */
export default function PatientHome() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const ctx = useOutletContext<PatientOutlet | undefined>();

  const visits = useResource(() => api.myAppointments(), []);
  const surveys = useResource(() => api.surveys(), []);
  const dynamics = useResource(() => api.myDynamics(), []);
  const plan = useResource(() => api.mySafetyPlan(), []);

  /* окно отмены — ответ на вопрос cancelVisit: «так» или «ні» человека, а не системного окна */
  const [asking, setAsking] = useState<Visit | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const [reason, setReason] = useState("");
  /* причина читается в момент отмены, после ответа в окне, — не та, что была при нажатии «…» */
  const reasonNow = useRef("");
  reasonNow.current = reason;
  const askCancel = (visit: Visit) =>
    new Promise<boolean>((resolve) => {
      setReason("");
      setAsking(visit);
      answer.current = (yes) => {
        answer.current = null;
        setAsking(null);
        resolve(yes);
      };
    });

  return (
    <>
      <HomeBody
        visits={visits}
        surveys={surveys}
        busy={busy}
        dynamics={dynamics.data}
        plan={plan.data?.plan ?? null}
        drafts={user ? drafts.list(user.id) : []}
        pending={ctx ? ctx.outbox.waiting.length + ctx.outbox.rejected.length : 0}
        /* перечитывается и на отказе: приём мог уже изменить специалист (pages/visitModel.ts, #178) */
        onConfirm={(id) => run(() => moveAndReload(() => api.confirmAppointment(id), visits.reload), ut("pt.confirmed"))}
        onCancel={(visit) =>
          run(
            () =>
              cancelVisit(visit, {
                ask: () => askCancel(visit),
                cancel: (id) => api.cancelAppointment(id, reasonNow.current.trim() || undefined),
                reload: visits.reload,
                ut,
              }),
            ut("pt.cancelled"),
          )
        }
      />
      {asking ? (
        <Modal
          title={ut("pt.cancelSure")}
          sub={ut("ptw.cancelSub")}
          icon={<Glyph name="calendar-x" size={18} />}
          onClose={() => answer.current?.(false)}
          footer={
            <>
              <Button variant="danger" icon={<Glyph name="calendar-x" size={16} />} onClick={() => answer.current?.(true)}>
                {ut("ptw.cancelYes")}
              </Button>
              <Button variant="quiet" onClick={() => answer.current?.(false)}>
                {ut("ptw.cancelKeep")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[16px] leading-6 text-text">
            {`${visitWhen(asking.startsAt, asking.endsAt)}, ${asking.specialistName}.`} {ut("ptw.cancelFrees")}
          </p>
          <div className="mt-3">
            {lateCancel(asking.startsAt) ? (
              <Callout kind="warn" className="text-[15px] leading-[22px]">
                {ut("pt.cancelLate")}
              </Callout>
            ) : (
              <Callout kind="good" className="text-[15px] leading-[22px]">
                {ut("ptw.cancelFree")}
              </Callout>
            )}
          </div>
          <div className="mt-4">
            <Field label={ut("ptw.cancelReason")} optional>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Тело главной — по загрузкам, без запросов внутри (проверяется разметкой:
 * test/loadStates.test.tsx).
 *
 * «Прийомів не заплановано» и «Поки нічого проходити» — ответ сервера, а
 * не отсутствие ответа: до ответа — скелет, на отказе — отказ с
 * «Повторити», и только пустой ответ — «не заплановано».
 */
export function HomeBody({
  visits,
  surveys,
  busy,
  onConfirm,
  onCancel,
  dynamics = null,
  plan = null,
  drafts: local = [],
  pending = 0,
}: {
  visits: Loaded<Visits>;
  surveys: Loaded<Surveys>;
  busy: boolean;
  onConfirm: (id: string) => void;
  /** Приём целиком: вопрос перед отменой зависит от того, сколько до него осталось */
  onCancel: (visit: Visit) => void;
  dynamics?: Dynamics | null;
  plan?: SafetyPlan | null;
  drafts?: RunnerDraft[];
  /** Сколько сдач ждёт на устройстве или не принято сервером */
  pending?: number;
}) {
  const { ut } = useLang();
  const [planOpen, setPlanOpen] = useState(false);
  const visitsView = loadView(visits);
  const surveysView = loadView(surveys);

  const upcoming = (visits.data?.items ?? [])
    .filter((a) => new Date(a.startsAt).getTime() > Date.now() && a.status !== "cancelled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const next = upcoming[0];

  /*
   * Только непройденное: спершу почате на этом устройстве, потом
   * назначенное (по сроку), потом доступное. Пройденное главная не зовёт
   * проходить — у МЛО двести пунктов, и «вы уже проходили» пришло бы только
   * при отправке.
   */
  const draftOf = new Map(local.map((d) => [d.surveyId, d]));
  const open = (surveys.data ?? []).filter((s) => s.status === "published" && (!s.completedByMe || draftOf.has(s.id)));
  const rank = (s: SurveyListItem) => (draftOf.has(s.id) ? 0 : s.assigned ? 1 : 2);
  const todo = [...open]
    .sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))
    .slice(0, 3);
  const assignedOpen = open.filter((s) => s.assigned);

  /* строка открытого: каждое открытое дело — пилюлей со своим переходом */
  const chips: ReactNode[] = [];
  if (next) {
    chips.push(
      <StripChip
        key="visit"
        /* к карточке приёма на этой же странице: подтверждают там, а на телефоне она ниже пилюль */
        href="#visit"
        tone={next.status === "booked" ? "warn" : "plain"}
        icon={<Glyph name="calendar-clock" size={16} />}
        label={`${ut("ptw.visitChip")} ${shortDay(next.startsAt)}`}
        detail={next.status === "booked" ? ut("ptw.toConfirm") : hm(next.startsAt)}
      />,
    );
  }
  for (const d of local.slice(0, 1)) {
    chips.push(
      <StripChip
        key={`d-${d.surveyId}`}
        to={`/me/tests/${d.surveyId}`}
        icon={<Glyph name="hourglass" size={16} />}
        label={d.title ? (instrumentCode(d.title) ?? instrumentName(d.title)) : ut("ptw.started")}
        detail={ut("ptw.started")}
      />,
    );
  }
  for (const s of assignedOpen.filter((s) => !draftOf.has(s.id)).slice(0, 2)) {
    chips.push(
      <StripChip
        key={`s-${s.id}`}
        to={`/me/tests/${s.id}`}
        icon={<ShellIcon name="clipboard-check" size={16} />}
        label={instrumentCode(s.title) ?? instrumentName(s.title)}
        detail={s.dueAt ? `${ut("ptw.dueUntil")} ${dm(s.dueAt)}` : ut("pt.assigned")}
      />,
    );
  }
  if (pending) {
    chips.push(
      <StripChip
        key="outbox"
        to="/me/tests"
        tone="warn"
        icon={<Ic.inbox size={16} />}
        label={ut("pt.outboxWaiting")}
        detail={String(pending)}
      />,
    );
  }

  const visitCard =
    visitsView === "wait" || visitsView === "failed" ? (
      <BandCard>
        <Pending res={visits} />
      </BandCard>
    ) : next ? (
      <VisitCard visit={next} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />
    ) : (
      <BandCard>
        <div className="flex items-center gap-2.5">
          <HeadTile icon={<Glyph name="calendar-clock" size={17} />} />
          <b className="text-[16px] font-extrabold">{ut("pt.nextVisit")}</b>
        </div>
        <p className="m-0 mt-3 text-[16px] leading-6 text-text-2">{ut("pt.noVisit")}</p>
        <ButtonLink className="mt-3.5" variant="primary" size="md" to="/me/booking">
          <ShellIcon name="calendar-plus" size={18} />
          {ut("pt.bookNow")}
        </ButtonLink>
      </BandCard>
    );

  const wellbeing = (dynamics?.surveys ?? [])
    .flatMap((s) => s.scales.map((sc) => ({ survey: s, scale: sc })))
    .filter((x) => x.scale.points.length > 0)
    .sort((a, b) => (b.scale.points.at(-1)?.submittedAt ?? "").localeCompare(a.scale.points.at(-1)?.submittedAt ?? ""))
    .slice(0, 3);

  return (
    <>
      <Hero title={ut(greetingKey())} lead={ut("ptw.homeLead")} aside={visitCard}>
        {chips.length ? (
          <ul aria-label={ut("ptw.openForYou")} className="m-0 mt-[18px] flex list-none flex-wrap gap-2 p-0">
            {chips.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        ) : null}
      </Hero>
      <Body>
        <SideGrid
          side={
            <PtPanel title={ut("ptw.ifHard")} icon={<Glyph name="heart-handshake" size={16} />}>
              <p className="m-0 text-[15.5px] leading-[23px] text-text-2">{ut("ptw.ifHardText")}</p>
              <div className="mt-3">
                <CallRows />
              </div>
              {plan ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button
                    icon={<ShellIcon name="shield-check" size={16} />}
                    aria-haspopup="dialog"
                    aria-expanded={planOpen}
                    onClick={() => setPlanOpen(true)}
                  >
                    {ut("ptw.myPlan")}
                  </Button>
                  <span className="text-[14px] text-text-2">{`${ut("ptw.planFrom")} ${dm(plan.createdAt)}`}</span>
                </div>
              ) : null}
            </PtPanel>
          }
        >
          <PtPanel
            title={ut("ptw.homeTodo")}
            icon={<ShellIcon name="clipboard-check" size={16} />}
            sub={assignedOpen.length ? `${ut("ptw.assignedCount")}: ${assignedOpen.length}` : undefined}
            actions={
              <ButtonLink to="/me/tests" variant="ghost" size="xs">
                {ut("ptw.allTests")}
              </ButtonLink>
            }
            flush
          >
            {surveysView === "wait" || surveysView === "failed" ? (
              <div className="px-[18px] pb-[18px]">
                <Pending res={surveys} />
              </div>
            ) : todo.length === 0 ? (
              <p className="m-0 px-[18px] pb-[18px] text-[16px] text-muted">{ut("pt.noTests")}</p>
            ) : (
              todo.map((s, i) => {
                const d = draftOf.get(s.id);
                return (
                  <div
                    key={s.id}
                    className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-divider px-[18px] py-4 first:border-t-0 first:pt-1.5 max-[600px]:grid-cols-[48px_minmax(0,1fr)] max-[600px]:gap-y-3"
                  >
                    <CodeTile title={s.title} tone={d || !s.assigned ? "neutral" : "violet"} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[17px] font-extrabold leading-6 text-text">
                        <span className="min-w-0">{instrumentName(s.title)}</span>
                        {d ? (
                          <Tag icon={<Glyph name="hourglass" size={12} />}>{ut("ptw.started")}</Tag>
                        ) : s.dueAt ? (
                          <Tag tone="primary" icon={<Ic.calendar size={12} />}>{`${ut("ptw.dueUntil")} ${dm(s.dueAt)}`}</Tag>
                        ) : null}
                      </div>
                      <MetaLine
                        items={[
                          { key: "n", icon: <ShellIcon name="list-checks" size={15} />, text: `${ut("ms.questions")}: ${s.questionCount}` },
                          ...(d
                            ? [{ key: "at", icon: <Glyph name="clock" size={15} />, text: `${ut("ptw.startedWhen")} ${whenSaid(d.startedAt, ut)}` }]
                            : s.assigned
                              ? [{ key: "who", icon: <Glyph name="user-round" size={15} />, text: ut("ptw.assignedBySpecialist") }]
                              : []),
                        ]}
                      />
                    </div>
                    <ButtonLink
                      to={`/me/tests/${s.id}`}
                      variant={i === 0 ? "primary" : "secondary"}
                      size="md"
                      className="max-[600px]:col-span-2 max-[600px]:w-full"
                      aria-label={`${d ? ut("ptw.continue") : ut("pt.start")}: ${s.title}`}
                    >
                      {d ? ut("ptw.continue") : ut("pt.start")}
                      {i === 0 ? <Ic.arrowRight size={17} /> : null}
                    </ButtonLink>
                  </div>
                );
              })
            )}
          </PtPanel>
          {wellbeing.length ? (
            <PtPanel title={ut("ptw.wellbeing")} icon={<Glyph name="activity" size={16} />} sub={ut("ptw.wellbeingSub")}>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-5">
                {wellbeing.map(({ survey, scale }) => (
                  <WellbeingBlock key={`${survey.surveyId}-${scale.code}`} title={survey.title} scale={scale} />
                ))}
              </div>
              <Callout kind="neutral" icon={<Glyph name="message-more" size={16} />} title={ut("ptw.notDiagnosisTitle")} className="mt-4 text-[15px] leading-[22px]">
                {ut("ptw.notDiagnosisText")}
              </Callout>
            </PtPanel>
          ) : null}
        </SideGrid>
      </Body>
      {plan ? <SafetyPlanDrawer plan={plan} open={planOpen} onClose={() => setPlanOpen(false)} /> : null}
    </>
  );
}

/** Квадрат значка 32 в шапке карточки на полосе */
function HeadTile({ icon }: { icon: ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-control bg-violet-tint text-violet-ink supports-[corner-shape:squircle]:rounded-[14px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
    >
      {icon}
    </span>
  );
}

/** Пилюля строки открытого на полосе (pt-strip): переход к своему делу */
function StripChip({
  to,
  href,
  icon,
  label,
  detail,
  tone = "plain",
}: {
  /** Переход на экран кабинета */
  to?: string;
  /** Место на этой странице («#visit») */
  href?: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  tone?: "plain" | "warn";
}) {
  const className = cx(
        "inline-flex h-[38px] items-center gap-1.5 rounded-[19px] pl-[11px] pr-[13px] text-[13.5px] font-semibold text-text-2 no-underline transition-colors hover:no-underline",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        tone === "warn"
          ? "bg-warn-tint text-warn hover:bg-warn-tint-2"
          : "bg-band-card shadow-[inset_0_0_0_1px_var(--bcardline)] hover:bg-violet-tint-2",
  );
  const inner = (
    <>
      <span className={cx("inline-flex", tone === "warn" ? "text-warn" : "text-violet-ink")}>{icon}</span>
      <b className={cx("font-extrabold", tone === "warn" ? "text-warn" : "text-text")}>{label}</b>
      {detail ? <span>{detail}</span> : null}
    </>
  );
  return href ? (
    <a href={href} className={className}>
      {inner}
    </a>
  ) : (
    <Link to={to ?? "/me"} className={className}>
      {inner}
    </Link>
  );
}

/** Карточка ближайшего приёма на полосе: когда, где, с кем; подтвердить, перенести, отменить */
function VisitCard({
  visit,
  busy,
  onConfirm,
  onCancel,
}: {
  visit: Visit;
  busy: boolean;
  onConfirm: (id: string) => void;
  onCancel: (visit: Visit) => void;
}) {
  const { ut } = useLang();
  const late = lateCancel(visit.startsAt);
  const place = visit.mode === "remote" ? ut("pt.remote") : visit.room ? `${ut("pt.room")} ${visit.room}` : null;
  return (
    <BandCard id="visit" className="scroll-mt-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <HeadTile icon={<Glyph name="calendar-clock" size={17} />} />
        <b className="text-[16px] font-extrabold">{ut("pt.nextVisit")}</b>
        <span className="ml-auto">
          {visit.status === "booked" ? (
            <Tag tone="attention" icon={<Glyph name="clock" size={12} />}>
              {ut("ptw.awaitsConfirm")}
            </Tag>
          ) : (
            <Tag tone="good" icon={<Ic.check size={12} />}>
              {ut("ptw.confirmedTag")}
            </Tag>
          )}
        </span>
      </div>
      <div className="mt-3 text-[24px] font-extrabold leading-[30px] tracking-[-0.02em] text-text max-[600px]:text-[21px] max-[600px]:leading-7">
        {visitWhen(visit.startsAt, visit.endsAt)}
      </div>
      <p className="m-0 mt-1 flex flex-wrap items-center gap-x-3 text-[15px] leading-[22px] text-text-2">
        {place ? (
          <span className="inline-flex items-center gap-1.5">
            <Glyph name={visit.mode === "remote" ? "video" : "map-pin"} size={15} className="text-muted" />
            {place}
          </span>
        ) : null}
        <span>{visit.specialistName}</span>
      </p>
      {/*
        Подтверждение — действие, ради которого экран открывают по дороге;
        отмена — за «…», не рядом с ним: промах пальцем стоил бы встречи
        (#178), и окно отмены всё равно спросит.
      */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {visit.status === "booked" ? (
          <Button variant="primary" size="md" icon={<Ic.check size={18} />} disabled={busy} onClick={() => onConfirm(visit.id)}>
            {ut("pt.confirm")}
          </Button>
        ) : null}
        {visit.mode === "remote" && visit.meetingUrl ? (
          <a
            href={visit.meetingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-12 items-center gap-2 rounded-[12px] bg-violet-tint px-[18px] text-[15px] font-bold text-violet-ink no-underline hover:bg-violet-tint-2 hover:no-underline"
          >
            <Glyph name="video" size={18} />
            {ut("pt.join")}
          </a>
        ) : null}
        <ButtonLink to={`/me/booking?move=${visit.id}`} size="md">
          <Glyph name="calendar-sync" size={18} />
          {ut("ptw.move")}
        </ButtonLink>
        <ActionMenu
          label={ut("ptw.visitMore")}
          triggerSize="md"
          triggerClassName="w-11 px-0"
          entries={[{ key: "cancel", label: ut("ptw.cancelVisit"), icon: <Glyph name="calendar-x" size={16} />, danger: true, onSelect: () => onCancel(visit) }]}
        />
      </div>
      <p className="m-0 mt-3 flex items-start gap-2 text-[13.5px] leading-[19px] text-muted">
        <Ic.info size={15} className="mt-0.5 shrink-0" />
        <span>
          {late
            ? ut("ptw.lateNow")
            : ut("ptw.freeUntil").replace("{d}", `${shortDay(freeCancelUntil(visit.startsAt))}, ${hm(freeCancelUntil(visit.startsAt))}`)}
        </span>
      </p>
    </BandCard>
  );
}

const SEVERITY: Record<string, Severity> = { none: "none", mild: "mild", moderate: "moderate", severe: "severe" };

/** Самочувствие по одной шкале: три последних замера плитками и полоса последнего — словом */
function WellbeingBlock({ title, scale }: { title: string; scale: DynScale }) {
  const { ut } = useLang();
  const points = scale.points.slice(-3);
  const last = points.at(-1)!;
  const first = scale.points[0]!;
  const delta = Math.round((last.value - first.value) * 10) / 10;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <b className="text-[16px] font-extrabold leading-[22px] text-text">{instrumentName(title)}</b>
        <span className="text-[13px] text-muted">{scale.code}</span>
      </div>
      <ol aria-label={`${scale.code}: ${ut("ptw.history")}`} className="m-0 mt-3 flex list-none items-stretch gap-1.5 p-0">
        {points.map((p, i) => {
          const now = i === points.length - 1;
          return (
            <li
              key={p.submittedAt}
              className={cx(
                "flex flex-1 flex-col gap-0.5 rounded-[14px] px-3 py-2.5 text-[13px] font-semibold leading-[17px]",
                now ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]" : "bg-sunk text-text-2",
              )}
            >
              <span className={now ? undefined : "text-muted"}>{dm(p.submittedAt)}</span>
              <b className={cx("text-[26px] font-extrabold leading-[30px] tabular-nums", now ? "text-violet-ink" : "text-text")}>
                {Math.round(p.value * 10) / 10}
              </b>
            </li>
          );
        })}
      </ol>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[14.5px] leading-5 text-text-2">
        {last.bandLabel ? <SeverityTag level={SEVERITY[last.severity ?? ""] ?? "none"}>{last.bandLabel}</SeverityTag> : null}
        {scale.points.length > 1 ? (
          <span>
            <b className="font-extrabold text-text tabular-nums">{delta > 0 ? `+${delta}` : String(delta)}</b>{" "}
            {ut("ptw.fromFirst")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
