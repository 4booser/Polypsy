import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, AlertOutcome, AlertSignalBasis, ResponseDetail, SafetyPlan } from "@quizzy/shared";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { dateTime, day, severityKey, timeOfDay } from "../format";
import { useLang } from "../lang";
import { useResource, useResourceMap } from "../useResource";
import {
  Callout,
  Drawer,
  DrawerPane,
  DrawerSection,
  Ic,
  Kbd,
  Loading,
  Modal,
  RiskTimer,
  useAction,
  useHotkeys,
  type DrawerPaneProps,
} from "../ui";
import { cx } from "../ui/cx";
import { Button, ChoiceCard, Field, ErrorText, SeverityTag, Tag, Textarea } from "../ui/primitives";
import { clockText, normText, riskClock } from "../pages/alerts/model";
import { instrumentCode, itemHistory, itemMax } from "../pages/patientCard/clinical";
import { shownNumber, shownValue } from "../pages/patients/model";
import { Panel } from "../ui/layout";

/*
 * Разбор сигнала риска — содержимое ящика, общее для карточки пациента,
 * экрана случаев и (дальше) «Сьогодні» и обхода с телефона.
 *
 * Что внутри (макет «Дія без переходу», панель «Розбір сигналу № 214»):
 *
 *   шапка   — таймер от открытия случая до нормы методики (настройка
 *             эскалации; без нормы — просто «відкрито … тому»);
 *   підстава — пункт, который поднял сигнал, ответ человека с весом и
 *             история ответа на этот пункт по прошлым замерам той же
 *             методики; сигнал по полосе шкалы — значение и полоса;
 *   план безпеки — действующая версия: кому звонить и доступ к средствам;
 *   рішення — исход случая (обязателен) и нотатка; «що вжито» дописывает
 *             готовые фразы в нотатку.
 *
 * Сохранение — PATCH /api/alert-cases/:id с временем последнего сигнала,
 * который человек видел: пришёл новый, пока читал, — 409, и случай
 * перечитывается, а набранное остаётся. «Взяти в роботу / Відпустити» —
 * POST …/assign: двое не разбирают одного человека дважды.
 *
 * Чего в макете больше, чем в приложении, и потому здесь нет: C-SSRS (в
 * каталоге методики нет), «передати черговому» (дежурств приложение не
 * знает — есть только «взяти / відпустити»), номера случаев (у случая
 * только идентификатор). Подписание заключения после разбора — правило
 * сервера не требует; карточка показывает заключение рядом, а не запирает.
 *
 * Вид — DrawerPane: Drawer узнаёт свои виды по типу ребёнка, поэтому экран
 * с несколькими видами раскладывает `review.pane` в свой <DrawerPane>, а
 * экрану с одним видом хватает <RiskReviewDrawer>.
 */

/** Исходы разбора — ровно те, что принимает сервер (routes/alertCases.ts) */
export const OUTCOMES = [
  { value: "confirmed", key: "cases.confirmed", sub: "rr.confirmedSub" },
  { value: "needs_followup", key: "cases.needsFollowup", sub: "rr.followupSub" },
  { value: "not_confirmed", key: "cases.notConfirmed", sub: "rr.notConfirmedSub" },
] as const;

/** Как называть исход в строке: «Ризик підтверджено», «Дубль зданої спроби» */
export const OUTCOME_KEY: Record<AlertOutcome, "cases.confirmed" | "cases.needsFollowup" | "cases.notConfirmed" | "cases.duplicate"> = {
  confirmed: "cases.confirmed",
  needs_followup: "cases.needsFollowup",
  not_confirmed: "cases.notConfirmed",
  duplicate: "cases.duplicate",
};

/** Готовые фразы «що вжито» — дописываются в нотатку, а не заменяют её */
const DONE_PHRASES = ["rr.didCall", "rr.didPlan", "rr.didBook"] as const;

/**
 * Предел нотатки разбора — тот же, что у сервера (PATCH /api/alert-cases/:id
 * режет длиннее молча): поле не даёт набрать больше, чем сохранится.
 */
export const NOTE_MAX = 2000;

/** Набранное к одному случаю: исход и нотатка */
export interface CaseDraft {
  outcome: string;
  note: string;
}

const NO_DRAFT: CaseDraft = { outcome: "", note: "" };

/**
 * Черновики разбора — по случаю, а не один на ящик.
 *
 * Решение принимается о случае. Пока черновик был один, он оставался в
 * форме, когда случай, о котором писали, уходил из открытых (коллега
 * разобрал его — 409 «уже разобрано», список перечитан): ящик вставал на
 * следующий открытый случай того же человека с набранным исходом и
 * нотаткой, и «Зберегти розбір» ложился решением не на тот случай.
 */
export function draftOf(drafts: Readonly<Record<string, CaseDraft>>, caseId: string | null | undefined): CaseDraft {
  return (caseId && drafts[caseId]) || NO_DRAFT;
}

export function withDraft(
  drafts: Readonly<Record<string, CaseDraft>>,
  caseId: string,
  patch: (d: CaseDraft) => CaseDraft,
): Record<string, CaseDraft> {
  return { ...drafts, [caseId]: patch(draftOf(drafts, caseId)) };
}

export function withoutDraft(drafts: Readonly<Record<string, CaseDraft>>, caseId: string): Record<string, CaseDraft> {
  const { [caseId]: _gone, ...rest } = drafts;
  return rest;
}

/** Есть ли набранное к случаю, который ещё открыт: закрытие ящика скажет «чернетку збережено» */
export function draftsDirty(drafts: Readonly<Record<string, CaseDraft>>, openIds: readonly string[]): boolean {
  return openIds.some((id) => {
    const d = drafts[id];
    return !!d && (d.outcome !== "" || d.note.trim() !== "");
  });
}

