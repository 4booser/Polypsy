import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { RuleAction } from "@quizzy/shared";
import { api } from "../../api";
import { day } from "../../format";
import { useLang } from "../../lang";
import { useShellNav } from "../../shell/useShellNav";
import { DataTable, type Column, Empty, KbdHints, Loading, useHotkeys, useToast } from "../../ui";
import { FilterBar, FilterChip } from "../../ui/filters";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { IconTile, Page, Panel } from "../../ui/layout";
import { ActionMenu, MenuButton, menuItemClass } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, perFrom } from "../../ui/paging";
import { Button, ButtonLink, Switch, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { testsHref } from "./tests/model";
import { AIc } from "./icons";
import {
  ANY_TEST,
  MODEL_SORTS,
  type ModelSort,
  type ModelView,
  type SavedModel,
  copyHref,
  coverage,
  modelHref,
  pageSlice,
  ruleTests,
  selectModels,
  sortFrom,
  sortModels,
  uncovered,
  viewFrom,
} from "./model";
import { ACT_ICON, ACT_KEY, ActTag, CondChip } from "./parts";

/*
 * «Моделі аналітики» — перечень правил поддержки решений (analytics-models).
 *
 * Строка читается без открытия модели: имя и описание, «спрацьовує, коли»
 * — условия пилюлями через «і», «що робить» — действия. Выключатель в
 * первой колонке выключает модель, ничего не удаляя (PATCH enabled — сервер
 * поднимает версию, как при любой правке). Дублировать — значит открыть
 * форму новой модели с копией условий и действий: копия заводится только
 * «Створити», а не нажатием в перечне.
 *
 * Поиск, вид, фильтры «Тест» и «Дія», порядок и страница — в адресе:
 * ссылку на «вимкнені з PHQ-9» пересылают коллеге. Маршрут не знает ни
 * поиска, ни страниц — моделей в учреждении единицы-десятки, всё
 * считается здесь.
 *
 * Под таблицей две панели: как модель срабатывает (три шага словами) и
 * какие методики под моделями — где включённых нет вовсе.
 */

export default function AnalyticsList() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const nav = useShellNav();
  /* выключатель — правка модели; без права правок он только показывает состояние */
  const canManage = nav ? nav.access.can("decisions.manage") : true;

  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));
  const view = viewFrom(params.get("view"));
  const sort = sortFrom(params.get("sort"));
  const test = params.get("test") || null;
  const actRaw = params.get("act");
  const act = actRaw && actRaw in ACT_KEY ? (actRaw as RuleAction["kind"]) : null;

  /* `replace`, а не push: каждая буква поиска — не шаг в истории браузера */
  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const list = useResource(() => api.decisionRules(), []);
  const surveys = useResource(() => api.surveys(), []);
  const titles = useMemo(() => new Map((surveys.data ?? []).map((s) => [s.id, s.title])), [surveys.data]);
  const testTitle = useCallback(
    (id: string) => (id === ANY_TEST ? ut("am.anyTest") : (titles.get(id) ?? ut("am.testUnavailable"))),
    [titles, ut],
  );

  /*
   * Выключатель меняет строку на месте, не дожидаясь перечитывания всего
   * списка. Пока запрос по модели в полёте, второе нажатие по ней не уходит:
   * два PATCH с разными enabled приходили на сервер в любом порядке, и в базе
   * оставалось не то, что на экране. Ответ кладётся в загруженный перечень
   * (patch), и подмена снимается — а не висит до ухода с экрана поверх
   * свежего перечня.
   */
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  /* решение «в полёте ли запрос» — в момент нажатия, до перерисовки: поэтому ref, а не состояние */
  const inFlight = useRef(new Set<string>());
  const latest = useRef(list.data);
  latest.current = list.data;
  useEffect(() => {
    setFlipped((f) => {
      const keep = Object.entries(f).filter(([id]) => inFlight.current.has(id));
      return keep.length === Object.keys(f).length ? f : Object.fromEntries(keep);
    });
  }, [list.data]);
  const rows = useMemo(
    () => (list.data ? list.data.map((m) => (m.id in flipped ? { ...m, enabled: flipped[m.id]! } : m)) : null),
    [list.data, flipped],
  );

  const found = useMemo(
    () => (rows ? sortModels(selectModels(rows, { q, view, test, act }), sort) : null),
    [rows, q, view, test, act, sort],
  );
  const pages = pageCount(found?.length ?? 0, per);
  const shown = useMemo(() => (found ? pageSlice(found, page, per) : null), [found, page, per]);

  /* страница за концом списка (сузили поиск) — возвращаемся на ближайшую */
  useEffect(() => {
    if (found && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [found, page, pages, update]);

  useHotkeys({ n: () => navigate(modelHref("new")) });

  const toggle = async (m: SavedModel, on: boolean) => {
    if (inFlight.current.has(m.id)) return;
    inFlight.current.add(m.id);
    setFlipped((f) => ({ ...f, [m.id]: on }));
    try {
      const res = await api.updateDecisionRule(m.id, { enabled: on });
      inFlight.current.delete(m.id);
      const now = latest.current;
      if (now) list.patch(now.map((r) => (r.id === m.id ? { ...r, enabled: on, version: res.version } : r)));
      toast(ut(on ? "am.turnedOn" : "am.turnedOff").replace("{title}", m.title), "ok");
      list.reload();
    } catch (e) {
      inFlight.current.delete(m.id);
      setFlipped(({ [m.id]: _drop, ...rest }) => rest);
      toast(e instanceof Error ? e.message : ut("ui.actionFailed"), "err");
    }
  };

  const total = rows?.length ?? 0;
  const enabled = rows?.filter((m) => m.enabled).length ?? 0;
  const counts: Record<ModelView, number> = { all: total, on: enabled, off: total - enabled };
  const VIEW_KEY = { all: "am.viewAll", on: "am.viewOn", off: "am.viewOff" } as const;
  const SORT_KEY = { new: "am.sortNew", changed: "am.sortChanged", title: "am.sortTitle" } as const;

  /* методики, которые встречаются в условиях, — для фильтра «Тест»; «будь-який» — последним */
  const testsInUse = useMemo(() => {
    const ids = [...new Set((rows ?? []).flatMap((m) => ruleTests(m)))];
    return ids.sort((a, b) => Number(a === ANY_TEST) - Number(b === ANY_TEST) || testTitle(a).localeCompare(testTitle(b)));
  }, [rows, testTitle]);
  const actsInUse = useMemo(() => (Object.keys(ACT_KEY) as RuleAction["kind"][]).filter((k) => rows?.some((m) => m.actions.some((a) => a.kind === k))), [rows]);

  const columns: Column<SavedModel>[] = [
    {
      key: "on",
      header: "",
      width: 64,
      required: true,
      render: (m) => (
        <Switch
          checked={m.enabled}
          disabled={!canManage}
          onChange={(v) => void toggle(m, v)}
          label={<span className="sr-only">{ut("am.enabledOf").replace("{title}", m.title)}</span>}
          className="gap-0"
        />
      ),
    },
    {
      key: "model",
      header: ut("am.colModel"),
      required: true,
      width: 400,
      render: (m) => (
        <div className="min-w-[240px] py-1.5">
          <Link
            to={modelHref(m.id)}
            className={cx(
              "text-[14px] font-extrabold leading-5 no-underline hover:text-violet-ink hover:underline hover:decoration-[1.5px] hover:underline-offset-[3px]",
              m.enabled ? "text-text" : "text-muted",
            )}
          >
            {m.title}
          </Link>
          {m.note ? <p className="m-0 mt-0.5 line-clamp-2 max-w-[60ch] text-small leading-[18px] text-text-2">{m.note}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-caption text-muted">
            {m.enabled ? null : (
              <Tag icon={<AIc.powerOff size={12} />} tone="plain">
                {ut("am.off")}
              </Tag>
            )}
            <span>
              {ut("am.versionN").replace("{n}", String(m.version))}
              {m.updatedAt ? `, ${ut("am.changedOn").replace("{date}", day(m.updatedAt))}` : ""}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: "when",
      header: ut("am.colWhen"),
      required: true,
      width: 330,
      render: (m) => (
        <ul className="m-0 flex list-none flex-col items-start gap-1.5 p-0 py-1.5">
          {m.conditions.map((c, i) => (
            <li key={i} className="flex max-w-full items-center gap-1.5">
              <span className="w-3.5 shrink-0 text-center text-caption font-bold text-muted">{i ? ut("am.and") : ""}</span>
              <CondChip c={c} testTitle={testTitle} />
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "does",
      header: ut("am.colDoes"),
      required: true,
      render: (m) => (
        <div className="flex max-w-[300px] flex-col items-start gap-1.5 py-1.5">
          {m.actions.map((a, i) => (
            <ActTag key={i} a={a} testTitle={testTitle} />
          ))}
        </div>
      ),
    },
  ];

  const rowActions = (m: SavedModel) => {
    const named = ruleTests(m).find((t) => t !== ANY_TEST);
    return (
      <>
        <ButtonLink to={modelHref(m.id)} size="xs">
          <Ic.pen size={14} />
          {ut("am.open")}
        </ButtonLink>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={ut("am.duplicate")}
          title={ut("am.duplicate")}
          onClick={() => navigate(copyHref(m.id))}
        >
          <AIc.copy size={15} />
        </Button>
        <ActionMenu
          label={ut("am.rowMenu")}
          triggerSize="icon-sm"
          plateClassName="min-w-[240px]"
          entries={[
            { label: ut("am.open"), to: modelHref(m.id), icon: <Ic.pen size={15} /> },
            { label: ut("am.duplicate"), to: copyHref(m.id), icon: <AIc.copy size={15} /> },
            {
              label: ut(m.enabled ? "am.disable" : "am.enable"),
              icon: <AIc.powerOff size={15} />,
              disabled: !canManage,
              onSelect: () => void toggle(m, !m.enabled),
            },
            ...(named ? [{ label: ut("am.testAnalytics"), to: testsHref(named), icon: <Ic.gauge size={15} />, ruled: true }] : []),
          ]}
        />
      </>
    );
  };

  return (
    <Page
      title={ut("am.title")}
      meta={
        rows
          ? [ut("am.metaCount").replace("{n}", String(total)).replace("{on}", String(enabled)), ut("am.metaSub")]
          : undefined
      }
      actions={
        <>
          <ButtonLink to="/analytics/tests">
            <Ic.gauge size={15} />
            {ut("ant.title")}
          </ButtonLink>
          <ButtonLink to={modelHref("new")} variant="primary" title={ut("am.newModel")}>
            <Ic.plus size={15} />
            {ut("am.newModel")}
          </ButtonLink>
        </>
      }
    >
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !shown || !found ? (
        <Loading rows={5} />
      ) : (
        <>
          <Panel flush>
            <div className="px-4 pb-3 pt-3.5">
              <FilterBar
                search={{ value: q, onChange: (v) => update({ q: v, page: null }), placeholder: ut("am.search"), width: 260 }}
                views={{
                  items: (["all", "on", "off"] as const).map((k) => ({ key: k, label: ut(VIEW_KEY[k]), count: counts[k] })),
                  value: view,
                  onChange: (k) => update({ view: k === "all" ? null : k, page: null }),
                  label: ut("am.views"),
                }}
                chips={
                  <>
                    <PickChip
                      label={ut("am.fTest")}
                      value={test ? testTitle(test) : null}
                      clearLabel={ut("am.fTest")}
                      onClear={() => update({ test: null, page: null })}
                      options={testsInUse.map((id) => ({
                        key: id,
                        label: testTitle(id),
                        icon: id === ANY_TEST ? <AIc.shuffle size={15} /> : <Ic.clipboard size={15} />,
                        count: (rows ?? []).filter((m) => ruleTests(m).includes(id)).length,
                      }))}
                      current={test}
                      onPick={(id) => update({ test: id, page: null })}
                    />
                    <PickChip
                      label={ut("am.fAct")}
                      value={act ? ut(ACT_KEY[act]) : null}
                      clearLabel={ut("am.fAct")}
                      onClear={() => update({ act: null, page: null })}
                      options={actsInUse.map((k) => ({
                        key: k,
                        label: ut(ACT_KEY[k]),
                        icon: ACT_ICON[k],
                        count: (rows ?? []).filter((m) => m.actions.some((a) => a.kind === k)).length,
                      }))}
                      current={act}
                      onPick={(k) => update({ act: k, page: null })}
                    />
                  </>
                }
                sort={{
                  options: MODEL_SORTS.map((k) => ({ key: k, label: ut(SORT_KEY[k]) })),
                  value: sort,
                  onChange: (k) => update({ sort: (k as ModelSort) === "new" ? null : k }),
                }}
              />
            </div>
            {shown.length === 0 ? (
              total === 0 ? (
                <Empty
                  title={ut("am.empty")}
                  hint={ut("am.emptyHint")}
                  icon={<Ic.chart />}
                  action={
                    <ButtonLink to={modelHref("new")} variant="primary">
                      <Ic.plus size={15} />
                      {ut("am.newModel")}
                    </ButtonLink>
                  }
                />
              ) : (
                <Empty title={ut("am.emptySearch")} hint={ut("am.emptySearchHint")} icon={<Ic.search />} />
              )
            ) : (
              <DataTable
                rows={shown}
                columns={columns}
                rowKey={(m) => m.id}
                label={ut("am.title")}
                onRowClick={(m) => navigate(modelHref(m.id))}
                rowActions={rowActions}
                hotkeys
                sticky={false}
              />
            )}
            {found.length > 0 ? (
              <div className="border-t border-divider py-2.5 pl-4 pr-3">
                <Pager
                  page={page}
                  pages={pages}
                  per={per}
                  total={found.length}
                  onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
                  onPage={(n) => update({ page: n > 1 ? String(n) : null })}
                />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-4 pb-3 pt-2.5">
              <KbdHints
                keys={[
                  ["J K", ut("am.kRows")],
                  ["/", ut("hotkey.search")],
                  ["Enter", ut("am.kOpen")],
                  ["N", ut("am.kNew")],
                ]}
              />
              <span className="ml-auto inline-flex items-center gap-1.5 text-caption text-muted">
                <Ic.info size={13} />
                {ut("am.switchNote")}
              </span>
            </div>
          </Panel>

          <div className="mt-4 grid grid-cols-2 items-stretch gap-4 max-[1080px]:grid-cols-1">
            <HowPanel />
            <CoveragePanel rows={rows ?? []} surveys={surveys.data ?? []} testTitle={testTitle} />
          </div>
        </>
      )}
    </Page>
  );
}

/**
 * Чип фильтра с меню значений: «Тест ⌄» → методики из условий с числом
 * моделей. Выбранное значение — в чипе, крестик снимает фильтр.
 */
function PickChip<K extends string>({
  label,
  value,
  clearLabel,
  onClear,
  options,
  current,
  onPick,
}: {
  label: string;
  value: string | null;
  clearLabel: string;
  onClear: () => void;
  options: { key: K; label: string; icon?: ReactNode; count: number }[];
  current: K | null;
  onPick: (key: K) => void;
}) {
  if (value !== null) return <FilterChip label={label} value={value} on onClear={onClear} />;
  return (
    <MenuButton
      label={clearLabel}
      plateClassName="min-w-[260px]"
      trigger={(p) => <FilterChip label={label} onClick={p.onClick} expanded={p["aria-expanded"]} />}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="menuitemradio"
            aria-checked={o.key === current}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              onPick(o.key);
            }}
          >
            {o.icon ? <span className="inline-flex text-muted">{o.icon}</span> : null}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            <span className="text-caption font-bold tabular-nums text-muted">{o.count}</span>
          </button>
        ))
      }
    </MenuButton>
  );
}

/** Шаг объяснения: квадрат значка, жирное начало и одна фраза */
function Step({ icon, tone = "violet", title, children }: { icon: ReactNode; tone?: "violet" | "neutral"; title: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 border-t border-divider py-3 first:border-t-0 first:pt-0.5">
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0">
        <b className="block text-body font-extrabold leading-5 text-text">{title}</b>
        <p className="m-0 mt-0.5 text-small leading-[18px] text-text-2">{children}</p>
      </div>
    </li>
  );
}

/** «Як спрацьовує модель»: три шага словами — то, что делает evaluateRules на каждой сдаче */
function HowPanel() {
  const { ut } = useLang();
  return (
    <Panel title={ut("am.howTitle")} icon={<AIc.workflow />}>
      <ol className="m-0 list-none p-0">
        <Step icon={<Ic.clipboard />} tone="neutral" title={ut("am.how1Title")}>
          {ut("am.how1")}
        </Step>
        <Step icon={<AIc.listChecks />} title={ut("am.how2Title")}>
          {ut("am.how2")}
        </Step>
        <Step icon={<AIc.zap />} title={ut("am.how3Title")}>
          {ut("am.how3")}
        </Step>
      </ol>
    </Panel>
  );
}

/** Сколько названий перечислять в строке «Без жодної моделі» — остальное числом */
const UNCOVERED_SHOWN = 12;

/**
 * «Під моделями»: методики из условий моделей — сколько включённых и
 * какие; ниже — методики, о которых не говорит ни одна модель. Ответ на
 * вопрос «что у нас не охраняется», которого перечень по моделям не даёт.
 */
function CoveragePanel({
  rows,
  surveys,
  testTitle,
}: {
  rows: SavedModel[];
  surveys: { id: string; title: string }[];
  testTitle: (id: string) => string;
}) {
  const { ut } = useLang();
  const cover = coverage(rows);
  const bare = uncovered(surveys, rows);
  const named = cover.filter((c) => c.key !== ANY_TEST).length;
  return (
    <Panel
      title={ut("am.coverTitle")}
      icon={<Ic.layers />}
      sub={surveys.length ? ut("am.coverSub").replace("{n}", String(named)).replace("{total}", String(surveys.length)) : undefined}
    >
      {cover.length ? (
        <ul className="m-0 list-none p-0">
          {cover.map((c) => (
            <li
              key={c.key}
              className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-3 border-t border-divider py-3 first:border-t-0 first:pt-0.5"
            >
              <b className="line-clamp-2 min-w-0 text-body font-extrabold text-text">
                {testTitle(c.key)}
              </b>
              <div className="min-w-0">
                <b className={cx("block text-body font-extrabold", c.on.length ? "text-text" : "text-muted")}>
                  {c.on.length
                    ? ut("am.coverOn").replace("{n}", String(c.on.length))
                    : ut("am.coverOffOnly").replace("{n}", String(c.off.length))}
                </b>
                <p className="m-0 mt-0.5 text-small leading-[18px] text-text-2">
                  {(c.on.length ? c.on : c.off).map((m) => m.title).join("; ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-small text-muted">{ut("am.coverNone")}</p>
      )}
      {bare.length ? (
        <p className="m-0 mt-2 text-small text-muted">
          {ut("am.uncovered")}{" "}
          {bare
            .slice(0, UNCOVERED_SHOWN)
            .map((s) => s.title)
            .join(", ")}
          {bare.length > UNCOVERED_SHOWN ? ` ${ut("ui.andMore")} ${bare.length - UNCOVERED_SHOWN}` : ""}
        </p>
      ) : null}
    </Panel>
  );
}
