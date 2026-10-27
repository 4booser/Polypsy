import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  FilterPresetListItem,
  SampleFilters,
  StatCell,
  StatModelColumn,
  StatRunColumn,
  StatRunResult,
} from "@quizzy/shared";
import { api } from "../../api";
import { GroupedHBars, type SeriesKey, SeriesLegend } from "../../charts/clinical";
import { useLang } from "../../lang";
import { Callout, Empty, Ic, Loading, Modal, SearchField, Tooltip, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
import { Button, ButtonLink, Checkbox, ErrorText, Segmented, SeverityTag, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  CRITERION_LABEL,
  type Criterion,
  HIDDEN_MARK,
  MAX_SAMPLES,
  type ReportRow,
  STATS_FILTERS,
  STATS_LIST,
  STATS_NEW,
  applyPreset,
  addSample,
  cellAt,
  cellShare,
  columnInput,
  columnsChanged,
  criteriaOf,
  criterionValue,
  isFigureRow,
  pickedModel,
  reportRows,
  withoutCriteria,
} from "./model";
import {
  CRITERION_ICON,
  CellText,
  CriteriaChips,
  HiddenWhy,
  SampleBadge,
  St,
  VshrMark,
  sampleColor,
  useSampleName,
} from "./parts";

/*
 * Графік — дизайн statistics-chart и окно statistics-apply-preset-dialog.
 *
 * Сверху — выбор модели (нажатие выбирает и сразу считает) и пресеты
 * фильтров (нажатие открывает окно: к каким выборкам применить). Ниже —
 * выборки модели строками с чипами критериев: нажатый чип участвует в
 * расчёте, отпущенный снят на этот запуск. «Оновити» считает то, что на
 * экране: нетронутую модель — POST /:id/run, с правками — превью без
 * сохранения; «Зберегти» кладёт правки в модель.
 *
 * Доли — сгруппированными полосами (GroupedHBars набора): строка —
 * показатель, полоса — выборка цветом её ряда. Скрытое сервером — «n < 5»
 * с объяснением приватности; число скрытой ячейки на экран не доезжает
 * (cellShare). Переключатель «Діаграма / Таблиця» — те же числа таблицей.
 */

/** Сколько моделей в выборе — пять; остальные — в перечне */
const SHOWN_MODELS = 5;

export default function StatChart() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const sampleName = useSampleName();
  const [params, setParams] = useSearchParams();

  const models = useResource(() => api.statModels(), []);
  const presets = useResource(() => api.filterPresets(), []);
  /* модель из адреса — только из видимых человеку; чужая, удалённая или пустая — первая (model.ts, pickedModel) */
  const picked = pickedModel(params.get("model"), models.data?.items ?? null);
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const model = useResource(() => api.statModel(picked!), [picked], { enabled: !!picked, manual: true });

  const [work, setWork] = useState<StatModelColumn[] | null>(null);
  const [off, setOff] = useState<Criterion[][]>([]);
  const [result, setResult] = useState<StatRunResult | null>(null);
  /* с какими колонками посчитан результат: после правки экран говорит, что числа старые */
  const [ranWith, setRanWith] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [applying, setApplying] = useState<FilterPresetListItem | null>(null);
  /*
   * Номер расчёта. Расчёт — действие человека, а не загрузка экрана, но ответ
   * его применяется только последний: выбрал модель А, не дождался, выбрал Б —
   * расчёт по А, пришедший позже, вставал на экран под названием Б.
   */
  const runNo = useRef(0);
  useEffect(() => {
    if (!model.data) return;
    runNo.current += 1;
    setWork(model.data.columns);
    setOff(model.data.columns.map(() => []));
    setResult(null);
    setRanWith(null);
  }, [model.data]);

  const presetOf = (c: StatModelColumn) => (c.presetId ? presets.data?.find((p) => p.id === c.presetId) : undefined);
  const baseOf = (c: StatModelColumn): SampleFilters => (c.presetId ? (presetOf(c)?.criteria ?? {}) : (c.filters ?? {}));

  /*
   * Колонки к расчёту: выборка со снятыми чипами уходит своими фильтрами
   * (без пресета) — сервер берёт либо пресет целиком, либо свои, и
   * «пресет без одного критерия» по-другому ему не сказать.
   */
  const payload = useMemo(
    () =>
      work?.map((c, i): StatModelColumn =>
        off[i]?.length ? { ...c, presetId: null, filters: withoutCriteria(baseOf(c), off[i]!) } : c,
      ) ?? null,
    /* baseOf читает presets.data — он в зависимостях вместо самой функции */
    [work, off, presets.data],
  );
  const changed = !!(model.data && payload && columnsChanged(model.data.columns, payload));
  const stale = !!(result && payload && ranWith !== JSON.stringify(payload.map(columnInput)));

  const refresh = (cols = payload, id = picked, title = model.data?.title) =>
    void run(async () => {
      if (!cols || !id) return false;
      const ticket = ++runNo.current;
      const same = model.data?.id === id && !columnsChanged(model.data.columns, cols);
      const next = same ? await api.runStatModel(id) : await api.previewStatModel(cols.map(columnInput), title);
      if (ticket !== runNo.current) return false;
      setResult(next);
      setRanWith(JSON.stringify(cols.map(columnInput)));
    });

  const save = () =>
    void run(async () => {
      if (!picked || !payload) return false;
      await api.updateStatModel(picked, { columns: payload.map(columnInput) });
      model.reload();
    }, ut("st.saved"));

  const pick = (id: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("model", id);
        return next;
      },
      { replace: true },
    );
  };

  /* нажатие по модели выбирает и считает её — как только она приехала */
  const [autoRun, setAutoRun] = useState<string | null>(null);
  useEffect(() => {
    if (autoRun && model.data?.id === autoRun && work) {
      setAutoRun(null);
      refresh(model.data.columns, model.data.id, model.data.title);
    }
    /* срабатывает на приезд выбранной модели, а не на каждую перерисовку refresh */
  }, [autoRun, model.data, work]);

  const list = models.data?.items ?? [];
  const shown = list.slice(0, SHOWN_MODELS);
  /* выбранная модель за пятой строкой всё равно видна: иначе подсветка терялась бы */
  const selected = list.find((m) => m.id === picked);
  if (selected && !shown.includes(selected)) shown.push(selected);

  const nameOf = (c: StatModelColumn, i: number) => sampleName(c.title, presetOf(c)?.title, i);

  return (
    <Page
      title={ut("sn.chart")}
      meta={[ut("st.chartMeta"), ut("st.chartLead")]}
      actions={
        <>
          <Tooltip label={changed ? ut("st.saveChart") : ut("st.nothingToSave")}>
            <span className="inline-flex">
              <Button icon={<St.save />} disabled={busy || !changed} onClick={save}>
                {ut("common.save")}
              </Button>
            </span>
          </Tooltip>
          <ActionMenu
            label={ut("st.menu")}
            glyph={<St.settings size={18} />}
            triggerSize="icon"
            entries={[
              { label: ut("st.manageFilters"), to: STATS_FILTERS, icon: <St.sliders size={15} /> },
              { label: ut("st.manageModels"), to: STATS_LIST, icon: <St.sigma size={15} /> },
              {
                label: ut("common.save"),
                onSelect: save,
                disabled: busy || !changed,
                hint: ut("st.nothingToSave"),
                ruled: true,
                icon: <St.save size={15} />,
              },
            ]}
          />
        </>
      }
    >
      {models.error ? (
        <Loading error={models.error} onRetry={models.reload} />
      ) : !models.data ? (
        <Loading rows={6} />
      ) : list.length === 0 ? (
        <Panel>
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
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid items-stretch gap-4 grid-cols-[minmax(0,1fr)_380px] max-[1180px]:grid-cols-1">
            <Panel title={ut("st.modelPanel")} icon={<St.sigma />} sub={ut("st.modelPanelSub")} flush>
              <ul className="m-0 grid list-none grid-cols-2 gap-1 px-1.5 pb-2 max-[760px]:grid-cols-1">
                {shown.map((m) => {
                  const on = m.id === picked;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-current={on ? "true" : undefined}
                        onClick={() => {
                          pick(m.id);
                          setAutoRun(m.id);
                        }}
                        className={cx(
                          "flex w-full min-h-0 cursor-pointer items-center gap-2 rounded-control border-0 px-2.5 py-2 text-left",
                          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                          on
                            ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]"
                            : "bg-transparent hover:bg-sunk",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className={cx("block truncate font-bold", on ? "text-violet-ink" : "text-text")}>
                            {m.title}
                          </span>
                          <small className="block truncate text-caption text-muted">
                            {m.surveyTitle ? `${m.surveyTitle}, ` : ""}
                            {ut("st.samplesN").replace("{n}", String(m.columnCount))}
                          </small>
                        </span>
                        {on ? <Ic.check size={15} className="text-violet-ink" /> : null}
                      </button>
                    </li>
                  );
                })}
                <li>
                  <Link
                    to={STATS_LIST}
                    className="flex items-center gap-2 rounded-control px-2.5 py-2 no-underline hover:bg-sunk"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold text-text">
                        {ut("st.allModels").replace("{n}", String(list.length))}
                      </span>
                      <small className="block text-caption text-muted">{ut("st.allModelsSub")}</small>
                    </span>
                    <St.arrowUpRight size={15} className="text-muted" />
                  </Link>
                </li>
              </ul>
            </Panel>
            <PresetPanel
              presets={presets.data}
              error={presets.error}
              onRetry={presets.reload}
              disabled={!work?.length}
              onPick={setApplying}
            />
          </div>

          <Panel
            title={ut("st.samplesPanel")}
            icon={<St.usersRound />}
            sub={ut("st.samplesPanelSub")}
            actions={
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<Ic.plus />}
                  disabled={!work || work.length >= MAX_SAMPLES}
                  onClick={() => {
                    if (!work) return;
                    setWork(addSample(work));
                    setOff((o) => [...o, []]);
                  }}
                >
                  {ut("st.sample")}
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  icon={<Ic.refresh />}
                  disabled={busy || !payload || !!model.error}
                  onClick={() => refresh()}
                >
                  {ut("st.refresh")}
                </Button>
              </>
            }
          >
            {/*
              Модель есть в перечне, а сама не загрузилась (удалили между
              двумя запросами, отозвали доступ) — отказ словами и
              «повторити», а не пустое место и не строки прежней модели под
              подсвеченной новой.
            */}
            {model.error ? (
              <Loading bare error={model.error} onRetry={model.reload} />
            ) : !work ? (
              <Loading bare rows={2} />
            ) : (
              <div className="flex flex-col">
                {work.map((c, i) => (
                  <SampleLine
                    key={i}
                    index={i}
                    of={work.length}
                    name={nameOf(c, i)}
                    filters={baseOf(c)}
                    preset={!!c.presetId}
                    off={off[i] ?? []}
                    res={stale ? undefined : result?.columns[i]}
                    onToggle={(k) =>
                      setOff((o) =>
                        o.map((one, j) => (j !== i ? one : one.includes(k) ? one.filter((x) => x !== k) : [...one, k])),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </Panel>

          <Shares
            result={result}
            stale={stale}
            title={model.data?.title ?? ""}
            columns={work ?? []}
            names={(work ?? []).map((c, i) => nameOf(c, i))}
            filtersOf={(i) => (payload?.[i] ? baseOfPayload(payload[i]!, presetOf) : {})}
            view={view}
            onView={setView}
          />
        </div>
      )}

      {applying && work ? (
        <ApplyPreset
          preset={applying}
          modelTitle={model.data?.title ?? ""}
          columns={work}
          names={work.map((c, i) => nameOf(c, i))}
          presetTitleOf={(c) => presetOf(c)?.title ?? null}
          filtersOf={baseOf}
          result={stale ? null : result}
          onApply={(targets, extra) => {
            setWork(applyPreset(work, applying.id, targets, extra));
            setOff((o) => [...o.map((one, i) => (targets.includes(i) ? [] : one)), ...(extra ? [[]] : [])]);
            setApplying(null);
          }}
          onClose={() => setApplying(null)}
        />
      ) : null}
    </Page>
  );
}

/** Фильтры, с которыми колонка уйдёт в расчёт: пресет целиком или свои */
function baseOfPayload(c: StatModelColumn, presetOf: (c: StatModelColumn) => FilterPresetListItem | undefined): SampleFilters {
  return c.presetId ? (presetOf(c)?.criteria ?? {}) : (c.filters ?? {});
}

/* ─────────── пресеты ─────────── */

function PresetPanel({
  presets,
  error,
  onRetry,
  disabled,
  onPick,
}: {
  presets: FilterPresetListItem[] | null;
  error: string | null;
  onRetry: () => void;
  disabled: boolean;
  onPick: (p: FilterPresetListItem) => void;
}) {
  const { ut } = useLang();
  const [q, setQ] = useState("");
  const found = (presets ?? []).filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Panel
      title={ut("st.presets")}
      icon={<St.sliders />}
      flush
      actions={
        <ButtonLink
          to={STATS_FILTERS}
          size="icon-sm"
          variant="quiet"
          aria-label={ut("st.newPreset")}
          title={ut("st.newPreset")}
        >
          <Ic.plus />
        </ButtonLink>
      }
    >
      <p className="m-0 px-4 pb-2 text-small text-muted">{ut("st.presetsHint")}</p>
      {(presets?.length ?? 0) > 6 ? (
        <div className="px-4 pb-2">
          <SearchField value={q} onChange={setQ} placeholder={ut("st.presetSearch")} width={0} />
        </div>
      ) : null}
      <div className="px-1.5 pb-2">
        {error ? (
          <div className="px-2.5">
            <Loading bare error={error} onRetry={onRetry} />
          </div>
        ) : !presets ? (
          <Loading bare rows={3} />
        ) : !found.length ? (
          <p className="m-0 px-2.5 py-2 text-small text-muted">{q ? ut("am.emptySearch") : ut("st.noPresets")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {found.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  disabled={disabled}
                  onClick={() => onPick(p)}
                  className={cx(
                    "flex w-full min-h-0 cursor-pointer items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left",
                    "hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-48",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  )}
                >
                  <St.sliders size={15} className="text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-text">{p.title}</span>
                    <PresetLine filters={p.criteria} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Критерии одной строкой — под именем пресета и у выборки в окне применения */
function PresetLine({ filters }: { filters: SampleFilters }) {
  const { ut } = useLang();
  return <small className="block truncate text-caption text-muted">{criteriaWords(filters, ut)}</small>;
}

function criteriaWords(filters: SampleFilters, ut: ReturnType<typeof useLang>["ut"]): string {
  const list = criteriaOf(filters);
  if (!list.length) return ut("st.everyone");
  return list
    .map((k) => {
      const v = criterionValue(k, filters, ut);
      return v ? `${ut(CRITERION_LABEL[k])}: ${v}` : ut(CRITERION_LABEL[k]);
    })
    .join("; ");
}

/* ─────────── выборки ─────────── */

/**
 * Строка выборки: номер, имя, чипы критериев и основание. Чип — кнопка:
 * нажатый участвует в расчёте, отпущенный зачёркнут и снят на этот запуск
 * (признак — и цвет, и черта, и aria-pressed). Значение в чипе — словами
 * (criterionValue); группа и человек — только именем критерия.
 */
function SampleLine({
  index,
  of,
  name,
  filters,
  preset,
  off,
  res,
  onToggle,
}: {
  index: number;
  of: number;
  name: string;
  filters: SampleFilters;
  preset: boolean;
  off: Criterion[];
  res: StatRunColumn | undefined;
  onToggle: (c: Criterion) => void;
}) {
  const { ut } = useLang();
  const crit = criteriaOf(filters);
  return (
    <div className="grid grid-cols-[22px_200px_minmax(0,1fr)_auto] items-center gap-3 border-t border-divider py-2.5 first:border-t-0 first:pt-0.5 max-[1100px]:grid-cols-[22px_minmax(0,1fr)_auto]">
      <SampleBadge n={index + 1} of={of} />
      <b className="truncate font-extrabold text-text">{name}</b>
      <div role="group" aria-label={name} className="flex flex-wrap items-center gap-1.5 max-[1100px]:col-span-3 max-[1100px]:row-start-2">
        {crit.length ? (
          crit.map((k) => {
            const on = !off.includes(k);
            const value = criterionValue(k, filters, ut);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                title={on ? ut("st.chipOff") : ut("st.chipOn")}
                onClick={() => onToggle(k)}
                className={cx(
                  "inline-flex h-[30px] min-h-0 max-w-full cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[15px] border-0 px-[11px]",
                  "text-caption font-semibold leading-none",
                  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  on
                    ? "bg-violet-tint text-violet-ink hover:bg-violet-tint-2"
                    : "bg-transparent text-muted line-through shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                )}
              >
                {CRITERION_ICON[k]}
                <span className="truncate">
                  {ut(CRITERION_LABEL[k])}
                  {value ? (
                    <>
                      : <b className="font-extrabold">{value}</b>
                    </>
                  ) : null}
                </span>
              </button>
            );
          })
        ) : (
          <Tag icon={<St.usersRound />}>{ut("st.everyone")}</Tag>
        )}
        {preset ? (
          <Tag tone="primary" icon={<St.sliders />}>
            {ut("st.presetWord")}
          </Tag>
        ) : null}
      </div>
      <span className="whitespace-nowrap text-right text-small tabular-nums text-muted">
        {res ? (
          <>
            {ut("st.nEq")} <CountText cell={res.respondents} />
          </>
        ) : null}
      </span>
    </div>
  );
}

/** Число людей ячейки — основание и «ВШР»: число или прочерк с подписью скрытого */
function CountText({ cell }: { cell: StatCell }) {
  const { ut } = useLang();
  if (!cell.suppressed) return <>{cell.count}</>;
  return (
    <span title={ut("st.hidden")}>
      <span aria-hidden>{HIDDEN_MARK}</span>
      <span className="sr-only">{ut("st.hidden")}</span>
    </span>
  );
}

/* ─────────── доли ─────────── */

function Shares({
  result,
  stale,
  title,
  columns,
  names,
  filtersOf,
  view,
  onView,
}: {
  result: StatRunResult | null;
  stale: boolean;
  title: string;
  columns: StatModelColumn[];
  names: string[];
  filtersOf: (i: number) => SampleFilters;
  view: "chart" | "table";
  onView: (v: "chart" | "table") => void;
}) {
  const { ut } = useLang();
  const cols = result?.columns ?? [];
  const head = cols[0];
  /* подписи — из расчёта: график рисуется только по нему, а он несёт их сам на языке запроса */
  const rows = result ? reportRows(columns.slice(0, cols.length), () => undefined, cols) : [];
  const floor = result?.smallCellFloor ?? 5;
  const series: SeriesKey[] = cols.map((c, i) => ({
    key: String(i),
    label: `${ut("st.sample")} ${i + 1}, ${ut("st.nEq")} ${c.respondents.suppressed ? HIDDEN_MARK : c.respondents.count}`,
    color: sampleColor(i, cols.length),
  }));

  return (
    <Panel
      title={ut("st.sharesTitle")}
      icon={<St.chartBar />}
      sub={
        head
          ? `${result?.title || title}, ${head.surveyTitle}, ${ut("st.versionN").replace("{n}", String(head.versionNumber))}`
          : undefined
      }
      actions={
        result ? (
          <Segmented
            label={ut("st.sharesTitle")}
            value={view}
            onChange={onView}
            items={[
              { key: "chart", label: ut("chart.viewChart") },
              { key: "table", label: ut("chart.viewTable") },
            ]}
          />
        ) : null
      }
    >
      {!result ? (
        <Empty compact title={ut("st.chartEmpty")} />
      ) : (
        <>
          {stale ? (
            <Callout kind="warn" className="mb-3" role="status">
              {ut("st.staleNote")}
            </Callout>
          ) : null}
          {view === "table" ? (
            <ShareTable rows={rows} cols={cols} />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <SeriesLegend items={series} className="mt-0" />
                <span className="text-caption text-muted">{ut("st.scaleNote")}</span>
              </div>
              <div className="grid gap-x-6 gap-y-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
                {groupsOf(rows).map((g) => (
                  <section key={g.head?.key ?? g.rows[0]?.key} aria-label={groupTitle(g.head, ut)}>
                    <h3 className="m-0 mb-2 flex items-center gap-2 border-b border-divider pb-2 text-[13.5px] font-extrabold leading-[18px] text-text">
                      {g.head ? <GroupHead row={g.head} /> : (
                        <>
                          <St.shieldAlert size={15} className="text-risk-ink" />
                          {ut("st.vshrLong")}
                        </>
                      )}
                    </h3>
                    <GroupedHBars
                      rows={g.rows.map((r) => ({
                        key: r.key,
                        label: <BarLabel row={r} />,
                        values: cols.map((c) => cellShare(cellAt(r, c))),
                      }))}
                      series={series}
                      max={100}
                      format={(v) => `${v} %`}
                      floor={floor}
                      hiddenWhy={<HiddenWhy floor={floor} />}
                      legend={false}
                    />
                  </section>
                ))}
                <section aria-label={ut("st.samplesPanel")}>
                  <h3 className="m-0 mb-2 flex items-center gap-2 border-b border-divider pb-2 text-[13.5px] font-extrabold leading-[18px] text-text">
                    <St.usersRound size={15} className="text-muted" />
                    {ut("st.samplesPanel")}
                  </h3>
                  <div className="flex flex-col">
                    {cols.map((c, i) => (
                      <div key={i} className="grid grid-cols-[22px_minmax(0,1fr)] gap-3 border-t border-divider py-2.5 text-small text-text-2 first:border-t-0 first:pt-0">
                        <SampleBadge n={i + 1} of={cols.length} />
                        <div className="min-w-0">
                          <b className="block font-extrabold text-text">{names[i]}</b>
                          <span className="block">
                            {ut("st.nEq")} <CountText cell={c.respondents} />
                            {c.highRisk ? (
                              <>
                                {", "}
                                {ut("st.withVshrLower")} <CountText cell={c.highRisk} />
                              </>
                            ) : null}
                          </span>
                          <span className="block">{criteriaWords(filtersOf(i), ut)}</span>
                          {c.note ? (
                            <span className="mt-1 flex items-start gap-1.5 text-muted">
                              <St.eyeOff size={13} className="mt-0.5 shrink-0" />
                              {c.note}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}
        </>
      )}
    </Panel>
  );
}

/** Строки отчёта группами: заголовок шкалы или вопроса и его строки; «ВШР» — своя группа без заголовка */
function groupsOf(rows: ReportRow[]): { head: ReportRow | null; rows: ReportRow[] }[] {
  const out: { head: ReportRow | null; rows: ReportRow[] }[] = [];
  for (const r of rows) {
    if (!isFigureRow(r)) out.push({ head: r, rows: [] });
    else if (r.kind === "risk") out.push({ head: null, rows: [r] });
    else out[out.length - 1]?.rows.push(r);
  }
  return out.filter((g) => g.rows.length);
}

function groupTitle(head: ReportRow | null, ut: ReturnType<typeof useLang>["ut"]): string {
  if (!head) return ut("st.vshrLong");
  if (head.kind === "scale") return head.title || head.code;
  if (head.kind === "question") return head.title;
  return "";
}

function GroupHead({ row }: { row: ReportRow }) {
  const { ut } = useLang();
  if (row.kind === "scale") {
    return (
      <>
        <span className="truncate font-bold">{row.title || row.code}</span>
      </>
    );
  }
  if (row.kind === "question") {
    return (
      <>
        {row.number ? <span>{ut("st.itemNo").replace("{n}", String(row.number))}</span> : null}
        <span className="truncate font-bold">{row.title}</span>
      </>
    );
  }
  return null;
}

/** Подпись строки полос: смуга словом тяжести, вариант с «ВШР», «Решта» */
function BarLabel({ row }: { row: ReportRow }): ReactNode {
  const { ut } = useLang();
  switch (row.kind) {
    case "band":
      return row.severity ? (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <SeverityTag level={row.severity} small>
            {row.label}
          </SeverityTag>
        </span>
      ) : (
        row.label
      );
    case "option":
      return (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className="truncate">{row.text}</span>
          {row.highRisk ? <VshrMark /> : null}
        </span>
      );
    case "rest":
      return ut("st.rest");
    case "risk":
      return ut("st.vshrRow");
    default:
      return null;
  }
}

/** Те же доли таблицей: сверять числа, печатать на монохромном принтере */
function ShareTable({ rows, cols }: { rows: ReportRow[]; cols: StatRunColumn[] }) {
  const { ut } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th scope="col" className="border-b border-divider bg-panel-2 px-3 py-2 text-left text-caption font-bold text-muted">
              {ut("st.indicator")}
            </th>
            {cols.map((_, i) => (
              <th key={i} scope="col" className="border-b border-divider bg-panel-2 px-3 py-2 text-right text-caption font-bold text-muted">
                {ut("st.sample")} {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            isFigureRow(r) ? (
              <tr key={r.key}>
                <th scope="row" className="border-b border-divider px-3 py-2 text-left font-normal text-text">
                  {r.kind === "band" ? r.label : r.kind === "option" ? r.text : r.kind === "rest" ? ut("st.rest") : ut("st.vshrRow")}
                </th>
                {cols.map((c, i) => (
                  <td key={i} className="border-b border-divider px-3 py-2 text-right font-bold tabular-nums text-text">
                    <CellText cell={cellAt(r, c)} />
                  </td>
                ))}
              </tr>
            ) : (
              <tr key={r.key}>
                <td colSpan={cols.length + 1} className="border-b border-divider bg-panel px-3 pb-1.5 pt-3 font-extrabold text-text">
                  {groupTitle(r, ut)}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────── окно «До яких вибірок застосувати пресет» ─────────── */

function ApplyPreset({
  preset,
  modelTitle,
  columns,
  names,
  presetTitleOf,
  filtersOf,
  result,
  onApply,
  onClose,
}: {
  preset: FilterPresetListItem;
  modelTitle: string;
  columns: StatModelColumn[];
  names: string[];
  presetTitleOf: (c: StatModelColumn) => string | null;
  filtersOf: (c: StatModelColumn) => SampleFilters;
  result: StatRunResult | null;
  onApply: (targets: number[], extra: boolean) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const [checked, setChecked] = useState<number[]>([]);
  const [extra, setExtra] = useState(false);
  const room = columns.length < MAX_SAMPLES;
  const count = checked.length + (extra ? 1 : 0);
  const toggle = (i: number) => setChecked((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i].sort()));
  const card = (on: boolean) =>
    cx(
      "m-0 flex cursor-pointer items-start gap-3 rounded-[12px] px-3.5 py-3",
      on ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--violet)]" : "bg-sunk hover:bg-sunk-2",
    );
  return (
    <Modal
      title={ut("st.applyTo")}
      sub={ut("st.applySub")}
      icon={<St.sliders />}
      width={640}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={<Ic.check />} disabled={!count} onClick={() => onApply(checked, extra)}>
            {ut("st.applyN").replace("{n}", String(count))}
          </Button>
          <Button onClick={onClose}>{ut("common.cancel")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pt-4">
        <Callout kind="violet" icon={<St.sliders />} title={preset.title}>
          <CriteriaChips filters={preset.criteria} className="mt-1.5" />
        </Callout>
        <div className="mb-1 mt-3 flex items-center justify-between gap-3">
          <b className="text-h3 font-extrabold text-text">{ut("st.modelSamples").replace("{title}", modelTitle)}</b>
          <Button variant="ghost" size="xs" onClick={() => setChecked(columns.map((_, i) => i))}>
            {ut("st.selectAll")}
          </Button>
        </div>
        {columns.map((c, i) => {
          const on = checked.includes(i);
          const current = presetTitleOf(c);
          const res = result?.columns[i];
          return (
            <label key={i} className={card(on)}>
              <Checkbox checked={on} onChange={() => toggle(i)} className="mt-0.5" />
              <SampleBadge n={i + 1} of={columns.length} />
              <span className="min-w-0 flex-1 text-small text-text-2">
                <span className="flex items-baseline gap-3">
                  <b className="min-w-0 flex-1 text-body font-extrabold text-text">
                    {ut("st.sample")} {i + 1}: {names[i]}
                  </b>
                  {res ? (
                    <span className="text-caption tabular-nums text-muted">
                      {ut("st.nEq")} <CountText cell={res.respondents} />
                    </span>
                  ) : null}
                </span>
                <span className="block">
                  {current
                    ? ut("st.presetQuoted").replace("{title}", current)
                    : `${ut("st.ownFilters")}: ${criteriaWords(filtersOf(c), ut)}`}
                </span>
                {on ? (
                  <ErrorText tone="warn" className="mt-1.5">
                    {current
                      ? ut("st.replacePreset").replace("{title}", current)
                      : ut("st.replaceOwn")}
                  </ErrorText>
                ) : null}
              </span>
            </label>
          );
        })}
        {room ? (
          <label
            className={cx(
              "m-0 mt-1 flex cursor-pointer items-start gap-3 rounded-[12px] px-3.5 py-3",
              extra ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--violet)]" : "shadow-[inset_0_0_0_1.5px_var(--ctl)] hover:bg-sunk",
            )}
          >
            <Checkbox checked={extra} onChange={() => setExtra((v) => !v)} className="mt-0.5" />
            <SampleBadge n={columns.length + 1} of={columns.length + 1} fresh />
            <span className="min-w-0 flex-1 text-small text-text-2">
              <b className="block text-body font-extrabold text-text">
                {ut("st.newSampleWith").replace("{n}", String(columns.length + 1))}
              </b>
              {ut("st.newSampleNote")
                .replace("{n}", String(columns.length + 1))
                .replace("{max}", String(MAX_SAMPLES))}
            </span>
          </label>
        ) : null}
        <p className="m-0 mt-2 flex items-start gap-1.5 text-small text-muted">
          <Ic.info size={14} className="mt-0.5 shrink-0" />
          <span>{ut("st.applyHint")}</span>
        </p>
      </div>
    </Modal>
  );
}
