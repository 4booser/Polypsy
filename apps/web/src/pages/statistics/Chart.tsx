import { useEffect, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { FilterPresetListItem, SampleFilters, StatModelColumn, StatRunResult } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { IconSearchGlass, Loading, isTopLayer, useAction, useFocusTrap } from "../../ui";
import { cx } from "../../ui/cx";
import { IconGear } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  CRITERION_LABEL,
  type Criterion,
  STATS_FILTERS,
  STATS_LIST,
  STATS_NEW,
  cellText,
  columnInput,
  columnsChanged,
  criteriaOf,
  criterionValue,
  describeSample,
  indicatorsOf,
  withoutCriteria,
} from "./model";
import { CellText } from "./parts";

/*
 * «Статистика» — кадр f24: пресеты по выборкам, «Оновити», перечень
 * моделей, диаграмма с легендой и «Керування фільтрами». Дверь сюда —
 * иконка «діаграма» строки заголовка f08; обратно — пункт «Керувати стат.
 * моделями» шестерёнки.
 *
 * Как прочитан кадр (у него нет подписей к действиям, и это решение, а не
 * буква):
 *
 *   строки «Пресет №124 [чипы]»   → выборки выбранной модели, по строке на
 *                                   колонку: имя пресета (или подпись колонки)
 *                                   и чипы её критериев. Чип — кнопка: нажатый
 *                                   (залитый) критерий участвует в расчёте,
 *                                   отпущенный (контур, как «Стать» у №124)
 *                                   на этот расчёт снят;
 *   «Оновити»                     → расчёт выбранной модели с тем, что сейчас
 *                                   на экране: нетронутая — POST /:id/run,
 *                                   с правками — превью без сохранения;
 *   пять строк моделей            → выбор модели (подсвечена выбранная);
 *                                   нажатие выбирает и сразу считает;
 *   столбики парами светлый/тёмный → доля по каждому показателю, светлый —
 *                                   первая выборка, тёмный — вторая;
 *   легенда                       → тест, модель, по каждой группе — выборка
 *                                   словами и доли по порядку столбиков;
 *   «Керування фільтрами»         → пресеты с поиском; нажатие открывает окно
 *                                   с флажками выборок — к каким применить
 *                                   пресет, «Застосувати / Скасувати»;
 *   шестерёнка                    → «Керувати фільтрами» (форма f23),
 *                                   «Керувати стат. моделями» (перечень f08),
 *                                   «Зберегти» (применённые пресеты и снятые
 *                                   чипы — в модель).
 *
 * Английские строки легенды («Example test», «Group 1: Males…») — наполнение
 * макета, а не текст интерфейса: здесь на их месте данные расчёта и слова
 * словаря. Чип «Населенный пункт» кадра набран с русской «ы» — опечатка
 * макета; чип подписан словом строки фильтра «Населений пункт».
 *
 * Скрытое сервером не рисуется столбиком вовсе: на его месте прочерк у
 * основания, в легенде — прочерк. Высота столбика — это число, и столбик
 * «примерно такой высоты» выдавал бы то, что сервер спрятал.
 */

/** Сколько моделей в перечне экрана — пять, как на кадре; остальные — в перечне f08 */
const SHOWN_MODELS = 5;

