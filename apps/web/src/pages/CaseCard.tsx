import { useMemo, useState } from "react";
import { Outlet, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { LOCALE_OF, type CaseSummary, type ReferralDestination, type ReferralUrgency, type RespondentDynamics } from "@quizzy/shared";
import { api, type TimelineItem } from "../api";
import { Here } from "../components/Here";
import { useLang } from "../lang";
import {
  AlertChip,
  AlertStrip,
  Avatar,
  Drawer,
  DrawerPane,
  DrawerSection,
  Ic,
  Loading,
  RiskChip,
  TextAction,
  Tooltip,
  useAction,
  useToast,
} from "../ui";
import { IconPrint } from "../ui";
import { Button, ButtonLink, ChoiceCard, Segmented, Tabs, Tag, Textarea } from "../ui/primitives";
import { useResource, type Resource } from "../useResource";
import { ShellIcon } from "../shell/icons";
import { fill, PageRules, SheetFoot, SheetHead, sheetDate, sheetTime, usePrintedBy } from "./printSheet";
import { DYN_KEY, TL_KEY, capital, ddmm, hhmm, whenShort } from "./patients/model";
import { DESTINATION_KEY, URGENCY_KEY } from "./referrals/model";

/**
 * Клиническая справа пациента: огляд, динаміка, хронологія — кадры
 * patients-case, patients-case-dynamics, patients-case-timeline набора.
 *
 * Адрес — /patients/:id/case. Сам /patients/:id — карточка пациента
 * (pages/patientCard, участок v2-card); сюда из неё ведёт «Клінічна
 * карта», а отсюда туда — «Картка пацієнта» в шапке: у двух записей одного
 * человека имена одни и те же с обеих сторон. Прежние адреса (/summary,
 * /dynamics, /timeline) перенаправляются (App.tsx).
 *
 * Шапка — карточка на полосе, как у карточки пациента: имя, кто это, кто
 * ведёт, и строка открытого — всё открытое по человеку пилюлями, у каждой
 * своё действие (сигнал → «Розібрати», черновик → продолжить, неявка, приём,
 * назначенная методика, направления). Под ней — вкладки справы. Шапка не
 * перерисовывается при переключении вкладок: это свойства человека.
 *
 * Действия — в ящике, страница стоит: «Виписати направлення» открывает ящик
 * с формой (кадр patients-referral-new), Esc сохраняет набранное.
 *
 * Вкладка стоит в адресе, а не в состоянии: справу пересылают коллеге и
 * кладут в закладку.
 */

/** Что шапка уже загрузила — вкладки не спрашивают второй раз */
export interface CardContext {
  data: CaseSummary;
  reload: () => void;
  dynamics: Resource<RespondentDynamics>;
  timeline: Resource<TimelineItem[]>;
  /** Открыть ящик «Виписати направлення» */
  openReferral: () => void;
}

export function useCaseCard(): CardContext {
  return useOutletContext<CardContext>();
}

export default function CaseCard() {
  const { userId } = useParams<{ userId: string }>();
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  const navigate = useNavigate();
  const toast = useToast();
  const printedBy = usePrintedBy();
  const [referral, setReferral] = useState(false);

  /* keep: false — справа прежнего пациента не стоит под адресом следующего (#177) */
  const res = useResource(() => api.caseSummary(userId!), [userId], { enabled: !!userId, keep: false });
  const card = useResource(() => api.patientCard(userId!), [userId], { enabled: !!userId, keep: false });
  const dynamics = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId, keep: false, key: DYN_KEY });
  const timeline = useResource(() => api.timeline(userId!), [userId], { enabled: !!userId, keep: false, key: TL_KEY });
  /* разговоры читателя: письмо пациента, на которое ещё не ответили, — тоже открытое */
  const threads = useResource(() => api.threads(), [], { key: "case-threads" });
  const form = useReferralPane(res.data, () => {
    setReferral(false);
    res.reload();
    timeline.reload();
  });

  if (!res.data) {
    return (
      <div className="px-5 pt-5">
        <Loading rows={6} error={res.error} onRetry={res.reload} busy={res.loading} />
      </div>
    );
  }
  const data = res.data;
  const now = Date.now();
  const words = { today: ut("plist.today"), tomorrow: ut("plist.tomorrow") };
  const items = timeline.data ?? [];
  const past = items.filter((e) => Date.parse(e.at) <= now);
  const nextVisit = items
    .filter((e) => e.kind === "visit" && (e.detail === "booked" || e.detail === "confirmed") && Date.parse(e.at) > now)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const noShow = items.find(
    (e) => e.kind === "visit" && e.detail === "no_show" && now - Date.parse(e.at) < 30 * 86_400_000,
  );
  const openAssignments = items.filter((e) => e.kind === "assignment" && e.detail === "open");
  const drafts = data.conclusions.filter((c) => !c.signedAt);
  const openRefs = data.referrals.filter((r) => r.status === "created" || r.status === "accepted");
  const measures = (dynamics.data?.surveys ?? []).reduce((n, s) => n + s.responseCount, 0);
  const firstAt = (dynamics.data?.surveys ?? []).map((s) => s.firstAt ?? "").filter(Boolean).sort()[0];
  const lead = card.data?.lead ?? null;
  const thread = threads.data?.items.find((t) => t.patientId === data.userId && t.unread > 0) ?? null;
  const anyOpen = !!(data.openAlerts.length || thread || noShow || nextVisit || drafts.length || openAssignments.length || openRefs.length);

  const facts = [
    {
      icon: <Ic.user size={15} />,
      text: [
        data.age !== null ? `${data.age} ${ut("pg.yearSuffix")}` : null,
        data.sex === "male" ? ut("case.male") : data.sex === "female" ? ut("case.female") : null,
      ]
        .filter(Boolean)
        .join(", "),
    },
    { icon: <Ic.idCard size={15} />, text: data.unit ?? "" },
    {
      icon: <Ic.clipboard size={15} />,
      text: measures ? ut("case.measures").replace("{n}", String(measures)).replace("{d}", firstAt ? ddmm(firstAt, locale) : "—") : "",
    },
    {
      icon: <ShellIcon name="stethoscope" size={15} />,
      text: lead ? ut("case.lead").replace("{name}", lead.name) : card.data ? ut("case.noLead") : "",
    },
  ].filter((f) => f.text);

  const copyLink = () =>
    void navigator.clipboard.writeText(location.href).then(
      () => toast(ut("case.linkCopied"), "ok"),
      () => toast(ut("ui.actionFailed"), "err"),
    );

  return (
    <>
      {/*
        Шапка листа на бумаге (UI 3, print-dynamics): знак, дата и «станом
        на» — как у листов сервера; на экране её нет. Поля страницы —
        «Сторінка N з M» и имя человека внизу каждого листа.
      */}
      <div className="print-only case-print">
        <PageRules running={data.fullName} />
        <SheetHead primary={sheetDate()} secondary={fill(ut("ps.asOf"), { time: sheetTime() })} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 bg-band px-5 pb-0 pt-4 max-[700px]:px-3">
          <section
            aria-labelledby="case-name"
            className="rounded-drawer border border-band-card-line bg-band-card px-5 pb-3 pt-4 shadow-banner max-[700px]:px-3.5"
          >
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
              <Avatar name={data.fullName} size={56} />
              <div className="min-w-0 flex-1">
                <h1 id="case-name" className="m-0 text-title font-extrabold leading-8 tracking-[-0.02em] text-text">
                  {data.fullName}
                </h1>
                <p className="m-0 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-2">
                  {facts.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 [&>svg]:text-muted">
                      {f.icon}
                      {f.text}
                    </span>
                  ))}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
                <ButtonLink to={`/patients/${data.userId}`}>
                  <Ic.idCard size={16} className="mr-2" />
                  {ut("case.card")}
                </ButtonLink>
                <Button
                  icon={<ShellIcon name="arrow-right-left" />}
                  aria-expanded={referral}
                  onClick={() => setReferral(true)}
                >
                  {ut("ref.new")}
                </Button>
                <Tooltip label={ut("sum.print")}>
                  <Button size="icon" aria-label={ut("sum.print")} onClick={() => window.print()}>
                    <IconPrint />
                  </Button>
                </Tooltip>
              </div>
            </div>
            {/*
              Открытого нет — строки нет: прежде на её месте стоял зелёный
              значок без подписи («відкритого немає» — только для диктора),
              и его принимали за кнопку или за «всё проверено».
            */}
            {anyOpen ? (
              <AlertStrip className="mt-3 print:hidden">
                {data.openAlerts.length ? (
                  <RiskChip
                    title={
                      data.openAlerts.length > 1
                        ? ut("plist.signals").replace("{n}", String(data.openAlerts.length))
                        : `${ut("evt.signal")}: ${data.openAlerts[0]!.surveyTitle}`
                    }
                    pop={
                      <span className="flex flex-col gap-1">
                        {data.openAlerts.map((a) => (
                          <span key={a.id}>
                            {a.surveyTitle}: {a.label}, {ddmm(a.at, locale)} {hhmm(a.at, locale)}
                          </span>
                        ))}
                      </span>
                    }
                    action={
                      <Button variant="risk" size="xs" className="rounded-2xl" onClick={() => navigate(`/alerts?patient=${data.userId}`)}>
                        {ut("plist.review")}
                      </Button>
                    }
                  />
                ) : null}
                {thread ? (
                  <AlertChip
                    kind="message"
                    icon={<Ic.message />}
                    label={ut("case.message")}
                    detail={ut("case.unreadN").replace("{n}", String(thread.unread))}
                    to={`/messages/${thread.id}`}
                  />
                ) : null}
                {noShow ? (
                  <AlertChip
                    kind="warn"
                    icon={<Ic.calendar />}
                    label={ut("plist.noShow").replace("{d}", ddmm(noShow.at, locale))}
                    pop={noShow.title || undefined}
                    to={`/patients/${data.userId}/case/timeline`}
                  />
                ) : null}
                {nextVisit ? (
                  <AlertChip
                    icon={<Ic.calendar />}
                    label={ut("case.visit")}
                    detail={whenShort(nextVisit.at, now, locale, words).text}
                    to={nextVisit.href ?? undefined}
                  />
                ) : null}
                {drafts.map((c) => (
                  <AlertChip
                    key={c.responseId}
                    icon={<Ic.pen />}
                    label={ut("qv.draft")}
                    detail={c.surveyTitle}
                    draft
                    to={`/responses/${c.responseId}/conclusion`}
                  />
                ))}
                {openAssignments.slice(0, 2).map((a) => (
                  <AlertChip
                    key={a.id}
                    icon={<Ic.clipboard />}
                    label={a.title}
                    detail={ut("evt.open")}
                    pop={ut("case.assignedOn").replace("{d}", ddmm(a.at, locale))}
                  />
                ))}
                {openRefs.length ? (
                  <AlertChip
                    icon={<ShellIcon name="arrow-right-left" />}
                    label={ut("ref.title")}
                    detail={String(openRefs.length)}
                    pop={
                      <span className="flex flex-col gap-1">
                        {openRefs.map((r) => (
                          <span key={r.id}>
                            {ut(DESTINATION_KEY[r.destination])}, {ut(URGENCY_KEY[r.urgency]).toLowerCase()}
                          </span>
                        ))}
                      </span>
                    }
                  />
                ) : null}
              </AlertStrip>
            ) : null}
          </section>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pb-2 print:hidden">
            <Tabs
              label={ut("pcard.clinical")}
              items={[
                { to: `/patients/${data.userId}/case`, label: ut("case.overview"), end: true },
                { to: `/patients/${data.userId}/case/dynamics`, label: ut("pc.dynamics") },
                { to: `/patients/${data.userId}/case/timeline`, label: ut("tl.title"), count: timeline.data ? past.length : null },
              ]}
            />
            <span className="ml-auto flex items-center gap-3 text-small text-text-2">
              <Here resource={`patient:${data.userId}`} />
              <TextAction onClick={copyLink}>
                <Ic.external size={14} className="mr-1.5" />
                {ut("case.copyLink")}
              </TextAction>
            </span>
          </div>
        </header>

        <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 pb-8 pt-4 outline-none max-[700px]:px-3">
          <Outlet
            context={
              {
                data,
                reload: res.reload,
                dynamics,
                timeline,
                openReferral: () => setReferral(true),
              } satisfies CardContext
            }
          />
          {/* штамп для подшивки: без «кто и когда распечатал» лист в деле безымянный */}
          <div className="print-only case-print">
            <SheetFoot lines={[printedBy, ut("ps.secrecy")]} right={data.fullName} />
          </div>
        </div>
      </div>

      <Drawer open={referral} onClose={() => setReferral(false)} onReturn={() => setReferral(true)}>
        <DrawerPane mode="referral" {...form.pane}>
          {form.body}
        </DrawerPane>
      </Drawer>
    </>
  );
}

