import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  LOCALE_OF,
  pointShare,
  pointValueText,
  pointValueTop,
  type PatientListCounts,
  type PatientListItem,
  type UiKey,
} from "@quizzy/shared";
import { api, openInTab } from "../api";
import { CourseChart } from "../charts/course";
import { courseEventsFromTimeline, courseFromDynamics } from "../charts/courseModel";
import { TimeLines } from "../charts/clinical";
import { instrumentMark, seriesColor } from "../charts/kit";
import { Hint } from "../components/Hint";
import { locale as consoleLocale, severityKey } from "../format";
import { useLang } from "../lang";
import {
  Avatar,
  BigValue,
  BigValues,
  BulkBar,
  ChangeCell,
  CourseDigits,
  DataTable,
  Drawer,
  DrawerPane,
  Empty,
  FilterBar,
  Ic,
  KbdHints,
  Loading,
  PersonCell,
  TextAction,
  Tooltip,
  ViewPill,
  ViewPills,
  tableToCsv,
  useAction,
  useHotkeys,
  type Column,
} from "../ui";
import { cx } from "../ui/cx";
import { Page, Panel } from "../ui/layout";
import { ActionMenu, MenuButton, menuItemClass } from "../ui/menu";
import { Pager } from "../ui/pager";
import { offsetPageCount, pageFrom, refilter, toPage } from "../ui/paging";
import { Button, ErrorText, Segmented, SeverityTag, Switch, Tabs, Tag } from "../ui/primitives";
import { patchParams } from "../ui/viewParams";
import { useDebounced, useResource } from "../useResource";
import { ShellIcon } from "../shell/icons";
import { useMedia } from "../shell/Rail";
import { usePatientViews } from "./patientGroups/views";
import { InviteDialog } from "./patients/InviteDialog";
import {
  changeOf,
  instrumentsOf,
  shortCode,
  shownDelta,
  shownThreshold,
  type Instrument,
  type InstrumentScale,
} from "./patients/instruments";
import {
  ageOf,
  ddmm,
  daysAgo,
  DYN_KEY,
  fmtNum,
  TL_KEY,
  groupTab,
  hhmm,
  kitSeverity,
  LIST_VIEWS,
  plural,
  registerBody,
  REGISTER_PER,
  registerPer,
  registerQuery,
  shownSeries,
  shownValue,
  sortOf,
  viewOf,
  whenShort,
  type ListSort,
} from "./patients/model";
import { useAssignPane, useGroupPane, useMessagePane, type PaneParts, type Who } from "./patients/actions";
import { useQuickViewPane } from "./patients/QuickView";

/*
 * Реестр пациентов 2.0 — кадр patients-list набора «Виразна».
 *
 * Что на кадре и откуда оно в коде:
 *
 *   шапка «Пацієнти», «N людей», «за вами / з сигналом»   → Page, счётчики сервера
 *   «Подання: …», выгрузка, «Запросити пацієнта»          → меню видов, CSV, окно приглашения
 *   вкладки групп с числами, «Ще N»                         → ?group, Tabs + меню
 *   поиск «/», «Закріплені за мною», «20 з 248», порядок     → ?q, ?mine, ?sort (сервер)
 *   «Потребує уваги»: Усі / ризик / без заміру / без запису  → ?view (сервер, со счётчиками)
 *   таблица: ризик першим, замір с ходом, прийом            → DataTable, страницы сервера
 *   отметка строк и «Вибрано: N»                            → BulkBar, действия в ящике
 *   «Хто це» по строке                                      → ящик рядом с таблицей, ↑↓ по строкам
 *
 * Откуда люди. GET /api/patients — все, кого читатель вправе видеть (не
 * только обследованные, как прежде /api/dynamics/respondents): записанный
 * на приём и ещё ничего не проходивший в реестре есть. Сервер же отдаёт
 * повод в строке — открытый случай, главную шкалу последнего замера с
 * ходом, ближайший приём, неявку, учёт, ведущего, — счётчики подань и
 * порядок «ризик спершу»: по одной странице их не посчитать.
 *
 * Чего на кадре нет в данных приложения и что не нарисовано: номер карты
 * («карта 0117»), курс терапии «КПТ, 5 з 8», вид «Картки». Вместо карты в
 * строке — подразделение; вместо курса — дата замера с пометкой давности.
 *
 * Всё состояние — в адресе: «подивись, хто без запису» пересылают ссылкой.
 */

type Mode = "who" | "assign" | "group" | "message";

interface DrawerState {
  open: boolean;
  mode: Mode;
  /** Для «Хто це» и «Написати» — кто именно */
  who: string | null;
  /** Для «Призначити» и «До групи»: с чего открыто — с выбранных или с одного человека */
  people: Who[];
}

const CLOSED: DrawerState = { open: false, mode: "who", who: null, people: [] };

