import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { PatientCard as PatientCardData } from "@quizzy/shared";
import { api, openInTab } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { Drawer, DrawerPane, Ic, IconPrint, Loading, useAction, useToast } from "../../ui";
import type { MenuEntry } from "../../ui/menu";
import { Here } from "../../components/Here";
import { usePersonCases, useRiskReview, useSafetyPlans } from "../../components/RiskReview";
import { AssignDrawer } from "../../components/AssignDrawer";
import { ShellIcon } from "../../shell/icons";
import { fill, PageRules, SheetFoot, SheetHead, sheetDate, sheetTime, usePrintedBy } from "../printSheet";
import { Banner } from "./Banner";
import { clinicalPicture, lastSession, nextVisit, openAssignments, openNoShow, visitsOf, type TimelineRow } from "./clinical";
import { DynamicsTab } from "./Dynamics";
import { useCodeKeys } from "./keys";
import { Overview } from "./Overview";
import { useBookPane, useConclusionPane, useEpisodePane, useNotePane, usePlanPane, useThreadPane } from "./Panes";
import { PatientList } from "./PatientList";
import { RecordsTab } from "./Records";
import { ReferralsTab, useReferralPane } from "./ReferralsTab";
import { MeasuresTab, MessagesTab } from "./TabViews";
import { TimelineTab } from "./Timeline";
import { CARD_TABS, tabRoute } from "./tabs";
import { leadAction, withConclusion, withEpisode, withLead, withReferral } from "./model";
import type { CardRefresh, CardTab, CardView, OpenOpts, PaneMode, ThreadMessage } from "./types";
import type { ThreadLike } from "./listModel";
import { Pi } from "./icons";

/*
 * Рабочее место пациента — одна страница о человеке (участок dp-patient).
 *
 * Прежде страниц было две: «Картка пацієнта» (/patients/:id: Огляд, Заміри,
 * Графіки, Заключення, Прийоми, Листування, Нотатки, Події) и «Клінічна
 * карта» (/patients/:id/case: Огляд справи, Динаміка, Хронологія) — с
 * таблицами результатов, графиками, лентами событий и заметками на обеих,
 * под разными именами. Теперь страница одна:
 *
 *   слева   — колонка «Мої пацієнти» (PatientList), J/K и «[»;
 *   сверху  — шапка: кто это, кто ведёт, обращение и его повод, ближайший
 *             приём, открытый случай риска и план безпеки, действия дня
 *             (Banner);
 *   вкладки — Огляд (клиническая картина по доменам, риск, план, последние
 *             записи), Динаміка (методика целиком), Заміри, Записи (записи
 *             прийому и заключения), Направлення, Листування, Хронологія;
 *   справа  — ящик действий: разбор (R), переписка (M), запись прийому (N),
 *             заключение, запись на приём, план безпеки, обращение,
 *             направление. Esc закрывает и оставляет черновик.
 *
 * Прежние адреса — /case, /case/dynamics, /case/timeline, /summary, старые
 * ?tab= — ведут сюда же (App.tsx, tabs.ts); ?pane=plan открывает вид ящика
 * (так ведёт сюда «Весь план» из ящика разбора на экране случаев).
 *
 * Журнал. Открытие пациента читает GET /api/patients/:id/card
 * (patient.card_read), динамику, хронологию, нотатки и план (response.read)
 * и случаи (alert.list) — как прежде карточка. Сводка консилиума
 * (/referrals/summary) больше не читается вовсе: её «Огляд справи» стал
 * «Оглядом», а направления — своей вкладкой (GET /api/referrals?patient=,
 * referral.list с именем человека). Карточка приёма (clinic.visit_open) для
 * «Наступного прийому» больше не открывается: вид и формат приёма приходят
 * с карточкой. Права проверяет сервер; кнопки, ведущие в отказ, не рисуются.
 *
 * keep: false у всего, что про одного человека (#177): ответ о прежнем
 * пациенте не встаёт под имя следующего, пока идёт загрузка.
 */

const COLLAPSE_KEY = "polypsy.card.listCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

const PANES: readonly PaneMode[] = ["signal", "thread", "concl", "note", "book", "plan", "episode", "referral"];