/** «Що вжито» — фразой в конец нотатки, через точку; не длиннее предела сервера */
export function appendPhrase(note: string, phrase: string): string {
  const next = note.trim() ? `${note.replace(/\s+$/, "")}${/[.!?]$/.test(note.trim()) ? "" : "."} ${phrase}` : phrase;
  return next.slice(0, NOTE_MAX);
}

export interface RiskReviewOptions {
  /** Чей случай; null — ящик пуст */
  userId: string | null;
  /** Какой случай открыть; без него — самый срочный из открытых у человека */
  caseId?: string | null;
  /** Случай, который экран уже знает (строка очереди): виден сразу, в том числе разобранный */
  known?: AlertCase | null;
  /**
   * Грузить ли: ящик закрыт — запросов нет. Основание, история пункта и
   * план безпеки читаются (и пишутся в журнал) тогда, когда их показывают,
   * а не на каждый выбор строки или открытие карточки.
   */
  enabled?: boolean;
  /** Случай разобран, взят или отпущен — экрану перечитать своё */
  onChanged?: () => void;
  /** Решение сохранено — экран очереди закрывает ящик и берёт следующий случай */
  onResolved?: (caseId: string) => void;
  /** Что предложить после сохранения (например, «Підписати заключення») */
  after?: ReactNode;
}

export interface RiskReview {
  /** Свойства вида ящика — вместе с телом (children) */
  pane: DrawerPaneProps;
  /** Открытые случаи человека; null — ещё грузятся */
  cases: AlertCase[] | null;
  /** Тот, что в разборе */
  current: AlertCase | null;
  /** Поставить исход клавишей (1/2/3 экрана) — без сохранения */
  pick: (outcome: string) => void;
}

/**
 * Открытые случаи человека — один запрос на экран: шапка карточки и ящик
 * разбора делят его по общему имени. Без права разбора — пусто: сервер всё
 * равно ответил бы отказом.
 *
 * Отказ — ошибкой, а не пустым списком. Прежде любой сбой (обрыв, 500)
 * превращался в «случаев нет»: карточка писала «Нічого відкритого», ящик —
 * «Відкритих сигналів немає», и открытый риск пропадал с экрана ровно тогда,
 * когда сервер не ответил. Ошибка же повторяется сама (слой загрузки), а
 * экран говорит «не вдалося перевірити» с «Повторити».
 */
export function usePersonCases(userId: string | null, enabled = true) {
  const { can } = useAuth();
  const allowed = can("alerts.review");
  return useResource(() => personCasesLoad(allowed, userId), [userId, allowed], {
    enabled: enabled && !!userId,
    keep: false,
    key: "riskReview:cases",
  });
}

/** Загрузка открытых случаев человека — отдельно от хука, ради проверки на подставном запросе (test/riskReview.test.tsx) */
export function personCasesLoad(
  allowed: boolean,
  userId: string | null,
  list: typeof api.alertCases = api.alertCases,
): Promise<AlertCase[]> {
  return allowed && userId
    ? list({ status: "open", group: "case", patient: userId, limit: "20" }).then((p) => p.items)
    : Promise.resolve([] as AlertCase[]);
}

