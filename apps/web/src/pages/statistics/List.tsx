import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { StatModelListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import {
  DataTable,
  Empty,
  FilterBar,
  Ic,
  KbdHints,
  KV,
  Loading,
  Modal,
  Tooltip,
  useAction,
  useHotkeys,
  useToast,
  type Column,
} from "../../ui";
import { Page, Panel } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, offsetPageCount, pageFrom, perFrom } from "../../ui/paging";
import { Button, ButtonLink } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  MAX_SAMPLES,
  STATS_FILTERS,
  STATS_NEW,
  chartHref,
  statEditHref,
  statHref,
  statListQuery,
} from "./model";
import { SampleBadge, St } from "./parts";

/*
 * «Статистичні моделі» — перечень (дизайн statistics-models).
 *
 * Таблица: модель с описанием, тест с версией, показатели и «ВШР», выборки
 * номерами, чем выборки отобраны — всё из сводки строки сервера (GET
 * /api/stat-models). Действия строки — «Порівняти», правка показателей и
 * меню: график, удаление с подтверждением. Нажатие на строку открывает
 * модель.
 *
 * Поиск и страницы — на сервере (?q, ?limit, ?offset → {items, total}),
 * состояние — в адресе, как у каталога методик. Пилюль вида «З ВШР» и
 * чипов «Тест»/«Пресет» из дизайна здесь нет: сервер их не фильтрует, а
 * фильтр по одной странице врал бы о числах.
 */
