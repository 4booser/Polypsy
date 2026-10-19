import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  FilterPresetListItem,
  PatientGroupWithCounts,
  SampleFilters,
  StatCell,
  StatModelColumn,
  StatRunColumn,
  StatRunResult,
  SurveyFull,
} from "@quizzy/shared";
import { api } from "../../api";
import { timeOfDay } from "../../format";
import { useLang } from "../../lang";
import {
  Callout,
  Drawer,
  DrawerPane,
  DrawerSection,
  Ic,
  KV,
  Loading,
  Modal,
  Tooltip,
  useAction,
  useToast,
} from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel } from "../../ui/layout";
import { ActionMenu } from "../../ui/menu";
import {
  Button,
  ButtonLink,
  Field,
  Input,
  SectionLabel,
  Segmented,
  Select,
  SeverityTag,
  Tag,
} from "../../ui/primitives";
import { useResource } from "../../useResource";
import { useSurveyAt } from "./data";
import {
  MAX_SAMPLES,
  type ReportRow,
  STATS_LIST,
  type SampleDraft,
  type Samples,
  addKeyed,
  cellAt,
  chartHref,
  columnInput,
  columnsChanged,
  diffText,
  duplicateKeyed,
  editSampleDraft,
  filterErrors,
  isFigureRow,
  keepDrafts,
  keyedSamples,
  removeKeyed,
  reportRows,
  sampleDraft,
  sampleDraftChanged,
  sampleKey,
  statEditHref,
  statHref,
  withSampleDraft,
} from "./model";
import {
  AgeFields,
  CriteriaChips,
  GroupSelect,
  HiddenCell,
  LocalityInput,
  PatientField,
  PeriodFields,
  SampleBadge,
  SexField,
  SourceTag,
  St,
  VshrToggle,
  sampleColor,
  useSampleName,
} from "./parts";

/*
 * Статистична модель — дизайн statistics-model: выборки рядом и
 * «Порівняти».
 *
 * Шапка: «Додати вибірку», «Змінити показники» (редактор), меню (график,
 * копия модели, удаление) и «Порівняти» — Ctrl/⌘ + Enter. «Зберегти»
 * появляется, только пока выборки или пометки «ВШР» изменены против
 * сохранённых: расчёт по правленой модели идёт превью (POST
 * /api/stat-models/run) и ничего не сохраняет — «сохранил, потому что
 * хотел посмотреть» случаться не должно.
 *
 * Полоса состояния под шапкой говорит, когда посчитано и как, и выбирает
 * опорную выборку разности («Різниця від»). Таблица: строки — показатели
 * (полосы шкал, варианты ответов, «Решта», «Респонденти з ВШР»), колонки —
 * выборки. В шапке колонки — номер на цвете ряда, имя, чипы критериев, чем
 * отобрана, основание и «ВШР». Фильтры выборки — в ящике справа: страница
 * остаётся на месте, набранное в ящике переживает Esc.
 *
 * Скрытая сервером ячейка — пунктирный прочерк с объяснением по наведению;
 * числа в ней нет и разности с ней нет (diffText). Результат живёт до первой
 * правки: доли рядом с изменёнными фильтрами печатали бы ответ на вопрос,
 * которого на экране уже нет.
 */

export default function StatModelPage() {
  const { id } = useParams<{ id: string }>();
  /* ключ: переход между моделями не должен оставлять в полях чужую выборку */
  return <ModelScreen key={id} id={id!} />;
}