export function useRiskReview({ userId, caseId, known, enabled = true, onChanged, onResolved, after }: RiskReviewOptions): RiskReview {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const casesRes = usePersonCases(userId, enabled);
  const open = casesRes.data ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CaseDraft>>({});
  /* случай, у которого нажали «Зберегти» без исхода — подсказка встаёт только у него */
  const [tried, setTried] = useState<string | null>(null);
  const [done, setDone] = useState<{ outcome: string; at: string; caseId: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* таймер идёт сам: ящик держат открытым минутами */
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [enabled]);

  /* другой человек — другой разбор: набранное прежнего сюда не переезжает */
  useEffect(() => {
    setPicked(null);
    setDrafts({});
    setTried(null);
    setDone(null);
  }, [userId]);

  const want = picked ?? caseId ?? null;
  const current: AlertCase | null =
    (want ? open?.find((c) => c.id === want) : null) ??
    (known && (!want || known.id === want) ? known : null) ??
    open?.[0] ??
    null;

  const cb = useCaseBasis(userId, current, enabled);
  const plans = useSafetyPlans(userId, enabled);

  const { outcome, note } = draftOf(drafts, current?.id);
  const edit = (patch: (d: CaseDraft) => CaseDraft) => {
    if (!current) return;
    const id = current.id;
    setDrafts((all) => withDraft(all, id, patch));
  };
  const resolved = !!current?.acknowledgedAt;
  const takenByOther = !!current?.assignedTo && current.assignedTo !== user?.id;
  const openIds = [...(open ?? []), ...(current && !resolved ? [current] : [])]
    .filter((c) => !c.acknowledgedAt)
    .map((c) => c.id);
  const dirty = draftsDirty(drafts, openIds);
  const clock = current ? riskClock(current, now) : null;

  const changed = () => {
    casesRes.reload();
    onChanged?.();
  };

  const save = () => {
    if (!current) return;
    if (!outcome) {
      setTried(current.id);
      return;
    }
    const target = current;
    const sent = { outcome, note: note.trim() };
    void run(async () => {
      try {
        await api.resolveCase(target.id, sent.outcome, sent.note, target.lastAlertAt);
      } catch (e) {
        /*
         * 409 — пришёл новый сигнал или случай уже разобрали: перечитать.
         * Набранное остаётся при своём случае; ушёл он из открытых — ящик
         * встанет на другой случай с его собственным (пустым) черновиком.
         */
        if (e instanceof ApiError && e.status === 409) changed();
        throw e;
      }
      setDone({ outcome: sent.outcome, at: new Date().toISOString(), caseId: target.id });
      setDrafts((all) => withoutDraft(all, target.id));
      setTried(null);
      setPicked(null);
      changed();
      onResolved?.(target.id);
    }, ut("cases.resolved"));
  };

  const take = (release: boolean) => {
    if (!current) return;
    const target = current;
    void run(async () => {
      try {
        await api.assignCase(target.id, release);
      } finally {
        changed();
      }
    }, ut(release ? "cases.released" : "cases.tookToast"));
  };

  const addPhrase = (key: (typeof DONE_PHRASES)[number]) => {
    const phrase = ut(key);
    edit((d) => ({ ...d, note: appendPhrase(d.note, phrase) }));
  };

  const name = current?.userName ?? known?.userName ?? "";
  const timer =
    current && clock && !resolved ? (
      clock.norm !== null ? (
        <RiskTimer
          size="lg"
          elapsed={clockText(clock.elapsed, ut("rr.days"))}
          of={normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") })}
          pct={clock.pct}
          note={
            clock.left !== null && clock.left > 0 ? (
              <>
                {ut("rr.until")} <b className="font-extrabold text-text">{timeOfDay(new Date(clock.dueAt!).toISOString())}</b>
                {", "}
                {ut("rr.left").replace("{t}", clockText(clock.left, ut("rr.days")))}
              </>
            ) : (
              <b className="font-extrabold text-risk-ink">{ut("rr.normPassed")}</b>
            )
          }
        />
      ) : (
        /* нормы у методики нет — сколько прошло с открытия, и только */
        <div className="flex h-[52px] items-center gap-2.5 rounded-panel bg-risk-tint px-3.5 text-small font-semibold text-text-2">
          <Ic.timer size={15} className="text-risk-ink" />
          <span>
            <b className="mr-1 text-[22px] font-extrabold leading-none tracking-[-0.03em] text-risk-ink">
              {clockText(clock.elapsed, ut("rr.days"))}
            </b>
            {ut("rr.sinceOpened")}
          </span>
        </div>
      )
    ) : null;

  /* отказ — «не вдалося перевірити» с повтором, а не «відкритих сигналів немає» */
  const body = !userId ? null : open === null && !known ? (
    <div className="py-4">
      <Loading
        rows={4}
        bare
        error={casesRes.error}
        onRetry={casesRes.reload}
        busy={casesRes.loading}
        title={casesRes.error ? ut("rr.casesFailed") : undefined}
      />
    </div>
  ) : !current ? (
    done ? (
      <DoneNote done={done} after={after} />
    ) : (
      <div className="py-6">
        <Callout kind="good" title={ut("rr.noneOpen")}>
          {ut("rr.noneOpenHint")}
        </Callout>
      </div>
    )
  ) : (
    <>
      {done && done.caseId !== current.id ? <DoneNote done={done} after={after} /> : null}
      {open && open.length > 1 ? (
        <DrawerSection title={ut("cases.personCases")} tag={<Tag>{open.length}</Tag>}>
          <div className="flex flex-col gap-1.5" role="group" aria-label={ut("cases.personCases")}>
            {open.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === current.id}
                onClick={() => setPicked(c.id)}
                className={cx(
                  "flex w-full cursor-pointer items-center gap-2 rounded-[12px] border-0 px-3 py-2 text-left text-[13px]",
                  "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                  c.id === current.id ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
                )}
              >
                <SeverityTag level={c.severity === "severe" ? "severe" : "moderate"} small>
                  {ut(severityKey[c.severity === "severe" ? "severe" : "moderate"])}
                </SeverityTag>
                <span className="min-w-0 flex-1 truncate font-semibold text-text">{c.surveyTitle}</span>
                <span className="shrink-0 text-caption text-muted">{day(c.openedAt)}</span>
              </button>
            ))}
          </div>
        </DrawerSection>
      ) : null}

      <Basis caseRow={current} cb={cb} />

      <SafetyPlanSection
        userId={userId}
        plans={plans.data?.versions ?? null}
        loading={plans.loading}
        error={plans.error}
        onRetry={plans.reload}
      />

      {resolved ? (
        <DrawerSection title={ut("rr.decision")}>
          <ResolvedNote c={current} />
        </DrawerSection>
      ) : (
        <DrawerSection title={ut("rr.decision")} sub={ut("rr.decisionSub")}>
          {takenByOther ? (
            <p className="m-0 mb-2.5 text-small text-text-2">
              <b className="font-extrabold text-text">{current.assignedToName}</b> {ut("rr.tookIt")}.
            </p>
          ) : null}
          <div role="radiogroup" aria-label={ut("rr.decision")} className="flex flex-col gap-1.5">
            {OUTCOMES.map((o, i) => (
              <ChoiceCard
                key={o.value}
                name={`rr-outcome-${current.id}`}
                value={o.value}
                checked={outcome === o.value}
                onChange={(v) => {
                  edit((d) => ({ ...d, outcome: v }));
                  setTried(null);
                }}
                title={
                  <span className="flex items-center gap-2">
                    {ut(o.key)}
                    <Kbd>{String(i + 1)}</Kbd>
                  </span>
                }
                sub={ut(o.sub)}
              />
            ))}
          </div>
          {tried === current.id && !outcome ? <ErrorText className="mt-2">{ut("rr.pickOutcome")}</ErrorText> : null}
          <Field label={ut("rr.note")} className="mt-3.5">
            <Textarea
              data-review-note=""
              rows={4}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => {
                const text = e.target.value;
                edit((d) => ({ ...d, note: text }));
              }}
              placeholder={ut("cases.whatDone")}
            />
          </Field>
          <p className="m-0 mb-1.5 text-caption font-bold text-muted">{ut("rr.addDone")}</p>
          <div className="flex flex-wrap gap-1.5">
            {DONE_PHRASES.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => addPhrase(k)}
                className="inline-flex h-8 min-h-0 cursor-pointer items-center gap-1.5 rounded-pill border-0 bg-violet-tint px-3 text-caption font-bold text-violet-ink hover:bg-violet-tint-2"
              >
                <Ic.plus size={13} />
                {ut(k)}
              </button>
            ))}
          </div>
          {done && done.caseId === current.id ? <DoneNote done={done} after={after} /> : null}
        </DrawerSection>
      )}
    </>
  );

  const pane: DrawerPaneProps = {
    mode: "signal",
    title: ut("rr.title"),
    sub: current ? `${name}, ${current.surveyTitle} ${ut("rr.of")} ${dateTime(current.lastAlertAt)}` : name || undefined,
    icon: <Ic.alert />,
    tone: "risk",
    headerExtra: timer,
    dirty,
    draftName: ut("rr.draftName"),
    kbd: "R",
    note: current && !resolved ? ut("rr.saveNote") : undefined,
    noteIcon: <Ic.info />,
    footer:
      current && !resolved ? (
        <>
          <Button variant="primary" disabled={busy} onClick={save}>
            {ut("rr.save")}
          </Button>
          {!current.assignedTo ? (
            <Button disabled={busy} onClick={() => take(false)}>
              {ut("cases.take")}
            </Button>
          ) : current.assignedTo === user?.id ? (
            <Button disabled={busy} onClick={() => take(true)}>
              {ut("cases.release")}
            </Button>
          ) : null}
        </>
      ) : undefined,
    children: body,
  };

  return {
    pane,
    cases: open,
    current,
    pick: (o) => {
      if (resolved || !current) return;
      edit((d) => ({ ...d, outcome: o }));
      setTried(null);
    },
  };
}

