import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AlertCase, AlertCasePage, AlertSignal, AlertSignalBasis, RiskSeverity, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dateTime, day, severityKey } from "../format";
import { Avatar, Empty, HotkeyHint, IconSearchGlass, Loading, Modal, useAction, useHotkeys, useUrlState } from "../ui";
import { Page } from "../ui/layout";
import { Button, Input, Num, SectionLabel, SeverityTag, Tabs, Tag } from "../ui/primitives";
import { RuleSection } from "../ui/section";
import { IconCaret, IconClose } from "../ui/glyphs";
import { cx } from "../ui/cx";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { onAppEvent } from "../events";
import { Hint } from "../components/Hint";
import { usePagedResource, useResource } from "../useResource";
import {
  hasNarrowing,
  queueQuery,
  queueSections,
  readFilters,
  rowOverdue,
  subtitleParts,
  uniqueRows,
  waitingMinutes,
  withCount,
  type CaseStatus,
} from "./alerts/model";

const OUTCOME = [
  { value: "confirmed", key: "cases.confirmed" },
  { value: "needs_followup", key: "cases.needsFollowup" },
  { value: "not_confirmed", key: "cases.notConfirmed" },
] as const;

/** Строк на страницу очереди: экран высотой в два-три десятка строк и ещё одна «впрок» */
const PAGE = 30;

/**
 * Сколько минут в человекочитаемом виде.
 *
 * Переводчик аргументом: функция чистая и живёт вне компонента, а сокращения
 * единиц в двух языках разные — «мин» против «хв». В очереди случаев эта
 * подпись стоит у каждой строки, то есть была самым частым русским словом на
 * украинском экране.
 */
