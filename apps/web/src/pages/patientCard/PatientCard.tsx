import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { PatientCard as PatientCardData } from "@quizzy/shared";
import { api, type TimelineItem } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { useResource, useResourceMap } from "../../useResource";
import { Drawer, DrawerPane, Loading, useAction, useUrlState } from "../../ui";
import { Here } from "../../components/Here";
import { usePersonCases, useRiskReview } from "../../components/RiskReview";
import { AssignSurveyDialog } from "../patientGroups/dialogs";
import { Banner, CARD_TABS, type CardTab } from "./Banner";
import {
  heldCount,
  instrumentRows,
  lastSession,
  latestResponseOf,
  nextVisit,
  openAssignments,
  openNoShow,
  visitsOf,
  type TimelineRow,
} from "./clinical";
import { useCodeKeys } from "./keys";
import { Overview } from "./Overview";
import { useBookPane, useConclusionPane, useNotePane, useThreadPane } from "./Panes";
import { PatientList } from "./PatientList";
import { ConclusionsTab, DynamicsTab, MeasuresTab, MessagesTab, NotesTab, TimelineTab, VisitsTab } from "./TabViews";
import type { CardView, OpenOpts, PaneMode, ThreadMessage } from "./types";
import type { ThreadLike } from "./listModel";