/**
 * Версии личного плана безпеки человека — один запрос на экран: строка
 * открытого карточки и ящик разбора делят его по общему имени.
 *
 * Отказ — ошибкой, а не «плана нет»: прежде сбой показывал янтарное
 * «Плану безпеки немає» у человека, план которого есть, — ровно в разборе
 * риска, где по нему звонят.
 */
export function useSafetyPlans(userId: string | null, enabled = true) {
  return useResource(() => (userId ? api.safetyPlans(userId) : Promise.resolve(null)), [userId], {
    enabled: enabled && !!userId,
    keep: false,
    key: "riskReview:plans",
  });
}


/**
 * «Вираженість депресії: 19 → 16 → 14» — содержательная шкала этой методики,
 * последние три замера. Шкалы достоверности («L») говорят о бланке, а не о
 * человеке: их отсеивает вид шкалы из прохождения.
 */
function sumLine(
  dyn: Awaited<ReturnType<typeof api.dynamics>> | null | undefined,
  surveyId: string,
  detail: ResponseDetail | null | undefined,
) {
  const sv = dyn?.surveys.find((s) => s.surveyId === surveyId);
  const clinical = (id: string) => {
    const kind = detail?.scores.find((x) => x.scaleId === id)?.kind;
    return !kind || kind === "clinical";
  };
  const sc = sv?.scales.find((s) => s.points.length > 0 && clinical(s.scaleId));
  if (!sc) return null;
  const pts = [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).slice(-3);
  const fmt = (p: (typeof pts)[number]) => (p.normalization === "ratio" ? `${Math.round(p.percent)} %` : shownNumber(p.rawScore));
  return { code: sc.title, values: pts.map(fmt) };
}

function DoneNote({ done, after }: { done: { outcome: string; at: string }; after?: ReactNode }) {
  const { ut } = useLang();
  const key = OUTCOME_KEY[done.outcome as AlertOutcome];
  return (
    <Callout kind="good" role="status" className="mt-3.5" title={ut("rr.savedAt").replace("{t}", timeOfDay(done.at))} actions={after}>
      {key ? ut(key) : null}
    </Callout>
  );
}

function ResolvedNote({ c }: { c: AlertCase }) {
  const { ut } = useLang();
  const key = c.outcome ? OUTCOME_KEY[c.outcome] : null;
  return (
    <div className="flex flex-col gap-2 text-small text-text-2">
      <span className="flex flex-wrap items-center gap-2">
        <Tag tone="good" icon={<Ic.check />}>
          {key ? ut(key) : ut("work.done")}
        </Tag>
        <span>
          {c.acknowledgedByName}, {dateTime(c.acknowledgedAt)}
        </span>
      </span>
      {c.note ? <p className="m-0 whitespace-pre-wrap rounded-panel bg-sunk px-3.5 py-3 text-[13px] leading-5 text-text">{c.note}</p> : null}
      {c.mergedFromLegacy ? <p className="m-0 text-caption text-muted">{ut("cases.mergedNote")}</p> : null}
    </div>
  );
}

/* ─────────── підстава ─────────── */

export interface CaseBasis {
  signals: AlertSignalBasis[] | null;
  error: string | null;
  /** Прохождения методики случая, по которым идёт история пункта, — старые первыми, до трёх */
  history: string[];
  details: Record<string, ResponseDetail | null>;
  /** Содержательная шкала методики: «Вираженість депресії: 19 → 16 → 14» */
  scaleLine: { code: string; values: string[] } | null;
}

/**
 * Основание случая — общее у ящика разбора и панели «Підстава» экрана
 * случаев: сигналы с ответом и полосой (GET /api/alert-cases/:id/signals),
 * динамика методики случая и прохождения целиком (полосы и веса той версии,
 * что человек видел). Загрузки — под общими именами (`key`): ящик и панель
 * одного случая делят и ответ, и запрос в полёте.
 */