/* ─────────── «Виписати направлення» ─────────── */

const DESTINATIONS: { value: ReferralDestination; sub: Parameters<ReturnType<typeof useLang>["ut"]>[0] }[] = [
  { value: "psychiatrist", sub: "case.destPsychiatrist" },
  { value: "inpatient", sub: "case.destInpatient" },
  { value: "outpatient", sub: "case.destOutpatient" },
  { value: "commander", sub: "case.destCommander" },
  { value: "other", sub: "case.destOther" },
];

/**
 * Ящик направления (кадр patients-referral-new): куда (пять вариантов),
 * терміновість с пояснением, підстава. Направление выписывается тем же
 * маршрутом, что и раньше (POST /api/referrals); дальше оно живёт на экране
 * направлений и в справе: виписано → прийнято → завершено (или відхилено).
 */
function useReferralPane(data: CaseSummary | null, onDone: () => void) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [destination, setDestination] = useState<ReferralDestination>("psychiatrist");
  const [urgency, setUrgency] = useState<ReferralUrgency>("routine");
  const [reason, setReason] = useState("");
  const dirty = reason.trim() !== "" || destination !== "psychiatrist" || urgency !== "routine";
  const urgencyNote = useMemo(
    () => ({ routine: ut("case.urgRoutine"), urgent: ut("case.urgUrgent"), immediate: ut("case.urgImmediate") })[urgency],
    [urgency, ut],
  );
  const issue = () =>
    data &&
    run(async () => {
      await api.createReferral({ userId: data.userId, destination, urgency, reason: reason.trim() || null });
      setReason("");
      setDestination("psychiatrist");
      setUrgency("routine");
      onDone();
    }, ut("ref.issuedToast"));

  return {
    pane: {
      title: ut("ref.new"),
      sub: data?.openAlerts.length ? ut("case.refSubSignal") : ut("case.refSub"),
      icon: <ShellIcon name="arrow-right-left" />,
      dirty,
      draftName: ut("case.refDraft"),
      note: ut("case.refLifecycle"),
      noteIcon: <Ic.list />,
      footer: (
        <>
          <Button variant="primary" icon={<ShellIcon name="arrow-right-left" />} disabled={busy || !data} onClick={() => void issue()}>
            {ut("ref.issue")}
          </Button>
          <Button onClick={onDone}>{ut("common.cancel")}</Button>
        </>
      ),
    },
    body: data ? (
      <>
        <DrawerSection>
          <div className="flex items-center gap-3 rounded-panel bg-sunk px-3.5 py-3">
            <Avatar name={data.fullName} size={34} />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-body font-extrabold text-text">{data.fullName}</b>
              <small className="block truncate text-caption text-muted">
                {[data.age !== null ? `${data.age} ${ut("pg.yearSuffix")}` : null, data.unit].filter(Boolean).join(", ")}
              </small>
            </span>
            {data.openAlerts.length ? (
              <Tag tone="danger" icon={<Ic.alert />}>
                {ut("plist.signal")}
              </Tag>
            ) : null}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("ref.where")}>
          <div role="radiogroup" aria-label={ut("ref.where")} className="grid grid-cols-2 gap-1.5 max-[520px]:grid-cols-1">
            {DESTINATIONS.map((d) => (
              <ChoiceCard
                key={d.value}
                name="referral-destination"
                value={d.value}
                checked={destination === d.value}
                onChange={(v) => setDestination(v as ReferralDestination)}
                title={capital(ut(DESTINATION_KEY[d.value]))}
                sub={ut(d.sub)}
              />
            ))}
          </div>
        </DrawerSection>
        <DrawerSection title={ut("ref.urgency")}>
          <Segmented
            wide
            label={ut("ref.urgency")}
            value={urgency}
            onChange={setUrgency}
            items={(["routine", "urgent", "immediate"] as const).map((u) => ({ key: u, label: capital(ut(URGENCY_KEY[u])) }))}
          />
          <p className="m-0 mt-2 text-caption text-text-2">{urgencyNote}</p>
        </DrawerSection>
        <DrawerSection title={ut("ref.reason")}>
          <Textarea
            value={reason}
            rows={5}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
            placeholder={ut("ref.reasonPlaceholder")}
            aria-label={ut("ref.reason")}
          />
        </DrawerSection>
      </>
    ) : null,
  };
}