function ModelScreen({ id }: { id: string }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const toast = useToast();
  const sampleName = useSampleName();
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const model = useResource(() => api.statModel(id), [id], { manual: true });
  const groups = useResource(() => api.patientGroups(), []);
  const presets = useResource(() => api.filterPresets(), []);

  const [saved, setSaved] = useState<StatModelColumn[] | null>(null);
  const [work, setWork] = useState<StatModelColumn[] | null>(null);
  /* ключ выборки — по одному на колонку work (model.ts, Samples): черновик ящика держится за выборку, а не за номер */
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!model.data) return;
    const s = keyedSamples(model.data.columns);
    setSaved(model.data.columns);
    setWork(s.columns);
    setKeys(s.keys);
  }, [model.data]);

  const [result, setResult] = useState<StatRunResult | null>(null);
  const [ref, setRef] = useState(0);
  /* ящик фильтров: открыт ли и чья выборка; черновики — по ключу выборки */
  const [drawer, setDrawer] = useState<{ open: boolean; key: string | null }>({ open: false, key: null });
  const [drafts, setDrafts] = useState<Record<string, SampleDraft>>({});
  /*
   * «Повернутися» в сообщении о черновике зовёт обработчик, замкнутый в
   * момент закрытия ящика; живы ли выборки — спрашивается у текущих ключей.
   */
  const keysNow = useRef<string[]>(keys);
  keysNow.current = keys;
  const [doomed, setDoomed] = useState(false);

  /* Ctrl/⌘ + Enter — «Порівняти» с любого места экрана, и из поля тоже; пока модель грузится — ничего */
  const [compareRef] = useState<{ current: () => void }>(() => ({ current: () => {} }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        compareRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [compareRef]);

  /*
   * Пресеты — до первого показа: у выборки с пресетом поля показывают его
   * критерии, и правка раньше их приезда начиналась бы с пустого места —
   * то есть молча выбрасывала бы критерии пресета из выборки.
   */
  const waiting = !presets.data && !presets.error;
  if (model.error || !model.data || !work || !saved || waiting) {
    return (
      <Page title={ut("top.statistics")} back={{ to: STATS_LIST, label: ut("st.backToList") }}>
        {model.error ? (
          <div className="flex flex-col items-start gap-3">
            <Loading error={model.error} onRetry={model.reload} />
            <Link to={STATS_LIST} className="text-body font-bold text-violet-ink">
              {ut("st.backToList")}
            </Link>
          </div>
        ) : (
          <Loading rows={6} />
        )}
      </Page>
    );
  }

  const title = model.data.title;
  const dirty = columnsChanged(saved, work);
  const presetOf = (c: StatModelColumn) => (c.presetId ? presets.data?.find((p) => p.id === c.presetId) : undefined);
  const criteriaOfPreset = (pid: string) => presets.data?.find((p) => p.id === pid)?.criteria;
  const filtersOf = (c: StatModelColumn): SampleFilters => (c.presetId ? (presetOf(c)?.criteria ?? {}) : (c.filters ?? {}));
  const nameOf = (c: StatModelColumn, i: number) => sampleName(c.title, presetOf(c)?.title, i);
  const refAt = Math.min(ref, work.length - 1);

  /*
   * Правка колонок сбрасывает расчёт. Черновики ящика держатся за выборку:
   * добавление, дубль и удаление соседей их не трогают, у убранной выборки
   * черновик уходит вместе с ней.
   */
  const samples: Samples = { columns: work, keys };
  const edit = (next: Samples) => {
    setWork(next.columns);
    setKeys(next.keys);
    setResult(null);
    setDrafts((d) => keepDrafts(d, next.keys));
  };

  /*
   * Перевёрнутый диапазон в любой выборке — причина сообщением, без
   * запроса: сервер отказал бы строкой схемы.
   */
  const problem = (): boolean => {
    const key = work.flatMap((c) => filterErrors(filtersOf(c)))[0];
    if (key) toast(ut(key), "err");
    return !!key;
  };

  const compare = () =>
    void run(async () => {
      if (problem()) return false;
      /* правленая выборка — превью; нетронутая — расчёт сохранённой модели, с её id в журнале */
      setResult(dirty ? await api.previewStatModel(work.map(columnInput), title) : await api.runStatModel(id));
    });
  compareRef.current = compare;

  const save = () =>
    void run(async () => {
      if (problem()) return false;
      const next = await api.updateStatModel(id, { columns: work.map(columnInput) });
      setSaved(next.columns);
      setWork(next.columns);
      /* сервер возвращает те же колонки тем же порядком; иначе прежние ключи и черновики к ним не относятся */
      if (next.columns.length !== keys.length) {
        setKeys(keyedSamples(next.columns).keys);
        setDrafts({});
      }
    }, ut("st.saved"));

  const duplicate = () =>
    void run(async () => {
      const copy = await api.createStatModel({
        title: ut("st.copyTitle").replace("{title}", title).slice(0, 200),
        description: model.data?.description ?? null,
        columns: work.map(columnInput),
      });
      toast(ut("st.copied"), "ok");
      navigate(statHref(copy.id));
    });

  const remove = () =>
    void run(async () => {
      await api.deleteStatModel(id);
      toast(ut("st.deleted"), "ok");
      navigate(STATS_LIST, { replace: true });
    });

  /* «ВШР» — у одного и того же варианта во всех выборках: показатели модели одни на все колонки */
  const toggleRisk = (questionId: string, optionId: string) => {
    const now = work
      .flatMap((c) => c.questions)
      .find((q) => q.questionId === questionId)
      ?.options.find((o) => o.optionId === optionId)?.highRisk;
    edit({
      columns: work.map((c) => ({
        ...c,
        questions: c.questions.map((q) =>
          q.questionId !== questionId
            ? q
            : { ...q, options: q.options.map((o) => (o.optionId === optionId ? { ...o, highRisk: !now } : o)) },
        ),
      })),
      keys,
    });
  };

  const openPane = (i: number) => {
    const key = keys[i];
    if (!key) return;
    setDrafts((d) => (d[key] ? d : { ...d, [key]: sampleDraft(work[i]!, criteriaOfPreset) }));
    setDrawer({ open: true, key });
  };
  const add = () => {
    const key = sampleKey();
    const next = addKeyed(samples, key);
    if (next === samples) return;
    edit(next);
    setDrafts((d) => ({ ...d, [key]: sampleDraft(next.columns[next.columns.length - 1]!, criteriaOfPreset) }));
    setDrawer({ open: true, key });
  };
  /* «Застосувати» — к той выборке, чей это ящик: по ключу, а не по номеру, который мог смениться */
  const applyDraft = (key: string) => {
    const d = drafts[key];
    const at = keys.indexOf(key);
    if (!d || at < 0) return;
    edit({ columns: work.map((c, j) => (j === at ? withSampleDraft(c, d) : c)), keys });
    setDrafts(({ [key]: _gone, ...rest }) => rest);
    setDrawer((s) => ({ ...s, open: false }));
  };
  const dropDraft = (key: string) => {
    setDrafts(({ [key]: _gone, ...rest }) => rest);
    setDrawer((s) => ({ ...s, open: false }));
  };

  const ranAt = result ? timeOfDay(result.ranAt) : null;
  const head = result?.columns[0];

  return (
    <Page
      title={title}
      back={{ to: STATS_LIST, label: ut("sn.statModels") }}
      actions={
        <>
          <Tooltip
            label={ut("st.addSampleTip")
              .replace("{n}", String(work.length))
              .replace("{max}", String(MAX_SAMPLES))}
          >
            <Button icon={<Ic.plus />} onClick={add} disabled={work.length >= MAX_SAMPLES}>
              {ut("st.addSampleShort")}
            </Button>
          </Tooltip>
          <ButtonLink to={statEditHref(id)}>
            <St.pencil />
            {ut("st.editIndicators")}
          </ButtonLink>
          <ActionMenu
            triggerSize="icon"
            entries={[
              { label: ut("sn.chart"), to: chartHref(id), icon: <St.chartColumn size={15} /> },
              { label: ut("st.duplicateModel"), onSelect: duplicate, icon: <St.copy size={15} />, disabled: busy },
              {
                label: ut("st.deleteModel"),
                onSelect: () => setDoomed(true),
                danger: true,
                ruled: true,
                icon: <St.trash size={15} />,
              },
            ]}
          />
          {dirty ? (
            <Button icon={<St.save />} disabled={busy} onClick={save}>
              {ut("common.save")}
            </Button>
          ) : null}
          <Tooltip label={ut("st.compare")} kbd="Ctrl Enter">
            <Button variant="primary" icon={<St.play />} disabled={busy} onClick={compare}>
              {ut("st.compare")}
            </Button>
          </Tooltip>
        </>
      }
    >
      {/* полоса состояния: когда и как посчитано, от какой выборки разность */}
      <section
        aria-label={ut("st.runState")}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-border bg-panel px-3.5 py-2.5 shadow-panel"
      >
        <div role="status" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
          {result ? (
            <>
              <Ic.circleCheck size={17} className="text-good" />
              <b className="font-extrabold text-text">{ut("st.ranAt").replace("{t}", ranAt ?? "")}</b>
              <span className="text-small text-text-2">
                {head ? `${head.surveyTitle}, ${ut("st.versionN").replace("{n}", String(head.versionNumber))}. ` : ""}
                {result.modelId ? ut("st.ranSaved") : ut("st.ranPreview")}
              </span>
            </>
          ) : (
            <>
              <Ic.info size={17} className="text-muted" />
              <span className="text-small text-text-2">
                {ut("st.percentPending")}
                {dirty ? `. ${ut("st.unsaved")}` : ""}
              </span>
            </>
          )}
        </div>
        {work.length > 1 ? (
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-small text-muted">{ut("st.diffFrom")}</span>
            <Segmented
              label={ut("st.diffFrom")}
              value={String(refAt)}
              onChange={(k) => setRef(Number(k))}
              items={work.map((_, i) => ({
                key: String(i),
                label: (
                  <>
                    <SampleBadge n={i + 1} of={work.length} small />
                    <span className="sr-only">
                      {ut("st.sample")} {i + 1}
                    </span>
                  </>
                ),
              }))}
            />
          </div>
        ) : null}
        <ButtonLink to={chartHref(id)} size="xs">
          <St.chartColumn />
          {ut("sn.chart")}
        </ButtonLink>
      </section>

      <Panel flush className="mt-4">
        <Comparison
          columns={work}
          result={result}
          refAt={refAt}
          filtersOf={filtersOf}
          nameOf={nameOf}
          presetTitleOf={(c) => presetOf(c)?.title ?? null}
          onOpen={openPane}
          onDuplicate={(i) => edit(duplicateKeyed(samples, i, sampleKey()))}
          onRemove={(i) => {
            edit(removeKeyed(samples, i));
            setDrawer((s) => ({ ...s, open: false }));
          }}
          onRisk={toggleRisk}
        />
      </Panel>

      <Panel title={ut("st.readTitle")} icon={<St.book />} className="mt-4">
        <KV
          w={150}
          rows={[
            [ut("st.readWho"), ut("st.readWhoText")],
            [ut("st.readPercent"), ut("st.readPercentText")],
            [ut("st.readDash"), ut("st.readDashText")],
            [ut("st.vshr"), ut("st.readVshrText")],
          ]}
        />
      </Panel>

      <Drawer
        open={drawer.open}
        mode={drawer.key ? `p:${drawer.key}` : undefined}
        onClose={() => setDrawer((s) => ({ ...s, open: false }))}
        onReturn={(mode) => {
          const key = mode?.startsWith("p:") ? mode.slice(2) : null;
          /*
           * Выборку убрали, пока висело «Повернутися», — возвращаться некуда:
           * ящик открыл бы свой первый вид, то есть чужую выборку.
           */
          if (key && keysNow.current.includes(key)) setDrawer({ open: true, key });
        }}
      >
        {work.map((c, i) => {
          const key = keys[i] ?? `i${i}`;
          const d = drafts[key] ?? sampleDraft(c, criteriaOfPreset);
          const changed = sampleDraftChanged(c, d);
          const bad = filterErrors(d.filters).length > 0;
          return (
            <DrawerPane
              key={key}
              mode={`p:${key}`}
              title={ut("st.samplePaneTitle").replace("{n}", String(i + 1))}
              sub={nameOf(c, i)}
              icon={<St.sliders />}
              dirty={changed}
              draftName={ut("st.samplePaneDraft").replace("{n}", String(i + 1))}
              note={ut("st.recountNote")}
              noteIcon={<Ic.refresh />}
              footer={
                <>
                  <Button
                    variant="primary"
                    icon={<Ic.check />}
                    disabled={!changed || bad}
                    onClick={() => applyDraft(key)}
                  >
                    {ut("st.apply")}
                  </Button>
                  <Button onClick={() => dropDraft(key)}>{ut("common.cancel")}</Button>
                </>
              }
            >
              <SamplePane
                index={i}
                draft={d}
                presets={presets.data ?? []}
                groups={groups.data}
                onChange={(next) => setDrafts((all) => ({ ...all, [key]: next }))}
              />
            </DrawerPane>
          );
        })}
      </Drawer>

      {doomed ? (
        <Modal
          title={ut("st.deleteConfirm")}
          sub={ut("st.cannotUndo")}
          icon={<St.trash />}
          tone="warn"
          onClose={() => setDoomed(false)}
          footer={
            <>
              <Button variant="primary" icon={<St.trash />} disabled={busy} onClick={remove}>
                {ut("st.deleteModel")}
              </Button>
              <Button onClick={() => setDoomed(false)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <p className="m-0 pt-3.5 text-body text-text-2">{ut("st.deleteText").replace("{title}", title)}</p>
        </Modal>
      ) : null}
    </Page>
  );
}

/* ─────────── ящик выборки ─────────── */

function SamplePane({
  index,
  draft,
  presets,
  groups,
  onChange,
}: {
  index: number;
  draft: SampleDraft;
  presets: FilterPresetListItem[];
  groups: PatientGroupWithCounts[] | null;
  onChange: (next: SampleDraft) => void;
}) {
  const { ut } = useLang();
  const f = draft.filters;
  const preset = draft.presetId ? presets.find((p) => p.id === draft.presetId) : undefined;
  const patch = (p: Partial<SampleFilters>) => onChange(editSampleDraft(draft, p));
  return (
    <>
      <DrawerSection>
        <Field label={ut("st.sampleName")} hint={ut("st.sampleNameHint")}>
          <Input
            data-autofocus
            value={draft.title}
            maxLength={120}
            placeholder={`${ut("st.sample")} ${index + 1}`}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </Field>
        <Field label={ut("st.presetField")}>
          <Select
            value={draft.presetId ?? ""}
            onChange={(e) => {
              const pid = e.target.value || null;
              const crit = pid ? presets.find((p) => p.id === pid)?.criteria : undefined;
              onChange({ ...draft, presetId: pid, filters: pid ? (crit ?? {}) : draft.filters });
            }}
          >
            <option value="">{ut("st.ownFilters")}</option>
            {/* пресет, которого больше нет в списке, остаётся выбранным строкой, а не исчезает молча */}
            {draft.presetId && !preset ? <option value={draft.presetId}>{ut("st.presetGone")}</option> : null}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        </Field>
        {preset ? (
          <Callout kind="violet" icon={<St.sliders />}>
            {ut("st.presetPaneNote").replace("{title}", preset.title)}
          </Callout>
        ) : (
          <Callout kind="line">{ut("st.ownPaneNote")}</Callout>
        )}
      </DrawerSection>
      <DrawerSection title={ut("st.conditions")} sub={ut("st.conditionsSub")}>
        <div className="flex flex-col gap-3.5">
          <PeriodFields from={f.from} to={f.to} onChange={(p) => patch(p)} />
          <div>
            <SectionLabel className="mb-1.5">
              {ut("st.patient")}
              <span className="font-medium"> — {ut("kit.optional")}</span>
            </SectionLabel>
            <PatientField label={ut("st.patient")} value={f.patientId} onChange={(patientId) => patch({ patientId })} />
          </div>
          <AgeFields min={f.ageMin} max={f.ageMax} onChange={(p) => patch(p)} />
          <Field label={ut("st.group")} className="mb-0">
            <GroupSelect value={f.patientGroupId} groups={groups} onChange={(patientGroupId) => patch({ patientGroupId })} />
          </Field>
          <div>
            <SectionLabel className="mb-1.5">{ut("person.sex")}</SectionLabel>
            <SexField value={f.sex} onChange={(sex) => patch({ sex })} />
          </div>
          <Field label={ut("st.locality")} hint={ut("st.localityHint")} className="mb-0">
            <LocalityInput value={f.locality} onChange={(locality) => patch({ locality })} />
          </Field>
        </div>
      </DrawerSection>
    </>
  );
}

/* ─────────── таблица сравнения ─────────── */

function Comparison({
  columns,
  result,
  refAt,
  filtersOf,
  nameOf,
  presetTitleOf,
  onOpen,
  onDuplicate,
  onRemove,
  onRisk,
}: {
  columns: StatModelColumn[];
  result: StatRunResult | null;
  refAt: number;
  filtersOf: (c: StatModelColumn) => SampleFilters;
  nameOf: (c: StatModelColumn, i: number) => string;
  presetTitleOf: (c: StatModelColumn) => string | null;
  onOpen: (i: number) => void;
  onDuplicate: (i: number) => void;
  onRemove: (i: number) => void;
  onRisk: (questionId: string, optionId: string) => void;
}) {
  const { ut } = useLang();
  /*
   * Версии методик — две загрузки на весь экран, а не по одной на колонку:
   * показатели у колонок модели одни, и восьмая колонка той же версии не
   * должна тянуть её восьмой раз. Вторая — на случай модели, собранной мимо
   * редактора, где колонки разошлись.
   */
  const head = columns[0]!;
  const other = columns.find((c) => c.surveyId !== head.surveyId || c.versionId !== head.versionId) ?? null;
  const surveyA = useSurveyAt(head.surveyId, head.versionId);
  const surveyB = useSurveyAt(other?.surveyId ?? null, other?.versionId ?? null);
  const surveyOf = (c: StatModelColumn): SurveyFull | null | undefined =>
    c.surveyId === head.surveyId && c.versionId === head.versionId ? surveyA : surveyB;
  const rows = reportRows(columns, surveyOf, result?.columns);
  const n = columns.length;
  const floor = result?.smallCellFloor ?? 5;

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full table-fixed border-separate border-spacing-0 text-[13px] leading-[18px]"
        style={{ minWidth: 236 + n * 224 }}
      >
        <colgroup>
          <col style={{ width: 236 }} />
          {columns.map((_, i) => (
            <col key={i} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="whitespace-normal border-b border-divider bg-panel-2 px-4 py-3.5 text-left align-top font-medium text-text-2">
              <b className="block text-h3 font-extrabold text-text">{ut("st.indicator")}</b>
              <p className="m-0 mt-1 text-small">{ut("st.sameForAll")}</p>
              {n > 1 ? (
                <p className="m-0 mt-2 text-small text-muted">{ut("st.diffNote").replace("{n}", String(refAt + 1))}</p>
              ) : null}
            </th>
            {columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className="whitespace-normal border-b border-l border-divider bg-panel-2 px-3.5 py-3.5 text-left align-top font-medium text-text-2"
              >
                <SampleHead
                  index={i}
                  of={n}
                  name={nameOf(c, i)}
                  filters={filtersOf(c)}
                  preset={presetTitleOf(c)}
                  res={result?.columns[i]}
                  floor={floor}
                  onOpen={() => onOpen(i)}
                  onDuplicate={n < MAX_SAMPLES ? () => onDuplicate(i) : undefined}
                  onRemove={n > 1 ? () => onRemove(i) : undefined}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            isFigureRow(row) ? (
              <tr key={row.key} className={cx("group/r", row.kind === "risk" && "bg-panel-2")}>
                <th
                  scope="row"
                  className="whitespace-normal border-b border-divider px-4 py-2.5 text-left align-middle font-normal group-hover/r:bg-panel-2"
                >
                  <RowLabel row={row} onRisk={onRisk} />
                </th>
                {columns.map((_, j) => (
                  <td key={j} className="border-b border-l border-divider px-3.5 py-2.5 align-top group-hover/r:bg-panel-2">
                    <Share
                      cell={cellAt(row, result?.columns[j])}
                      base={result?.columns[j]?.respondents}
                      against={j === refAt ? undefined : cellAt(row, result?.columns[refAt])}
                      color={sampleColor(j, n)}
                      floor={floor}
                      ran={!!result}
                    />
                  </td>
                ))}
              </tr>
            ) : (
              <tr key={row.key}>
                <td colSpan={n + 1} className="border-b border-divider bg-panel px-4 py-3">
                  <GroupLabel row={row} />
                </td>
              </tr>
            ),
          )}
          {result ? (
            <tr>
              <th scope="row" className="whitespace-normal bg-panel-2 px-4 py-3 text-left align-top text-small font-medium text-muted">
                {ut("st.serverNotes")}
              </th>
              {result.columns.map((c, j) => (
                <td key={j} className="border-l border-divider bg-panel-2 px-3.5 py-3 align-top text-small text-text-2">
                  <span className="flex items-start gap-1.5">
                    {c.note ? (
                      <St.eyeOff size={14} className="mt-0.5 text-muted" />
                    ) : (
                      <Ic.circleCheck size={14} className="mt-0.5 text-good" />
                    )}
                    <span>{c.note ?? ut("st.allShown")}</span>
                  </span>
                </td>
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** Шапка колонки выборки: номер, имя, фильтры в ящике, меню, критерии, основание */
function SampleHead({
  index,
  of,
  name,
  filters,
  preset,
  res,
  floor,
  onOpen,
  onDuplicate,
  onRemove,
}: {
  index: number;
  of: number;
  name: string;
  filters: SampleFilters;
  preset: string | null;
  res: StatRunColumn | undefined;
  floor: number;
  onOpen: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  const { ut } = useLang();
  const no = String(index + 1);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start gap-2">
        <SampleBadge n={index + 1} of={of} />
        <b className="min-w-0 flex-1 break-words text-[13.5px] font-extrabold leading-[19px] text-text">{name}</b>
        <Button
          variant="quiet"
          size="icon-sm"
          className="-mt-1.5"
          aria-label={ut("st.samplePaneTitle").replace("{n}", no)}
          title={ut("st.samplePaneTitle").replace("{n}", no)}
          onClick={onOpen}
        >
          <St.sliders />
        </Button>
        <ActionMenu
          label={ut("st.sampleActions").replace("{n}", no)}
          triggerSize="icon-sm"
          triggerClassName="-mt-1.5"
          entries={[
            { label: ut("st.samplePaneTitle").replace("{n}", no), onSelect: onOpen, icon: <St.sliders size={15} /> },
            {
              label: ut("st.duplicateSample"),
              onSelect: onDuplicate,
              disabled: !onDuplicate,
              hint: ut("st.samplesFull"),
              icon: <St.copy size={15} />,
            },
            {
              label: ut("st.removeSample"),
              onSelect: onRemove,
              disabled: !onRemove,
              hint: ut("st.lastSample"),
              ruled: true,
              icon: <Ic.x size={15} />,
            },
          ]}
        />
      </div>
      <CriteriaChips filters={filters} />
      <div>
        <SourceTag preset={preset} />
      </div>
      {res ? (
        <div className="mt-0.5 flex gap-[18px]">
          <div>
            <small className="block text-[11.5px] font-bold leading-[15px] text-muted">{ut("st.respondents")}</small>
            {res.respondents.suppressed ? (
              <HiddenCell floor={floor} />
            ) : (
              <b className="text-[20px] font-extrabold leading-6 tabular-nums text-text">{res.respondents.count}</b>
            )}
          </div>
          {res.highRisk ? (
            <div>
              <small className="block text-[11.5px] font-bold leading-[15px] text-muted">{ut("st.withVshr")}</small>
              {res.highRisk.suppressed ? (
                <HiddenCell floor={floor} />
              ) : (
                <b className="text-[20px] font-extrabold leading-6 tabular-nums text-text">
                  {res.highRisk.count}
                  <span className="ml-1 text-caption font-bold text-muted">{res.highRisk.percent} %</span>
                </b>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Доля ячейки: «26% 6 з 23», разность от опорной выборки и полоса; скрытая — прочерк с объяснением */
function Share({
  cell,
  base,
  against,
  color,
  floor,
  ran,
}: {
  cell: StatCell | null;
  base: StatCell | undefined;
  /** Ячейка опорной выборки; undefined — эта колонка сама опорная */
  against: StatCell | null | undefined;
  color: string;
  floor: number;
  ran: boolean;
}) {
  const { ut } = useLang();
  if (!cell) {
    /* до расчёта — пустая дорожка: строка видна, чисел ещё нет */
    return ran ? null : <div aria-hidden className="mt-[29px] h-1.5 rounded-[3px] bg-track" />;
  }
  if (cell.suppressed) {
    return (
      <>
        <div className="flex items-center gap-2">
          <HiddenCell floor={floor} />
          <span className="flex items-center gap-1 text-caption text-muted">
            <Ic.lock size={12} />
            {ut("st.hiddenWord")}
          </span>
        </div>
        <div aria-hidden className="mt-[7px] h-1.5 rounded-[3px] shadow-[inset_0_0_0_1px_var(--ctl)]" />
      </>
    );
  }
  const diff = against === undefined ? "" : diffText(against, cell);
  return (
    <>
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <b className="text-[17px] font-extrabold leading-[22px] tracking-[-0.01em] tabular-nums text-text">
          {cell.percent}
          <small className="ml-px text-caption font-bold text-muted">%</small>
        </b>
        {base && !base.suppressed ? (
          <span className="text-caption tabular-nums text-muted">
            {ut("kit.ofTotal").replace("{n}", String(cell.count)).replace("{total}", String(base.count))}
          </span>
        ) : null}
        {diff ? (
          <Tag className="ml-auto self-center tabular-nums">
            <span className="sr-only">{ut("st.diffHint")}: </span>
            {ut("st.pp").replace("{n}", diff)}
          </Tag>
        ) : null}
      </div>
      <div aria-hidden className="mt-[7px] h-1.5 overflow-hidden rounded-[3px] bg-track">
        <i className="block h-full rounded-[3px]" style={{ width: `${Math.max(cell.percent, 1)}%`, background: color }} />
      </div>
    </>
  );
}

/** Подпись строки с числами: полоса словом тяжести, «Решта», вариант с «ВШР», «Респонденти з ВШР» */
function RowLabel({ row, onRisk }: { row: ReportRow; onRisk: (questionId: string, optionId: string) => void }) {
  const { ut } = useLang();
  switch (row.kind) {
    case "band":
      return (
        <span className="flex flex-wrap items-center gap-2">
          {row.severity ? (
            <SeverityTag level={row.severity} small>
              {row.label || ut("st.band")}
            </SeverityTag>
          ) : (
            <span className="font-semibold text-text">{row.label}</span>
          )}
          {row.range ? <span className="text-caption text-muted">{ut("st.points").replace("{r}", row.range)}</span> : null}
        </span>
      );
    case "option":
      return (
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-text">{row.text}</span>
          <VshrToggle pressed={row.highRisk} onToggle={() => onRisk(row.questionId, row.optionId)} />
        </span>
      );
    case "rest":
      return (
        <span className="block">
          <b className="block font-bold text-text-2">{ut("st.rest")}</b>
          {row.others ? <small className="block text-caption text-muted">{row.others}</small> : null}
        </span>
      );
    case "risk":
      return (
        <span className="block">
          <span className="flex items-center gap-2">
            <St.shieldAlert size={15} className="text-risk-ink" />
            <b className="font-extrabold text-text">{ut("st.vshrRow")}</b>
          </span>
          <small className="block text-caption text-muted">{ut("st.vshrRowSub")}</small>
        </span>
      );
    default:
      return null;
  }
}

/** Заголовок группы строк: шкала с её смугами или вопрос с его вариантами */
function GroupLabel({ row }: { row: ReportRow }) {
  const { ut } = useLang();
  if (row.kind === "scale") {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {row.code ? <b className="font-extrabold text-text">{row.code}</b> : null}
        <b className="font-bold text-text">{row.title}</b>
        <span className="text-small text-muted">{ut("st.scaleGroupSub")}</span>
      </span>
    );
  }
  if (row.kind === "question") {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {row.number ? <b className="font-extrabold text-text">{ut("st.itemNo").replace("{n}", String(row.number))}</b> : null}
        <b className="font-bold text-text">{row.title}</b>
        {row.type ? (
          <span className="text-small text-muted">
            {row.type === "multiple"
              ? ut("st.typeMultiple")
              : row.type === "yesno"
                ? ut("st.typeYesNo")
                : ut("st.typeSingle")}
          </span>
        ) : null}
      </span>
    );
  }
  return null;
}