export function useCaseBasis(userId: string | null, c: AlertCase | null, enabled = true): CaseBasis {
  const basis = useResource(
    () => (c ? api.alertCaseSignals(c.id) : Promise.resolve([] as AlertSignalBasis[])),
    [c?.id, c?.lastAlertAt],
    { enabled: enabled && !!c, key: "riskReview:signals" },
  );
  const dyn = useResource(
    () => (userId && c ? api.dynamics(userId, c.surveyId).catch(() => null) : Promise.resolve(null)),
    [userId, c?.surveyId],
    { enabled: enabled && !!c && !!userId, key: "riskReview:dynamics" },
  );
  /* прохождения этой методики — последние три: по ним история ответа на пункт */
  const history = useMemo(() => {
    const at = new Map<string, number>();
    for (const sv of dyn.data?.surveys ?? []) for (const sc of sv.scales) for (const p of sc.points) at.set(p.responseId, Date.parse(p.submittedAt));
    for (const s of basis.data ?? []) if (!at.has(s.responseId)) at.set(s.responseId, Date.parse(s.responseSubmittedAt ?? s.at));
    return [...at.keys()].sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0)).slice(-3);
  }, [dyn.data, basis.data]);
  const details = useResourceMap("rd", enabled ? history : [], api.responseDetail);
  const lead = basis.data?.[0];
  return {
    signals: basis.data ?? null,
    error: basis.error,
    history,
    details,
    scaleLine: c ? sumLine(dyn.data, c.surveyId, details[lead?.responseId ?? ""] ?? null) : null,
  };
}

/** Главный сигнал случая — по отмеченному пункту, иначе первый */
function leadOf(signals: readonly AlertSignalBasis[]): AlertSignalBasis | undefined {
  return signals.find((s) => s.kind === "option" && s.questionId) ?? signals[0];
}

function Basis({ caseRow, cb }: { caseRow: AlertCase; cb: CaseBasis }) {
  const { ut } = useLang();
  const [openResponse, setOpenResponse] = useState<string | null>(null);
  const { signals, error, details, history, scaleLine } = cb;
  if (!signals) {
    return (
      <DrawerSection title={ut("cases.basis")}>
        {error ? <p className="m-0 text-small text-muted">{ut("cases.loadBasisFailed")}</p> : <Loading rows={2} bare />}
      </DrawerSection>
    );
  }
  const lead = leadOf(signals);
  const rest = signals.filter((s) => s !== lead);
  const dets = history.map((id) => details[id]).filter((d): d is ResponseDetail => !!d);

  return (
    <>
      {lead ? (
        lead.kind === "option" && lead.questionId ? (
          <OptionSignal
            s={lead}
            dets={dets}
            max={itemMax(details[lead.responseId], lead.questionId)}
            scaleLine={scaleLine}
            onOpen={() => setOpenResponse(lead.responseId)}
          />
        ) : (
          <BandSignal s={lead} onOpen={() => setOpenResponse(lead.responseId)} />
        )
      ) : (
        <DrawerSection title={ut("cases.basis")}>
          <p className="m-0 text-small text-muted">{caseRow.surveyTitle}</p>
        </DrawerSection>
      )}
      {rest.length ? (
        <DrawerSection title={ut("rr.otherSignals")} tag={<Tag>{rest.length}</Tag>}>
          <OtherSignals list={rest} />
        </DrawerSection>
      ) : null}
      {openResponse ? <ResponseModal id={openResponse} onClose={() => setOpenResponse(null)} /> : null}
    </>
  );
}