export default function PatientCard() {
  const { userId } = useParams<{ userId: string }>();
  const id = userId!;
  const res = useResource(() => api.patientCard(id), [id], { keep: false });
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* приватное окно: свёрнутость просто не запомнится */
      }
      return !c;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1">
      <PatientList currentId={id} collapsed={collapsed} onCollapse={toggle} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {res.data && res.data.id === id ? (
          <CardRecord key={id} card={res.data} patchCard={res.patch} collapsed={collapsed} onExpand={toggle} />
        ) : (
          <div className="p-5">
            <Loading rows={6} error={res.error} onRetry={res.reload} />
          </div>
        )}
      </div>
    </div>
  );
}

function CardRecord({
  card,
  patchCard,
  collapsed,
  onExpand,
}: {
  card: PatientCardData;
  /** Подменить карточку после своего действия: чтение карточки — одно на открытие (журнал) */
  patchCard: (next: PatientCardData) => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const id = card.id;
  const { ut } = useLang();
  const { user, can } = useAuth();
  const { run, busy } = useAction();
  const toast = useToast();
  const printedBy = usePrintedBy();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* ── вкладка в адресе: рабочее место пересылают коллеге и кладут в закладку ── */
  const [params, setParams] = useSearchParams();
  const route = tabRoute(params.get("tab"));
  const tab = route.tab;
  const rewrite = route.rewrite ? JSON.stringify(route.rewrite) : null;
  useEffect(() => {
    if (!rewrite) return;
    /* прежнее значение ?tab= — на нынешнее: «Заключення» — это «Записи» с видом заключений */
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, val] of Object.entries(JSON.parse(rewrite) as Record<string, string>)) {
          if (val) next.set(k, val);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  }, [rewrite, setParams]);
  const goTab = useCallback(
    (t: CardTab, extra?: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          /* отбор прежней вкладки новой не принадлежит */
          next.delete("kind");
          next.delete("m");
          if (t === "overview") next.delete("tab");
          else next.set("tab", t);
          for (const [k, val] of Object.entries(extra ?? {})) {
            if (val) next.set(k, val);
            else next.delete(k);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  /* ── данные человека ── */
  const dynamics = useResource(() => api.dynamics(id), [id], { keep: false });
  const timeline = useResource(() => api.timeline(id), [id], { keep: false });
  const cases = usePersonCases(id);
  const threads = useResource(
    () =>
      can("messages.write")
        ? api
            .threads()
            .then((r) => r.items as ThreadLike[])
            .catch(() => [] as ThreadLike[])
        : Promise.resolve([] as ThreadLike[]),
    [id],
  );
  const thread = threads.data?.find((t) => t.patientId === id) ?? null;
  const messages = useResource(
    () => (thread ? api.thread(thread.id).then((r) => r.items as ThreadMessage[]) : Promise.resolve(null)),
    [thread?.id, thread?.lastMessageAt, thread?.unread],
    { enabled: !!thread },
  );
  const notes = useResource(() => api.notes(id), [id], { keep: false });
  /* тот же запрос, что у ящика разбора и вида плана (общее имя): план читается раз на страницу */
  const plans = useSafetyPlans(id);
  /* направления человека — только когда вкладка открыта: это чтение его поводов (журнал) */
  const referrals = useResource(() => api.referrals(true, null, { patient: id }), [id], {
    enabled: tab === "referrals" && can("referrals.manage"),
    keep: false,
  });

  const signalResponses = useMemo(
    () => new Set((cases.data ?? []).flatMap((c) => c.signals.map((s) => s.responseId))),
    [cases.data],
  );
  const picture = useMemo(() => clinicalPicture(dynamics.data, card.domains, signalResponses), [dynamics.data, card.domains, signalResponses]);

  const tl = (timeline.data ?? null) as TimelineRow[] | null;
  const visits = useMemo(() => visitsOf(tl ?? []), [tl]);
  const next = nextVisit(visits, now);
  /* хронология называет специалиста приёма ФИО — так же, как профиль вошедшего; карточка знает точно */
  const me = user?.fullName?.trim() ?? "";
  const known = next ? card.upcoming?.find((u) => u.id === next.id) : undefined;
  const nextIsMine = !!next && (known ? known.mine : !!me && next.specialist.trim() === me);

  /* ── ящик ── */
  const [drawer, setDrawer] = useState<{ open: boolean; mode: PaneMode }>({ open: false, mode: "signal" });
  const [assigning, setAssigning] = useState(false);
  const [conclFor, setConclFor] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);

  const open = useCallback((mode: PaneMode, opts?: OpenOpts) => {
    if (opts?.responseId) setConclFor(opts.responseId);
    if (opts?.slotId) setSlotId(opts.slotId);
    setDrawer({ open: true, mode });
  }, []);

  /* ?pane=plan — открыть вид ящика по ссылке (из ящика разбора на экране случаев) и снять параметр */
  const paneParam = params.get("pane");
  useEffect(() => {
    if (!paneParam) return;
    if ((PANES as readonly string[]).includes(paneParam)) open(paneParam as PaneMode);
    setParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        nextParams.delete("pane");
        return nextParams;
      },
      { replace: true },
    );
  }, [paneParam, open, setParams]);

  /*
   * После действия в ящике — только то, что оно меняет (CardRefresh): ни
   * карточка, ни случаи, ни план безпеки от переписки, нотатки, заключения или
   * записи на приём не меняются, а их чтения пишут журнал. Карточка правится
   * на месте от последней своей правки, а не от той, что видел рендер:
   * подпись после сохранения — две правки подряд.
   */
  const latest = useRef(card);
  const arrived = useRef(card);
  if (arrived.current !== card) {
    arrived.current = card;
    latest.current = card;
  }
  const patch = useCallback(
    (edit: (c: PatientCardData) => PatientCardData) => {
      latest.current = edit(latest.current);
      patchCard(latest.current);
    },
    [patchCard],
  );
  const refresh = useMemo<CardRefresh>(
    () => ({
      messages: threads.reload,
      timeline: timeline.reload,
      notes: (state) => (state ? notes.patch(state) : notes.reload()),
      conclusion: (responseId, state) => patch((c) => withConclusion(c, responseId, state)),
      episode: (episode) => patch((c) => withEpisode(c, episode)),
      referral: (r) => patch((c) => withReferral(c, r)),
    }),
    [threads.reload, timeline.reload, notes.patch, notes.reload, patch],
  );

  const v: CardView = {
    id,
    card,
    now,
    dynamics: dynamics.data ?? null,
    dynamicsError: dynamics.error,
    reloadDynamics: dynamics.reload,
    picture,
    timeline: tl,
    timelineError: timeline.data ? null : timeline.error,
    reloadTimeline: timeline.reload,
    visits,
    next,
    last: lastSession(visits, now),
    noShow: openNoShow(visits, now),
    assignments: openAssignments(tl ?? []),
    cases: cases.data ?? null,
    casesError: cases.data ? null : cases.error,
    reloadCases: cases.reload,
    thread,
    messages: messages.data ?? null,
    notes: notes.data ?? null,
    notesError: notes.data ? null : notes.error,
    reloadNotes: notes.reload,
    plan: plans.data?.versions.find((p) => p.active) ?? null,
    planKnown: !!plans.data,
    planError: plans.data ? null : plans.error,
    reloadPlan: plans.reload,
    nextIsMine,
    slotId,
    setSlotId,
    open,
    onAssign: can("assignments.manage") ? () => setAssigning(true) : null,
    goTab,
    pane: drawer.open ? drawer.mode : null,
    can,
    refresh,
  };

  const firstDraft = card.conclusions.find((c) => c.status === "draft");
  const reviewing = drawer.open && drawer.mode === "signal";
  /*
   * Разбор грузит своё (основание, историю пункта, план безпеки) только
   * открытым: открытие карточки — не чтение ответов о риске, и в журнал
   * «alert.signals» уходит, когда основание показали. Случаи человека —
   * общий с шапкой запрос: решение перечитывает их, и шапка видит то же.
   */
  const review = useRiskReview({
    userId: id,
    enabled: reviewing,
    after:
      firstDraft && can("conclusions.write") ? (
        <ButtonLike onClick={() => open("concl", { responseId: firstDraft.responseId })}>{ut("card.toConclusion")}</ButtonLike>
      ) : undefined,
  });
  const close = () => setDrawer((d) => ({ ...d, open: false }));
  const threadPane = useThreadPane(v, drawer.open && drawer.mode === "thread");
  const conclPane = useConclusionPane(v, drawer.open && drawer.mode === "concl", conclFor);
  const notePane = useNotePane(v, drawer.open && drawer.mode === "note");
  const bookPane = useBookPane(v, drawer.open && drawer.mode === "book");
  const planPane = usePlanPane(v, drawer.open && drawer.mode === "plan");
  const episodePane = useEpisodePane(v, drawer.open && drawer.mode === "episode");
  const referralPane = useReferralPane(
    v,
    (r) => {
      close();
      refresh.referral(r);
      refresh.timeline();
      referrals.reload();
    },
    close,
  );

  /* ── клавиши: R — разбор, M — письмо, N — запись прийому; 1–3 — исход в открытом разборе ── */
  useCodeKeys({
    KeyR: () => {
      /* и при отказе: ящик скажет «не вдалося перевірити» и даст повторить */
      if (can("alerts.review") && (cases.data?.length || cases.error)) open("signal");
    },
    KeyM: () => {
      if (can("messages.write")) open("thread");
    },
    KeyN: () => {
      if (can("notes.write")) open("note");
    },
    /* цифры — только при открытом разборе: подсказки 1–3 стоят на исходах, и без ящика клавиши свободны */
    ...(reviewing
      ? {
          Digit1: () => review.pick("confirmed"),
          Digit2: () => review.pick("needs_followup"),
          Digit3: () => review.pick("not_confirmed"),
        }
      : {}),
  });

  /* ── закрепление ── */
  const toggleLead = () =>
    void run(async () => {
      const take = !card.lead?.mine;
      await api.takeLead(card.id, take);
      if (user) patch((c) => withLead(c, take, user));
    }, ut(card.lead?.mine ? "pcard.unsubscribed" : "pcard.subscribed"));

  /* ── ящик встаёт под полосу с человеком: она липнет, и человек остаётся на виду ── */
  const bannerRef = useRef<HTMLElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = bannerRef.current;
    if (!el) return;
    const measure = () => setTop(window.innerWidth >= 1024 ? Math.round(el.getBoundingClientRect().bottom) : null);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const tabs = CARD_TABS.filter((t) => (t === "referrals" ? can("referrals.manage") : t === "messages" ? can("messages.write") : true));
  const shownTab: CardTab = tabs.includes(tab) ? tab : "overview";
  const counts: Partial<Record<CardTab, number>> = {
    measures: card.responses.length,
    records: (notes.data?.versions.length ?? 0) + card.conclusions.length || undefined,
    referrals: card.openReferrals?.length || undefined,
    messages: thread?.unread || undefined,
  };

  const copyLink = () =>
    void navigator.clipboard.writeText(location.href).then(
      () => toast(ut("case.linkCopied"), "ok"),
      () => toast(ut("ui.actionFailed"), "err"),
    );
  const menu: MenuEntry[] = [
    {
      key: "lead",
      label: ut(leadAction(card) === "unsubscribe" ? "pcard.unsubscribe" : "pcard.subscribe"),
      icon: <Pi.userPlus size={15} />,
      disabled: busy,
      onSelect: toggleLead,
    },
    { key: "episode", label: ut("ws.menuEpisode"), icon: <ShellIcon name="folder-tree" size={15} />, onSelect: () => open("episode") },
    { key: "plan", label: ut("ws.menuPlan"), icon: <Ic.shieldCheck size={15} />, onSelect: () => open("plan") },
    ...(can("referrals.manage")
      ? [{ key: "referral", label: ut("ref.new"), icon: <ShellIcon name="arrow-right-left" size={15} />, onSelect: () => open("referral") }]
      : []),
    { key: "print", label: ut("ws.printTab"), icon: <IconPrint />, ruled: true, onSelect: () => window.print() },
    { key: "chart", label: ut("ep.chart"), icon: <Ic.file size={15} />, onSelect: () => openInTab(`/api/reports/patients/${id}/chart`) },
    { key: "link", label: ut("case.copyLink"), icon: <Ic.external size={15} />, onSelect: copyLink },
  ];

  return (
    <>
      <div className="kit-scroll flex min-h-0 flex-1 flex-col overflow-y-auto" data-card-scroll="">
        {/*
          Шапка листа на бумаге (UI 3, print-dynamics): знак, дата и «станом
          на» — как у листов сервера; на экране её нет. Поля страницы —
          «Сторінка N з M» и имя человека внизу каждого листа.
        */}
        <div className="print-only case-print">
          <PageRules running={card.fullName} />
          <SheetHead primary={sheetDate()} secondary={fill(ut("ps.asOf"), { time: sheetTime() })} />
        </div>
        <Banner
          ref={bannerRef}
          v={v}
          tab={shownTab}
          onTab={(t) => goTab(t)}
          tabs={tabs}
          counts={counts}
          collapsed={collapsed}
          onExpand={onExpand}
          onAssign={() => setAssigning(true)}
          onToggleLead={toggleLead}
          leadBusy={busy}
          menu={menu}
          here={<Here resource={`patient:${id}`} />}
          drafts={{
            signal: !!review.pane.dirty,
            thread: !!threadPane.dirty,
            concl: !!conclPane.dirty,
            note: !!notePane.dirty,
          }}
        />
        <div id="card-tabpanel" role="tabpanel" aria-labelledby={`card-tab-${shownTab}`} className="px-5 pb-8 pt-4">
          {shownTab === "overview" ? (
            <Overview v={v} />
          ) : shownTab === "dynamics" ? (
            <DynamicsTab v={v} />
          ) : shownTab === "measures" ? (
            <MeasuresTab v={v} />
          ) : shownTab === "records" ? (
            <RecordsTab v={v} />
          ) : shownTab === "referrals" ? (
            <ReferralsTab v={v} res={referrals} />
          ) : shownTab === "messages" ? (
            <MessagesTab v={v} />
          ) : (
            <TimelineTab v={v} />
          )}
          {/* штамп для подшивки: без «кто и когда распечатал» лист в деле безымянный */}
          <div className="print-only case-print">
            <SheetFoot lines={[printedBy, ut("ps.secrecy")]} right={card.fullName} />
          </div>
        </div>
      </div>

      <div className="print:hidden" style={top !== null ? ({ "--ah": `${top}px` } as CSSProperties) : undefined}>
        <Drawer
          open={drawer.open}
          mode={drawer.mode}
          modal={false}
          wide={drawer.mode === "plan" || drawer.mode === "episode"}
          onClose={close}
          onReturn={(m) => setDrawer({ open: true, mode: (m as PaneMode) ?? "signal" })}
          label={ut("card.drawerLabel")}
        >
          <DrawerPane {...review.pane} />
          <DrawerPane {...threadPane} />
          <DrawerPane {...conclPane} />
          <DrawerPane {...notePane} />
          <DrawerPane {...bookPane} />
          <DrawerPane {...planPane} />
          <DrawerPane {...episodePane} />
          <DrawerPane {...referralPane} />
        </Drawer>
      </div>

      {/*
        «Призначити методику» — общий ящик назначения (как у групп и выбранных):
        поиск по названию и коду, срок кнопками, комментарий для пациента и
        набор вместо методики. Адресат — этот человек; ящик встаёт под полосу
        с ним, как остальные действия карточки.
      */}
      <div className="print:hidden" style={top !== null ? ({ "--ah": `${top}px` } as CSSProperties) : undefined}>
        <AssignDrawer
          choose="test"
          open={assigning}
          onClose={() => setAssigning(false)}
          onReturn={() => setAssigning(true)}
          who={card.fullName}
          whoNote={ut("card.assignNote")}
          comment
          existingFor={async (surveyId) => {
            /* прежняя выдача этой методики этому человеку — чтобы ящик сказал «вже призначено до …» */
            const mine = (await api.grants(surveyId)).find((g) => g.userId === card.id);
            return mine ? { until: mine.expiresAt, done: mine.completed } : null;
          }}
          onAssign={async (surveyId, expiresAt, note) => {
            /* выдача методики — строка доступа: ни карточка, ни хронология от неё не меняются */
            await api.grant(surveyId, card.id, note ?? undefined, expiresAt);
            return ut("pg.assigned");
          }}
          sets={{
            onAssign: async (batteryId, dueAt, note) => {
              await api.assignBattery(batteryId, card.id, dueAt, note);
              /* назначение набора — событие хронологии и строка «Плану» огляда */
              refresh.timeline();
              return ut("card.setAssigned");
            },
          }}
        />
      </div>
    </>
  );
}

/** Кнопка внутри заметки «розбір збережено»: следующий шаг — заключение */
function ButtonLike({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 min-h-0 cursor-pointer items-center rounded-[9px] border-0 bg-violet px-3 text-small font-bold text-onfill shadow-primary hover:bg-violet-hover"
    >
      {children}
    </button>
  );
}

