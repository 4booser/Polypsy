import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LOCALE_OF, type PatientListCounts, type PatientListItem, type UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { severityKey } from "../format";
import { useLang } from "../lang";
import {
  Avatar,
  BulkBar,
  DataTable,
  Drawer,
  DrawerPane,
  Empty,
  FilterBar,
  Ic,
  KbdHints,
  Loading,
  PersonCell,
  Tooltip,
  ViewPill,
  ViewPills,
  tableToCsv,
  useAction,
  useHotkeys,
  useToast,
  type Column,
} from "../ui";
import { cx } from "../ui/cx";
import { Page, Panel } from "../ui/layout";
import { ActionMenu, MenuButton, menuItemClass } from "../ui/menu";
import { Pager } from "../ui/pager";
import { offsetPageCount, pageFrom, refilter, toPage } from "../ui/paging";
import { Button, ErrorText, SeverityTag, Tabs, Tag } from "../ui/primitives";
import { patchParams } from "../ui/viewParams";
import { useDebounced, useResource } from "../useResource";
import { ShellIcon } from "../shell/icons";
import { useMedia } from "../shell/Rail";
import { usePatientViews } from "./patientGroups/views";
import { InviteDialog } from "./patients/InviteDialog";
import {
  ageOf,
  CLINICAL_DOMAIN_KEY,
  ddmm,
  daysAgo,
  groupTab,
  hhmm,
  kitSeverity,
  LIST_VIEWS,
  registerBody,
  REGISTER_PER,
  registerPer,
  registerQuery,
  shownValue,
  sortOf,
  viewOf,
  whenShort,
  type ListSort,
} from "./patients/model";
import { useAssignPane, useGroupPane, useMessagePane, type PaneParts, type Who } from "./patients/actions";
import { useQuickViewPane } from "./patients/QuickView";
import type { Via } from "../components/settledSelection";
import { withCount } from "../ui/plural";

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
 *   таблица: ризик першим, клінічний стан, прийом          → DataTable, страницы сервера
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
  const { user } = useAuth();
  const locale = LOCALE_OF[lang];
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

  const query = registerQuery({ q: qSent, group: current?.id ?? null, view, mine, me: user?.id ?? null, sort, page, per });
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
   * Числа шапки и вкладки «Усі» — без поиска и без «за мною»: «248 людей» не
   * должно превращаться в «3» на каждую букву или в число моих. Запоминаются
   * по вкладке из ответа без сужения; пока такого ответа не было, числа нет,
   * а не ноль.
   */
  const baseCounts = useRef(new Map<string, PatientListCounts>());
  if (list.data?.counts && !query.q && !query.lead) baseCounts.current.set(current?.id ?? "", list.data.counts);
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

  /*
   * Чем сменили человека «Хто це»: открытие строки — выбор сразу; шаг J/K и
   * стрелками шапки — по списку, и его сводка, карточка и хронология (чтения
   * в журнал) грузятся, когда курсор остановился (components/settledSelection).
   */
  const whoVia = useRef<Via>("click");
  const openWho = (r: PatientListItem) => {
    whoVia.current = "click";
    setDrawer({ open: true, mode: "who", who: r.id, people: [] });
  };
  const step = (d: 1 | -1) => {
    const next = rows[at + d];
    if (!next) return;
    whoVia.current = "key";
    setDrawer((s) => ({ ...s, who: next.id }));
  };
  const whoOf = (r: PatientListItem): Who => ({ id: r.id, name: r.name });

  useHotkeys({ n: () => setInvite(true) });

  const views = usePatientViews();
  const { run, busy } = useAction();
  const toast = useToast();

  /*
   * «Закріпити за собою» — строкой, из меню строки и для отмеченных: прежде
   * взять человека можно было только из его карточки, и у ста двадцати
   * незакреплённых в реестре стояло «не закріплено» без способа это
   * исправить. Тот же маршрут, что в карточке и на приёме (POST
   * /api/clinic/patients/:id/lead, в журнал — clinic.lead_take). Человека,
   * которого ведёт коллега, отметка не забирает: смена ведущего — перевод,
   * его делают в карточке человека.
   */
  const takeLead = (people: PatientListItem[]) =>
    void run(async () => {
      const free = people.filter((p) => !p.leadSpecialistId);
      for (const p of free) await api.takeLead(p.id, true);
      const skipped = people.length - free.length;
      list.reload();
      const took = ut("ws.tookN").replace("{n}", String(free.length));
      toast(skipped ? `${took}; ${ut("ws.skippedLed").replace("{n}", String(skipped))}` : took, "ok");
    });

  /* виды ящика — хуками: Drawer узнаёт вид по элементу DrawerPane, и обёртка его спрятала бы */
  const close = () => setDrawer((s) => ({ ...s, open: false }));
  const who = useQuickViewPane({
    person: focused,
    via: whoVia.current,
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
  const columns = useColumns({ locale, now, words, narrow, onTake: (r) => takeLead([r]), busy });

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
              withCount(ut("plist.people"), allCounts.all, lang),
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
              <Button variant="panel" size="xs" icon={<Ic.user />} disabled={busy} onClick={() => takeLead([...picked.values()])}>
                {ut("pcard.subscribe")}
              </Button>
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
                    <ActionMenu
                      label={`${ut("kit.moreActions")}: ${r.name}`}
                      triggerSize="icon-sm"
                      entries={[
                        { key: "card", label: ut("pt.openCard"), to: `/patients/${r.id}` },
                        ...(r.leadSpecialistId ? [] : [{ key: "lead", label: ut("pcard.subscribe"), onSelect: () => takeLead([r]) }]),
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
  onTake,
  busy,
}: {
  locale: string;
  now: number;
  words: { today: string; tomorrow: string };
  narrow: boolean;
  /** «Закріпити за собою» строки незакреплённого человека */
  onTake: (r: PatientListItem) => void;
  busy: boolean;
}): Column<PatientListItem>[] {
  const { ut } = useLang();
  const all: Column<PatientListItem>[] = [
    {
      key: "name",
      header: ut("ref.patient"),
      required: true,
      width: 230,
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
      width: 150,
      render: (r) => <StateCell r={r} locale={locale} now={now} />,
    },
    {
      key: "measure",
      required: true,
      header: ut("ws.clinicalState"),
      width: 236,
      render: (r) => <ClinicalStateCell r={r} locale={locale} now={now} today={words.today} narrow={narrow} />,
    },
    {
      key: "last",
      required: true,
      header: ut("plist.measuredAt"),
      width: 120,
      render: (r) => <MeasuredAt r={r} now={now} locale={locale} today={words.today} />,
    },
    {
      key: "lead",
      required: true,
      header: ut("plist.lead"),
      width: 136,
      render: (r) =>
        r.leadName ? (
          <span className="inline-flex min-w-0 items-center gap-2" title={r.leadName}>
            <Avatar name={r.leadName} size={24} tone="neutral" />
            <span className="truncate text-small text-text">{shortName(r.leadName)}</span>
          </span>
        ) : (
          <span className="flex flex-col items-start gap-0.5">
            <span className="text-small text-muted">{ut("plist.noLead")}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => onTake(r)}
              className="min-h-0 cursor-pointer rounded-[6px] border-0 bg-transparent p-0 text-caption font-bold text-violet-ink outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--vring)] disabled:opacity-50"
            >
              {ut("pcard.subscribe")}
            </button>
          </span>
        ),
    },
    {
      key: "next",
      required: true,
      header: ut("plist.nextVisit"),
      width: 124,
      render: (r) => {
        /*
         * «Не записано» — обычное состояние почти каждого в стационаре, а не
         * тревога: приглушённым словом, без янтаря. Внимания требует неявка
         * без новой записи и просроченный осмотр — их говорит «Стан».
         */
        if (!r.nextVisit) return <span className="whitespace-nowrap text-small text-muted">{ut("plist.notBooked")}</span>;
        const w = whenShort(r.nextVisit.at, now, locale, words);
        return (
          <span className={cx("text-small", w.soon ? "font-extrabold text-violet-ink" : "text-text")}>
            {w.text}
            {r.nextVisit.mode === "remote" ? <span className="font-semibold">, {ut("pt.remote")}</span> : null}
          </span>
        );
      },
    },
  ];
  return narrow ? all.filter((c) => c.key !== "last") : all;
}

/**
 * Клинический стан строки: самая тяжёлая полоса среди последних замеров по
 * ключевым доменам (сервер, routes/patients.ts, measuresOf) — полоса словом,
 * куда сдвинулась ступень от прошлого замера, методика с баллом, домен и
 * другие домены в клиническом диапазоне. Прежде здесь стоял последний
 * сданный замер, какой бы он ни был: «WHO-5 1» у человека с тяжёлой
 * депрессией по PHQ-9.
 */
function ClinicalStateCell({
  r,
  locale,
  now,
  today,
  narrow,
}: {
  r: PatientListItem;
  locale: string;
  now: number;
  today: string;
  narrow: boolean;
}) {
  const { ut } = useLang();
  const m = r.measure;
  if (!m) return <span className="text-small text-muted">{ut("plist.noMeasure")}</span>;
  const v = shownValue(m.values.at(-1) ?? 0, m.normalization);
  const band = m.bandLabel ?? (m.severity ? ut(severityKey[m.severity]) : null);
  const domain = m.domain ? ut(CLINICAL_DOMAIN_KEY[m.domain]) : null;
  const also = (m.also ?? []).map((d) => ut(CLINICAL_DOMAIN_KEY[d]).toLowerCase());
  /* целиком — в подсказке: домен, методика, полоса и другие домены в клиническом диапазоне */
  const title = [domain, `${m.title}: ${v.text}${v.unit}${band ? ` — ${band}` : ""}`, also.length ? `${ut("ws.alsoClinical")} ${also.join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");
  const stale = !!r.lastResponseAt && daysAgo(r.lastResponseAt, now) >= 30;
  return (
    <span className="flex min-w-0 max-w-[230px] flex-col gap-0.5" title={title}>
      <span className="flex min-w-0 items-center gap-1.5">
        {band ? (
          <SeverityTag level={kitSeverity(m.severity)} small className="min-w-0 max-w-full">
            <span className="min-w-0 truncate">{band}</span>
          </SeverityTag>
        ) : (
          <span className="text-small text-muted">{ut("ws.noBands")}</span>
        )}
        {m.trend === "worse" || m.trend === "better" ? (
          <Tooltip label={ut(m.trend === "worse" ? "ws.trendWorse" : "ws.trendBetter")}>
            <span
              tabIndex={0}
              aria-label={ut(m.trend === "worse" ? "ws.trendWorse" : "ws.trendBetter")}
              className={cx(
                "inline-flex shrink-0 rounded-[4px] outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                m.trend === "worse" ? "text-warn" : "text-good",
              )}
            >
              {m.trend === "worse" ? <Ic.arrowUp size={14} /> : <Ic.arrowDown size={14} />}
            </span>
          </Tooltip>
        ) : null}
        {also.length ? <span className="shrink-0 text-caption font-bold text-muted">+{also.length}</span> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-caption text-text-2">
        <b className="shrink-0 font-bold text-text">
          {m.code} {v.text}
          {v.unit}
        </b>
        {domain ? <span className="min-w-0 truncate">· {domain}</span> : null}
        {/* дата замера — здесь, когда колонки даты нет; давность 30+ дней — янтарём */}
        {narrow && stale ? (
          <span className="shrink-0">
            <MeasuredAt r={r} now={now} locale={locale} today={today} />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Когда мерили: дата, сегодня — словом; 30+ дней — янтарём с числом дней */
function MeasuredAt({ r, now, locale, today }: { r: PatientListItem; now: number; locale: string; today: string }) {
  const { ut } = useLang();
  /* замеров не было — прочерк: «замірів немає» уже сказано в колонке замера рядом */
  if (!r.lastResponseAt) return <span className="text-small text-muted">—</span>;
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
  const { ut, lang } = useLang();
  if (r.risk) {
    const sub = r.risk.assigneeName
      ? ut("plist.caseWith").replace("{name}", shortName(r.risk.assigneeName))
      : ut("plist.caseSince").replace("{when}", `${ddmm(r.risk.openedAt, locale)}, ${hhmm(r.risk.openedAt, locale)}`);
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tag tone={r.risk.assigneeName ? "handover" : "danger"} icon={<Ic.alert />}>
          {/* число открытых случаев, а не сигналов: у случая их бывает несколько */}
          {withCount(ut("plist.cases"), r.risk.cases, lang)}
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
    { key: "domain", header: ut("ws.clinicalState"), render: none, csv: (r) => (r.measure?.domain ? ut(CLINICAL_DOMAIN_KEY[r.measure.domain]) : null) },
    { key: "code", header: ut("plist.instrument"), render: none, csv: (r) => r.measure?.code ?? null },
    {
      key: "value",
      header: ut("ws.colScore"),
      render: none,
      csv: (r) => (r.measure ? shownValue(r.measure.values.at(-1) ?? 0, r.measure.normalization).text : null),
    },
    { key: "band", header: ut("pt.interpretation"), render: none, csv: (r) => r.measure?.bandLabel ?? null },
    { key: "last", header: ut("plist.measuredAt"), render: none, csv: (r) => r.lastResponseAt?.slice(0, 10) ?? null },
    { key: "lead", header: ut("plist.lead"), render: none, csv: (r) => r.leadName ?? null },
    { key: "next", header: ut("plist.nextVisit"), render: none, csv: (r) => r.nextVisit?.at.slice(0, 16).replace("T", " ") ?? null },
  ];
}