function OtherSignals({ list }: { list: readonly AlertSignalBasis[] }) {
  const { ut } = useLang();
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {list.map((s) => (
        <li key={s.id} className="flex items-start gap-2.5 border-t border-divider py-2 text-[13px] leading-[18px] first:border-t-0 first:pt-0">
          <SeverityTag level={s.severity === "severe" ? "severe" : "moderate"} small>
            {ut(severityKey[s.severity === "severe" ? "severe" : "moderate"])}
          </SeverityTag>
          <span className="min-w-0 flex-1 text-text">
            {s.kind === "option" ? (
              <>
                {s.questionNumber !== null ? <b className="font-extrabold">{s.questionNumber}. </b> : null}
                {s.questionTitle}
                {s.pickedOptions.length ? <span className="text-muted"> {s.pickedOptions.join(", ")}</span> : null}
              </>
            ) : (
              <>
                {s.scaleTitle}: <b className="font-extrabold">{s.scaleValue}</b>
                {s.bandLabel ? <span className="text-muted"> {s.bandLabel}</span> : null}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Панель «Підстава» экрана случаев (макет day-alerts): пункт, вся шкала
 * ответов с отмеченным вариантом, история пункта за курс и сумма шкалы.
 * Те же данные, что в ящике разбора, — тем же хуком. Пояснения «на чому
 * ґрунтується висновок» внизу больше нет: вид основания называет пилюля
 * («За позначеною відповіддю», «За смугою шкали»).
 */
export function CaseBasisPanel({ userId, c }: { userId: string; c: AlertCase }) {
  const { ut } = useLang();
  const cb = useCaseBasis(userId, c, true);
  const [openResponse, setOpenResponse] = useState<string | null>(null);
  const lead = cb.signals ? leadOf(cb.signals) : undefined;
  const rest = cb.signals?.filter((s) => s !== lead) ?? [];
  const detail = lead ? cb.details[lead.responseId] : null;
  const answer = lead?.questionId ? detail?.answers.find((a) => a.questionId === lead.questionId) : undefined;
  const pickedIds = new Set(answer?.optionIds ?? []);
  const dets = cb.history.map((id) => cb.details[id]).filter((d): d is ResponseDetail => !!d);
  const hist = lead?.questionId ? itemHistory(dets, lead.questionId) : [];
  const max = lead?.questionId ? itemMax(detail, lead.questionId) : null;
  const cols = Math.min(answer?.options.length ?? 1, 4);
  return (
    <Panel
      title={ut("cases.basis")}
      icon={<Ic.file />}
      sub={lead ? `${instrumentCode(lead.surveyTitle)} ${ut("rr.of")} ${dateTime(lead.responseSubmittedAt ?? lead.at)}` : undefined}
      actions={
        lead ? (
          <Button variant="ghost" size="xs" onClick={() => setOpenResponse(lead.responseId)}>
            {ut("cases.openResponse")}
          </Button>
        ) : undefined
      }
    >
      {!cb.signals ? (

        cb.error ? (
          <p className="m-0 text-small text-muted">{ut("cases.loadBasisFailed")}</p>
        ) : (
          <Loading rows={3} bare />
        )
      ) : !lead ? (
        <p className="m-0 text-small text-muted">{c.surveyTitle}</p>
      ) : lead.kind === "option" && lead.questionId ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-small text-text-2">
            <Tag tone="danger" icon={<Ic.alert />}>
              {ut("cases.kind.option")}
            </Tag>
            <Tag>
              {instrumentCode(lead.surveyTitle)}, {ut("cases.item").toLowerCase()} {lead.questionNumber ?? ""}
            </Tag>
          </div>
          <p className="m-0 mt-2.5 text-h3 font-extrabold leading-5 text-text">{lead.questionTitle}</p>
          {answer && answer.options.length ? (
            <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
              {answer.options.map((o) => {
                const on = pickedIds.has(o.id);
                return (
                  <span
                    key={o.id}
                    className={cx(
                      "flex min-h-[60px] flex-col gap-0.5 rounded-[12px] px-2.5 py-2 text-caption",
                      on
                        ? o.riskFlag
                          ? "bg-risk text-onfill"
                          : "bg-violet text-onfill"
                        : "bg-panel text-text-2 shadow-[inset_0_0_0_1px_var(--border)]",
                    )}
                  >
                    {o.score !== null && max ? <b className={cx("text-small font-extrabold", on ? "text-onfill" : "text-muted")}>{o.score}</b> : null}
                    <span className={cx(on && "font-extrabold")}>{o.text}</span>
                  </span>
                );
              })}
            </div>
          ) : null}
          {hist.length > 1 ? (
            <>
              <p className="m-0 mb-1.5 mt-4 text-caption font-bold text-muted">{ut("rr.itemOverCourse")}</p>
              <HistoryTiles hist={hist} nowId={lead.responseId} categorical={!max} />
            </>
          ) : null}
          {cb.scaleLine && cb.scaleLine.values.length > 1 ? (
            <p className="m-0 mt-3 text-small text-text-2">
              {cb.scaleLine.code}: <b className="font-extrabold text-text">{cb.scaleLine.values.join(" → ")}</b>
            </p>
          ) : null}
          {rest.length ? (
            <div className="mt-4 border-t border-divider pt-3">
              <p className="m-0 mb-2 text-caption font-bold text-muted">
                {ut("rr.otherSignals")} ({rest.length})
              </p>
              <OtherSignals list={rest} />
            </div>
          ) : null}
        </>
      ) : (
        <BandFacts s={lead} />
      )}
      {openResponse ? <ResponseModal id={openResponse} onClose={() => setOpenResponse(null)} /> : null}
    </Panel>
  );
}

/** Плитки истории ответа на пункт: «24.08 0 зовсім ні › 11.09 0 › 08.10 1 кілька днів» */
function HistoryTiles({ hist, nowId, categorical }: { hist: ReturnType<typeof itemHistory>; nowId: string; categorical: boolean }) {
  const { ut } = useLang();
  const now = hist.find((h) => h.responseId === nowId) ?? hist[hist.length - 1];
  const hot = (h: (typeof hist)[number]) => h === now && (categorical || (h.score ?? 0) > 0);
  return (
    <ol aria-label={ut("rr.itemHistory")} className="m-0 flex list-none items-stretch gap-1.5 p-0">
      {hist.map((h, i) => {
        const red = hot(h);
        return (
          <li key={h.responseId} className="contents">
            {i ? (
              <span aria-hidden className="flex items-center text-muted">
                <Ic.chevronRight size={14} />
              </span>
            ) : null}
            <span
              className={cx(
                "flex min-w-0 flex-1 flex-col gap-0.5 rounded-panel px-3 py-2.5 text-caption font-semibold text-text-2",
                red ? "bg-risk-tint shadow-[inset_0_0_0_1px_var(--riskline)]" : "bg-sunk",
              )}
            >
              <span className="text-muted">{day(h.at)}</span>
              {categorical ? (
                <b className={cx("truncate text-[18px] font-extrabold leading-[26px]", red ? "text-risk-ink" : "text-text")}>{h.text ?? "—"}</b>
              ) : (
                <>
                  <b className={cx("text-[28px] font-extrabold leading-[32px] tracking-[-0.02em]", red ? "text-risk-ink" : "text-text")}>
                    {h.score ?? "—"}
                  </b>
                  <span className={cx("truncate", red && "font-extrabold text-risk-ink")}>{h.text ?? "—"}</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function OptionSignal({
  s,
  dets,
  max,
  scaleLine,
  onOpen,
}: {
  s: AlertSignalBasis;
  dets: ResponseDetail[];
  max: number | null;
  scaleLine: { code: string; values: string[] } | null;
  onOpen: () => void;
}) {
  const { ut } = useLang();
  const hist = itemHistory(dets, s.questionId!);
  const now = hist.find((h) => h.responseId === s.responseId) ?? hist[hist.length - 1];
  const before = hist.filter((h) => h !== now);
  /* «так / ні» без весов: в истории — слово ответа, «впервые» — по смене слова */
  const categorical = !max;
  const firstTime = categorical
    ? before.length > 0 && before.every((h) => h.text !== now?.text)
    : before.length > 0 && before.every((h) => (h.score ?? 0) === 0) && (now?.score ?? 0) > 0;
  const answered = s.pickedOptions.length > 0 || s.answeredNumber !== null;
  return (
    <DrawerSection
      title={`${instrumentCode(s.surveyTitle)}, ${ut("cases.item").toLowerCase()} ${s.questionNumber ?? ""}`.trim()}
      sub={firstTime ? ut(categorical ? "rr.firstAnswer" : "rr.firstTime") : undefined}
      right={
        <Button variant="ghost" size="xs" onClick={onOpen}>
          {ut("cases.openResponse")}
        </Button>
      }
    >
      <p className="m-0 rounded-panel bg-sunk px-3.5 py-3 text-[13px] leading-5 text-text-2">{s.questionTitle}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-small">
        <span className="text-caption font-bold text-muted">{ut("cases.picked")}</span>

        {answered ? (
          <Tag tone="danger">{s.pickedOptions.length ? s.pickedOptions.join(", ") : String(s.answeredNumber)}</Tag>
        ) : (
          <span className="text-caption text-muted">{ut("cases.noAnswerStored")}</span>
        )}
        {!categorical && now?.score !== null && now?.score !== undefined && max !== null ? (
          <span className="text-muted">{ut("rr.points").replace("{n}", String(now.score)).replace("{max}", String(max))}</span>
        ) : null}
      </div>
      {hist.length > 1 ? (
        <div className="mt-3">
          <HistoryTiles hist={hist} nowId={s.responseId} categorical={categorical} />
        </div>
      ) : null}
      {scaleLine && scaleLine.values.length > 1 ? (
        <p className="m-0 mt-3 text-small text-text-2">
          {scaleLine.code}: <b className="font-extrabold text-text">{scaleLine.values.join(" → ")}</b>
        </p>
      ) : null}
    </DrawerSection>
  );
}

function BandSignal({ s, onOpen }: { s: AlertSignalBasis; onOpen: () => void }) {
  const { ut } = useLang();
  return (
    <DrawerSection
      title={ut("cases.basis")}
      sub={ut("cases.kind.band")}
      right={
        <Button variant="ghost" size="xs" onClick={onOpen}>
          {ut("cases.openResponse")}
        </Button>
      }
    >
      <BandFacts s={s} />
    </DrawerSection>
  );
}

/** Сигнал по полосе шкалы: шкала, значение, полоса с границами и рекомендация методики */
function BandFacts({ s }: { s: AlertSignalBasis }) {
  const { ut } = useLang();
  return (
    <div className="flex flex-col gap-1.5 text-small text-text-2">
      <span>
        {ut("cases.scale")}: <b className="font-extrabold text-text">{s.scaleTitle}</b>
        {s.scaleCode ? <span className="text-muted"> {s.scaleCode}</span> : null}
      </span>
      {s.scaleValue !== null ? (
        <span>
          <b className="text-[22px] font-extrabold text-text">{s.scaleValue}</b>{" "}
          {s.normalization ? ut(`norm.${s.normalization}` as never) : ""}
          {s.scaleRawScore !== null ? (
            <span className="text-muted">
              {" "}
              ({ut("cases.rawScore")} {s.scaleRawScore})
            </span>
          ) : null}
        </span>
      ) : null}
      {s.bandLabel ? (
        <span>
          {ut("cases.band")}: <b className="font-extrabold text-text">{s.bandLabel}</b>
          {s.bandMin !== null && s.bandMax !== null ? (
            <span className="text-muted">
              {" "}
              ({s.bandMin}–{s.bandMax})
            </span>
          ) : null}
        </span>
      ) : null}
      {s.bandRecommendation || s.bandDescription ? (
        <p className="m-0 text-caption text-muted">{s.bandRecommendation ?? s.bandDescription}</p>
      ) : null}
    </div>
  );
}

/* ─────────── план безпеки ─────────── */

/** Похоже ли на номер телефона: «+380 67 315 40 22», «7333» */
const PHONE = /^[+\d][\d\s()-]{2,}$/;

/** Раздел «План безпеки» ящика; экспорт — ради проверки разметки (test/riskReview.test.tsx) */
export function SafetyPlanSection({
  userId,
  plans,
  loading,
  error,
  onRetry,
}: {
  userId: string;
  plans: SafetyPlan[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { ut } = useLang();
  const active = plans?.find((v) => v.active) ?? null;
  const contacts = active ? [...active.content.people, ...active.content.professionals].filter((p) => p.name.trim()) : [];
  /* не пришло — не «плану немає»: отказ говорит об отказе, пока грузится — скелет */
  if (!plans) {
    return (
      <DrawerSection title={ut("rr.safetyPlan")}>
        <Loading rows={2} bare error={error} onRetry={onRetry} busy={loading} />
      </DrawerSection>
    );
  }
  return (
    <DrawerSection
      id="rr-safety"
      title={ut("rr.safetyPlan")}
      tag={
        active ? (
          <span className="inline-grid h-[22px] place-items-center rounded-[11px] bg-violet-tint px-2 text-[11px] font-extrabold text-violet-ink">
            v{active.version}
          </span>
        ) : undefined
      }
      sub={active ? ut("rr.planUpdated").replace("{d}", day(active.reviewedAt ?? active.createdAt)) : undefined}
      right={
        <Link to={`/patients/${userId}?pane=plan`} className="text-small font-bold text-violet-ink">
          {active ? ut("rr.wholePlan") : ut("rr.makePlan")}
        </Link>
      }
    >
      {!active ? (
        <Callout kind="warn" title={ut("rr.noPlan")}>
          {ut("rr.noPlanHint")}
        </Callout>
      ) : (
        <>
          {contacts.length ? (
            <ul className="m-0 list-none p-0">
              {contacts.map((p, i) => (
                <li key={`${p.name}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-2.5 border-t border-divider py-[7px] first:border-t-0">
                  <span className="min-w-0 text-[13px] leading-[17px]">
                    <b className="font-extrabold text-text">{p.name}</b>
                  </span>
                  <span className="whitespace-nowrap text-[13px] font-bold text-text">{p.contact}</span>
                  {PHONE.test(p.contact.trim()) ? (
                    <a
                      href={`tel:${p.contact.replace(/[^\d+]/g, "")}`}
                      aria-label={ut("rr.call").replace("{name}", p.name)}
                      className="inline-grid size-9 place-items-center rounded-control bg-violet-tint text-violet-ink hover:bg-violet-tint-2"
                    >
                      <Ic.phone size={14} />
                    </a>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-small text-muted">{ut("rr.noContacts")}</p>
          )}
          {active.content.meansRestriction.trim() ? (
            <Callout kind="warn" className="mt-2.5" title={ut("rr.means")}>
              {active.content.meansRestriction}
            </Callout>
          ) : null}
        </>
      )}
    </DrawerSection>
  );
}

/* ─────────── прохождение целиком ─────────── */

const th = "border-b border-divider px-2 py-1.5 text-left text-caption font-bold text-muted";
const td = "border-b border-divider px-2 py-1.5 align-top";

/**
 * Прохождение целиком: ответы по пунктам и баллы по шкалам.
 *
 * Окно, а не переход: уйдя из разбора, дежурный теряет место в очереди.
 * Варианты ответа — той версии, которую человек видел: после правки
 * методики набор вариантов другой, и «что он ответил» получилось бы не из
 * того списка. Ссылка на страницу прохождения — для протокола целиком.
 */
export function ResponseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { ut } = useLang();
  const res = useResource(() => api.responseDetail(id), [id]);
  const data = res.data;

  return (
    <Modal title={ut("cases.responseTitle")} onClose={onClose} wide>
      {!data ? (
        <Loading rows={5} error={res.error} onRetry={res.reload} busy={res.loading} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <b className="font-extrabold text-text">{data.survey.title}</b>
            <span className="text-muted">{dateTime(data.submittedAt ?? data.startedAt)}</span>
            <Link to={`/surveys/${data.survey.id}/responses/${id}`} className="text-small font-bold text-violet-ink">
              {ut("rsp.openPage")}
            </Link>
          </div>

          {data.scores.length ? (
            <div>
              <h3 className="m-0 mb-2 text-h3 font-extrabold text-text">{ut("cases.scoresTitle")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={th}>{ut("cs.scaleTitle")}</th>
                      <th className={th}>{ut("cs.raw")}</th>
                      <th className={th}>{ut("cs.normalization")}</th>
                      <th className={th}>{ut("cs.bands")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.scores.map((sc) => (
                      <tr key={sc.scaleId}>
                        <td className={td}>{sc.scaleTitle}</td>
                        <td className={cx(td, "tabular-nums")}>{shownNumber(sc.rawScore)}</td>
                        <td className={cx(td, "tabular-nums")}>
                          {shownValue(sc.value, sc.normalization).text}
                          {shownValue(sc.value, sc.normalization).unit}{" "}
                          <span className="text-muted">{ut(`norm.${sc.normalization}` as never)}</span>
                        </td>
                        <td className={td}>
                          {sc.band ? (
                            <SeverityTag level={sc.band.severity} small>
                              {sc.band.label}
                            </SeverityTag>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div>
            <h3 className="m-0 mb-2 text-h3 font-extrabold text-text">{ut("cases.answersTitle")}</h3>
            <ol className="m-0 flex flex-col gap-1.5 pl-6 text-small">
              {data.answers.map((a) => {
                const pickedIds = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
                const chosen = a.options.filter((o) => pickedIds.has(o.id));
                return (
                  <li key={a.questionId}>
                    <div className="text-text">{a.title}</div>
                    {!a.answered ? (
                      <span className="text-muted">{ut("cases.skipped")}</span>
                    ) : chosen.length ? (
                      <span>
                        {chosen.map((o, i) => (
                          <span key={o.id}>
                            {i ? ", " : ""}
                            <b className={o.riskFlag ? "font-extrabold text-risk-ink" : "font-bold text-text"}>{o.text}</b>
                            {/* критический вариант — словом, а не только цветом */}
                            {o.riskFlag ? <span className="text-caption text-risk-ink"> ({ut("cases.criticalOption")})</span> : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-text">{a.text ?? (a.number !== null ? String(a.number) : (a.date ?? "—"))}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────── ящик одного вида ─────────── */

/**
 * Ящик разбора для экрана, у которого других видов нет («Сьогодні»,
 * очередь случаев). Клавиши 1–3 ставят исход, пока ящик открыт и курсор не
 * в поле; R открывает — это дело экрана.
 */
export function RiskReviewDrawer({
  open,
  onClose,
  onReturn,
  userId,
  caseId,
  known,
  onChanged,
  onResolved,
  after,
  modal = false,
}: {
  open: boolean;
  onClose: () => void;
  onReturn?: () => void;
  userId: string | null;
  caseId?: string | null;
  known?: AlertCase | null;
  onChanged?: () => void;
  onResolved?: (caseId: string) => void;
  after?: ReactNode;
  modal?: boolean;
}) {
  /*
   * Грузит ящик, пока он открыт: план безпеки и случаи человека — то, что
   * показывает только он, и при выборе строки очереди (J/K) их не читали бы
   * зря и не писали бы в журнал. Основание случая уже читает панель
   * «Підстава» экрана под тем же именем — ящик берёт его оттуда.
   */
  const review = useRiskReview({ userId, caseId, known, enabled: open, onChanged, onResolved, after });
  useHotkeys(
    {
      "1": () => review.pick("confirmed"),
      "2": () => review.pick("needs_followup"),
      "3": () => review.pick("not_confirmed"),
    },
    open,
  );
  return (
    <Drawer open={open} mode="signal" modal={modal} onClose={onClose} onReturn={onReturn ? () => onReturn() : undefined}>
      <DrawerPane {...review.pane} />
    </Drawer>
  );
}
