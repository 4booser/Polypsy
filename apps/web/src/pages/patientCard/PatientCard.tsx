import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import type { PatientCard as PatientCardData } from "@quizzy/shared";
import { api, type TimelineItem } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { useResource, useResourceMap } from "../../useResource";
import { Drawer, DrawerPane, Loading, useAction, useUrlState } from "../../ui";
import { Here } from "../../components/Here";
import { usePersonCases, useRiskReview, useSafetyPlans } from "../../components/RiskReview";
import { AssignDrawer } from "../../components/AssignDrawer";
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
import { withConclusion, withLead } from "./model";
import type { CardRefresh, CardView, OpenOpts, PaneMode, ThreadMessage } from "./types";
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
  /* тот же запрос, что у ящика разбора (общее имя): план читается раз на карточку */
  const plans = useSafetyPlans(id);

  const latestIds = useMemo(
    () => (dynamics.data?.surveys ?? []).map(latestResponseOf).filter((x): x is string => !!x),
    [dynamics.data],
  );
  const details = useResourceMap("rd", latestIds, api.responseDetail);
  const rows = useMemo(() => instrumentRows(dynamics.data, details), [dynamics.data, details]);
  /* «Графіки» — все шкалы каждой методики: свёртка многошкальной методики нужна таблице «Методики», а не графикам */
  const chartRows = useMemo(
    () => instrumentRows(dynamics.data, details, { fold: false, limit: Number.POSITIVE_INFINITY }),
    [dynamics.data, details],
  );

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
    timeline: tl,
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
    plan: plans.data?.versions.find((p) => p.active) ?? null,
    planKnown: !!plans.data,
    planError: plans.data ? null : plans.error,
    reloadPlan: plans.reload,
    details,
    rows,
    chartRows,
    nextIsMine: !!next && !!me && next.specialist.trim() === me,
    slotId,
    setSlotId,
    open,
    goTab: (t) => setTab(t),
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
  const threadPane = useThreadPane(v, drawer.open && drawer.mode === "thread");
  const conclPane = useConclusionPane(v, drawer.open && drawer.mode === "concl", conclFor);
  const notePane = useNotePane(v, drawer.open && drawer.mode === "note");
  const bookPane = useBookPane(v, drawer.open && drawer.mode === "book");

  /* ── клавиши: R — разбор, M — письмо, N — нотатка; 1–3 — исход в открытом разборе ── */
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

      {/*
        «Призначити методику» — общий ящик назначения (как у групп и выбранных):
        поиск по названию и коду, срок кнопками, комментарий для пациента и
        набор вместо методики. Адресат — этот человек; ящик встаёт под полосу
        с ним, как остальные действия карточки.
      */}
      <div style={top !== null ? ({ "--ah": `${top}px` } as CSSProperties) : undefined}>
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
              /* назначение набора — событие хронологии и пилюля «Призначено» в шапке */
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