export default function StatChart() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();

  const models = useResource(() => api.statModels(), []);
  const presets = useResource(() => api.filterPresets(), []);
  const picked = params.get("model") ?? models.data?.items[0]?.id ?? null;
  const model = useResource(() => api.statModel(picked!), [picked], { enabled: !!picked });

  const [work, setWork] = useState<StatModelColumn[] | null>(null);
  const [off, setOff] = useState<Criterion[][]>([]);
  const [result, setResult] = useState<StatRunResult | null>(null);
  useEffect(() => {
    if (!model.data) return;
    setWork(model.data.columns);
    setOff(model.data.columns.map(() => []));
    setResult(null);
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

  const refresh = (cols = payload, id = picked, title = model.data?.title) =>
    void run(async () => {
      if (!cols || !id) return false;
      const same = model.data?.id === id && !columnsChanged(model.data.columns, cols);
      setResult(same ? await api.runStatModel(id) : await api.previewStatModel(cols.map(columnInput), title));
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

  const entries: MenuEntry[] = [
    { label: ut("st.manageFilters"), to: STATS_FILTERS },
    { label: ut("st.manageModels"), to: STATS_LIST },
    { label: ut("common.save"), onSelect: save, disabled: busy || !changed, hint: ut("st.nothingToSave") },
  ];

  const list = models.data?.items ?? [];
  const shown = list.slice(0, SHOWN_MODELS);
  /* выбранная модель за пятой строкой всё равно видна: иначе подсветка терялась бы */
  const selected = list.find((m) => m.id === picked);
  if (selected && !shown.includes(selected)) shown.push(selected);

  return (
    <Page
      title={ut("top.statistics")}
      snug
      tight
      actions={
        /*
          Шестерня f24: чернила 1365…1389 при правом крае колонки 1400 — 11
          от края; плашка 209 шириной, пункты 15/400 серым с шагом 30 (рамка
          #999999 1189…1397 × 151…245). Наезд плашки на глиф кадра не
          повторяется — по той же причине, что у формы рассылки (MailingEditor):
          это небрежность рисунка, а зазор каркаса не прячет знак меню.
        */
        <ActionMenu
          label={ut("st.menu")}
          glyph={<IconGear />}
          entries={entries}
          className="mr-[11px]"
          plateClassName="min-w-[209px]"
        />
      }
    >
      {models.error ? (
        <Loading error={models.error} onRetry={models.reload} />
      ) : !models.data ? (
        <Loading rows={6} />
      ) : list.length === 0 ? (
        <p className="m-0 mt-[34px] text-[15px] text-muted">
          {ut("st.empty")}.{" "}
          <Link to={STATS_NEW} className="font-bold text-primary">
            {ut("st.add")}
          </Link>
        </p>
      ) : (
        <>
          {/* строки выборок: чипы 30 высотой с шагом 40, первая строка 34 ниже заголовка (170 → 204) */}
          <div className="mt-[34px] flex flex-col gap-[10px]">
            {(work ?? []).map((c, i) => (
              <SampleLine
                key={i}
                label={presetOf(c)?.title ?? c.title ?? `${ut("st.sample")} ${i + 1}`}
                criteria={criteriaOf(baseOf(c))}
                filters={baseOf(c)}
                off={off[i] ?? []}
                onToggle={(k) =>
                  setOff((o) =>
                    o.map((list, j) => (j !== i ? list : list.includes(k) ? list.filter((x) => x !== k) : [...list, k])),
                  )
                }
              />
            ))}
          </div>
          {/* «Оновити» 215×45 правым краем по колонке — вплотную под строками (273 → 274) */}
          <div className="mt-[1px] flex justify-end">
            <Button size="md" className="w-[215px]" disabled={busy || !payload} onClick={() => refresh()}>
              {ut("st.refresh")}
            </Button>
          </div>

          <hr className="m-0 mt-[17px] h-[2px] border-0 bg-hairline" />

          {/* перечень моделей: строки 56, выбранная подсвечена #f7f5fa, как строка под курсором на кадре */}
          <ul aria-label={ut("st.listTitle")} className="m-0 mt-[3px] list-none p-0">
            {shown.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  aria-current={m.id === picked ? "true" : undefined}
                  onClick={() => {
                    pick(m.id);
                    setAutoRun(m.id);
                  }}
                  className={cx(
                    "flex h-[56px] w-full items-center border-0 p-0 text-left hover:bg-primary-tint",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                    m.id === picked ? "bg-primary-tint" : "bg-transparent",
                  )}
                >
                  {/* имя 20/700 в колонке 272 (204…476), описание 15/400 в две строки по 18 */}
                  <span
                    className={cx(
                      "w-[272px] shrink-0 truncate pl-[4px] pr-[24px]",
                      "text-[20px] font-bold leading-[24px] text-primary",
                    )}
                  >
                    {m.title}
                  </span>
                  <span className="line-clamp-2 min-w-0 flex-1 pr-[38px] text-[15px] leading-[18px] text-muted">
                    {m.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <hr className="m-0 mt-[61px] h-[2px] border-0 bg-hairline" />

          <Bars result={result} />
          <Legend result={result} />

          <FilterManagement
            presets={presets.data}
            columns={work ?? []}
            labelOf={(c, i) => presetOf(c)?.title ?? c.title ?? `${ut("st.sample")} ${i + 1}`}
            onApply={(presetId, targets) => {
              setWork((w) => w?.map((c, i) => (targets.includes(i) ? { ...c, presetId, filters: null } : c)) ?? w);
              setOff((o) => o.map((list, i) => (targets.includes(i) ? [] : list)));
            }}
          />
        </>
      )}
    </Page>
  );
}

/**
 * Строка выборки: имя 20/700 в колонке 148 (204…352) и чипы критериев.
 *
 * Чип — 30 высотой, 15/700, поля 8, радиус 5 (замер f24: «Віковий діапазон»
 * 361…515 × 222…251, текст с 369). Нажатый — заливка #f0ecff и фиолетовый,
 * отпущенный — контур #666666 и серый («Стать» у №124: рамка 701…759).
 * Область нажатия дотянута до 44 по высоте псевдоэлементом: строки стоят с
 * шагом 40, и соседние области перекрываются на 4 — лучше, чем промах мимо.
 *
 * Решение заказчика 2026-09-26: адекватные фильтры. Чип несёт и значение —
 * «Стать Чоловіки», «Віковий діапазон 25–45»: по одному имени критерия
 * нельзя было понять, кого именно отбирает выборка, не открывая пресет.
 * Значение набрано обычным начертанием после полужирного имени — имя
 * остаётся тем, что нажимают, значение — тем, что читают.
 */
function SampleLine({
  label,
  criteria,
  filters,
  off,
  onToggle,
}: {
  label: string;
  criteria: Criterion[];
  filters: SampleFilters;
  off: Criterion[];
  onToggle: (c: Criterion) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex min-h-[30px] items-center">
      <span className="w-[148px] shrink-0 truncate text-[20px] font-bold leading-[24px] text-primary">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-[10px]">
        {criteria.map((k) => {
          const on = !off.includes(k);
          const value = criterionValue(k, filters, ut);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              title={value ? `${ut(CRITERION_LABEL[k])}: ${value}` : undefined}
              onClick={() => onToggle(k)}
              className={cx(
                "relative flex h-[30px] items-center whitespace-nowrap rounded-[5px] px-[8px] text-[15px] font-bold",
                "after:absolute after:inset-x-0 after:top-1/2 after:h-[44px] after:-translate-y-1/2 after:content-['']",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                on ? "border-0 bg-primary-soft text-primary" : "border border-field-border bg-[var(--bg)] text-muted",
              )}
            >
              {ut(CRITERION_LABEL[k])}
              {value ? <span className="ml-[6px] max-w-[220px] truncate font-normal">{value}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Внутренняя высота поля диаграммы: рамка 704…1069, 364 между рамками */
const PLOT = 364;
/** Линии сетки: шесть, через 52 от основания (замер: 770, 823, 876, 929, 982, 1035 на кадре) */
const GRID = [1, 2, 3, 4, 5, 6].map((k) => k * 52);

/**
 * Поле диаграммы — рамка #666666 во всю колонку (200…1399), поля по 140 от
 * рамки до крайних столбиков, столбики по 178 (замер f24: 349…526, 603…779,
 * 857…1034, 1091…1268). При большем числе столбиков они сужаются, а поля
 * остаются.
 *
 * Высота столбика — доля от 0 до 100% по всей высоте поля. Цвета — первая
 * выборка #f0ecff (--primary-soft), вторая #b299cc (--primary-rule, цвет
 * замера, а не текстовая ступень); третья и дальше чередуются.
 */
function Bars({ result }: { result: StatRunResult | null }) {
  const { ut } = useLang();
  const cols = result?.columns ?? [];
  const keys = cols[0] ? indicatorsOf(cols[0]) : [];
  const bars = keys.flatMap((ind) =>
    cols.map((col, i) => ({
      key: `${ind.key}:${i}`,
      label: ind.label,
      group: i,
      cell: indicatorsOf(col).find((x) => x.key === ind.key)?.cell ?? null,
    })),
  );
  const width = bars.length ? Math.min(178, Math.floor((920 - (bars.length - 1) * 12) / bars.length)) : 178;
  return (
    <div
      role="img"
      aria-label={ut("st.chartLabel")}
      className="relative mt-[22px] h-[366px] rounded-[5px] border border-field-border"
    >
      {GRID.map((y) => (
        <div
          key={y}
          aria-hidden
          className="absolute inset-x-0 h-[2px] bg-[color-mix(in_srgb,var(--hairline)_50%,transparent)]"
          style={{ bottom: y }}
        />
      ))}
      <div className="absolute inset-y-0 left-[139px] right-[139px] flex items-end justify-between">
        {bars.map((b) => (
          <div key={b.key} className="relative flex h-full flex-col justify-end" style={{ width }}>
            {b.cell && !b.cell.suppressed ? (
              <div
                title={`${ut("st.group")} ${b.group + 1} · ${b.label}: ${cellText(b.cell)}`}
                className={cx("rounded-t-[3px]", b.group % 2 === 0 ? "bg-primary-soft" : "bg-primary-rule")}
                style={{ height: Math.round((b.cell.percent / 100) * PLOT) }}
              />
            ) : b.cell ? (
              <span aria-hidden title={ut("st.hidden")} className="pb-[4px] text-center text-[15px] font-bold text-muted">
                {cellText(b.cell)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Легенда — рамка #666666 208 высотой (1095…1302), текст 15/20 фиолетовым с
 * 40 от рамки: тест и модель полужирным, затем по группе в колонку 235 —
 * «Група N:» полужирным, выборка словами с основанием, доли по порядку
 * столбиков через запятую (замер f24: строки 1124, 1144, 1172, 1192, 1213).
 */
function Legend({ result }: { result: StatRunResult | null }) {
  const { ut } = useLang();
  const cols = result?.columns ?? [];
  return (
    <div
      className={cx(
        "mt-[25px] min-h-[208px] rounded-[5px] border border-field-border px-[39px] pb-[20px] pt-[7px]",
        "text-[15px] leading-[20px] text-primary",
      )}
    >
      {result ? (
        <>
          <p className="m-0 font-bold">{cols[0]?.surveyTitle}</p>
          <p className="m-0 font-bold">{result.title}</p>
          <div className="mt-[8px] flex flex-wrap gap-x-[40px] gap-y-[12px]">
            {cols.map((c, i) => (
              <div key={i} className="w-[195px]">
                <p className="m-0 font-bold">
                  {ut("st.group")} {i + 1}:
                </p>
                <p className="m-0">
                  {describeSample(c.filters, ut)}, n&nbsp;=&nbsp;
                  <CellText cell={c.respondents} />
                </p>
                <p className="m-0">
                  {indicatorsOf(c).map((ind, k) => (
                    <span key={ind.key}>
                      {k ? ", " : ""}
                      <span className="sr-only">{ind.label}: </span>
                      <CellText cell={ind.cell} />
                    </span>
                  ))}
                </p>
                {c.note ? <p className="m-0 text-[13px] leading-[18px] text-muted">{c.note}</p> : null}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="m-0 text-muted">{ut("st.chartEmpty")}</p>
      )}
    </div>
  );
}

/**
 * «Керування фільтрами» — пресеты с поиском и окно применения.
 *
 * Замер f24: заголовок 24/700; рамка #666666 во всю колонку, поиск 28
 * высотой в 7 от рамки с лупой слева; пресеты 15/400 серым с шагом 30.
 * Окно — 585 шириной, в 604 от левой рамки и 43 от верхней (под поиском),
 * рамка #999999 с тенью: флажки 16 с шагом 30, «Застосувати» — плашка
 * #f0ecff 135×25 слева, «Скасувати» — текстом справа.
 *
 * Флажки окна — выборки модели: к каким из них применить нажатый пресет.
 * Отвергнуто: флажки критериев пресета («Вибір 1…5» кадра — пять, как
 * пять строк фильтра) — снять критерий на этот расчёт уже умеет чип
 * строки выборки, и два места для одного действия разошлись бы.
 */
function FilterManagement({
  presets,
  columns,
  labelOf,
  onApply,
}: {
  presets: FilterPresetListItem[] | null;
  columns: StatModelColumn[];
  labelOf: (c: StatModelColumn, i: number) => string;
  onApply: (presetId: string, targets: number[]) => void;
}) {
  const { ut } = useLang();
  const [q, setQ] = useState("");
  const [openFor, setOpenFor] = useState<FilterPresetListItem | null>(null);
  const found = (presets ?? []).filter((p) => p.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section aria-labelledby="st-manage">
      <h2 id="st-manage" className="m-0 mt-[41px] text-[24px] font-bold leading-tight text-primary">
        {ut("st.filterManagement")}
      </h2>
      <div className="relative mt-[31px] min-h-[228px] rounded-[5px] border border-field-border px-[7px] pb-[6px] pt-[7px]">
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-[1px] top-1/2 -translate-y-1/2 text-text [&>svg]:size-[24px]"
          >
            <IconSearchGlass />
          </span>
          <input
            aria-label={ut("st.presetSearch")}
            value={q}
            maxLength={200}
            onChange={(e) => setQ(e.target.value)}
            className={cx(
              "h-[28px] w-full rounded-[5px] border border-field-border bg-[var(--bg)] pl-[30px] pr-[8px] text-[15px] text-text",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            )}
            autoComplete="off"
          />
        </div>
        <ul className="m-0 mt-[5px] list-none p-0">
          {found.length === 0 ? (
            <li className="flex h-[30px] items-center px-[1px] text-[15px] text-muted">{ut("st.noPresets")}</li>
          ) : (
            found.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={openFor?.id === p.id}
                  onClick={() => setOpenFor(p)}
                  disabled={!columns.length}
                  className={cx(
                    "flex h-[30px] w-full items-center border-0 bg-transparent px-[1px] text-left text-[15px] font-normal text-muted",
                    "hover:bg-primary-tint hover:text-primary disabled:opacity-45",
                    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  )}
                >
                  <span className="truncate">{p.title}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        {openFor ? (
          <ApplyWindow
            preset={openFor}
            options={columns.map((c, i) => labelOf(c, i))}
            onApply={(targets) => {
              onApply(openFor.id, targets);
              setOpenFor(null);
            }}
            onClose={() => setOpenFor(null)}
          />
        ) : null}
      </div>
    </section>
  );
}

/** Окно применения пресета: флажки выборок, «Застосувати» / «Скасувати» */
function ApplyWindow({
  preset,
  options,
  onApply,
  onClose,
}: {
  preset: FilterPresetListItem;
  options: string[];
  onApply: (targets: number[]) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const id = useId();
  const [checked, setChecked] = useState<number[]>(options.map((_, i) => i));
  const ref = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);
  /* область нажатия кнопок окна — 44 по высоте псевдоэлементом: плашка на кадре 25 */
  const reach =
    "relative after:absolute after:inset-x-0 after:top-1/2 after:h-[44px] after:-translate-y-1/2 after:content-['']";
  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-40" />
      <div
        ref={ref}
        role="dialog"
        aria-labelledby={id}
        tabIndex={-1}
        className={cx(
          "absolute left-[603px] top-[42px] z-50 w-[585px] max-w-[calc(100%-16px)] max-[1260px]:left-[8px]",
          "rounded-[5px] border border-border-strong bg-[var(--bg)] px-[16px] py-[12px] shadow-pop",
        )}
      >
        <p id={id} className="sr-only">
          {ut("st.applyTo")}: {preset.title}
        </p>
        <ul className="m-0 list-none p-0">
          {options.map((label, i) => (
            <li key={i}>
              <label className="flex h-[30px] cursor-pointer items-center gap-[6px] text-[15px] text-muted">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={checked.includes(i)}
                  onChange={(e) => setChecked((c) => (e.target.checked ? [...c, i] : c.filter((x) => x !== i)))}
                />
                {/* флажок кадра: рамка #cccccc 16, внутри квадрат 8 фиолетовым */}
                <span
                  aria-hidden
                  className={cx(
                    "relative flex size-[16px] shrink-0 items-center justify-center rounded-[2px] border border-hairline",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus)]",
                  )}
                >
                  {checked.includes(i) ? <span className="size-[8px] rounded-[1px] bg-primary" /> : null}
                </span>
                <span className="truncate">{label}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-[4px] flex items-center justify-between">
          <button
            type="button"
            disabled={!checked.length}
            onClick={() => onApply(checked)}
            className={cx(
              reach,
              "flex h-[25px] w-[135px] items-center justify-center rounded-[5px] border-0 bg-primary-soft text-[15px] font-bold text-primary",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-45",
            )}
          >
            {ut("st.apply")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className={cx(
              reach,
              "h-[25px] border-0 bg-transparent px-[4px] text-[15px] font-bold text-primary",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            )}
          >
            {ut("common.cancel")}
          </button>
        </div>
      </div>
    </>
  );
}