/*
 * Карточка пациента — эталонный экран «Виразної», мир «Дія без переходу»
 * (.superdesign/ui3/screens/style_drawer_vivid.py, утверждён 2026-10-17).
 *
 *   слева   — колонка «Мої пацієнти», сгруппированная по причине (PatientList);
 *   сверху  — человек на фиолетовой полосе: кто он, строка открытого (сигнал
 *             с таймером, письмо, неявка, черновик, назначенное, план безпеки)
 *             и вкладки (Banner);
 *   ниже    — вкладка: «Огляд» в две колонки (Overview) или остальные (TabViews);
 *   справа  — ящик действий поверх правой колонки: разбор сигнала (общий
 *             components/RiskReview), переписка с переносом, заключение,
 *             нотатка, запись на приём (Panes). Esc закрывает и оставляет
 *             черновик; R / M / N открывают нужный вид.
 *
 * Данные — только из приложения. Открытие карточки по-прежнему читает
 * GET /api/patients/:id/card — это чтение журналируется сервером
 * (patient.card_read), и карточка без него не открывается. Остальное —
 * динамика, хронология, случаи, переписка, нотатки, план безпеки — теми же
 * маршрутами, что и клиническая карта (/patients/:id/case), ссылка на неё —
 * в шапке и в меню. Права проверяет сервер; кнопки, ведущие в отказ
 * (нет messages.write, notes.write, appointments.manage, conclusions.*,
 * alerts.review), не рисуются.
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
          <CardRecord key={id} card={res.data} reloadCard={res.reload} collapsed={collapsed} onExpand={toggle} />
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
  reloadCard,
  collapsed,
  onExpand,
}: {
  card: PatientCardData;
  reloadCard: () => void;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const id = card.id;
  const { ut } = useLang();
  const { user, can } = useAuth();
  const { run, busy } = useAction();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* ── данные человека ── */
  const dynamics = useResource(() => api.dynamics(id), [id], { keep: false });
  const timeline = useResource(() => api.timeline(id).catch(() => [] as TimelineItem[]), [id], { keep: false });
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
  const notes = useResource(() => api.notes(id).catch(() => null), [id], { keep: false });
  const plans = useResource(() => api.safetyPlans(id).catch(() => null), [id], { keep: false });

  const latestIds = useMemo(
    () => (dynamics.data?.surveys ?? []).map(latestResponseOf).filter((x): x is string => !!x),
    [dynamics.data],
  );
  const details = useResourceMap("rd", latestIds, api.responseDetail);
  const rows = useMemo(() => instrumentRows(dynamics.data, details), [dynamics.data, details]);

  const tl = (timeline.data ?? null) as TimelineRow[] | null;
  const visits = useMemo(() => visitsOf(tl ?? []), [tl]);
  const next = nextVisit(visits, now);
  /* хронология называет специалиста приёма ФИО — так же, как профиль вошедшего */
  const me = user?.fullName?.trim() ?? "";

  /* ── ящик ── */
  const [drawer, setDrawer] = useState<{ open: boolean; mode: PaneMode }>({ open: false, mode: "signal" });
  const [conclFor, setConclFor] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [tabRaw, setTab] = useUrlState("tab", "overview");
  const tab: CardTab = (CARD_TABS as string[]).includes(tabRaw) ? (tabRaw as CardTab) : "overview";

  const open = useCallback(
    (mode: PaneMode, opts?: OpenOpts) => {
      if (opts?.responseId) setConclFor(opts.responseId);
      if (opts?.slotId) setSlotId(opts.slotId);
      setDrawer({ open: true, mode });
    },
    [],
  );

  const reload = useCallback(() => {
    timeline.reload();
    threads.reload();
    messages.reload();
    notes.reload();
    cases.reload();
    plans.reload();
    reloadCard();
  }, [timeline.reload, threads.reload, messages.reload, notes.reload, cases.reload, plans.reload, reloadCard]);

  const v: CardView = {
    id,
    card,
    now,
    dynamics: dynamics.data ?? null,
    dynamicsError: dynamics.error,
    reloadDynamics: dynamics.reload,
    timeline: tl,
    visits,
    next,
    last: lastSession(visits, now),
    noShow: openNoShow(visits, now),
    assignments: openAssignments(tl ?? []),
    cases: cases.data ?? null,
    thread,
    messages: messages.data ?? null,
    notes: notes.data ?? null,
    plan: plans.data?.versions.find((p) => p.active) ?? null,
    details,
    rows,
    nextIsMine: !!next && !!me && next.specialist.trim() === me,
    slotId,
    setSlotId,
    open,
    goTab: (t) => setTab(t),
    pane: drawer.open ? drawer.mode : null,
    can,
    reload,
  };

  const firstDraft = card.conclusions.find((c) => c.status === "draft");
  const review = useRiskReview({
    userId: id,
    enabled: true,
    onChanged: reload,
    after:
      firstDraft && can("conclusions.write") ? (
        <ButtonLike onClick={() => open("concl", { responseId: firstDraft.responseId })}>{ut("card.toConclusion")}</ButtonLike>
      ) : undefined,
  });
  const threadPane = useThreadPane(v, drawer.open && drawer.mode === "thread");
  const conclPane = useConclusionPane(v, drawer.open && drawer.mode === "concl", conclFor);
  const notePane = useNotePane(v, drawer.open && drawer.mode === "note");
  const bookPane = useBookPane(v, drawer.open && drawer.mode === "book");

  /* ── клавиши: R — разбор, M — письмо, N — нотатка ── */
  useCodeKeys({
    KeyR: () => {
      if (can("alerts.review") && cases.data?.length) open("signal");
    },
    KeyM: () => {
      if (can("messages.write")) open("thread");
    },
    KeyN: () => {
      if (can("notes.write")) open("note");
    },
  });

  /* ── закрепление ── */
  const toggleLead = () =>
    void run(async () => {
      await api.takeLead(card.id, !card.lead?.mine);
      reloadCard();
    }, ut(card.lead?.mine ? "pcard.unsubscribed" : "pcard.subscribed"));
  const [assigning, setAssigning] = useState(false);

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

  const counts: Partial<Record<CardTab, number>> = {
    measures: card.responses.length,
    conclusions: card.conclusions.length,
    visits: heldCount(visits) || undefined,
    messages: messages.data?.length || undefined,
    notes: notes.data?.versions.length || undefined,
  };

  return (
    <>
      <div className="kit-scroll flex min-h-0 flex-1 flex-col overflow-y-auto" data-card-scroll="">
        <Banner
          ref={bannerRef}
          v={v}
          tab={tab}
          onTab={setTab}
          counts={counts}
          collapsed={collapsed}
          onExpand={onExpand}
          onAssign={() => setAssigning(true)}
          onToggleLead={toggleLead}
          leadBusy={busy}
          here={<Here resource={`patient:${id}`} />}
          drafts={{
            signal: !!review.pane.dirty,
            thread: !!threadPane.dirty,
            concl: !!conclPane.dirty,
            note: !!notePane.dirty,
          }}
        />
        <div id="card-tabpanel" role="tabpanel" aria-labelledby={`card-tab-${tab}`} className="px-5 pb-8 pt-5">
          {tab === "overview" ? (
            <Overview v={v} />
          ) : tab === "measures" ? (
            <MeasuresTab v={v} />
          ) : tab === "dynamics" ? (
            <DynamicsTab v={v} />
          ) : tab === "conclusions" ? (
            <ConclusionsTab v={v} />
          ) : tab === "visits" ? (
            <VisitsTab v={v} />
          ) : tab === "messages" ? (
            <MessagesTab v={v} />
          ) : tab === "notes" ? (
            <NotesTab v={v} />
          ) : (
            <TimelineTab v={v} />
          )}
        </div>
      </div>

      <div style={top !== null ? ({ "--ah": `${top}px` } as CSSProperties) : undefined}>
        <Drawer
          open={drawer.open}
          mode={drawer.mode}
          modal={false}
          onClose={() => setDrawer((d) => ({ ...d, open: false }))}
          onReturn={(m) => setDrawer({ open: true, mode: (m as PaneMode) ?? "signal" })}
          label={ut("card.drawerLabel")}
        >
          <DrawerPane {...review.pane} />
          <DrawerPane {...threadPane} />
          <DrawerPane {...conclPane} />
          <DrawerPane {...notePane} />
          <DrawerPane {...bookPane} />
        </Drawer>
      </div>

      {assigning ? (
        <AssignSurveyDialog
          title={ut("pg.assignTest")}
          onAssign={async (surveyId, expiresAt) => {
            await api.grant(surveyId, card.id, undefined, expiresAt);
            reload();
            return ut("pg.assigned");
          }}
          onClose={() => setAssigning(false)}
        />
      ) : null}
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