export function PatientList() {
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const groupId = params.get("group");
  const q = params.get("q") ?? "";
  const view = viewOf(params.get("view"));
  const mine = params.get("mine") === "1";
  const sort = sortOf(params.get("sort"));
  const page = pageFrom(params.get("page"));
  const per = registerPer(params.get("per"));
  const qSent = useDebounced(q, 250);

  const update = useCallback(
    (patch: Record<string, string | null>) => setParams((prev) => patchParams(prev, patch), { replace: true }),
    [setParams],
  );

  /*
   * Группы — вкладки. Отказ по ним не прячет реестр: вкладки — другой угол
   * на тех же людей. Чужая или удалённая группа в адресе — «Усі», и адрес
   * говорит то же (patients/model.ts, groupTab).
   */
  const groups = useResource(() => api.patientGroups(), []);
  const { current, pending, stale } = groupTab(groupId, groups.data, groups.error);
  useEffect(() => {
    if (stale) update({ group: null });
  }, [stale, update]);

  const query = registerQuery({ q: qSent, group: current?.id ?? null, view, mine, sort, page, per });
  const list = useResource(() => api.patientRegister(query), [JSON.stringify(query)], { enabled: !pending });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const body = registerBody({
    hasData: !!list.data,
    error: list.error,
    rows: rows.length,
    filtered: !!(query.q || view || mine),
    group: !!current,
  });
  const pages = offsetPageCount(total, per);
  useEffect(() => {
    if (list.data && page > pages) update(toPage(pages));
  }, [list.data, page, pages, update]);

  /*
   * Числа шапки и вкладки «Усі» — без поиска: «248 людей» не должно
   * превращаться в «3» на каждую букву. Запоминаются по вкладке из ответа без
   * поиска; пока такого ответа не было, числа нет, а не ноль.
   */
  const baseCounts = useRef(new Map<string, PatientListCounts>());
  if (list.data?.counts && !query.q) baseCounts.current.set(current?.id ?? "", list.data.counts);
  const allCounts = baseCounts.current.get("") ?? null;
  const counts = list.data?.counts ?? null;

  /* отмеченные — по всем страницам; имена нужны ящику, поэтому строка целиком */
  const [picked, setPicked] = useState<Map<string, PatientListItem>>(() => new Map());
  const pickedKeys = useMemo(() => new Set(picked.keys()), [picked]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const [drawer, setDrawer] = useState<DrawerState>(CLOSED);
  const [invite, setInvite] = useState(false);
  const focused = drawer.who ? (byId.get(drawer.who) ?? null) : null;
  const at = focused ? rows.indexOf(focused) : -1;

  const openWho = (r: PatientListItem) => setDrawer({ open: true, mode: "who", who: r.id, people: [] });
  const step = (d: 1 | -1) => {
    const next = rows[at + d];
    if (next) setDrawer((s) => ({ ...s, who: next.id }));
  };
  const whoOf = (r: PatientListItem): Who => ({ id: r.id, name: r.name });

  useHotkeys({ n: () => setInvite(true) });

  const views = usePatientViews();
  const { run, busy } = useAction();

  /* виды ящика — хуками: Drawer узнаёт вид по элементу DrawerPane, и обёртка его спрятала бы */
  const close = () => setDrawer((s) => ({ ...s, open: false }));
  const who = useQuickViewPane({
    person: focused,
    position: focused ? { at, of: rows.length, sort: ut(SORT_LABEL[sort]) } : null,
    onStep: step,
    onWrite: () => focused && setDrawer({ open: true, mode: "message", who: focused.id, people: [whoOf(focused)] }),
    onAssign: () => focused && setDrawer({ open: true, mode: "assign", who: focused.id, people: [whoOf(focused)] }),
    locale,
  });
  const assign = useAssignPane(drawer.mode === "assign" ? drawer.people : [], close);
  const group = useGroupPane(drawer.mode === "group" ? drawer.people : [], groups.data ?? [], () => {
    close();
    groups.reload();
  });
  const message = useMessagePane(drawer.mode === "message" ? (drawer.people[0] ?? null) : null, close);
  /* J/K в открытом «Хто це» ходят по строкам, как стрелки в шапке ящика */
  useHotkeys(
    { j: () => step(1), k: () => step(-1) },
    drawer.open && drawer.mode === "who",
  );

  /* выгрузка — весь отбор, страницами по 200: экспорт одной страницы был бы обрезком */
  const exportCsv = (only?: PatientListItem[]) =>
    run(async () => {
      let all: PatientListItem[] = only ?? [];
      if (!only) {
        for (let offset = 0; offset < total; offset += 200) {
          const chunk = await api.patientRegister({ ...query, limit: 200, offset });
          all = all.concat(chunk.items);
          if (chunk.items.length < 200) break;
        }
      }
      const blob = new Blob([tableToCsv(all, csvColumns(ut))], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ut("patients.title")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const now = Date.now();
  const words = { today: ut("plist.today"), tomorrow: ut("plist.tomorrow") };
  /*
   * На 13-дюймовом ноутбуке (1280) шести колонок с подписями не уместить:
   * дата замера уходит строкой под ход «19 → 16 → 14» той же ячейки.
   */
  const narrow = useMedia("(max-width: 1380px)");
  const columns = useColumns({ locale, now, words, narrow });

  /* вкладки групп: первые пять на виду, остальные — «Ще N»; открытая из «Ще» встаёт на последнее место */
  const allGroups = groups.data ?? [];
  const shownGroups = allGroups.slice(0, 5);
  if (current && !shownGroups.some((g) => g.id === current.id)) shownGroups.splice(4, 1, current);
  const moreGroups = allGroups.filter((g) => !shownGroups.includes(g));

  const viewName = views.entries.find((e) => e.disabled && e.key?.startsWith("view:") && e.key !== "view:save")?.label;

  return (
    <Page
      title={ut("patients.title")}
      meta={
        allCounts
          ? [
              plural(ut("plist.people"), allCounts.all, locale),
              ut("plist.metaLine").replace("{mine}", String(allCounts.mine)).replace("{risk}", String(allCounts.risk)),
            ]
          : undefined
      }
      actions={
        <>
          <MenuButton
            label={ut("plist.views")}
            trigger={(p) => (
              <Button {...p} icon={<Ic.layers />}>
                {viewName ? `${ut("plist.view")}: ${viewName}` : ut("plist.views")}
              </Button>
            )}
          >
            {(close) =>
              views.entries.map((e) => (
                <button
                  key={e.key ?? e.label}
                  type="button"
                  role="menuitem"
                  aria-disabled={e.disabled || undefined}
                  title={e.disabled ? e.hint : undefined}
                  className={menuItemClass("right", e.disabled ? "disabled" : e.danger ? "danger" : "normal")}
                  onClick={() => {
                    if (e.disabled) return;
                    close();
                    e.onSelect?.();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                </button>
              ))
            }
          </MenuButton>
          <Tooltip label={ut("plist.export")}>
            <Button
              size="icon"
              aria-label={ut("plist.export")}
              disabled={busy || !total}
              onClick={() => void exportCsv()}
            >
              <Ic.download />
            </Button>
          </Tooltip>
          <Button variant="primary" icon={<ShellIcon name="user-plus" />} onClick={() => setInvite(true)}>
            {ut("pg.invite")}
          </Button>
        </>
      }
      below={
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Tabs
            label={ut("pg.tabsLabel")}
            items={[
              {
                id: "pg-tab-all",
                label: ut("pg.allTab"),
                count: allCounts?.all ?? null,
                active: !current && !pending,
                onSelect: () => update(refilter({ group: null })),
                controls: "patients-panel",
              },
              ...shownGroups.map((g) => ({
                id: `pg-tab-${g.id}`,
                label: g.title,
                count: g.memberCount,
                active: g.id === (current?.id ?? (pending ? groupId : null)),
                onSelect: () => update(refilter({ group: g.id })),
                controls: "patients-panel",
              })),
            ]}
          />
          {moreGroups.length ? (
            <ActionMenu
              label={ut("plist.moreGroups")}
              glyph={
                <span className="inline-flex items-center gap-1.5 text-body font-semibold text-text-2">
                  {ut("plist.moreN").replace("{n}", String(moreGroups.length))}
                  <Ic.chevronDown size={14} />
                </span>
              }
              triggerClassName="px-3"
              align="left"
              entries={moreGroups.map((g) => ({
                key: g.id,
                label: `${g.title} (${g.memberCount})`,
                onSelect: () => update(refilter({ group: g.id })),
              }))}
            />
          ) : null}
          {groups.error ? <span className="ml-2 text-caption text-risk-ink">{groups.error}</span> : null}
        </div>
      }
    >
      {views.dialog}
      <Panel flush className="mb-2" as="div">
        <div id="patients-panel" role="tabpanel" aria-label={current?.title ?? ut("patients.title")}>
          <div className="flex flex-col gap-2.5 px-4 pb-3 pt-4">
            <FilterBar
              search={{
                value: q,
                onChange: (v) => update(refilter({ q: v || null })),
                placeholder: ut("plist.searchPh"),
                label: ut("ui.search"),
                width: 260,
              }}
              chips={
                <ViewPill
                  label={ut("plist.mine")}
                  count={counts?.mine ?? null}
                  on={mine}
                  icon={<Ic.user size={14} />}
                  onClick={() => update(refilter({ mine: mine ? null : "1" }))}
                />
              }
              count={list.data ? { shown: rows.length, total } : undefined}
              sort={{
                label: ut("kit.sort"),
                value: sort,
                onChange: (k) => update(refilter({ sort: k === "risk" ? null : k })),
                options: (Object.keys(SORT_LABEL) as ListSort[]).map((k) => ({ key: k, label: ut(SORT_LABEL[k]) })),
              }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-small font-bold text-muted">{ut("plist.attention")}</span>
              <ViewPills
                label={ut("plist.attention")}
                value={view ?? "all"}
                onChange={(k) => update(refilter({ view: k === "all" ? null : k }))}
                items={[
                  { key: "all", label: ut("pg.allTab"), count: counts?.all ?? null },
                  ...LIST_VIEWS.map((v) => ({
                    key: v,
                    label: ut(VIEW_LABEL[v]),
                    count: counts ? counts[v] : null,
                    risk: v === "risk",
                  })),
                ]}
              />
            </div>
            <BulkBar
              count={picked.size}
              total={total <= 200 ? total : undefined}
              onSelectAll={
                total <= 200
                  ? () =>
                      void run(async () => {
                        const all = await api.patientRegister({ ...query, limit: 200, offset: 0 });
                        setPicked(new Map(all.items.map((r) => [r.id, r])));
                      })
                  : undefined
              }
              onClear={() => setPicked(new Map())}
            >
              <Button
                variant="panel"
                size="xs"
                icon={<Ic.users />}
                onClick={() => setDrawer({ open: true, mode: "group", who: null, people: [...picked.values()].map(whoOf) })}
              >
                {ut("pg.addToGroup")}
              </Button>
              <Button
                variant="panel"
                size="xs"
                icon={<Ic.clipboard />}
                onClick={() => setDrawer({ open: true, mode: "assign", who: null, people: [...picked.values()].map(whoOf) })}
              >
                {ut("pg.assignTest")}
              </Button>
              <Button
                variant="panel"
                size="xs"
                icon={<Ic.download />}
                disabled={busy}
                onClick={() => void exportCsv([...picked.values()])}
              >
                {ut("plist.exportPicked")}
              </Button>
            </BulkBar>
          </div>

          {list.error && list.data ? (
            <div role="alert" className="flex items-center gap-2.5 px-4 pb-2.5">
              <ErrorText>{list.error}</ErrorText>
              <Button variant="quiet" size="xs" onClick={list.reload}>
                {ut("common.retry")}
              </Button>
            </div>
          ) : null}
          {body === "failed" ? (
            <div className="px-4 pb-4">
              <Loading error={list.error} onRetry={list.reload} />
            </div>
          ) : body === "loading" ? (
            <div className="px-4 pb-4">
              <Loading rows={8} />
            </div>
          ) : body !== "rows" ? (
            <div className="px-4 pb-6">
              <Empty
                icon={<Ic.users />}
                title={body === "noMatch" ? ut("pt.nobodyFound") : body === "emptyGroup" ? ut("pg.noMembers") : ut("plist.emptyTitle")}
                hint={body === "noMatch" ? ut("plist.emptyFilterHint") : body === "emptyGroup" ? undefined : ut("inv.noneHint")}
                action={
                  body === "noMatch" ? (
                    <Button onClick={() => update(refilter({ q: null, view: null, mine: null }))}>{ut("plist.resetFilters")}</Button>
                  ) : body === "empty" ? (
                    <Button variant="primary" onClick={() => setInvite(true)}>
                      {ut("pg.invite")}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div data-patients>
              <DataTable
                rows={rows}
                columns={columns}
                rowKey={(r) => r.id}
                label={ut("patients.title")}
                selectable
                selected={pickedKeys}
                onSelectedChange={(keys) =>
                  setPicked((prev) => {
                    const next = new Map<string, PatientListItem>();
                    for (const k of keys) {
                      const row = prev.get(k) ?? byId.get(k);
                      if (row) next.set(k, row);
                    }
                    return next;
                  })
                }
                onRowClick={openWho}
                isRowActive={(r) => drawer.open && drawer.mode === "who" && drawer.who === r.id}
                hotkeys={!(drawer.open && drawer.mode === "who")}
                rowActions={(r) => (
                  <>
                    <Tooltip label={ut("pt.whoIsThis")}>
                      <Button variant="quiet" size="icon-sm" aria-label={`${ut("pt.whoIsThis")}: ${r.name}`} onClick={() => openWho(r)}>
                        <Ic.eye />
                      </Button>
                    </Tooltip>
                    <Tooltip label={ut("plist.write")}>
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        aria-label={`${ut("plist.write")}: ${r.name}`}
                        onClick={() => setDrawer({ open: true, mode: "message", who: r.id, people: [whoOf(r)] })}
                      >
                        <Ic.message />
                      </Button>
                    </Tooltip>
                    <Tooltip label={ut("pcard.clinical")}>
                      <Button
                        variant="quiet"
                        size="icon-sm"
                        aria-label={`${ut("pcard.clinical")}: ${r.name}`}
                        onClick={() => navigate(`/patients/${r.id}/case`)}
                      >
                        <Ic.chart />
                      </Button>
                    </Tooltip>
                    <ActionMenu
                      label={`${ut("kit.moreActions")}: ${r.name}`}
                      triggerSize="icon-sm"
                      entries={[
                        { key: "card", label: ut("pt.openCard"), to: `/patients/${r.id}` },
                        {
                          key: "assign",
                          label: ut("pg.assignTest"),
                          onSelect: () => setDrawer({ open: true, mode: "assign", who: null, people: [whoOf(r)] }),
                        },
                        {
                          key: "group",
                          label: ut("pg.addToGroup"),
                          onSelect: () => setDrawer({ open: true, mode: "group", who: null, people: [whoOf(r)] }),
                        },
                        ...(r.risk ? [{ key: "review", label: ut("plist.review"), to: `/alerts?patient=${r.id}`, ruled: true }] : []),
                      ]}
                    />
                  </>
                )}
              />
            </div>
          )}

          {list.data && total > Math.min(10, per) ? (
            <div className="border-t border-divider py-2.5 pl-4 pr-3">
              <Pager
                page={page}
                pages={pages}
                per={per}
                total={total}
                sizes={[10, 20, 50, 100]}
                onPer={(n) => update(refilter({ per: n === REGISTER_PER ? null : String(n) }))}
                onPage={(n) => update(toPage(n))}
              />
            </div>
          ) : null}
          <KbdHints
            bar
            keys={[
              ["J K", ut("plist.keyRows")],
              ["X", ut("plist.keyPick")],
              ["Enter", ut("pt.whoIsThis")],
              ["/", ut("ui.search")],
              ["N", ut("pg.invite")],
            ]}
          />
        </div>
      </Panel>

      <Drawer
        open={drawer.open}
        mode={drawer.mode}
        modal={drawer.mode !== "who"}
        onClose={close}
        onReturn={(m) => setDrawer((s) => ({ ...s, open: true, mode: (m as Mode) ?? s.mode }))}
      >
        <DrawerPane mode="who" {...paneProps(who)}>
          {who.body}
        </DrawerPane>
        <DrawerPane mode="assign" {...paneProps(assign)}>
          {assign.body}
        </DrawerPane>
        <DrawerPane mode="group" {...paneProps(group)}>
          {group.body}
        </DrawerPane>
        <DrawerPane mode="message" {...paneProps(message)}>
          {message.body}
        </DrawerPane>
      </Drawer>

      {invite ? <InviteDialog onClose={() => setInvite(false)} onCreated={() => list.reload()} /> : null}
    </Page>
  );
}

const SORT_LABEL: Record<ListSort, UiKey> = {
  risk: "plist.sortRisk",
  name: "plist.sortName",
  last: "plist.sortLast",
  next: "plist.sortNext",
};

/** Свойства DrawerPane из частей вида (тело идёт детьми) */
function paneProps({ body: _body, ...rest }: PaneParts) {
  return rest;
}

const VIEW_LABEL: Record<(typeof LIST_VIEWS)[number], UiKey> = {
  risk: "plist.viewRisk",
  stale: "plist.viewStale",
  unbooked: "plist.viewUnbooked",
};

/** «І. Савчук»: в таблице — инициал и фамилия (ФИО хранится «Прізвище Ім’я По батькові») */
export function shortName(full: string): string {
  const [last = "", first = ""] = full.trim().split(/\s+/);
  return first ? `${first[0]}. ${last}` : last;
}

/* ─────────── колонки ─────────── */

function useColumns({
  locale,
  now,
  words,
  narrow,
}: {
  locale: string;
  now: number;
  words: { today: string; tomorrow: string };
  narrow: boolean;
}): Column<PatientListItem>[] {
  const { ut } = useLang();
  const all: Column<PatientListItem>[] = [
    {
      key: "name",
      header: ut("ref.patient"),
      required: true,
      width: 250,
      render: (r) => {
        const age = ageOf(r.birthYear, now);
        const sub = [
          age !== null ? `${age} ${ut("pg.yearSuffix")}` : null,
          r.sex === "male" ? ut("adm.male") : r.sex === "female" ? ut("adm.female") : null,
          r.unit,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <PersonCell
            name={r.name}
            sub={sub || r.email}
            to={`/patients/${r.id}`}
            avatar={<Avatar name={r.name} size={28} />}
          />
        );
      },
    },
    {
      key: "state",
      required: true,
      header: ut("plist.state"),
      width: 170,
      render: (r) => <StateCell r={r} locale={locale} now={now} />,
    },
    {
      key: "measure",
      required: true,
      header: ut("pt.lastMeasure"),
      width: 210,
      render: (r) => {
        const m = r.measure;
        if (!m) return <span className="text-small text-muted">{ut("plist.noMeasure")}</span>;
        const last = m.values.at(-1) ?? 0;
        const v = shownValue(last, m.normalization);
        return (
          <span className="flex min-w-0 flex-col gap-0.5" title={m.title}>
            <span className="inline-flex items-center gap-2">
              <b className="text-[15px] font-extrabold tabular-nums text-text">
                {v.text}
                {v.unit ? <small className="ml-0.5 text-caption font-bold text-muted">{v.unit}</small> : null}
              </b>
              {m.severity || m.bandLabel ? (
                <SeverityTag level={kitSeverity(m.severity)} small>
                  {m.bandLabel ?? ut(severityKey[m.severity ?? "none"])}
                </SeverityTag>
              ) : null}
            </span>
            <span className="flex items-center gap-2.5">
              {m.better ? (
                <CourseDigits code={shortCode(m.code)} values={shownSeries(m.values, m.normalization)} better={m.better} />
              ) : (
                <span className="text-caption text-text-2">
                  <b className="mr-1 text-[11px] font-bold text-muted">{shortCode(m.code)}</b>
                  {shownSeries(m.values, m.normalization).join(" → ")}
                </span>
              )}
              {narrow ? (
                <span className="text-caption">
                  <MeasuredAt r={r} now={now} locale={locale} today={words.today} />
                </span>
              ) : null}
            </span>
          </span>
        );
      },
    },
    {
      key: "last",
      required: true,
      header: ut("plist.measuredAt"),
      width: 130,
      render: (r) => <MeasuredAt r={r} now={now} locale={locale} today={words.today} />,
    },
    {
      key: "lead",
      required: true,
      header: ut("plist.lead"),
      width: 140,
      render: (r) =>
        r.leadName ? (
          <span className="inline-flex min-w-0 items-center gap-2" title={r.leadName}>
            <Avatar name={r.leadName} size={24} tone="neutral" />
            <span className="truncate text-small text-text">{shortName(r.leadName)}</span>
          </span>
        ) : (
          <span className="text-small text-muted">{ut("plist.noLead")}</span>
        ),
    },
    {
      key: "next",
      required: true,
      header: ut("plist.nextVisit"),
      width: 160,
      render: (r) => {
        if (!r.nextVisit)
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small font-semibold text-warn">
              <Ic.calendar size={13} />
              {ut("plist.notBooked")}
            </span>
          );
        const w = whenShort(r.nextVisit.at, now, locale, words);
        return (
          <span className={cx("whitespace-nowrap text-small", w.soon ? "font-extrabold text-violet-ink" : "text-text")}>
            {w.text}
            {r.nextVisit.mode === "remote" ? <span className="font-semibold">, {ut("pt.remote")}</span> : null}
          </span>
        );
      },
    },
  ];
  return narrow ? all.filter((c) => c.key !== "last") : all;
}

/** Когда мерили: дата, сегодня — словом; 30+ дней — янтарём с числом дней */
function MeasuredAt({ r, now, locale, today }: { r: PatientListItem; now: number; locale: string; today: string }) {
  const { ut } = useLang();
  if (!r.lastResponseAt) return <span className="text-small text-muted">{ut("plist.never")}</span>;
  const d = daysAgo(r.lastResponseAt, now);
  const stale = d >= 30;
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap text-small", stale ? "font-bold text-warn" : "text-text-2")}>
      {stale ? <Ic.timer size={13} /> : null}
      {d === 0 ? today : ddmm(r.lastResponseAt, locale)}
      {stale ? <span className="font-semibold">{ut("plist.daysAgo").replace("{n}", String(d))}</span> : null}
    </span>
  );
}

/** Почему человек в списке сейчас: случай, неявка, учёт — красным только риск */
function StateCell({ r, locale, now }: { r: PatientListItem; locale: string; now: number }) {
  const { ut } = useLang();
  if (r.risk) {
    const sub = r.risk.assigneeName
      ? ut("plist.caseWith").replace("{name}", shortName(r.risk.assigneeName))
      : ut("plist.caseSince").replace("{when}", `${ddmm(r.risk.openedAt, locale)}, ${hhmm(r.risk.openedAt, locale)}`);
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={r.risk.assigneeName ? "handover" : "danger"} icon={<Ic.alert />}>
          {r.risk.cases > 1 ? ut("plist.signals").replace("{n}", String(r.risk.cases)) : ut("plist.signal")}
        </Tag>
        <small className="text-caption text-text-2">{sub}</small>
      </span>
    );
  }
  if (r.lastNoShowAt) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone="attention" icon={<Ic.calendar />}>
          {ut("plist.noShow").replace("{d}", ddmm(r.lastNoShowAt, locale))}
        </Tag>
        {!r.nextVisit ? <small className="text-caption text-text-2">{ut("plist.noBooking")}</small> : null}
      </span>
    );
  }
  if (r.dispensary) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={r.dispensary.overdue ? "attention" : "plain"} icon={r.dispensary.overdue ? <Ic.timer /> : <Ic.eye />}>
          {r.dispensary.overdue ? ut("plist.checkOverdue") : ut("plist.onRecord")}
        </Tag>
        <small className="truncate text-caption text-text-2">
          {r.dispensary.overdue
            ? ut("plist.dueSince").replace("{d}", ddmm(r.dispensary.nextDueAt, locale))
            : `${r.dispensary.groupLabel}, ${ut("plist.dueOn").replace("{d}", ddmm(r.dispensary.nextDueAt, locale))}`}
        </small>
      </span>
    );
  }
  void now;
  return <span className="text-small text-muted">—</span>;
}

/** Колонки выгрузки: те же поля, что на экране, словами */
function csvColumns(ut: (k: UiKey) => string): Column<PatientListItem>[] {
  const none = () => null;
  return [
    { key: "name", header: ut("ref.patient"), render: none, csv: (r) => r.name },
    { key: "email", header: ut("plist.email"), render: none, csv: (r) => r.email },
    { key: "phone", header: ut("plist.phone"), render: none, csv: (r) => r.phone },
    { key: "unit", header: ut("ui.unit"), render: none, csv: (r) => r.unit },
    { key: "year", header: ut("plist.birthYear"), render: none, csv: (r) => r.birthYear },
    { key: "risk", header: ut("plist.state"), render: none, csv: (r) => (r.risk ? r.risk.cases : null) },
    { key: "code", header: ut("plist.instrument"), render: none, csv: (r) => r.measure?.code ?? null },
    {
      key: "value",
      header: ut("pt.lastMeasure"),
      render: none,
      csv: (r) => (r.measure ? shownValue(r.measure.values.at(-1) ?? 0, r.measure.normalization).text : null),
    },
    { key: "band", header: ut("pt.interpretation"), render: none, csv: (r) => r.measure?.bandLabel ?? null },
    { key: "last", header: ut("plist.measuredAt"), render: none, csv: (r) => r.lastResponseAt?.slice(0, 10) ?? null },
    { key: "lead", header: ut("plist.lead"), render: none, csv: (r) => r.leadName ?? null },
    { key: "next", header: ut("plist.nextVisit"), render: none, csv: (r) => r.nextVisit?.at.slice(0, 16).replace("T", " ") ?? null },
  ];
}

/* ═══════════════════ Динамика ═══════════════════ */

/**
 * Вкладка «Динаміка» справы пациента — кадр patients-case-dynamics.
 *
 *   «Методики»: большие числа со сравнением и смыслом      → BigValue по главной шкале каждой методики
 *   «Курс» с переключателем методик                         → CourseChart: полосы, межі похибки, сесії, сигнали
 *   «Достовірність зсуву»: RCI, поріг, α, перцентиль         → из основы RCI сервера; перцентиль — точки
 *   «Методики разом» с таблицей                             → TimeLines в % від максимуму шкали (pointShare)
 *   «За шкалами»: перший і останній замір                   → субшкалы многошкальной методики
 *   «Звести версії»                                         → коэффициенты приведения сервера, включает человек
 *
 * Прогноза («тренд ≈ 11») и цели курса нет: приложение их не считает, а
 * догадка, нарисованная как оценка, хуже пустого места.
 */
export function PatientDynamics() {
  const { ut } = useLang();
  const { userId } = useParams<{ userId: string }>();
  const { run, busy } = useAction();
  const [equating, setEquating] = useState(false);
  /* тот же кэш, что у шапки справы (CaseCard): динамика и хронология уже приехали */
  const dyn = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId, keep: false, key: DYN_KEY });
  const timeline = useResource(() => api.timeline(userId!), [userId], { enabled: !!userId, keep: false, key: TL_KEY });
  const instruments = useMemo(() => instrumentsOf(dyn.data), [dyn.data]);
  const [pickRaw, setPick] = useState<string | null>(null);
  const pick = instruments.find((i) => i.surveyId === pickRaw) ?? instruments[0] ?? null;
  const multi = instruments.filter((i) => i.scales.length > 1);
  const [profileRaw, setProfile] = useState<string | null>(null);
  const profile = multi.find((i) => i.surveyId === profileRaw) ?? multi[0] ?? null;
  const canEquate = instruments.some((i) => i.scales.some((s) => s.scale.equated?.length));
  const labels = { of: ut("an.of"), norm: normLabels(ut) };

  if (dyn.error && !dyn.data) return <Loading error={dyn.error} onRetry={dyn.reload} />;
  if (!dyn.data) return <Loading rows={6} />;
  if (!instruments.length) {
    return <Empty icon={<Ic.chart />} title={ut("pt.noCompleted")} hint={ut("dyn.emptyHint")} />;
  }

  const lastAt = instruments.map((i) => i.lastAt ?? "").sort().at(-1) ?? null;
  const firstAt = instruments.map((i) => i.firstAt ?? "").filter(Boolean).sort()[0] ?? null;
  const showStens = instruments.some((i) => i.scales.some((s) => s.last.normalization === "sten" || s.last.normalization === "tscore"));

  /*
   * Ряд курса — в единицах последнего замера: со «Звести версії» старые
   * версии приведены коэффициентами сервера, без — как сданы. Перцентиль,
   * полосы и порог — те же.
   */
  const series = (s: InstrumentScale) =>
    equating ? { ...s.scale, points: s.scale.points.map((p) => ({ ...p, rawScore: equatedValue(p, s.scale.equated) })) } : s.scale;
  const course = pick ? courseFromDynamics(series(pick.main), pick.main.rungs) : null;
  const events = timeline.data ? courseEventsFromTimeline(timeline.data) : [];
  const last = pick?.main.last ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={ut("dyn.instruments")}
        icon={<Ic.clipboard />}
        sub={
          lastAt
            ? ut("dyn.instrumentsSub")
                .replace("{last}", ddmmOf(lastAt))
                .replace("{first}", firstAt ? ddmmOf(firstAt) : "—")
            : undefined
        }
        actions={<TextAction to={`/patients/${userId}`}>{ut("dyn.allMeasures")}</TextAction>}
        flush
      >
        <BigValues className="border-t border-divider [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))] [&>*]:border-b [&>*]:border-divider">
          {instruments.map((i) => (
            <InstrumentValue key={i.surveyId} i={i} />
          ))}
        </BigValues>
        {showStens ? (
          <div className="px-4 pb-3">
            <Hint id="stens" text="hint.stens" />
          </div>
        ) : null}
      </Panel>

      <div className="grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_minmax(320px,440px)] max-[1180px]:grid-cols-1">
        <Panel
          title={ut("dyn.course")}
          icon={<Ic.chart />}
          sub={
            pick
              ? ut("dyn.courseSub")
                  .replace("{n}", String(pick.responseCount))
                  .replace("{title}", pick.title)
              : undefined
          }
          actions={
            instruments.length > 1 ? (
              <>
                <Segmented
                  label={ut("rch.pickScale")}
                  value={pick && instruments.indexOf(pick) < 5 ? pick.surveyId : ""}
                  onChange={setPick}
                  items={instruments.slice(0, 5).map((i) => ({ key: i.surveyId, label: shortCode(i.code, 10) }))}
                />
                {instruments.length > 5 ? (
                  <ActionMenu
                    label={ut("rch.pickScale")}
                    glyph={
                      <span className="inline-flex items-center gap-1 text-caption font-bold text-text-2">
                        {pick && instruments.indexOf(pick) >= 5 ? shortCode(pick.code, 12) : ut("plist.moreN").replace("{n}", String(instruments.length - 5))}
                        <Ic.chevronDown size={13} />
                      </span>
                    }
                    triggerSize="xs"
                    triggerClassName="px-2.5"
                    entries={instruments.slice(5).map((i) => ({ key: i.surveyId, label: i.title, onSelect: () => setPick(i.surveyId) }))}
                  />
                ) : null}
              </>
            ) : undefined
          }
          footer={
            last ? (
              <>
                <span className="text-small text-text-2">
                  {ut("pt.lastMeasure")}: <b className="font-bold text-text">{pointValueText(last, labels)}</b>
                </span>
                <Button
                  variant="quiet"
                  size="xs"
                  className="ml-auto"
                  icon={<Ic.file />}
                  disabled={busy}
                  onClick={() => run(() => openInTab(api.reportUrl(last.responseId)))}
                >
                  {ut("an.conclusion")}
                </Button>
              </>
            ) : undefined
          }
        >
          {pick && course ? (
            <CourseChart title={pick.code} {...course} max={last ? pointValueTop(last) : null} events={events} />
          ) : null}
          {canEquate ? (
            <div className="mt-3 rounded-panel bg-sunk px-3.5 py-3">
              <Switch checked={equating} onChange={setEquating} label={ut("eq.title")} sub={ut("dyn.equateSub")} />
              <p className="m-0 mt-1.5 text-caption text-text-2">{ut("eq.hint")}</p>
            </div>
          ) : null}
        </Panel>

        <Panel
          title={ut("pt.rciTitle")}
          icon={<Ic.gauge />}
          sub={firstAt && lastAt ? `${ddmmOf(firstAt)} → ${ddmmOf(lastAt)}` : undefined}
          flush
          footer={<span className="text-caption text-text-2">{ut("dyn.rciFoot")}</span>}
        >
          <ul className="m-0 list-none p-0">
            {instruments.map((i) => (
              <ReliabilityRow key={i.surveyId} i={i} />
            ))}
          </ul>
        </Panel>
      </div>

      <div className={cx("grid items-start gap-4", profile ? "grid-cols-2 max-[1180px]:grid-cols-1" : "grid-cols-1")}>
        <Together instruments={instruments} />
        {profile ? (
          <Panel
            title={ut("dyn.byScales")}
            icon={<Ic.list />}
            sub={ut("dyn.byScalesSub").replace("{n}", String(profile.responseCount))}
            actions={
              multi.length > 1 ? (
                <Segmented
                  label={ut("dyn.byScales")}
                  value={profile.surveyId}
                  onChange={setProfile}
                  items={multi.slice(0, 4).map((i) => ({ key: i.surveyId, label: i.code }))}
                />
              ) : undefined
            }
            flush
          >
            <ScaleProfileTable i={profile} />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

/** «08.10» по часам консоли — для подписей панелей */
function ddmmOf(iso: string): string {
  return new Date(iso).toLocaleDateString(consoleLocale(), { day: "2-digit", month: "2-digit" });
}

/** Большое число методики: значение, слово полосы, «було …», сдвиг с порогом */
function InstrumentValue({ i }: { i: Instrument }) {
  const { ut } = useLang();
  const s = i.main;
  const norm = s.last.normalization;
  const v = shownValue(s.last.rawScore, norm);
  const delta = changeOf(s);
  const thr = shownThreshold(s);
  const ratio = norm === "ratio";
  return (
    <BigValue
      code={shortCode(i.code, 18)}
      measure={s.scale.title}
      better={s.better ?? undefined}
      value={v.text}
      unit={v.unit || undefined}
      severity={
        s.last.severity || s.last.bandLabel
          ? { word: s.last.bandLabel ?? ut(severityKey[s.last.severity ?? "none"]), level: kitSeverity(s.last.severity) }
          : undefined
      }
      history={shownSeries(s.history.slice(-2), norm)}
      change={delta !== null && thr !== null ? { delta: shownDelta(s, delta), threshold: thr, unit: ratio ? ut("dyn.pp") : undefined } : undefined}
    />
  );
}

/** Строка «Достовірність зсуву»: метка методики, RCI, поріг, α, сдвиг словом и перцентиль */
function ReliabilityRow({ i }: { i: Instrument }) {
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  const s = i.main;
  const rc = s.scale.reliableChange;
  const delta = changeOf(s);
  const ratio = s.last.normalization === "ratio";
  const mark = instrumentMark(i.code);
  const word =
    s.scale.incomparable === "version"
      ? ut("rch.versions")
      : s.scale.incomparable === "units"
        ? ut("rch.units")
        : s.scale.incomparable === "unreliable"
          ? ut("rch.unreliable")
          : delta === null
            ? ut("pt.needSecond")
            : !rc
              ? ut("qv.noThreshold")
              : rc.significant
                ? s.better
                  ? (s.better === "down" ? delta < 0 : delta > 0)
                    ? ut("kit.reliablyBetter")
                    : ut("kit.reliablyWorse")
                  : ut("pt.reliable")
                : ut("kit.withinError");
  const good = !!rc?.significant && !!s.better && (s.better === "down" ? (delta ?? 0) < 0 : (delta ?? 0) > 0);
  const worse = !!rc?.significant && !!s.better && !good;
  const pct = s.last.percentile;
  const thr = shownThreshold(s);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] gap-x-3 gap-y-0.5 border-t border-divider px-4 py-3 first:border-t-0">
      <span className="flex min-w-0 items-center gap-2">
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
          <MarkerGlyph shape={mark?.shape ?? "circle"} color={mark?.color ?? "var(--series)"} />
        </svg>
        <b className="shrink-0 text-[13.5px] font-extrabold text-text" title={i.title}>
          {shortCode(i.code, 12)}
        </b>
        <span className="truncate text-small text-muted">{s.scale.title}</span>
      </span>
      <span className={cx("whitespace-nowrap text-right text-small font-bold", good ? "text-good" : worse ? "text-warn" : "text-text")}>
        {delta !== null ? (
          <b className="mr-1.5 text-[14px] font-extrabold">
            {signedNum(shownDelta(s, delta))}
            {ratio ? ut("dyn.pp") : ""}
          </b>
        ) : null}
        <span className={good || worse ? "" : "font-medium text-text-2"}>{word}</span>
      </span>
      <span className="text-caption text-muted">
        {rc
          ? ut("dyn.rciLine")
              .replace("{rci}", fmtNum(rc.rci, locale))
              .replace("{thr}", thr !== null ? fmtNum(thr, locale) : "—")
              .replace("{alpha}", fmtNum(rc.basis.alpha, locale))
          : ut("dyn.noBasis")}
      </span>
      <span className="text-right text-caption text-text-2">
        {pct === null ? ut("mark.smallSample") : `${ut("pt.higherThanPct")} ${fmtNum(pct, locale)} %`}
      </span>
    </li>
  );
}

function MarkerGlyph({ shape, color }: { shape: string; color: string }) {
  if (shape === "square") return <rect x="2" y="2" width="8" height="8" rx="1.5" fill={color} />;
  if (shape === "diamond") return <path d="M6 1 11 6 6 11 1 6Z" fill={color} />;
  if (shape === "triangle") return <path d="M6 1.5 11 10.5H1Z" fill={color} />;
  return <circle cx="6" cy="6" r="4.5" fill={color} />;
}

/** «−14», «+16» — минус знаком минуса */
function signedNum(v: number): string {
  return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0";
}

/**
 * «Методики разом» — главные шкалы на одной оси в процентах от максимума
 * шкалы (pointShare: доля сырого балла после поправок — единица одна для
 * всех), с таблицей баллов по датам. Даты — по дню замера: батарея сдаётся
 * за один присест, и замеры одного дня — одна колонка.
 */
function Together({ instruments }: { instruments: Instrument[] }) {
  const { ut } = useLang();
  const shown = instruments.slice(0, 4);
  const days = [...new Set(shown.flatMap((i) => i.main.scale.points.map((p) => dayOf(p.submittedAt))))].sort();
  const x = days.map((d) => ({ key: d, label: ddmmOf(`${d}T12:00:00`) }));
  const lines = shown.map((i, n) => {
    const mark = instrumentMark(i.code);
    const color = mark?.color ?? seriesColor(n, shown.length);
    return {
      key: i.surveyId,
      label: i.code,
      color,
      values: days.map((d) => {
        const p = i.main.scale.points.filter((pt) => dayOf(pt.submittedAt) === d).at(-1);
        return p ? Math.round(pointShare(p) * 100) : null;
      }),
    };
  });
  return (
    <Panel title={ut("dyn.together")} icon={<Ic.chart />} sub={ut("dyn.togetherSub")} flush>
      <div className="px-4 pb-2">
        <TimeLines x={x} series={lines} label={ut("dyn.together")} format={(v) => `${v} %`} height={220} />

      </div>
      <div className="overflow-x-auto border-t border-divider">
        <table className="w-full border-separate border-spacing-0 text-small">
          <thead>
            <tr>
              <th className="h-9 border-b border-divider bg-panel-2 px-4 text-left text-caption font-bold text-muted">{ut("plist.instrument")}</th>
              {days.slice(-4).map((d) => (
                <th key={d} className="h-9 border-b border-divider bg-panel-2 px-3 text-right text-caption font-bold text-muted">
                  {ddmmOf(`${d}T12:00:00`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.surveyId}>
                <td className="border-b border-divider px-4 py-2 align-top">
                  <b className="block font-extrabold text-text">{i.code}</b>
                  <span className="text-caption text-muted">{i.main.scale.title}</span>
                </td>
                {days.slice(-4).map((d) => {
                  const p = i.main.scale.points.filter((pt) => dayOf(pt.submittedAt) === d).at(-1);
                  const v = p ? shownValue(p.rawScore, p.normalization) : null;
                  return (
                    <td key={d} className="border-b border-divider px-3 py-2 text-right align-top tabular-nums">
                      {p && v ? (
                        <>
                          <b className="block font-bold text-text">
                            {v.text}
                            {v.unit}
                          </b>
                          <span className="text-caption text-muted">{Math.round(pointShare(p) * 100)} %</span>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** День замера по часам консоли, «YYYY-MM-DD» */
function dayOf(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * «За шкалами»: первый и последний замер каждой шкалы многошкальной
 * методики — гантелью в доле от максимума и таблицей со сдвигом и порогом.
 */
function ScaleProfileTable({ i }: { i: Instrument }) {
  const { ut } = useLang();
  return (
    <>
      <ul className="m-0 grid list-none gap-2.5 px-4 pb-3 pt-1">
        {i.scales.map((s) => {
          const a = Math.round(pointShare(s.first) * 100);
          const b = Math.round(pointShare(s.last) * 100);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          return (
            <li key={s.scale.code} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] items-center gap-3">
              <span className="truncate text-small font-semibold text-text-2" title={s.scale.title}>
                {s.scale.title}
              </span>
              <span className="relative block h-3" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-px bg-divider" />
                <span className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded bg-series" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
                <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-muted bg-panel" style={{ left: `${a}%` }} />
                <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-series" style={{ left: `${b}%` }} />
              </span>
              <span className="whitespace-nowrap text-small tabular-nums text-text-2">
                {shownValue(s.first.rawScore, s.first.normalization).text} →{" "}
                <b className="font-extrabold text-text">{shownValue(s.last.rawScore, s.last.normalization).text}</b>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 flex items-center gap-3 px-4 pb-3 text-caption text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2.5 rounded-full border-2 border-muted" />
          {ut("dyn.first")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-2 rotate-45 bg-series" />
          {ut("dyn.last")}
        </span>
        <span>{ut("dyn.shareNote")}</span>
      </p>
      <div className="overflow-x-auto border-t border-divider">
        <table className="w-full border-separate border-spacing-0 text-small">
          <thead>
            <tr>
              {[ut("sum.scale"), ut("dyn.first"), ut("dyn.last"), ut("dyn.fromStart")].map((h, n) => (
                <th
                  key={h}
                  className={cx("h-9 border-b border-divider bg-panel-2 px-3 text-caption font-bold text-muted first:pl-4", n ? "text-right" : "text-left")}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {i.scales.map((s) => {
              const delta = changeOf(s);
              return (
                <tr key={s.scale.code}>
                  <td className="border-b border-divider py-2 pl-4 pr-3">
                    <b className="block font-bold text-text">{s.scale.title}</b>
                    <span className="text-caption text-muted">{s.scale.code}</span>
                  </td>
                  <td className="border-b border-divider px-3 py-2 text-right tabular-nums">{shownValue(s.first.rawScore, s.first.normalization).text}</td>
                  <td className="border-b border-divider px-3 py-2 text-right font-bold tabular-nums">{shownValue(s.last.rawScore, s.last.normalization).text}</td>
                  <td className="border-b border-divider px-3 py-2 text-right">
                    {delta !== null && shownThreshold(s) !== null && s.better ? (
                      <span className="inline-flex justify-end">
                        <ChangeCell delta={shownDelta(s, delta)} threshold={shownThreshold(s)!} better={s.better} />
                      </span>
                    ) : delta !== null ? (
                      <span className="tabular-nums">{signedNum(shownDelta(s, delta))}</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Балл, приведённый к версии последнего замера.
 *
 * Если для версии этой точки коэффициентов нет — балл остаётся своим. Это
 * лучше, чем прятать точку: пропуск в ряду читается как «замера не было», а
 * замер был, просто свести его не из чего.
 */
function equatedValue(
  point: { rawScore: number; versionNo?: number | null },
  rules: { fromVersion: number; slope: number; intercept: number }[] | null | undefined,
): number {
  const rule = rules?.find((r) => r.fromVersion === point.versionNo);
  if (!rule) return point.rawScore;
  return Math.round((rule.slope * point.rawScore + rule.intercept) * 100) / 100;
}

/** Подписи единиц значения для «Останній замір»: «T-бал 70», «стен 7» (#199) */
function normLabels(ut: (k: UiKey) => string) {
  return { raw: ut("norm.raw"), ratio: ut("norm.ratio"), tscore: ut("norm.tscore"), sten: ut("norm.sten") };
}

