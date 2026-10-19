import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AlertCase, AlertCasePage, RiskSeverity, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, day, severityKey, timeOfDay } from "../format";
import { useLang } from "../lang";
import { onAppEvent } from "../events";
import { usePagedResource, useResource } from "../useResource";
import {
  ActivityList,
  AlertStrip,
  Avatar,
  Empty,
  Ic,
  KbdHints,
  ListGroup,
  Loading,
  RiskChip,
  RiskTimer,
  SearchField,
  Tooltip,
  useAction,
  useHotkeys,
  useUrlState,
  type ActivityEvent,
} from "../ui";
import { cx } from "../ui/cx";
import { Panel } from "../ui/layout";
import { Button, Input, Select, SeverityTag, Tag } from "../ui/primitives";
import { RuleSection } from "../ui/section";
import { SavedViews } from "../ui/SavedViews";
import { listBody } from "../ui/paging";
import { patchParams } from "../ui/viewParams";
import { CaseBasisPanel, OUTCOME_KEY, RiskReviewDrawer } from "../components/RiskReview";
import { useCodeKeys } from "./patientCard/keys";
import { Pi } from "./patientCard/icons";
import { dm } from "./patientCard/format";
import {
  CLEAR_NARROWING,
  clockText,
  emptyQueueKey,
  hasNarrowing,
  normText,
  ownGroupsOf,
  queueGate,
  queueQuery,
  queueSections,
  readFilters,
  riskClock,
  rowOverdue,
  statusPatch,
  subtitleParts,
  uniqueRows,
  waitingMinutes,
  withCount,
  type CaseStatus,
} from "./alerts/model";

/** Строк на страницу очереди: экран высотой в два-три десятка строк и ещё одна «впрок» */
const PAGE = 30;

/**
 * Сколько минут в человекочитаемом виде.
 *
 * Отрицательное или нечисло — часы клиента разошлись с сервером: «-5 хв
 * тому» читалось бы как время из будущего, а не как сбой. Прочерк честнее.
 */