export default function StatList() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

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

  /* поиск ждёт паузу в наборе: запрос на каждую букву — лишняя нагрузка без пользы */
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  /* пределы сервера — в запросе, а не отказом на весь перечень (model.ts, statListQuery) */
  const list = useResource(() => api.statModels(statListQuery(dq, page, per)), [dq, page, per]);
  const pages = offsetPageCount(list.data?.total ?? 0, per);

  /* страница за концом списка (сузили поиск) — возвращаемся на ближайшую */
  useEffect(() => {
    if (list.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [list.data, page, pages, update]);

  useHotkeys({ n: () => navigate(STATS_NEW) });

  const [doomed, setDoomed] = useState<StatModelListItem | null>(null);
  const remove = (m: StatModelListItem) =>
    void run(async () => {
      await api.deleteStatModel(m.id);
      setDoomed(null);
      toast(ut("st.deleted"), "ok");
      list.reload();
    });

  const columns: Column<StatModelListItem>[] = [
    {
      key: "model",
      header: ut("st.colModel"),
      required: true,
      render: (m) => (
        <div className="min-w-0 py-1">
          <Link
            to={statHref(m.id)}
            className="text-body font-extrabold text-text no-underline hover:text-violet-ink hover:underline"
          >
            {m.title}
          </Link>
          {m.description ? (
            <p className="m-0 mt-0.5 line-clamp-2 max-w-[56ch] text-small text-text-2">{m.description}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: "test",
      header: ut("st.colTest"),
      required: true,
      width: 190,
      render: (m) => (
        <div className="min-w-0">
          <span className="block truncate font-bold text-text">{m.surveyTitle ?? ut("st.testHidden")}</span>
          {m.versionNumber ? (
            <small className="block text-caption text-muted">{ut("st.versionN").replace("{n}", String(m.versionNumber))}</small>
          ) : null}
        </div>
      ),
    },
    {
      key: "indicators",
      header: ut("st.colIndicators"),
      required: true,
      width: 170,
      render: (m) => (
        <div>
          <span className="block text-text">
            {[
              m.bandCount ? ut("st.bandsN").replace("{n}", String(m.bandCount)) : null,
              m.questionCount ? ut("st.questionsN").replace("{n}", String(m.questionCount)) : null,
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
          <small className="block text-caption text-muted">
            {m.highRiskCount ? ut("st.vshrN").replace("{n}", String(m.highRiskCount)) : ut("st.noVshr")}
          </small>
        </div>
      ),
    },
    {
      key: "samples",
      header: ut("st.colSamples"),
      required: true,
      width: 170,
      render: (m) => (
        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(m.columnCount, 4) }, (_, i) => (
            <SampleBadge key={i} n={i + 1} of={m.columnCount} small />
          ))}
          <span className="ml-1 whitespace-nowrap text-caption text-muted">
            {ut("kit.ofTotal").replace("{n}", String(m.columnCount)).replace("{total}", String(MAX_SAMPLES))}
          </span>
        </div>
      ),
    },
    {
      key: "filters",
      header: ut("st.colFilters"),
      required: true,
      width: 150,
      render: (m) => {
        const own = m.columnCount - m.presetColumns;
        return (
          <span className="block text-text-2">
            {own ? <span className="block">{ut("st.ownN").replace("{n}", String(own))}</span> : null}
            {m.presetColumns ? (
              <span className="block">{ut("st.presetN").replace("{n}", String(m.presetColumns))}</span>
            ) : null}
          </span>
        );
      },
    },
  ];

  const total = list.data?.total ?? 0;

  return (
    <Page
      title={ut("sn.statModels")}
      meta={list.data ? [ut("st.modelsCount").replace("{n}", String(total)), ut("st.listLead")] : undefined}
      actions={
        <>
          <ButtonLink to={STATS_FILTERS}>
            <St.sliders />
            {ut("st.presets")}
          </ButtonLink>
          <Tooltip label={ut("st.newModel")} kbd="N">
            <span className="inline-flex">
              <ButtonLink to={STATS_NEW} variant="primary">
                <Ic.plus />
                {ut("st.newModel")}
              </ButtonLink>
            </span>
          </Tooltip>
        </>
      }
    >
      <Panel flush>
        <div className="px-4 pb-3 pt-3.5">
          <FilterBar
            search={{ value: q, onChange: (v) => update({ q: v, page: null }), placeholder: ut("st.search"), width: 320 }}
            count={list.data ? { shown: list.data.items.length, total } : undefined}
          />
        </div>
        {list.error ? (
          <div className="px-4 pb-4">
            <Loading bare error={list.error} onRetry={list.reload} />
          </div>
        ) : !list.data ? (
          <div className="px-4 pb-4">
            <Loading bare rows={5} />
          </div>
        ) : (
          <DataTable
            rows={list.data.items}
            columns={columns}
            rowKey={(m) => m.id}
            label={ut("sn.statModels")}
            onRowClick={(m) => navigate(statHref(m.id))}
            hotkeys
            sticky={false}
            empty={
              dq.trim() ? (
                <Empty compact title={ut("am.emptySearch")} hint={ut("st.searchHint")} />
              ) : (
                <Empty
                  title={ut("st.empty")}
                  hint={ut("st.emptyHint")}
                  icon={<St.sigma />}
                  action={
                    <ButtonLink to={STATS_NEW} variant="primary">
                      <Ic.plus />
                      {ut("st.newModel")}
                    </ButtonLink>
                  }
                />
              )
            }
            rowActions={(m) => (
              <>
                <ButtonLink to={statHref(m.id)} size="xs">
                  <St.play />
                  {ut("st.compare")}
                </ButtonLink>
                <ButtonLink
                  to={statEditHref(m.id)}
                  size="icon-sm"
                  variant="quiet"
                  aria-label={ut("st.editIndicators")}
                  title={ut("st.editIndicators")}
                >
                  <St.pencil />
                </ButtonLink>
                <ActionMenu
                  triggerSize="icon-sm"
                  entries={[
                    { label: ut("st.openChart"), to: chartHref(m.id), icon: <St.chartColumn size={15} /> },
                    {
                      label: ut("st.deleteModel"),
                      onSelect: () => setDoomed(m),
                      danger: true,
                      ruled: true,
                      icon: <St.trash size={15} />,
                    },
                  ]}
                />
              </>
            )}
          />
        )}
        {list.data && total > 0 ? (
          <div className="border-t border-divider px-4 py-3">
            <Pager
              page={page}
              pages={pages}
              per={per}
              total={total}
              onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
              onPage={(n) => update({ page: n > 1 ? String(n) : null })}
            />
          </div>
        ) : null}
        <KbdHints
          bar
          keys={[
            ["J K", ut("st.kRows")],
            ["/", ut("hotkey.search")],
            ["Enter", ut("st.kCompare")],
            ["N", ut("st.newModel")],
          ]}
        />
      </Panel>

      <Panel title={ut("st.howTitle")} icon={<St.book />} sub={ut("st.howSub")} className="mt-4">
        <KV
          w={170}
          rows={[
            [ut("st.howWhat"), ut("st.howWhatText")],
            [ut("st.howWho"), ut("st.howWhoText")],
            [ut("st.howHidden"), ut("st.howHiddenText")],
            [ut("st.howSees"), ut("st.howSeesText")],
          ]}
        />
      </Panel>

      {doomed ? (
        <Modal
          title={ut("st.deleteConfirm")}
          sub={ut("st.cannotUndo")}
          icon={<St.trash />}
          tone="warn"
          onClose={() => setDoomed(null)}
          footer={
            <>
              <Button variant="primary" icon={<St.trash />} disabled={busy} onClick={() => remove(doomed)}>
                {ut("st.deleteModel")}
              </Button>
              <Button onClick={() => setDoomed(null)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 pt-3.5 text-body text-text-2">
            {ut("st.deleteText").replace("{title}", doomed.title)}
          </p>
        </Modal>
      ) : null}
    </Page>
  );
}