function duration(minutes: number, ut: (k: UiKey) => string): string {
  /*
   * Отрицательное или нечисло — часы клиента разошлись с сервером (или
   * данных нет): «-5 хв тому» читалось бы как время из будущего, а не как
   * сбой. Прочерк честнее — то же правило, что у длительностей в format.ts.
   */
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)} ${ut("dur.min")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${ut("dur.hour")}`;
  return `${Math.round(hours / 24)} ${ut("dur.day")}`;
}

/*
 * Форма точки выраженности — та же, что у SeverityTag (primitives.tsx):
 * умеренная — квадрат, тяжёлая — ромб. В строке очереди метки целиком нет —
 * подпись несёт заголовок раздела над строками, — но точка той же формы
 * остаётся: очередь читают боковым зрением, и форма различается там, где
 * цвет не различается вовсе.
 */
const DOT: Record<RiskSeverity, string> = {
  moderate: "bg-[var(--sev-moderate)]",
  severe: "bg-[var(--sev-severe)] rotate-45",
};

/**
 * Разбор случаев риска.
 *
 * Единица работы — человек, а не сработавший пункт. До этого экран показывал
 * строку на каждый отмеченный пункт: на четырёхстах обследуемых получалось
 * 397 карточек, где один человек встречался пять раз подряд, и дежурный не
 * мог ни расставить приоритеты, ни найти нужного.
 *
 * Порядок разбора задан, а не оставлен на усмотрение: тяжёлые сверху,
 * дальше по времени последнего сигнала. Кто взял случай — видно всем, иначе
 * двое дежурных разбирают одного человека дважды.
 *
 * ═══ Под нагрузкой (внешний разбор, волна 12) ═══
 *
 * Экран становился непригодным на сотнях открытых случаев. Курсор и
 * несколько фильтров уже были; не хватало того, без чего длинная очередь
 * всё равно врёт или теряется:
 *
 *   · строка на ЧЕЛОВЕКА, а не на случай: у человека бывает несколько
 *     открытых случаев (разные группы, давний за окном методики), и они
 *     раскатывались по разным страницам — разбирая свежий, дежурный не
 *     знал о старом. Сами случаи — рядом, в панели разбора (см. PersonCases);
 *   · разделы «Важкі / Помірні» с числами по всей выборке. Выраженность и
 *     так первый ключ порядка, поэтому разделы подписывают строки, а не
 *     переставляют их; группой по выраженности мы бы ничего не свернули;
 *   · все числа — подзаголовок, разделы, варианты фильтров — из SQL
 *     (facets), а не из загруженной страницы: прежде «прострочено» и
 *     «на мені» считались по тридцати строкам на экране;
 *   · фильтры по статусу, выраженности, «хто розбирає», підрозділу, групі
 *     пацієнтів, пацієнту і періоду — в адресе, как у соседних экранов, и
 *     поэтому сохраняются видом и пересылаются ссылкой.
 *
 * Три панели остаются: выбор строки не уводит со списка — ради этого они и
 * заводились (e2e/triage.e2e.ts).
 */
export default function Alerts() {
  const { user } = useAuth();
  const { ut } = useLang();
  const { run } = useAction();
  const [, setParams] = useSearchParams();

  /*
   * Отбор — в адресе, по полю на параметр (useUrlState пишет через replace:
   * «назад» уводит с экрана, а не отматывает фильтры по одному). Читается
   * через readFilters: незнакомое значение в адресе, присланном ссылкой, не
   * применяется, а не роняет экран в ошибку сервера.
   */
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
  const raw: Record<string, string> = {
    status: statusRaw,
    all: legacyAll,
    severity,
    assigned,
    unit,
    patientGroup,
    patient,
    from,
    to,
    q,
  };
  const filters = readFilters((name) => raw[name] ?? "");

  /*
   * Несколько параметров разом — одним переходом. Два вызова useUrlState
   * подряд писали бы каждый поверх адреса, который видел до другого, и
   * второй затирал бы первый. Смена статуса снимает и прежний `all=1`:
   * иначе «Відкриті» (статус по умолчанию, в адресе его нет) снова
   * читались бы как «Усі».
   */
  const patch = useCallback(
    (changes: Record<string, string>) =>
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            if (v) copy.set(k, v);
            else copy.delete(k);
          }
          return copy;
        },
        { replace: true },
      ),
    [setParams],
  );
  const setStatus = (next: CaseStatus) => patch({ status: next === "open" ? "" : next, all: "" });

  /*
   * Какой случай «под рукой» — по идентификатору, а не по номеру строки.
   * Указатель на позицию сползал: после «взять на себя» список перечитывался,
   * порядок менялся, и на экране оказывался уже другой человек — тот, кто
   * занял освободившееся место.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Случай человека, выбранный в панели разбора; null — самый срочный, тот, что в строке */
  const [pickedId, setPickedId] = useState<string | null>(null);

  // ключ отбора строкой: сравнивать объект в зависимостях эффекта бесполезно
  const filterKey = JSON.stringify(filters);

  // 300 мс на набор текста: поиск не дёргает сервер на каждую букву
  const page = usePagedResource<AlertCase, AlertCasePage>(
    (cursor) => api.alertCases(queueQuery(filters, PAGE, cursor)),
    [filterKey],
    { debounceMs: 300 },
  );
  const facets = page.head?.facets;
  const grouping = page.head?.grouping ?? (filters.status === "open" && !filters.patient ? "person" : "case");

  const units = useResource(() => api.alertCaseUnits(), []).data ?? [];
  /*
   * Группы пациентов — свои (чужая в адресе даёт 404, как у списка
   * пациентов). Права на них может и не быть: разбирать случаи — одно право,
   * видеть списки пациентов — другое; тогда фильтра нет, а экран работает.
   */
  const groups = useResource(() => api.patientGroups().catch(() => []), []).data ?? [];

  const rows = uniqueRows(page.items ?? [], grouping);
  const open = rows.filter((c) => !c.acknowledgedAt);
  // выбранный либо тот, что выбрали, либо первый в очереди
  const current = rows.find((c) => c.id === selectedId) ?? open[0];
  const selected = current ?? rows[0] ?? null;

  /*
   * Случаи человека строки — отдельным запросом, только когда их больше
   * одного: у большинства строк случай один, и ходить за ним второй раз
   * незачем.
   */
  const many = (selected?.group?.cases ?? 1) > 1;
  const personCases = useResource(
    () =>
      many && selected
        ? api
            .alertCases({ status: "open", group: "case", patient: selected.userId, limit: "20" })
            .then((p) => p.items)
        : Promise.resolve<AlertCase[]>([]),
    [many, selected?.userId, selected?.lastAlertAt, selected?.group?.cases],
  );
  useEffect(() => setPickedId(null), [selected?.userId]);
  const shown = personCases.data?.find((c) => c.id === pickedId) ?? selected;

  const refresh = useCallback(() => {
    page.reload();
    personCases.reload();
  }, [page.reload, personCases.reload]);

  /*
   * Очередь обновляется по событию: новая тревога должна появиться у
   * дежурного сразу, а взятый коллегой случай — сразу пометиться, иначе
   * двое разбирают одного человека.
   */
  useEffect(
    () =>
      onAppEvent((e) => {
        if (e.kind === "alert.created" || e.kind === "case.changed") refresh();
      }),
    [refresh],
  );

  /** Сдвиг по очереди клавишами: считается от текущего, а не от позиции */
  const move = (delta: number) => {
    if (!open.length) return;
    const at = open.findIndex((c) => c.id === current?.id);
    const next = open[Math.min(Math.max((at < 0 ? 0 : at) + delta, 0), open.length - 1)];
    if (next) setSelectedId(next.id);
  };

  /*
   * Решение уходит вместе с временем последнего сигнала, который человек
   * видел: пришёл новый, пока он читал, — сервер отвечает 409, а не кладёт
   * исход на непрочитанное. Очередь перечитывается в любом случае: и после
   * решения, и после отказа — во втором новый сигнал должен встать на экран.
   */
  const resolve = (target: AlertCase, outcome: string, note: string) =>
    run(async () => {
      try {
        await api.resolveCase(target.id, outcome, note, target.lastAlertAt);
      } finally {
        refresh();
      }
      // разобранный уходит из очереди: следующий сам станет выбранным
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

  /*
   * Клавиши подобраны так, чтобы рука не уходила с домашнего ряда: j/k —
   * движение по списку (как в почтовых клиентах и терминалах, где это
   * привычно), цифры 1–3 — исход в том же порядке, что кнопки на экране.
   */
  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    "1": () => shown && !shown.acknowledgedAt && void resolve(shown, "confirmed", ""),
    "2": () => shown && !shown.acknowledgedAt && void resolve(shown, "needs_followup", ""),
    "3": () => shown && !shown.acknowledgedAt && void resolve(shown, "not_confirmed", ""),
    t: () => {
      if (!shown || shown.assignedTo || shown.acknowledgedAt) return;
      void take(shown, false);
    },
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
  const sections = queueSections(rows, facets);
  const now = Date.now();

  return (
    /* заголовок остаётся: без него экран теряет ориентацию, а диктор — точку входа */
    <Page
      bleed
      title={ut("cases.title")}
      count={facets?.total ?? null}
      sub={subtitle || undefined}
      toolbar={
        <div className="relative w-full max-w-[520px] min-w-0">
          {/* имя полю — из плейсхолдера (Input сам ставит aria-label); лупа — украшение */}
          <Input
            look="fill"
            data-queue-search=""
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={ut("ui.surname")}
            className="pr-[34px]"
            autoComplete="off"
          />
          <span aria-hidden className="pointer-events-none absolute right-[8px] top-1/2 -translate-y-1/2 text-primary [&>svg]:size-[20px]">
            <IconSearchGlass />
          </span>
        </div>
      }
    >
      {/* на узком окне прокручивается всё вместе: строка отбора там выше половины экрана */}
      <div className="flex h-full min-h-0 flex-col max-[900px]:overflow-y-auto">
        {/*
          Строка отбора — над всеми тремя панелями, а не в узкой колонке
          очереди: семь полей в колонке 320 вставали столбиком и съедали
          полэкрана списка, ради которого экран и открыт.
        */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-[14px] gap-y-[10px] border-b border-hairline px-[22px] pb-[12px]">
          {/* обёртка с min-w-0: на узком окне полоса вкладок прокручивается сама, а не распирает строку */}
          <div className="min-w-0 max-w-full">
            <Tabs
              label={ut("cases.statusLabel")}
              items={(
                [
                  ["open", "cases.filterOpen"],
                  ["resolved", "cases.filterResolved"],
                  ["all", "cases.filterAll"],
                ] as const
              ).map(([value, key]) => ({
                id: `cases-status-${value}`,
                label: ut(key),
                active: filters.status === value,
                onSelect: () => setStatus(value),
                controls: "cases-queue",
              }))}
            />
          </div>
          <span className="w-[10px]" aria-hidden />
          <FillSelect
            label={ut("cases.severityLabel")}
            value={filters.severity}
            onChange={setSeverity}
            options={[
              { value: "", label: ut("cases.anySeverity") },
              { value: "severe", label: withCount(ut("cases.severeOnly"), facets?.severity.severe) },
              { value: "moderate", label: withCount(ut("cases.moderate"), facets?.severity.moderate) },
            ]}
          />
          <FillSelect
            label={ut("cases.assignedLabel")}
            value={filters.assigned}
            onChange={setAssigned}
            options={[
              { value: "", label: ut("cases.assignedAny") },
              { value: "me", label: withCount(ut("cases.assignedMe"), facets?.assigned.me) },
              { value: "none", label: withCount(ut("cases.assignedNone"), facets?.assigned.none) },
              { value: "others", label: withCount(ut("cases.assignedOthers"), facets?.assigned.others) },
            ]}
          />
          <FillSelect
            label={ut("ui.unit")}
            value={filters.unit}
            onChange={setUnit}
            options={[
              { value: "", label: ut("ui.unitAll") },
              // значение из адреса, которого нет среди подразделений, всё равно показывается выбранным
              ...[...new Set([...units, ...(filters.unit ? [filters.unit] : [])])].map((u) => ({ value: u, label: u })),
            ]}
          />
          {groups.length || filters.patientGroup ? (
            <FillSelect
              label={ut("cases.groupLabel")}
              value={filters.patientGroup}
              onChange={setPatientGroup}
              options={[
                { value: "", label: ut("cases.groupAll") },
                ...groups.map((g) => ({ value: g.id, label: g.title })),
                ...(filters.patientGroup && !groups.some((g) => g.id === filters.patientGroup)
                  ? [{ value: filters.patientGroup, label: ut("cases.groupLabel") }]
                  : []),
              ]}
            />
          ) : null}
          {/*
            Период — по дате открытия случая: она у случая не меняется, и
            «за вчерашнє чергування» не расползается от нового сигнала.
          */}
          <Input
            type="date"
            look="fill"
            aria-label={ut("cases.periodFrom")}
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="w-[168px]"
          />
          <Input
            type="date"
            look="fill"
            aria-label={ut("cases.periodTo")}
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="w-[168px]"
          />
          {filters.patient ? (
            <span className="inline-flex items-center gap-[6px]">
              <Tag tone="primary">
                {ut("cases.patientFilter")}: {rows[0]?.userName ?? "…"}
              </Tag>
              <Button size="glyph-sm" variant="quiet" aria-label={ut("cases.clearPatient")} onClick={() => patch({ patient: "" })}>
                <IconClose />
              </Button>
            </span>
          ) : null}
          {narrowed ? (
            <Button
              variant="quiet"
              onClick={() =>
                patch({ severity: "", assigned: "", unit: "", patientGroup: "", patient: "", from: "", to: "", q: "" })
              }
            >
              {ut("cases.clearFilters")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <SavedViews scope="alerts" />
        </div>

        <div
          className={cx(
            "grid min-h-0 flex-1",
            "grid-cols-[minmax(280px,340px)_minmax(420px,1fr)_minmax(260px,330px)]",
            /* на 3/4 экрана контекст пациента уходит: три колонки там превращаются в кашу */
            "max-[1400px]:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]",
            /* на узком — столбиком, очередь сверху своей прокруткой */
            "max-[900px]:flex max-[900px]:flex-none max-[900px]:flex-col",
          )}
        >
          {/* ── панель 1: очередь ── */}
          <aside
            id="cases-queue"
            aria-label={ut("cases.queueLabel")}
            className="flex min-h-0 flex-col overflow-y-auto border-r border-hairline max-[900px]:max-h-[46vh] max-[900px]:shrink-0 max-[900px]:border-b max-[900px]:border-r-0"
          >
            {!page.items ? (
              <div className="p-[12px]">
                <Loading rows={6} error={page.error} onRetry={page.reload} />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-[12px]">
                <Empty
                  title={
                    narrowed
                      ? ut("cases.emptyFiltered")
                      : filters.status === "open"
                        ? ut("cases.emptyOpen")
                        : ut("cases.emptyAll")
                  }
                  hint={ut("cases.emptyHint")}
                />
              </div>
            ) : (
              sections.map((s) => (
                <section key={s.severity} aria-labelledby={`cases-section-${s.severity}`}>
                  {/*
                    Заголовок раздела прилипает к верху колонки: листая
                    умеренные, дежурный видит, что тяжёлые кончились, — и
                    сколько их было всего, а не сколько загрузилось.
                  */}
                  <h2
                    id={`cases-section-${s.severity}`}
                    className="sticky top-0 z-[1] m-0 flex items-center gap-[8px] border-b-2 border-primary-rule bg-[var(--bg)] px-[12px] py-[8px]"
                  >
                    <SeverityTag level={s.severity}>
                      {s.severity === "severe" ? ut("cases.sectionSevere") : ut("cases.moderate")}
                    </SeverityTag>
                    {s.total !== null ? <Num className="text-[13px] text-muted">{s.total}</Num> : null}
                  </h2>
                  <ul className="m-0 list-none p-0">
                    {s.items.map((c) => (
                      <li key={c.id}>
                        <QueueRow
                          c={c}
                          active={c.id === selected?.id}
                          me={user?.id}
                          now={now}
                          onPick={() => setSelectedId(c.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
            {page.items && rows.length ? (
              <div className="px-[12px] py-[12px]">
                {page.hasMore ? (
                  <Button variant="ghost" className="w-full" disabled={page.loadingMore} onClick={page.loadMore}>
                    {page.loadingMore ? ut("ui.loading") : ut("ui.loadMore")}
                  </Button>
                ) : (
                  <p className="m-0 text-center text-[13px] text-muted">{ut("ui.endOfList")}</p>
                )}
              </div>
            ) : null}
          </aside>

          {/* ── панель 2: сам случай ── */}
          <section data-triage-case="" className="min-h-0 overflow-y-auto px-[22px] pb-[40px] pt-[18px]">
            {shown ? (
              <CaseCard
                key={shown.id}
                c={shown}
                row={selected!}
                personCases={many ? (personCases.data ?? null) : null}
                pickedId={shown.id}
                onPickCase={setPickedId}
                onShowPerson={() => patch({ patient: shown.userId })}
                onResolve={(outcome, note) => resolve(shown, outcome, note)}
                onTake={(release) => take(shown, release)}
                me={user?.id}
              />
            ) : (
              /*
                «Ничего не выбрано» — не то же, что «ничего нет».
                Здесь стояло «Открытых случаев нет» — и висело оно при полном
                списке слева: панель разбора путала пустую очередь с невыбранной
                строкой и врала о состоянии отделения. Ровно эту же ошибку уже
                находили в переписке.
              */
              <Empty
                title={ut(rows.length ? "cases.pickOne" : "cases.emptyOpen")}
                hint={ut(rows.length ? "cases.pickOneHint" : "cases.emptyHint")}
              />
            )}
            <div className="mt-[24px]">
              <HotkeyHint
                keys={[
                  ["J / K", ut("hotkey.next")],
                  ["1", ut("hotkey.confirm")],
                  ["2", ut("hotkey.followup")],
                  ["3", ut("hotkey.reject")],
                  ["T", ut("hotkey.take")],
                  ["/", ut("hotkey.search")],
                ]}
              />
            </div>
          </section>

          {/* ── панель 3: контекст человека ── */}
          <aside className="flex min-h-0 flex-col gap-[16px] overflow-y-auto border-l border-hairline p-[16px] max-[1400px]:hidden">
            {selected ? <PatientContext userId={selected.userId} /> : null}
          </aside>
        </div>
      </div>
    </Page>
  );
}

/**
 * Выбор-фильтр в залитом силуэте поля (заливка #f0ecff, без рамки, высота
 * 36, радиус 5) — как фильтры «Лікарі» и «Статистики».
 *
 * Свой, а не общий Select: у того залитого вида нет, а перекрыть рамку и
 * заливку классом снаружи нельзя — две утилиты одного свойства в строке
 * классов спорят, и побеждает та, что ниже в собранном CSS (см. FillSelect в
 * people/StaffList.tsx, откуда взят рисунок). Пустой выбор набран подписью
 * поля — 17/700 фиолетовым, выбранный — начертанием данных: заполненный
 * фильтр обязан отличаться от незаполненного с первого взгляда.
 */
function FillSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const empty = !value;
  return (
    <span className="relative block w-[220px] min-w-0 max-[900px]:w-full">
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-9 w-full min-w-0 appearance-none truncate rounded-[5px] border-0 bg-primary-soft pl-[10px] pr-[30px] text-[17px]",
          empty ? "font-bold text-primary" : "font-normal text-text",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-[11px] top-1/2 flex -translate-y-1/2 text-primary">
        <IconCaret />
      </span>
    </span>
  );
}

/**
 * Строка очереди.
 *
 * Всё, что нужно для выбора следующего: выраженность точкой и разделом,
 * кто держит случай, сколько у человека случаев и сколько он ждёт.
 * Разбор идёт подряд, и строка не должна требовать чтения — только взгляда.
 *
 * Янтарь — только у «прострочено»: это и есть «требует внимания». «Взяв» —
 * состояние, оно фиолетовое; прежде кружок «кто взял» был янтарным и спорил
 * с просроченными за один и тот же цвет.
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
  const severity: RiskSeverity = c.severity === "severe" ? "severe" : "moderate";
  const outcome = OUTCOME.find((o) => o.value === c.outcome);
  return (
    <button
      type="button"
      data-queue-row=""
      data-done={done ? "true" : undefined}
      onClick={onPick}
      aria-current={active}
      className={cx(
        "flex w-full items-start gap-[10px] border-0 border-b border-hairline px-[12px] py-[10px] text-left",
        "transition-colors duration-[var(--dur-fast)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]",
        active ? "bg-primary-soft" : "bg-transparent hover:bg-primary-tint",
      )}
    >
      <span aria-hidden className={cx("mt-[7px] size-2 shrink-0", DOT[severity])} />
      <span className="min-w-0 flex-1">
        <span
          data-queue-name=""
          className={cx("block truncate text-[15px] font-bold leading-[20px]", done ? "text-muted" : "text-primary")}
        >
          {c.userName}
        </span>
        <span className="block truncate text-[13px] leading-[18px] text-muted">
          <span className="sr-only">{ut(severityKey[severity])} · </span>
          {c.unit ? `${c.unit} · ` : ""}
          {c.surveyTitle}
        </span>
        <span className="mt-[4px] flex flex-wrap gap-[6px] empty:hidden">
          {!done && rowOverdue(c) ? <Tag tone="attention">{ut("cases.overdue")}</Tag> : null}
          {c.group && c.group.cases > 1 ? <Tag>{ut("cases.casesN").replace("{n}", String(c.group.cases))}</Tag> : null}
          {done ? (
            <Tag>{outcome ? ut(outcome.key) : ut("work.done")}</Tag>
          ) : c.assignedTo ? (
            <Tag tone={c.assignedTo === me ? "primary" : "plain"}>
              {c.assignedTo === me ? ut("cases.mine") : `${ut("cases.taken")}: ${c.assignedToName ?? "—"}`}
            </Tag>
          ) : null}
        </span>
      </span>
      <span className="shrink-0 pt-[2px] font-mono text-[11px] tabular-nums text-muted">
        {duration(waitingMinutes(c, now), ut)}
      </span>
    </button>
  );
}

/**
 * Контекст пациента рядом со случаем.
 *
 * Раньше, чтобы понять, кого разбираешь, нужно было уйти на карту и потерять
 * место в очереди. Здесь то же самое стоит рядом: последние баллы, открытые
 * тревоги, направления и подписанные заключения.
 */
function PatientContext({ userId }: { userId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.caseSummary(userId), [userId]);
  const data = res.data;

  if (!data) return <Loading rows={4} error={res.error} />;

  return (
    <>
      <div className="flex items-center gap-[10px]">
        <Avatar name={data.fullName} size={30} />
        <div className="min-w-0 flex-1">
          <Link to={`/patients/${userId}`} className="block truncate text-[15px] font-bold text-primary">
            {data.fullName}
          </Link>
          <p className="m-0 text-[13px] text-muted">
            {[data.unit, data.age ? `${data.age}` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      {data.surveys.map((sv) => (
        <div key={sv.surveyId} className="flex flex-col gap-[4px]">
          <h3 className="m-0 text-[13px] font-bold text-text">{sv.title}</h3>
          {sv.scales.slice(0, 6).map((sc) => (
            <div key={sc.code} className="flex items-center gap-[8px] border-b border-hairline py-[3px] text-[13px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{sc.title}</span>
              <Num>{sc.lastValue}</Num>
              {/* выраженность — меткой с подписью и формой точки, не одним цветом */}
              {sc.severity ? <SeverityTag level={sc.severity}>{ut(severityKey[sc.severity])}</SeverityTag> : null}
            </div>
          ))}
        </div>
      ))}

      {data.referrals.length ? (
        <div className="flex flex-col gap-[4px]">
          <h3 className="m-0 text-[13px] font-bold text-text">{ut("nav.referrals")}</h3>
          {data.referrals.slice(0, 3).map((r) => (
            <div key={r.id} className="flex items-center gap-[8px] border-b border-hairline py-[3px] text-[13px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{r.destination}</span>
              <span className="text-muted">{day(r.createdAt)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {data.conclusions.length ? (
        <div className="flex flex-col gap-[4px]">
          <h3 className="m-0 text-[13px] font-bold text-text">{ut("an.conclusion")}</h3>
          <p className="m-0 text-[13px] text-muted">
            {data.conclusions[0]!.text.slice(0, 180)}
            {data.conclusions[0]!.text.length > 180 ? "…" : ""}
          </p>
        </div>
      ) : null}
    </>
  );
}

function CaseCard({
  c,
  row,
  personCases,
  pickedId,
  onPickCase,
  onShowPerson,
  onResolve,
  onTake,
  me,
}: {
  c: AlertCase;
  /** Строка очереди, из которой открыт случай: у неё — сводка по всем случаям человека */
  row: AlertCase;
  /** Открытые случаи человека, если их больше одного; null — один или ещё грузятся */
  personCases: AlertCase[] | null;
  pickedId: string;
  onPickCase: (id: string) => void;
  onShowPerson: () => void;
  onResolve: (outcome: string, note: string) => Promise<unknown>;
  onTake: (release: boolean) => Promise<unknown>;
  me: string | undefined;
}) {
  const { ut } = useLang();
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const done = !!c.acknowledgedAt;
  const takenByOther = !!c.assignedTo && c.assignedTo !== me;
  const outcome = OUTCOME.find((o) => o.value === c.outcome);
  const many = (row.group?.cases ?? 1) > 1;

  return (
    <article
      data-case-card=""
      // ref-колбэк обязан ничего не возвращать: React трактует возврат как функцию очистки
      ref={(el) => {
        el?.scrollIntoView({ block: "nearest" });
      }}
      className="flex flex-col gap-[16px]"
    >
      <header className="flex flex-wrap items-start gap-[12px]">
        <Avatar name={c.userName} size={30} />
        <div className="min-w-0 flex-1">
          <Link to={`/patients/${c.userId}`} className="text-[20px] font-bold leading-[24px] text-primary">
            {c.userName}
          </Link>
          <p className="m-0 mt-[2px] text-[13px] leading-[18px] text-muted">
            {c.unit ? `${c.unit} · ` : ""}
            {c.surveyTitle} · {ut("cases.signals")} <Num>{c.signalCount}</Num> · {ut("cases.openedAgo")}{" "}
            {duration(c.minutesOpen, ut)} {ut("cases.ago")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[6px]">
          <SeverityTag level={c.severity}>{ut(severityKey[c.severity])}</SeverityTag>
          {c.overdue ? <Tag tone="attention">{ut("cases.overdue")}</Tag> : null}
          {done ? (
            <Tag>{outcome ? ut(outcome.key) : ut("work.done")}</Tag>
          ) : c.assignedTo ? (
            <Tag tone={takenByOther ? "plain" : "primary"}>
              {takenByOther ? `${ut("cases.taken")}: ${c.assignedToName}` : ut("cases.mine")}
            </Tag>
          ) : null}
        </div>
      </header>

      {many ? (
        <PersonCases
          total={row.group!.cases}
          cases={personCases}
          pickedId={pickedId}
          onPick={onPickCase}
          onShowPerson={onShowPerson}
        />
      ) : null}

      <div>
        <Button variant="quiet" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? ut("cases.hideSignals") : `${ut("cases.showSignals")} (${c.signalCount})`}
        </Button>
        {expanded ? <CaseBasis caseId={c.id} preview={c.signals} total={c.signalCount} /> : null}
      </div>

      {done ? (
        <p className="m-0 text-[13px] text-muted">
          {c.acknowledgedByName}, {dateTime(c.acknowledgedAt)}
          {c.note ? ` · ${c.note}` : ""}
          {c.mergedFromLegacy ? ` · ${ut("cases.mergedNote")}` : ""}
        </p>
      ) : (
        <div className="flex flex-col gap-[10px]">
          {takenByOther ? <p className="m-0 text-[13px] text-muted">{ut("cases.takenByOther")}</p> : null}
          <Input
            look="outline"
            ph="plain"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={ut("cases.whatDone")}
          />
          <div className="flex flex-wrap items-center gap-[8px]">
            {!c.assignedTo ? (
              <Button variant="ghost" onClick={() => void onTake(false)}>
                {ut("cases.take")}
              </Button>
            ) : c.assignedTo === me ? (
              <Button variant="ghost" onClick={() => void onTake(true)}>
                {ut("cases.release")}
              </Button>
            ) : null}
            {/*
              Исходы разбора называются коротко, и «без исхода» читается как
              «ничего не сделал». Объяснение стоит рядом с кнопками, а не в
              документации, которую в разборе не открывают.
            */}
            {OUTCOME.map((o, i) => (
              <Button key={o.value} variant={i === 0 ? "primary" : "ghost"} onClick={() => void onResolve(o.value, note)}>
                {ut(o.key)}
              </Button>
            ))}
          </div>
          <Hint id="case-status" text="hint.caseStatus" />
        </div>
      )}
    </article>
  );
}

/**
 * Случаи человека, когда их у него больше одного.
 *
 * Строка очереди стоит за человека, а решение принимается о случае: у
 * каждого своя зона видимости (группа методики) и своё окно. Поэтому они
 * здесь перечислены, выбираются по одному, и хоткеи работают с выбранным.
 * «Усі випадки людини» ставит отбор по пациенту — очередь раскладывает его
 * случаи строками, и их можно пройти подряд.
 */
export function PersonCases({
  total,
  cases,
  pickedId,
  onPick,
  onShowPerson,
}: {
  total: number;
  cases: AlertCase[] | null;
  pickedId: string;
  onPick: (id: string) => void;
  onShowPerson: () => void;
}) {
  const { ut } = useLang();
  return (
    <RuleSection
      title={
        <>
          {ut("cases.personCases")} <Num className="text-[13px] font-normal text-muted">{total}</Num>
        </>
      }
      hint={ut("cases.personCasesHint")}
      actions={
        <Button variant="ghost" onClick={onShowPerson}>
          {ut("cases.showPersonCases")}
        </Button>
      }
    >
      {!cases ? (
        <Loading rows={2} />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {cases.map((pc) => (
            <li key={pc.id}>
              <button
                type="button"
                aria-pressed={pc.id === pickedId}
                onClick={() => onPick(pc.id)}
                className={cx(
                  "flex w-full flex-wrap items-center gap-[8px] border-0 border-b border-hairline px-[8px] py-[8px] text-left text-[13px]",
                  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]",
                  pc.id === pickedId ? "bg-primary-soft" : "bg-transparent hover:bg-primary-tint",
                )}
              >
                <SeverityTag level={pc.severity}>{ut(severityKey[pc.severity])}</SeverityTag>
                <span className="min-w-0 flex-1 truncate text-text">{pc.surveyTitle}</span>
                {pc.overdue ? <Tag tone="attention">{ut("cases.overdue")}</Tag> : null}
                <span className="font-mono text-[11px] tabular-nums text-muted">{day(pc.openedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </RuleSection>
  );
}

/**
 * Основание тревог случая.
 *
 * Раньше здесь стояли три поля из очереди: время, готовая подпись и
 * «заголовок» — который у половины строк был вовсе не заголовком пункта, а
 * названием шкалы. Разбирающий видел «Суицидальный риск» и не мог узнать
 * главного: человек это отметил или так посчиталось. Разница клиническая:
 * отмеченный вариант — прямое высказывание, полоса — вывод из суммы баллов.
 *
 * Поэтому оба вида подписаны прямо и показываются по-разному, а рядом стоит
 * ход к самому прохождению: ответы по пунктам — единственное, что закрывает
 * вопрос «на основании чего» окончательно.
 *
 * Грузится по раскрытию, а не вместе с очередью: очередь отдаёт тридцать
 * случаев, а основание читают у одного.
 */
function CaseBasis({
  caseId,
  preview,
  total,
}: {
  caseId: string;
  /** Что уже пришло со случаем: показывается, пока грузится основание */
  preview: AlertSignal[];
  total: number;
}) {
  const { ut } = useLang();
  const [openResponse, setOpenResponse] = useState<string | null>(null);
  const res = useResource(() => api.alertCaseSignals(caseId), [caseId]);
  const items = res.data;

  if (!items) {
    return (
      <div className="mt-[8px] flex flex-col gap-[6px]">
        {preview.map((s) => (
          <div key={s.id} className="grid grid-cols-[130px_1fr_1fr] gap-[10px] border-b border-hairline py-[5px] text-[13px]">
            <span className="text-muted">{dateTime(s.at)}</span>
            <span>{s.label}</span>
            <span className="text-muted">{s.questionTitle}</span>
          </div>
        ))}
        {res.error ? <p className="m-0 text-[13px] text-muted">{ut("cases.loadBasisFailed")}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <SectionLabel>{ut("cases.basis")}</SectionLabel>
      {/*
        Пояснение стоит здесь, а не в документации: два вида сигнала —
        отмеченный вариант и полоса шкалы — разные по клиническому весу, и
        разбирающий должен знать это в момент чтения, а не когда-нибудь.
      */}
      <p className="m-0 max-w-[68ch] text-caption text-muted">{ut("cases.basisHint")}</p>
      {items.map((s) => (
        <SignalBasisRow key={s.id} s={s} onOpen={() => setOpenResponse(s.responseId)} />
      ))}
      {/*
        Число сигналов в шапке считается по доступным методикам, а список
        здесь — тоже. Расхождение возможно только если тревогу разобрали
        между двумя запросами, и тогда честнее сказать, сколько не показано,
        чем молча показать меньше.
      */}
      {total > items.length ? (
        <p className="m-0 text-[13px] text-muted">
          …{ut("ui.andMore")} {total - items.length}
        </p>
      ) : null}
      {openResponse ? <ResponseModal id={openResponse} onClose={() => setOpenResponse(null)} /> : null}
    </div>
  );
}

/** Одна строка основания: слева вид сигнала, справа — на чём он держится */
function SignalBasisRow({ s, onOpen }: { s: AlertSignalBasis; onOpen: () => void }) {
  const { ut } = useLang();
  const answered = s.pickedOptions.length > 0 || s.answeredNumber !== null;

  return (
    <div className="rounded-sm border border-hairline p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityTag level={s.severity}>{ut(severityKey[s.severity])}</SeverityTag>
        <Tag>{ut(s.kind === "option" ? "cases.kind.option" : "cases.kind.band")}</Tag>
        <span className="text-caption text-muted">{s.surveyTitle}</span>
        <span className="text-caption text-muted">{dateTime(s.at)}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {ut("cases.openResponse")}
        </Button>
      </div>

      {s.kind === "option" ? (
        <div className="mt-1.5 text-small">
          <div>
            <span className="text-muted">{ut("cases.item")}</span>{" "}
            {s.questionNumber !== null ? <Num>{s.questionNumber}</Num> : null}
            {s.questionNumber !== null ? ". " : ""}
            {s.questionTitle}
          </div>
          {answered ? (
            <div>
              <span className="text-muted">{ut("cases.picked")}:</span>{" "}
              <strong>
                {s.pickedOptions.length ? s.pickedOptions.join(", ") : String(s.answeredNumber)}
              </strong>
            </div>
          ) : (
            /*
             * Ответа нет, а тревога есть: так бывает у сигнала, поднятого
             * автосохранением черновика, который потом переписали. Молчать
             * об этом нельзя — иначе пустая строка читается как «человек
             * ничего не отмечал», и сигнал выглядит ложным.
             */
            <p className="m-0 text-caption text-muted">{ut("cases.noAnswerStored")}</p>
          )}
        </div>
      ) : (
        <div className="mt-1.5 text-small">
          <div>
            <span className="text-muted">{ut("cases.scale")}:</span> {s.scaleTitle}
            {s.scaleCode ? <span className="text-muted"> · {s.scaleCode}</span> : null}
          </div>
          <div>
            {s.scaleValue !== null ? (
              <>
                <strong>
                  <Num>{s.scaleValue}</Num>
                </strong>{" "}
                {s.normalization ? ut(`norm.${s.normalization}`) : ""}
                {s.scaleRawScore !== null ? (
                  <span className="text-muted">
                    {" "}
                    · {ut("cases.rawScore")} <Num>{s.scaleRawScore}</Num>
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          {s.bandLabel ? (
            <div>
              <span className="text-muted">{ut("cases.band")}:</span> <strong>{s.bandLabel}</strong>
              {/*
                Границы полосы — не украшение: без них значение нечитаемо.
                «2 стена» — это много или мало, зависит от того, где проходит
                полоса, и держать это в голове разбирающий не обязан.
              */}
              {s.bandMin !== null && s.bandMax !== null ? (
                <span className="text-muted">
                  {" "}
                  (<Num>{s.bandMin}</Num>–<Num>{s.bandMax}</Num>)
                </span>
              ) : null}
            </div>
          ) : null}
          {s.bandRecommendation ? (
            <p className="m-0 text-caption text-muted">{s.bandRecommendation}</p>
          ) : s.bandDescription ? (
            <p className="m-0 text-caption text-muted">{s.bandDescription}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

const th = "border-b border-hairline px-[8px] py-[6px] text-left text-[13px] font-bold text-muted";
const td = "border-b border-hairline px-[8px] py-[6px] align-top";

/**
 * Прохождение целиком: ответы по пунктам и баллы по шкалам.
 *
 * Открывается прямо из разбора, а не переходом на другой экран: уйдя из
 * очереди, дежурный теряет место в ней, а вернувшись — уже другой порядок.
 *
 * Варианты ответа приходят вместе с прохождением и той версии, которую
 * человек реально видел. Сопоставлять их с действующей версией методики
 * нельзя: после правки набор вариантов другой, и «что он ответил» получилось
 * бы не из того списка.
 */
function ResponseModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { ut } = useLang();
  const res = useResource(() => api.responseDetail(id), [id]);
  const data = res.data;

  return (
    <Modal title={ut("cases.responseTitle")} onClose={onClose} wide>
      {!data ? (
        <Loading rows={5} error={res.error} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span>
              <strong>{data.survey.title}</strong>
              <span className="text-muted"> · {dateTime(data.submittedAt ?? data.startedAt)}</span>
            </span>
            {/*
              Окно остаётся окном (см. выше, почему не переход), но у
              прохождения теперь есть и адрес — с весами вариантов и
              лестницей диапазонов, которых в окне нет. Ссылка ведёт туда
              тем, кому нужен протокол целиком или ссылка для коллеги.
            */}
            <Link to={`/surveys/${data.survey.id}/responses/${id}`} className="text-[13px]">
              {ut("rsp.openPage")}
            </Link>
          </div>

          {data.scores.length ? (
            <div>
              <SectionLabel className="mb-2">{ut("cases.scoresTitle")}</SectionLabel>
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
                        <td className={td}>
                          <Num>{sc.rawScore}</Num>
                        </td>
                        <td className={td}>
                          <Num>{sc.value}</Num> <span className="text-muted">{ut(`norm.${sc.normalization}`)}</span>
                        </td>
                        <td className={td}>
                          {sc.band ? (
                            <SeverityTag level={sc.band.severity}>{sc.band.label}</SeverityTag>
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
            <SectionLabel className="mb-2">{ut("cases.answersTitle")}</SectionLabel>
            <ol className="m-0 flex flex-col gap-1.5 pl-6">
              {data.answers.map((a) => {
                const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
                const chosen = a.options.filter((o) => picked.has(o.id));
                return (
                  <li key={a.questionId} className="text-small">
                    <div>{a.title}</div>
                    {!a.answered ? (
                      <span className="text-muted">{ut("cases.skipped")}</span>
                    ) : chosen.length ? (
                      <span>
                        {chosen.map((o, i) => (
                          <span key={o.id}>
                            {i ? ", " : ""}
                            <strong className={o.riskFlag ? "text-danger" : undefined}>{o.text}</strong>
                            {/*
                              Критический вариант помечается словом, а не
                              только цветом: цвет один не работает, и на
                              разборе риска это не тот случай, где можно
                              положиться на оттенок.
                            */}
                            {o.riskFlag ? (
                              <span className="text-caption text-danger"> · {ut("cases.criticalOption")}</span>
                            ) : null}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span>{a.text ?? (a.number !== null ? String(a.number) : (a.date ?? "—"))}</span>
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