function duration(minutes: number, ut: (k: UiKey) => string): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)} ${ut("dur.min")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${ut("dur.hour")}`;
  return `${Math.round(hours / 24)} ${ut("dur.day")}`;
}

/** Виды очереди пилюлями: открытые, на мне, разобранные, все — состояние и «хто розбирає» в адресе */
type QueueView = "open" | "mine" | "resolved" | "all";
const VIEWS: { key: QueueView; label: UiKey }[] = [
  { key: "open", label: "cases.filterOpen" },
  { key: "mine", label: "cases.assignedMe" },
  { key: "resolved", label: "cases.filterResolved" },
  { key: "all", label: "cases.filterAll" },
];

/**
 * Разбор случаев риска — список и запись (макет day-alerts «Виразної»).
 *
 * Единица работы — человек, а не сработавший пункт: строка очереди стоит за
 * человека (grouping: person), его случаи — рядом, в разборе. Порядок
 * задан: тяжёлые сверху, дальше по времени последнего сигнала; кто взял
 * случай — видно всем, иначе двое разбирают одного человека дважды.
 *
 *   слева  — очередь: поиск, виды «Відкриті / На мені / Розібрані / Усі»,
 *            фильтры (терміновість, хто розбирає, підрозділ, група, період,
 *            пацієнт, збережені види) за кнопкой — в адресе, как и прежде;
 *            разделы «Важкі / Помірні» с числами по всей выборке (SQL);
 *   справа — выбранный случай: человек на полосе со строкой открытого,
 *            «Розбір» (таймер до нормы методики, кто держит, случаи
 *            человека), «Підстава» (пункт, шкала ответов, история пункта),
 *            хронология случая из журнала, последние замеры, ритм разбора.
 *
 * Решение принимается в ящике разбора (components/RiskReview — тот же, что
 * в карточке пациента): «Продовжити розбір» или R. Цифры 1–3 по-прежнему
 * ставят исход сразу, пока ящик закрыт (в ящике — выбирают его), T берёт
 * случай на себя, J/K ходят по очереди, «/» — поиск.
 *
 * Под нагрузкой (внешний разбор, волна 12) всё прежнее на месте: курсор
 * страниц, счётчики из SQL, отбор в адресе, строка «повторити» при отказе
 * перечитывания, обновление по событиям потока.
 */
export default function Alerts() {
  const { user } = useAuth();
  const { ut } = useLang();
  const { run } = useAction();
  const [, setParams] = useSearchParams();

  const [statusRaw] = useUrlState("status");
  const [legacyAll] = useUrlState("all");
  const [severity, setSeverity] = useUrlState("severity");
  const [assigned, setAssigned] = useUrlState("assigned");
  const [unit, setUnit] = useUrlState("unit");
  const [patientGroup, setPatientGroup] = useUrlState("patientGroup");
  const [patient] = useUrlState("patient");
  const [from, setFrom] = useUrlState("from");
  const [to, setTo] = useUrlState("to");
  const [q, setQ] = useUrlState("q");
  const raw: Record<string, string> = { status: statusRaw, all: legacyAll, severity, assigned, unit, patientGroup, patient, from, to, q };

  /*
   * Группы пациентов — свои. Права на них может и не быть: тогда фильтра нет,
   * а экран работает. Отказ — null, а не пустой список (withOwnGroup).
   */
  const groupsRes = useResource(() => api.patientGroups().catch(() => null), []);
  const groups = groupsRes.data ?? [];
  const gate = queueGate(readFilters((name) => raw[name] ?? ""), ownGroupsOf(groupsRes));
  const filters = gate.filters;

  /* несколько параметров разом — одним переходом (statusPatch снимает прежний `all=1`) */
  const patch = useCallback(
    (changes: Record<string, string>) => setParams((prev) => patchParams(prev, changes), { replace: true }),
    [setParams],
  );
  const view: QueueView = filters.status === "open" && filters.assigned === "me" ? "mine" : filters.status;
  const setView = (v: QueueView) => {
    const status: CaseStatus = v === "mine" ? "open" : v;
    patch({ ...statusPatch(status), assigned: v === "mine" ? "me" : filters.assigned === "me" ? "" : filters.assigned });
  };

  /* какой случай «под рукой» — по идентификатору, а не по номеру строки */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const narrowCount = [filters.severity, filters.unit, filters.patientGroup, filters.from || filters.to, filters.patient].filter(Boolean)
    .length + (filters.assigned && filters.assigned !== "me" ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(() => narrowCount > 0);

  const filterKey = JSON.stringify(filters);
  const page = usePagedResource<AlertCase, AlertCasePage>(
    (cursor) => api.alertCases(queueQuery(filters, PAGE, cursor)),
    [filterKey],
    { debounceMs: 300, enabled: gate.ready },
  );
  const facets = page.head?.facets;
  const grouping = page.head?.grouping ?? (filters.status === "open" && !filters.patient ? "person" : "case");
  const units = useResource(() => api.alertCaseUnits(), []).data ?? [];

  const rows = uniqueRows(page.items ?? [], grouping);
  const open = rows.filter((c) => !c.acknowledgedAt);
  const current = rows.find((c) => c.id === selectedId) ?? open[0];
  const selected = current ?? rows[0] ?? null;

  /* случаи человека строки — отдельным запросом, только когда их больше одного */
  const many = (selected?.group?.cases ?? 1) > 1;
  const personCases = useResource(
    () =>
      many && selected
        ? api.alertCases({ status: "open", group: "case", patient: selected.userId, limit: "20" }).then((p) => p.items)
        : Promise.resolve<AlertCase[]>([]),
    [many, selected?.userId, selected?.lastAlertAt, selected?.group?.cases],
  );
  useEffect(() => setPickedId(null), [selected?.userId]);
  const shown = personCases.data?.find((c) => c.id === pickedId) ?? selected;

  const refresh = useCallback(() => {
    page.reload();
    personCases.reload();
  }, [page.reload, personCases.reload]);

  /* очередь обновляется по событию: новая тревога — сразу, взятый коллегой случай — сразу */
  useEffect(
    () =>
      onAppEvent((e) => {
        if (e.kind === "alert.created" || e.kind === "case.changed") refresh();
      }),
    [refresh],
  );

  const move = (delta: number) => {
    const list = filters.status === "open" ? open : rows;
    if (!list.length) return;
    const at = list.findIndex((c) => c.id === current?.id);
    const next = list[Math.min(Math.max((at < 0 ? 0 : at) + delta, 0), list.length - 1)];
    if (next) setSelectedId(next.id);
  };

  /*
   * Решение — вместе с временем последнего сигнала, который человек видел:
   * пришёл новый — 409, и очередь перечитывается в любом случае.
   */
  const resolve = (target: AlertCase, outcome: string, note: string) =>
    run(async () => {
      try {
        await api.resolveCase(target.id, outcome, note, target.lastAlertAt);
      } finally {
        refresh();
      }
      setSelectedId(null);
      setPickedId(null);
    }, ut("cases.resolved"));

  const take = (target: AlertCase, release: boolean) =>
    run(async () => {
      try {
        await api.assignCase(target.id, release);
      } finally {
        refresh();
      }
    }, ut(release ? "cases.released" : "cases.tookToast"));

  const canAct = (c: AlertCase | null): c is AlertCase => !!c && !c.acknowledgedAt;
  useCodeKeys({
    KeyJ: () => move(1),
    KeyK: () => move(-1),
    KeyR: () => {
      if (shown) setReviewOpen(true);
    },
    KeyT: () => {
      if (canAct(shown) && !shown.assignedTo && !reviewOpen) void take(shown, false);
    },
    /* цифры — исход сразу, пока ящик закрыт; в ящике они выбирают исход (RiskReviewDrawer) */
    Digit1: () => {
      if (canAct(shown) && !reviewOpen) void resolve(shown, "confirmed", "");
    },
    Digit2: () => {
      if (canAct(shown) && !reviewOpen) void resolve(shown, "needs_followup", "");
    },
    Digit3: () => {
      if (canAct(shown) && !reviewOpen) void resolve(shown, "not_confirmed", "");
    },
  });
  useHotkeys({
    "/": () => {
      const input = document.querySelector<HTMLInputElement>("[data-queue-search]");
      input?.focus();
      input?.select();
    },
    Escape: () => (document.activeElement as HTMLElement | null)?.blur(),
  });

  const subtitle = subtitleParts(facets, filters.status, {
    people: ut("cases.peopleSub"),
    overdue: ut("cases.overdue"),
    mine: ut("cases.mine"),
    resolved: ut("cases.resolvedSub"),
    all: ut("cases.allSub"),
  });
  const narrowed = hasNarrowing(filters);
  const queue = listBody(page.items ? rows : null, page.error);
  const sections = queueSections(rows, facets);
  const now = Date.now();

  /* выбранная строка — в поле зрения после J/K */
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-queue-row][aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  return (
    /* узкое окно: очередь сверху своей прокруткой, случай под ней — всё листается вместе */
    <div className="flex min-h-0 flex-1 max-[900px]:flex-col max-[900px]:overflow-y-auto">
      {/* ── очередь ── */}
      <aside
        id="cases-queue"
        aria-label={ut("cases.queueLabel")}
        className="flex w-[340px] min-h-0 shrink-0 flex-col border-r border-border bg-panel max-[900px]:w-full max-[900px]:max-h-[46vh] max-[900px]:border-b max-[900px]:border-r-0"
      >
        <div className="shrink-0 px-4 pt-3.5">
          <div className="flex h-9 items-center gap-2">
            <h1 className="m-0 whitespace-nowrap text-[18px] font-extrabold leading-none tracking-[-0.02em] text-text">{ut("nav.cases")}</h1>
            {facets ? (
              <span className="inline-grid h-[22px] min-w-[26px] place-items-center rounded-[11px] bg-sunk px-[7px] text-caption font-bold text-text-2">
                {facets.total}
              </span>
            ) : null}
            <span className="ml-auto flex gap-1">
              <Tooltip label={ut("al.filters")}>
                <Button
                  variant="quiet"
                  size="glyph"
                  aria-label={ut("al.filters")}
                  aria-expanded={filtersOpen}
                  aria-controls="cases-filters"
                  onClick={() => setFiltersOpen((v) => !v)}
                >
                  <Pi.sliders size={16} />
                  {narrowCount ? (
                    <span className="absolute -right-0.5 -top-0.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-violet px-1 text-[10px] font-extrabold text-onfill">
                      {narrowCount}
                    </span>
                  ) : null}
                </Button>
              </Tooltip>
            </span>
          </div>
          {subtitle ? <p className="m-0 mt-0.5 text-small text-text-2">{subtitle}</p> : null}
          <SearchField
            value={q}
            onChange={setQ}
            placeholder={ut("ui.surname")}
            label={ut("ui.surname")}
            width={0}
            className="mt-2.5 w-full"
            inputProps={{ "data-queue-search": "" }}
          />
          <div role="tablist" aria-label={ut("cases.statusLabel")} className="mt-2.5 flex flex-wrap gap-x-[5px] gap-y-1.5">
            {VIEWS.map((v) => {
              const on = view === v.key;
              const count = v.key === view ? (facets?.total ?? null) : v.key === "mine" && filters.status === "open" ? (facets?.assigned.me ?? null) : null;
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  id={`cases-status-${v.key}`}
                  aria-selected={on}
                  aria-controls="cases-queue-list"
                  onClick={() => setView(v.key)}
                  className={cx(
                    "inline-flex h-8 min-h-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-2xl border-0 px-2.5 text-small leading-none",
                    "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                    on ? "bg-violet font-bold text-onfill" : "bg-sunk font-semibold text-text-2 hover:bg-sunk-2 hover:text-text",
                  )}
                >
                  {ut(v.label)}
                  {count !== null ? <span className={cx("font-bold tabular-nums", on ? "text-onfill-muted" : "text-muted")}>{count}</span> : null}
                </button>
              );
            })}
          </div>
          {filtersOpen ? (
            <div id="cases-filters" className="mt-3 flex flex-col gap-2 rounded-panel bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--divider)]">
              <Select aria-label={ut("cases.severityLabel")} value={filters.severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="">{ut("cases.anySeverity")}</option>
                <option value="severe">{withCount(ut("cases.severeOnly"), facets?.severity.severe)}</option>
                <option value="moderate">{withCount(ut("cases.moderate"), facets?.severity.moderate)}</option>
              </Select>
              <Select aria-label={ut("cases.assignedLabel")} value={filters.assigned} onChange={(e) => setAssigned(e.target.value)}>
                <option value="">{ut("cases.assignedAny")}</option>
                <option value="me">{withCount(ut("cases.assignedMe"), facets?.assigned.me)}</option>
                <option value="none">{withCount(ut("cases.assignedNone"), facets?.assigned.none)}</option>
                <option value="others">{withCount(ut("cases.assignedOthers"), facets?.assigned.others)}</option>
              </Select>
              <Select aria-label={ut("ui.unit")} value={filters.unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="">{ut("ui.unitAll")}</option>
                {[...new Set([...units, ...(filters.unit ? [filters.unit] : [])])].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
              {groups.length || filters.patientGroup ? (
                <Select aria-label={ut("cases.groupLabel")} value={filters.patientGroup} onChange={(e) => setPatientGroup(e.target.value)}>
                  <option value="">{ut("cases.groupAll")}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                  {filters.patientGroup && !groups.some((g) => g.id === filters.patientGroup) ? (
                    <option value={filters.patientGroup}>{ut("cases.groupLabel")}</option>
                  ) : null}
                </Select>
              ) : null}
              {/* период — по дате открытия случая: она у случая не меняется */}
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="date"
                  aria-label={ut("cases.periodFrom")}
                  value={filters.from}
                  max={filters.to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
                <Input
                  type="date"
                  aria-label={ut("cases.periodTo")}
                  value={filters.to}
                  min={filters.from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              {filters.patient ? (
                <span className="inline-flex items-center gap-1.5">
                  <Tag tone="primary">
                    {ut("cases.patientFilter")}: {rows[0]?.userName ?? "…"}
                  </Tag>
                  <Button size="icon-sm" variant="quiet" aria-label={ut("cases.clearPatient")} onClick={() => patch({ patient: "" })}>
                    <Ic.x size={14} />
                  </Button>
                </span>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <SavedViews scope="alerts" />
                {narrowed ? (
                  <Button variant="quiet" size="xs" onClick={() => patch(CLEAR_NARROWING)}>
                    {ut("cases.clearFilters")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="mt-1.5 flex h-9 items-center gap-[7px] text-small text-muted">
            <Ic.sortDesc size={14} />
            {ut("al.sortLine")} <b className="font-bold text-text-2">{ut("al.sortLineB")}</b>
          </div>
        </div>
        <div
          ref={listRef}
          id="cases-queue-list"
          role="tabpanel"
          aria-labelledby={`cases-status-${view}`}
          className="kit-scroll min-h-0 flex-1 overflow-y-auto border-t border-divider pb-2.5"
        >
          {queue.stale ? (
            <div role="alert" className="flex items-center gap-2.5 border-b border-divider px-4 py-2">
              <p className="m-0 min-w-0 flex-1 text-small font-bold text-risk-ink">{queue.stale}</p>
              <Button variant="quiet" size="xs" onClick={page.reload}>
                {ut("common.retry")}
              </Button>
            </div>
          ) : null}
          {queue.body === "failed" || queue.body === "loading" ? (
            <div className="p-4">
              <Loading rows={6} error={page.error} onRetry={page.reload} bare />
            </div>
          ) : queue.body === "empty" ? (
            <div className="p-2">
              <Empty title={ut(emptyQueueKey(filters))} hint={ut("cases.emptyHint")} icon={<Ic.shieldCheck />} />
            </div>
          ) : (
            sections.map((s) => (
              <section key={s.severity} aria-labelledby={`cases-section-${s.severity}`}>
                <div id={`cases-section-${s.severity}`}>
                  <ListGroup
                    label={s.severity === "severe" ? ut("cases.sectionSevere") : ut("cases.moderate")}
                    count={s.total ?? s.items.length}
                    mark={s.severity === "severe" ? "risk" : "warn"}
                    note={s.severity === "severe" && filters.status === "open" ? ut("al.severeNote") : undefined}
                  />
                </div>
                {s.items.map((c) => (
                  <QueueRow key={c.id} c={c} active={c.id === selected?.id} me={user?.id} now={now} onPick={() => setSelectedId(c.id)} />
                ))}
              </section>
            ))
          )}
          {page.items && rows.length ? (
            <div className="px-4 pb-1 pt-3">
              {page.hasMore ? (
                <Button className="w-full" disabled={page.loadingMore} onClick={page.loadMore}>
                  {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
                </Button>
              ) : (
                <p className="m-0 text-center text-small text-muted">{ut("ui.endOfList")}</p>
              )}
            </div>
          ) : null}
        </div>
        <div className="flex h-[42px] shrink-0 items-center gap-3 border-t border-divider px-4 text-caption text-muted">
          <div className="min-w-0 [&>div]:flex-nowrap [&>div]:gap-x-3">
            <KbdHints
              className="hotkeys"
              keys={[
                ["J K", ut("card.kRows")],
                ["T", ut("al.kTake")],
                ["R", ut("al.kReview")],
              ]}
            />

          </div>
          {facets ? (
            <span className="ml-auto whitespace-nowrap font-bold text-text-2">
              {ut("kit.ofTotal").replace("{n}", String(rows.length)).replace("{total}", String(facets.total))}
            </span>
          ) : null}
        </div>
      </aside>

      {/* ── выбранный случай ── */}
      <section
        data-triage-case=""
        aria-label={ut("al.recordLabel")}
        className="kit-scroll min-h-0 min-w-0 flex-1 overflow-y-auto max-[900px]:flex-none max-[900px]:overflow-visible"
      >

        {shown ? (
          <CaseRecord
            key={shown.id}
            c={shown}
            row={selected!}
            personCases={many ? (personCases.data ?? null) : null}
            personCasesError={many && !personCases.data ? personCases.error : null}
            onRetryPersonCases={personCases.reload}
            onPickCase={setPickedId}
            onShowPerson={() => patch({ patient: shown.userId })}
            onTake={(release) => take(shown, release)}
            onReview={() => setReviewOpen(true)}
            reviewOpen={reviewOpen}
            me={user?.id}
            facets={filters.status === "open" ? facets : undefined}
            now={now}
          />
        ) : (
          /* «ничего не выбрано» — не то же, что «ничего нет» */
          <div className="p-5">
            <Empty
              title={ut(rows.length ? "cases.pickOne" : "cases.emptyOpen")}
              hint={ut(rows.length ? "cases.pickOneHint" : "cases.emptyHint")}
              icon={<Ic.shieldCheck />}
            />
          </div>
        )}
      </section>

      <RiskReviewDrawer
        open={reviewOpen && !!shown}
        onClose={() => setReviewOpen(false)}
        onReturn={() => setReviewOpen(true)}
        userId={shown?.userId ?? null}
        caseId={shown?.id ?? null}
        known={shown}
        onChanged={refresh}
        onResolved={() => {
          setReviewOpen(false);
          setSelectedId(null);
          setPickedId(null);
        }}
      />
    </div>
  );
}

/* ─────────── строка очереди ─────────── */

const SEVERITY_LEVEL: Record<RiskSeverity, "severe" | "moderate"> = { severe: "severe", moderate: "moderate" };

/**
 * Строка очереди (.prow набора): ПОЧЕМУ человек здесь и ЧТО дальше.
 *
 *   имя                      случаев у человека / подразделение
 *   причина пилюлей          тяжесть словом
 *   ↳ следующий шаг          сколько ждёт / «прострочено»
 *
 * Красная пилюля — открытый сигнал с таймером; «взяв» — состоянием, не
 * янтарём: янтарь — только у просроченного.
 */
export function QueueRow({
  c,
  active,
  me,
  now,
  onPick,
}: {
  c: AlertCase;
  active: boolean;
  me: string | undefined;
  now: number;
  onPick: () => void;
}) {
  const { ut } = useLang();
  const done = !!c.acknowledgedAt;
  const level = SEVERITY_LEVEL[c.severity] ?? "moderate";
  const outcome = c.outcome ? OUTCOME_KEY[c.outcome] : null;
  const clock = riskClock(c, now);
  const timer =
    clock.norm !== null
      ? ut("kit.timerOf")
          .replace("{elapsed}", clockText(clock.elapsed, ut("rr.days")))
          .replace("{of}", normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") }))
      : clockText(clock.elapsed, ut("rr.days"));
  const overdue = !done && rowOverdue(c);
  const mine = !!c.assignedTo && c.assignedTo === me;

  const reason = done ? (
    <Tag tone="good" icon={<Ic.check />}>
      {outcome ? ut(outcome) : ut("work.done")}
    </Tag>
  ) : c.assignedTo && !mine ? (
    <Tag tone="handover" icon={<Ic.user />}>
      {ut("cases.taken")}: {c.assignedToName ?? "—"}
    </Tag>
  ) : (
    <Tag tone="danger" icon={<Ic.timer />}>
      {ut("card.rsSignal").replace("{t}", timer)}
    </Tag>
  );
  const next = done
    ? `${c.acknowledgedByName ?? "—"}, ${day(c.acknowledgedAt!)}`
    : mine
      ? ut("al.youTook")
      : clock.dueAt !== null && clock.left !== null && clock.left > 0
        ? ut("card.nxReviewBy").replace("{t}", timeOfDay(new Date(clock.dueAt).toISOString()))
        : ut("card.nxReview");

  return (
    <button
      type="button"
      data-queue-row=""
      data-done={done ? "true" : undefined}
      onClick={onPick}
      aria-current={active}
      className={cx(
        "relative mx-1.5 my-0.5 block w-[calc(100%-12px)] cursor-pointer rounded-[12px] border-0 pb-[11px] pl-5 pr-2.5 pt-2.5 text-left",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-focus",
        active ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "bg-transparent hover:bg-sunk",
      )}
    >
      <span className="flex items-baseline gap-2">
        <span
          data-queue-name=""
          className={cx(
            "min-w-0 truncate text-[14px] leading-5",
            active ? "font-extrabold text-violet-ink" : done ? "font-bold text-muted" : "font-bold text-text",
          )}
        >
          {c.userName}
        </span>
        <span className="ml-auto whitespace-nowrap text-small text-muted">
          {c.group && c.group.cases > 1 ? ut("cases.casesN").replace("{n}", String(c.group.cases)) : (c.unit ?? "")}
        </span>
      </span>
      <span className="mt-1.5 flex items-center justify-between gap-1.5">
        {reason}
        <SeverityTag level={level} small>
          {ut(severityKey[level])}
        </SeverityTag>
      </span>
      <span className="mt-1.5 flex items-center gap-2.5 text-caption text-text-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="inline-flex text-muted">{done ? <Ic.circleCheck size={13} /> : <Ic.alert size={13} />}</span>
          <span className="truncate">{next}</span>
        </span>
        {overdue ? (
          <Tag tone="attention" className="ml-auto">
            {ut("cases.overdue")}
          </Tag>
        ) : (
          <span className="ml-auto whitespace-nowrap text-muted">{duration(waitingMinutes(c, now), ut)}</span>
        )}
      </span>
    </button>
  );
}

/* ─────────── выбранный случай ─────────── */

function CaseRecord({
  c,
  row,
  personCases,
  personCasesError,
  onRetryPersonCases,
  onPickCase,
  onShowPerson,
  onTake,
  onReview,
  reviewOpen,
  me,
  facets,
  now,
}: {
  c: AlertCase;
  /** Строка очереди, из которой открыт случай: у неё — сводка по всем случаям человека */
  row: AlertCase;
  /** Открытые случаи человека, если их больше одного; null — один или ещё грузятся */
  personCases: AlertCase[] | null;
  /** Случаи человека не пришли — отказ с «Повторити», а не вечный скелет */
  personCasesError: string | null;
  onRetryPersonCases: () => void;
  onPickCase: (id: string) => void;
  onShowPerson: () => void;
  onTake: (release: boolean) => Promise<unknown>;
  onReview: () => void;
  reviewOpen: boolean;
  me: string | undefined;
  facets: AlertCasePage["facets"];
  now: number;
}) {
  const done = !!c.acknowledgedAt;
  const many = (row.group?.cases ?? 1) > 1;
  return (
    <article data-case-card="" className="flex min-h-full flex-col">
      <PatientBand c={c} now={now} onReview={onReview} reviewOpen={reviewOpen} />
      <div className="@container px-5 pb-8 pt-5">
        <div className="grid items-start gap-5 @min-[780px]:grid-cols-[minmax(0,1fr)_300px] @min-[1000px]:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <ReviewPanel c={c} me={me} now={now} onTake={onTake} onReview={onReview}>
              {many ? (
                <PersonCases
                  total={row.group!.cases}
                  cases={personCases}
                  error={personCasesError}
                  onRetry={onRetryPersonCases}
                  pickedId={c.id}
                  onPick={onPickCase}
                  onShowPerson={onShowPerson}
                />
              ) : null}
            </ReviewPanel>
            <CaseBasisPanel userId={c.userId} c={c} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <HistoryPanel c={c} />
            <PatientContext userId={c.userId} />
            {facets && !done ? <RhythmPanel facets={facets} now={now} /> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Человек на полосе (как в карточке пациента): кто это и строка открытого */
function PatientBand({ c, now, onReview, reviewOpen }: { c: AlertCase; now: number; onReview: () => void; reviewOpen: boolean }) {
  const { ut } = useLang();
  const userId = c.userId;
  /* keep: false — сводка прежнего пациента не встаёт рядом со случаем следующего (#177) */
  const summary = useResource(() => api.caseSummary(userId), [userId], { keep: false, key: "alerts:summary" });
  const s = summary.data;
  const done = !!c.acknowledgedAt;
  const clock = riskClock(c, now);
  const others = (s?.openAlerts.length ?? 0) - c.signalCount;
  const sex = s?.sex === "male" ? ut("card.male") : s?.sex === "female" ? ut("card.female") : null;
  return (
    <div className="border-b border-band-card-line bg-band px-4 pb-3.5 pt-3.5">
      <div className="rounded-drawer border border-band-card-line bg-band-card py-3 pl-3.5 pr-3 shadow-banner">
        <div className="flex min-w-0 items-center gap-3.5">
          <Avatar name={c.userName} size={56} />
          <div className="flex min-w-0 flex-col gap-[5px]">
            <h2 className="m-0 truncate text-title font-extrabold leading-[30px] tracking-[-0.03em] text-text">
              <Link to={`/patients/${userId}`} className="text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[5px]">
                {c.userName}
              </Link>
            </h2>
            <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold text-text-2">
              {s && (s.age !== null || sex) ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Pi.userRound size={15} className="text-violet-ink" />
                  <span>
                    {s.age !== null ? <b className="font-extrabold text-text">{ut("card.years").replace("{n}", String(s.age))}</b> : null}
                    {s.age !== null && sex ? ", " : null}
                    {sex}
                  </span>
                </span>
              ) : null}

              {c.unit ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Ic.idCard size={15} className="text-violet-ink" />
                  <b className="font-extrabold text-text">{c.unit}</b>
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Ic.clipboard size={15} className="text-violet-ink" />
                {c.surveyTitle}
              </span>
            </span>
          </div>
          <Link
            to={`/patients/${userId}`}
            className="ml-auto inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-control bg-violet-tint px-4 text-body font-bold text-violet-ink no-underline hover:bg-violet-tint-2 hover:no-underline"
          >
            <Ic.user size={15} />
            {ut("al.openCard")}
          </Link>
        </div>
        <AlertStrip className="mt-3 min-h-10">
          <RiskChip
            title={ut("card.signal")}
            state={done ? "done" : "open"}
            timer={
              done ? (
                <span className="text-caption font-semibold text-text-2">{dateTime(c.acknowledgedAt)}</span>
              ) : clock.norm !== null ? (
                <RiskTimer
                  elapsed={clockText(clock.elapsed, ut("rr.days"))}
                  of={normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") })}
                  pct={clock.pct}
                />
              ) : (
                <span className="text-caption font-semibold text-text-2">
                  <b className="text-body font-extrabold text-risk-ink">{clockText(clock.elapsed, ut("rr.days"))}</b>
                </span>
              )
            }
            action={
              <Tooltip label={ut("card.reviewTip")} kbd="R">
                <Button variant="risk" size="xs" className="rounded-2xl" aria-expanded={reviewOpen} onClick={onReview}>
                  {ut("card.review")}
                </Button>
              </Tooltip>
            }
          />
          {others > 0 ? (
            <span className="inline-flex h-[34px] shrink-0 items-center gap-[5px] rounded-[17px] bg-sunk pl-[9px] pr-[11px] text-caption font-semibold text-text-2">
              <Ic.alert size={15} className="text-muted" />
              <b className="font-bold text-text">{ut("al.otherAlerts").replace("{n}", String(others))}</b>
            </span>
          ) : null}
          {s?.conclusions.length ? (
            <span className="inline-flex h-[34px] shrink-0 items-center gap-[5px] rounded-[17px] bg-sunk pl-[9px] pr-[11px] text-caption font-semibold text-text-2">
              <Ic.file size={15} className="text-muted" />
              <b className="font-bold text-text">{ut("al.signedN").replace("{n}", String(s.conclusions.length))}</b>
            </span>
          ) : null}
        </AlertStrip>
      </div>
    </div>
  );
}

function ReviewPanel({
  c,
  me,
  now,
  onTake,
  onReview,
  children,
}: {
  c: AlertCase;
  me: string | undefined;
  now: number;
  onTake: (release: boolean) => Promise<unknown>;
  onReview: () => void;
  children?: ReactNode;
}) {
  const { ut } = useLang();
  const done = !!c.acknowledgedAt;
  const clock = riskClock(c, now);
  const takenByOther = !!c.assignedTo && c.assignedTo !== me;
  const level = SEVERITY_LEVEL[c.severity] ?? "moderate";
  const outcome = c.outcome ? OUTCOME_KEY[c.outcome] : null;
  const who = c.assignedTo ? (c.assignedTo === me ? ut("cases.mine") : `${ut("cases.taken")}: ${c.assignedToName ?? "—"}`) : ut("card.notTaken");

  return (
    <Panel
      title={ut("al.review")}
      icon={<Ic.alert />}
      tone="risk"
      sub={
        <span className="inline-flex items-center gap-2">
          {done ? (outcome ? ut(outcome) : ut("work.done")) : who}
          <SeverityTag level={level} small>
            {ut(severityKey[level])}
          </SeverityTag>
        </span>
      }
    >
      {!done ? (
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
          <div className="flex h-[52px] items-center gap-2.5 rounded-panel bg-risk-tint px-3.5 text-small font-semibold text-text-2">
            <Ic.timer size={15} className="text-risk-ink" />
            <span>
              <b className="mr-1 text-[22px] font-extrabold leading-none tracking-[-0.03em] text-risk-ink">{clockText(clock.elapsed, ut("rr.days"))}</b>
              {ut("rr.sinceOpened")}
            </span>
            <span className="ml-auto text-muted">{ut("rr.noNorm")}</span>
          </div>
        )
      ) : null}

      <ul className="m-0 mt-1 list-none p-0">
        <Fact icon={<Ic.alert />} title={ut("al.signalsN").replace("{n}", String(c.signalCount))} note={`${dm(c.lastAlertAt)}, ${timeOfDay(c.lastAlertAt)}`}>
          {c.signals[0]?.label ?? c.surveyTitle}
        </Fact>
        <Fact icon={<Ic.history />} title={ut("al.opened")} note={dateTime(c.openedAt)}>
          {clock.norm !== null ? ut("al.normIs").replace("{n}", normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") })) : ut("rr.noNorm")}
        </Fact>
        <Fact icon={<Ic.user />} title={ut("cases.assignedLabel")} note={null}>
          {who}
        </Fact>
        {done ? (
          <Fact icon={<Ic.circleCheck />} title={outcome ? ut(outcome) : ut("work.done")} note={dateTime(c.acknowledgedAt)} tone="good">
            {c.acknowledgedByName}
            {c.note ? <span className="mt-1 block whitespace-pre-wrap text-text">{c.note}</span> : null}
            {c.mergedFromLegacy ? <span className="mt-1 block">{ut("cases.mergedNote")}</span> : null}
          </Fact>
        ) : null}
      </ul>

      {takenByOther && !done ? <p className="m-0 mt-2 text-small text-text-2">{ut("cases.takenByOther")}</p> : null}

      {children ? <div className="mt-4">{children}</div> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Tooltip label={ut(done ? "al.openReview" : "al.continue")} kbd="R">
          <Button variant={done ? "secondary" : "risk"} onClick={onReview}>
            {ut(done ? "al.openReview" : "al.continue")}
          </Button>
        </Tooltip>
        {done ? null : !c.assignedTo ? (
          <Button onClick={() => void onTake(false)}>{ut("cases.take")}</Button>
        ) : c.assignedTo === me ? (
          <Button onClick={() => void onTake(true)}>{ut("cases.release")}</Button>
        ) : null}
      </div>
      {done ? null : (
        <KbdHints
          className="mt-3.5"
          keys={[
            ["1", ut("hotkey.confirm")],
            ["2", ut("hotkey.followup")],
            ["3", ut("hotkey.reject")],
            ["/", ut("hotkey.search")],
          ]}
        />
      )}
    </Panel>

  );
}

function Fact({
  icon,
  title,
  note,
  tone,
  children,
}: {
  icon: ReactNode;
  title: string;
  note: ReactNode;
  tone?: "good";
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 border-t border-divider py-2.5 first:border-t-0">
      <span
        aria-hidden
        className={cx(
          "mt-0.5 inline-grid size-[22px] shrink-0 place-items-center rounded-full [&>svg]:size-3",
          tone === "good" ? "bg-good-tint text-good" : "bg-sunk text-muted",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-small text-text-2">
        <b className="block text-[13px] font-extrabold text-text">{title}</b>
        {children}
      </span>
      {note ? <span className="shrink-0 whitespace-nowrap text-caption font-semibold text-text-2">{note}</span> : null}
    </li>
  );
}

/**
 * Случаи человека, когда их у него больше одного.
 *
 * Строка очереди стоит за человека, а решение принимается о случае: у
 * каждого своя зона видимости (группа методики) и своё окно. Поэтому они
 * перечислены, выбираются по одному, и клавиши работают с выбранным.
 * «Усі випадки людини» ставит отбор по пациенту.
 */
export function PersonCases({
  total,
  cases,
  error = null,
  onRetry,
  pickedId,
  onPick,
  onShowPerson,
}: {
  total: number;
  cases: AlertCase[] | null;
  /** Случаи не пришли — отказ с «Повторити», а не скелет навсегда */
  error?: string | null;
  onRetry?: () => void;
  pickedId: string;
  onPick: (id: string) => void;
  onShowPerson: () => void;
}) {
  const { ut } = useLang();
  return (
    <RuleSection
      title={
        <>
          {ut("cases.personCases")} <span className="text-small font-semibold text-muted">{total}</span>
        </>
      }
      hint={ut("cases.personCasesHint")}
      actions={
        <Button variant="ghost" size="xs" onClick={onShowPerson}>
          {ut("cases.showPersonCases")}
        </Button>
      }
      className="border-t border-divider pt-[18px]"
    >
      {!cases ? (
        <Loading rows={2} bare error={error} onRetry={onRetry} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {cases.map((pc) => {
            const level = SEVERITY_LEVEL[pc.severity] ?? "moderate";
            return (
              <li key={pc.id}>
                <button
                  type="button"
                  aria-pressed={pc.id === pickedId}
                  onClick={() => onPick(pc.id)}
                  className={cx(
                    "flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-[12px] border-0 px-3 py-2 text-left text-[13px]",
                    "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                    pc.id === pickedId ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
                  )}
                >
                  <SeverityTag level={level} small>
                    {ut(severityKey[level])}
                  </SeverityTag>
                  <span className="min-w-0 flex-1 truncate font-semibold text-text">{pc.surveyTitle}</span>
                  {pc.overdue ? <Tag tone="attention">{ut("cases.overdue")}</Tag> : null}
                  <span className="text-caption text-muted">{day(pc.openedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </RuleSection>
  );
}

/* ─────────── хронология случая ─────────── */

const ACTION_KEY: Record<string, UiKey> = {
  "alert.assign": "al.hAssign",
  "alert.release": "al.hRelease",
  "alert.acknowledge": "al.hResolved",
};

/**
 * Хронология случая: сигналы и действия по нему из журнала (кто брал, кто
 * отпускал, кто и с каким исходом разобрал). Заступивший видит, почему
 * случай ещё открыт, не расспрашивая предыдущую смену.
 */
function HistoryPanel({ c }: { c: AlertCase }) {
  const { ut } = useLang();
  const res = useResource(() => api.alertCaseHistory(c.id).catch(() => []), [c.id, c.lastAlertAt, c.assignedTo, c.acknowledgedAt], {
    keep: false,
  });
  const events: (ActivityEvent & { t: number })[] = [];
  for (const s of c.signals) {
    events.push({
      t: Date.parse(s.at),
      date: dm(s.at),
      time: timeOfDay(s.at),
      icon: <Ic.alert />,
      tone: "risk",
      text: (
        <>
          <b>{ut("card.evSignal")}</b>: {s.label}
        </>
      ),
    });
  }
  for (const h of res.data ?? []) {
    const key = ACTION_KEY[h.action];
    if (!key) continue;
    const outcome = typeof h.details?.outcome === "string" ? OUTCOME_KEY[h.details.outcome as keyof typeof OUTCOME_KEY] : null;
    events.push({
      t: Date.parse(h.at),
      date: dm(h.at),
      time: timeOfDay(h.at),
      icon: h.action === "alert.acknowledge" ? <Ic.circleCheck /> : <Ic.user />,
      tone: h.action === "alert.acknowledge" ? "good" : "neutral",
      text: (
        <>
          {ut(key)} <b>{h.actorName}</b>
          {outcome ? <span className="text-muted">, {ut(outcome)}</span> : null}
        </>
      ),
    });
  }
  events.sort((a, b) => a.t - b.t);
  return (
    <Panel title={ut("al.history")} icon={<Ic.history />} sub={dm(c.openedAt)} flush>
      {!res.data && res.loading ? (
        <div className="px-4 pb-4">
          <Loading rows={3} bare />
        </div>
      ) : events.length ? (
        <ActivityList events={events.map(({ t: _t, ...e }) => e)} />
      ) : (
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{ut("tl.empty")}</p>
      )}
    </Panel>
  );
}

/* ─────────── контекст человека ─────────── */

/**
 * Последние замеры человека рядом со случаем: чтобы понять, кого разбираешь,
 * не уходя из очереди, — последние баллы с тяжестью словом, направления и
 * последнее подписанное заключение.
 */
function PatientContext({ userId }: { userId: string }) {
  const { ut } = useLang();
  /* keep: false — сводка прежнего пациента не встаёт рядом со случаем следующего (#177) */
  const res = useResource(() => api.caseSummary(userId), [userId], { keep: false, key: "alerts:summary" });
  const data = res.data;
  return (
    <Panel title={ut("al.context")} icon={<Ic.chart />} flush>
      {!data ? (
        <div className="px-4 pb-4">
          <Loading rows={3} error={res.error} onRetry={res.reload} busy={res.loading} bare />
        </div>
      ) : (
        <div className="border-t border-divider">
          {data.surveys.slice(0, 4).map((sv) => (
            <div key={sv.surveyId} className="border-b border-divider px-4 py-2.5 last:border-b-0">
              <div className="flex items-baseline gap-2">
                <b className="min-w-0 truncate text-[13px] font-extrabold text-text">{sv.title}</b>
                {sv.lastAt ? <span className="ml-auto shrink-0 text-caption text-muted">{dm(sv.lastAt)}</span> : null}
              </div>
              {sv.scales.slice(0, 3).map((sc) => (
                <div key={sc.code} className="mt-1 flex items-center gap-2 text-small">
                  <span className="min-w-0 flex-1 truncate text-text-2">{sc.title}</span>
                  <b className="font-extrabold tabular-nums text-text">{sc.lastValue}</b>
                  {sc.severity ? (
                    <SeverityTag level={sc.severity} small>
                      {sc.bandLabel ?? ut(severityKey[sc.severity])}
                    </SeverityTag>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
          {data.referrals.length ? (
            <div className="border-t border-divider px-4 py-2.5">
              <p className="m-0 mb-1 text-caption font-bold text-muted">{ut("nav.referrals")}</p>
              {data.referrals.slice(0, 3).map((r) => (
                <div key={r.id} className="flex items-center gap-2 py-0.5 text-small">
                  <span className="min-w-0 flex-1 truncate text-text">{ut(`dest.${r.destination}` as UiKey)}</span>
                  <span className="text-caption text-muted">{day(r.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {data.conclusions.length ? (
            <div className="border-t border-divider px-4 py-2.5">
              <p className="m-0 mb-1 text-caption font-bold text-muted">{ut("an.conclusion")}</p>
              <p className="m-0 line-clamp-3 text-small text-text-2">{data.conclusions[0]!.text}</p>
            </div>
          ) : null}
          {!data.surveys.length && !data.referrals.length && !data.conclusions.length ? (
            <p className="m-0 px-4 py-3.5 text-small text-muted">{ut("pt.noCompleted")}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/* ─────────── ритм разбора ─────────── */

/** Числа очереди целиком — из SQL (facets), а не из загруженной страницы */
function RhythmPanel({ facets, now }: { facets: NonNullable<AlertCasePage["facets"]>; now: number }) {
  const { ut } = useLang();
  const oldest = facets.oldestOpenedAt ? Math.max(0, Math.floor((now - Date.parse(facets.oldestOpenedAt)) / 60_000)) : null;
  const rows: [string, string, ReactNode][] = [
    [ut("al.rPeople"), ut("al.rPeopleSub").replace("{n}", String(facets.assigned.others)), facets.total],
    [ut("al.rOverdue"), ut("al.rOverdueSub"), facets.overdue],
    [ut("al.rMine"), ut("al.rMineSub").replace("{n}", String(facets.assigned.none)), facets.assigned.me],
  ];
  return (
    <Panel title={ut("al.rhythm")} icon={<Ic.gauge />} sub={ut("al.rhythmSub")} flush>
      <ul className="m-0 list-none border-t border-divider p-0">
        {rows.map(([label, sub, n]) => (
          <li key={label} className="flex items-start gap-3 border-b border-divider px-4 py-2.5 last:border-b-0">
            <span className="min-w-0 flex-1 text-small text-text">
              {label}
              <small className="block text-caption text-muted">{sub}</small>
            </span>
            <b className="text-[18px] font-extrabold tabular-nums text-text">{n}</b>
          </li>
        ))}
        {oldest !== null ? (
          <li className="flex items-start gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 text-small text-text">
              {ut("al.rOldest")}
              <small className="block text-caption text-muted">{dateTime(facets.oldestOpenedAt)}</small>
            </span>
            <b className="text-[18px] font-extrabold tabular-nums text-text">{clockText(oldest, ut("rr.days"))}</b>
          </li>
        ) : null}
      </ul>
    </Panel>
  );
}
