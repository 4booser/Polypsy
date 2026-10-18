import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { StatModel, StatModelColumn, SurveyFull, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { ATTENTION_COLOR } from "../../charts/kit";
import { useLang } from "../../lang";
import { Empty, Ic, Loading, Modal, Tooltip, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel, SideLayout } from "../../ui/layout";
import {
  Button,
  ButtonLink,
  Checkbox,
  ErrorText,
  Field,
  Input,
  Select,
  SeverityTag,
  Switch,
  Textarea,
} from "../../ui/primitives";
import { useResource } from "../../useResource";
import { useSurveyAt, useSurveyVersions } from "./data";
import {
  MAX_FIGURES,
  MAX_SAMPLES,
  type QuestionBlock,
  type ReportRow,
  STATS_LIST,
  type StructureDraft,
  columnsFromDraft,
  emptyStructure,
  figureCount,
  indicatorsFromDraft,
  newQuestionBlock,
  removeSample,
  reportRows,
  setOptionRisk,
  setScaleBands,
  statHref,
  structureFromModel,
  toggleBand,
  toggleOption,
  validateStructure,
} from "./model";
import { SampleBadge, St, VshrMark, useSampleName } from "./parts";

/*
 * Редактор статистичної моделі — дизайн statistics-model-edit; тот же экран
 * на /statistics/new создаёт модель.
 *
 * Здесь — ЧТО считать: название и описание, тест и его версия, смуги
 * результату галочками по шкалам, питання з відповідями й позначкою «ВШР».
 * КОГО считать — на экране модели: выборки и их фильтры. При правке
 * структура ложится на каждую колонку, а выборки остаются (columnsFromDraft).
 *
 * Справа — «Рядки звіту»: так выглядит каждая колонка, с «Рештою» и
 * «Респонденти з ВШР», и сколько чисел она напечатает против потолка
 * сервера. Ниже — выборки модели: убрать лишнюю можно и здесь.
 */

export default function StatEditorPage() {
  const { id } = useParams<{ id: string }>();
  /* ключ: форма новой модели и правка — один компонент на двух адресах */
  return <Editor key={id ?? "new"} id={id ?? null} />;
}

/** Типы вопросов, по которым сервер считает доли (lib/statModels.ts, QUESTION_TYPES) */
const COUNTED = new Set(["single", "yesno", "multiple"]);

function Editor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const sampleName = useSampleName();

  const surveys = useResource(() => api.surveys(), []);
  const presets = useResource(() => api.filterPresets(), []);
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const model = useResource(() => api.statModel(id!), [id], { enabled: id !== null, manual: true });

  const [draft, setDraft] = useState<StructureDraft | null>(id === null ? emptyStructure() : null);
  const [columns, setColumns] = useState<StatModel["columns"] | null>(null);
  useEffect(() => {
    if (!model.data) return;
    setDraft(structureFromModel(model.data));
    setColumns(model.data.columns);
  }, [model.data]);

  const survey = useSurveyAt(draft?.surveyId || null, draft?.versionId ?? null);
  const current = useSurveyAt(draft?.surveyId || null, null);
  const versions = useSurveyVersions(draft?.surveyId || null);

  const [errors, setErrors] = useState<UiKey[]>([]);
  const [doomed, setDoomed] = useState(false);

  /* Ctrl/⌘ + S — «Зберегти»; пока форма грузится — ничего */
  const [saveRef] = useState<{ current: () => void }>(() => ({ current: () => {} }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saveRef]);

  const heading = id === null ? ut("st.newModel") : ut("st.editTitle");
  const back = id === null ? STATS_LIST : statHref(id);

  if (!draft || !surveys.data || (id !== null && !columns)) {
    return (
      <Page title={heading} back={{ to: back, label: ut("st.backToList") }}>
        <Loading
          rows={6}
          error={model.error ?? surveys.error}
          onRetry={() => {
            if (model.error) model.reload();
            if (surveys.error) surveys.reload();
          }}
        />
      </Page>
    );
  }

  const patch = (next: Partial<StructureDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));

  const save = () => {
    const errs = validateStructure(draft);
    setErrors(errs);
    if (errs.length) return;
    void run(async () => {
      const body = {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        columns: columnsFromDraft(draft, columns),
      };
      if (id === null) {
        const created = await api.createStatModel(body);
        /* replace: «назад» с экрана новой модели ведёт в перечень, а не в пустую форму */
        navigate(statHref(created.id), { replace: true });
      } else {
        await api.updateStatModel(id, body);
        navigate(statHref(id));
      }
    }, ut("st.saved"));
  };
  saveRef.current = save;

  const remove = () =>
    void run(async () => {
      if (id === null) return false;
      await api.deleteStatModel(id);
      toast(ut("st.deleted"), "ok");
      navigate(STATS_LIST, { replace: true });
    });

  /* смена теста или версии сбрасывает строки: полосы и варианты принадлежат версии */
  const resetRows = { bands: [], questions: [] };
  const counted = (survey?.questions ?? []).filter((q) => COUNTED.has(q.type));
  const taken = new Set(draft.questions.map((q) => q.questionId));
  const free = counted.filter((q) => !taken.has(q.id));

  /* строки отчёта — по черновику, как одна колонка: тот же разбор, что у экрана модели */
  const ind = indicatorsFromDraft(draft);
  const preview: StatModelColumn = {
    title: null,
    presetId: null,
    filters: {},
    surveyId: draft.surveyId,
    versionId: draft.versionId ?? "",
    bands: ind.bands,
    questions: ind.questions,
  };
  const rows = draft.surveyId ? reportRows([preview], () => survey) : [];
  const figures = figureCount(ind.bands, ind.questions);
  const presetTitle = (pid: string | null) => (pid ? presets.data?.find((p) => p.id === pid)?.title : undefined);
  const testMissing = draft.surveyId && !surveys.data.some((s) => s.id === draft.surveyId);

  return (
    <Page
      title={heading}
      back={{ to: back, label: id === null ? ut("sn.statModels") : (model.data?.title ?? "") }}
      meta={[id === null ? ut("st.newModelMeta") : (model.data?.title ?? ""), ut("st.editLead")]}
      actions={
        <>
          <ButtonLink to={back} variant="ghost">
            {ut("common.cancel")}
          </ButtonLink>
          <Tooltip label={id === null ? ut("st.create") : ut("common.save")} kbd="Ctrl S">
            <Button variant="primary" icon={<Ic.check />} disabled={busy} onClick={save}>
              {id === null ? ut("st.create") : ut("common.save")}
            </Button>
          </Tooltip>
        </>
      }
    >
      {errors.length ? (
        <div role="alert" className="mb-4 flex flex-col gap-1 rounded-panel border border-border bg-panel px-4 py-3">
          {errors.map((k) => (
            <ErrorText key={k}>{ut(k)}</ErrorText>
          ))}
        </div>
      ) : null}

      <SideLayout
        narrow
        side={
          <>
            <Panel title={ut("st.previewTitle")} icon={<Ic.table />} sub={ut("st.previewSub")}>
              {rows.length ? <Tree rows={rows} /> : <p className="m-0 text-small text-muted">{ut("st.previewEmpty")}</p>}
              {/* счёт чисел — когда есть что считать: у пустой формы «1 з 16» было бы одним основанием */}
              <div className={cx("mt-4 border-t border-divider pt-3", !rows.length && "hidden")}>
                <div className="flex items-baseline justify-between text-small">
                  <span className="text-text-2">{ut("st.figures")}</span>
                  <b className="tabular-nums text-text">
                    {ut("kit.ofTotal").replace("{n}", String(figures)).replace("{total}", String(MAX_FIGURES))}
                  </b>
                </div>
                <div aria-hidden className="mt-2 h-2 overflow-hidden rounded-[4px] bg-track">
                  <i
                    className="block h-full rounded-[4px]"
                    style={{
                      width: `${Math.min(100, (figures / MAX_FIGURES) * 100)}%`,
                      background: figures > MAX_FIGURES ? ATTENTION_COLOR : "var(--violet)",
                    }}
                  />
                </div>
                <p className={cx("m-0 mt-2 text-small", figures > MAX_FIGURES ? "font-bold text-warn" : "text-muted")}>
                  {ut("st.figuresNote").replace("{max}", String(MAX_FIGURES))}
                </p>
              </div>
            </Panel>
            {id !== null && columns ? (
              <Panel
                title={ut("st.samples")}
                icon={<St.usersRound />}
                actions={
                  <span className="text-caption text-muted">
                    {ut("kit.ofTotal").replace("{n}", String(columns.length)).replace("{total}", String(MAX_SAMPLES))}
                  </span>
                }
              >
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {columns.map((c, i) => {
                    const name = sampleName(c.title, presetTitle(c.presetId), i);
                    return (
                      <li key={i} className="flex items-center gap-3 rounded-control px-1 py-1.5">
                        <SampleBadge n={i + 1} of={columns.length} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold text-text">{name}</span>
                          <small className="block truncate text-caption text-muted">
                            {c.presetId
                              ? `${ut("st.presetWord")}: ${presetTitle(c.presetId) ?? ut("st.presetGone")}`
                              : ut("st.ownFilters")}
                          </small>
                        </span>
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-label={`${ut("st.removeSample")}: ${name}`}
                          title={columns.length > 1 ? `${ut("st.removeSample")}: ${name}` : ut("st.lastSample")}
                          disabled={columns.length <= 1}
                          onClick={() => setColumns((cs) => (cs ? removeSample(cs, i) : cs))}
                        >
                          <Ic.x />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                <p className="m-0 mt-2 text-small text-muted">{ut("st.samplesNote")}</p>
              </Panel>
            ) : null}
          </>
        }
      >
        <Panel title={ut("st.nameTitle")} icon={<Ic.type />}>
          <Field label={ut("st.modelName")}>
            <Input
              data-autofocus
              value={draft.title}
              maxLength={200}
              aria-invalid={errors.includes("st.errTitle") || undefined}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field
            label={ut("st.description")}
            hint={ut("st.descHint").replace("{n}", String(draft.description.length))}
          >
            <Textarea
              rows={2}
              maxLength={4000}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>
        </Panel>

        <Panel title={ut("st.testTitle")} icon={<Ic.clipboard />} sub={ut("st.testSub")}>
          <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-x-3 max-[900px]:grid-cols-1">
            <Field label={ut("am.testName")} error={errors.includes("st.errSurvey") ? ut("st.errSurvey") : null}>
              <Select
                value={draft.surveyId}
                onChange={(e) => patch({ surveyId: e.target.value, versionId: null, ...resetRows })}
              >
                <option value="">{ut("st.pickTest")}</option>
                {/* тест модели, которого нет в списке (снят, вне зоны), остаётся выбранным, а не пропадает */}
                {testMissing ? <option value={draft.surveyId}>{survey?.title ?? ut("st.testHidden")}</option> : null}
                {surveys.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={ut("st.versionField")}>
              <Select
                value={draft.versionId ?? ""}
                disabled={!draft.surveyId}
                onChange={(e) => patch({ versionId: e.target.value || null, ...resetRows })}
              >
                <option value="">
                  {current
                    ? ut("st.versionCurrentN").replace("{n}", String(current.versionNumber))
                    : ut("st.versionCurrent")}
                </option>
                {draft.versionId && !(versions ?? []).some((v) => v.id === draft.versionId) ? (
                  <option value={draft.versionId}>
                    {survey ? ut("st.versionN").replace("{n}", String(survey.versionNumber)) : ut("st.versionField")}
                  </option>
                ) : null}
                {[...(versions ?? [])]
                  .sort((a, b) => b.version - a.version)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {ut("st.versionPick")
                        .replace("{n}", String(v.version))
                        .replace("{count}", String(v.responseCount))}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-text-2">
            <Ic.info size={14} className="text-muted" />
            <span className="min-w-0 flex-1">{ut("st.versionNote")}</span>
            <Button
              variant="ghost"
              size="xs"
              icon={<Ic.x />}
              disabled={!draft.surveyId}
              onClick={() => patch({ surveyId: "", versionId: null, ...resetRows })}
            >
              {ut("st.resetTest")}
            </Button>
          </div>
        </Panel>

        <BandsPanel draft={draft} survey={survey} onChange={(bands) => patch({ bands })} />

        <Panel
          title={ut("st.questionsTitle")}
          icon={<St.listOrdered />}
          sub={ut("st.questionsSub")}
          actions={
            <span className="text-caption text-muted">
              {ut("st.questionsCount").replace("{n}", String(draft.questions.length))}
            </span>
          }
        >
          <div className="flex flex-col gap-3">
            {draft.questions.map((q, qi) => (
              <QuestionCard
                key={q.key}
                n={qi + 1}
                block={q}
                survey={survey}
                taken={taken}
                onChange={(next) => patch({ questions: draft.questions.map((x) => (x.key === q.key ? next : x)) })}
                onRemove={() => patch({ questions: draft.questions.filter((x) => x.key !== q.key) })}
              />
            ))}
          </div>
          <div className={cx("flex flex-wrap items-center gap-3", draft.questions.length > 0 && "mt-3")}>
            <Button
              size="xs"
              icon={<Ic.plus />}
              disabled={!survey || !free.length}
              onClick={() => patch({ questions: [...draft.questions, newQuestionBlock()] })}
            >
              {ut("st.addQuestion")}
            </Button>
            <span className="text-small text-muted">
              {survey ? ut("st.addQuestionHint").replace("{n}", String(free.length)) : ut("st.pickTestFirst")}
            </span>
          </div>
        </Panel>

        {id !== null && columns ? (
          <Panel title={ut("st.deleteModel")} icon={<St.trash />} tone="neutral">
            <div className="flex flex-wrap items-center gap-4">
              <p className="m-0 min-w-0 flex-1 text-small text-text-2">
                {ut("st.deleteBlock").replace("{n}", String(columns.length))}
              </p>
              <Button icon={<St.trash />} onClick={() => setDoomed(true)}>
                {ut("st.deleteModel")}
              </Button>
            </div>
          </Panel>
        ) : null}
      </SideLayout>

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
          <p className="m-0 pt-3.5 text-body text-text-2">
            {ut("st.deleteText").replace("{title}", model.data?.title ?? draft.title)}
          </p>
        </Modal>
      ) : null}
    </Page>
  );
}

/* ─────────── смуги ─────────── */

function BandsPanel({
  draft,
  survey,
  onChange,
}: {
  draft: StructureDraft;
  survey: SurveyFull | null | undefined;
  onChange: (bands: StructureDraft["bands"]) => void;
}) {
  const { ut } = useLang();
  const scales = (survey?.scales ?? []).filter((s) => s.bands.length);
  const order = scales.flatMap((s) => s.bands.map((b) => `${s.id}:${b.id}`));
  const picked = new Map(draft.bands.map((b, i) => [b.value, i + 1] as const));
  const total = order.length;
  return (
    <Panel
      title={ut("st.bandsTitle")}
      icon={<Ic.layers />}
      sub={ut("st.bandsSub")}
      actions={
        total ? (
          <span className="text-caption text-muted">
            {ut("st.pickedOf").replace("{n}", String(draft.bands.length)).replace("{total}", String(total))}
          </span>
        ) : null
      }
    >
      {!draft.surveyId ? (
        <Empty compact title={ut("st.pickTestFirst")} />
      ) : survey === undefined ? (
        <Loading bare rows={3} />
      ) : !scales.length ? (
        <Empty compact title={ut("st.noScales")} />
      ) : (
        <div className="flex flex-col gap-4">
          {scales.map((s) => {
            const values = s.bands.map((b) => `${s.id}:${b.id}`);
            const min = Math.min(...s.bands.map((b) => b.minScore));
            const max = Math.max(...s.bands.map((b) => b.maxScore));
            return (
              <div key={s.id}>
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {s.code ? <b className="font-extrabold text-text">{s.code}</b> : null}
                  <b className="font-bold text-text">{s.title}</b>
                  <span className="text-small text-muted">
                    {ut("st.scaleRange")
                      .replace("{r}", `${min}–${max}`)
                      .replace("{n}", String(s.bands.length))}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="xs" onClick={() => onChange(setScaleBands(draft.bands, values, true, order))}>
                      {ut("st.all")}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => onChange(setScaleBands(draft.bands, values, false, order))}>
                      {ut("st.none")}
                    </Button>
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {s.bands.map((b) => {
                    const value = `${s.id}:${b.id}`;
                    const at = picked.get(value);
                    return (
                      <label
                        key={b.id}
                        className={cx(
                          "m-0 flex min-h-[42px] cursor-pointer items-center gap-3 rounded-control px-3",
                          at ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-sunk",
                        )}
                      >
                        <Checkbox checked={!!at} onChange={() => onChange(toggleBand(draft.bands, value, order))} />
                        <SeverityTag level={b.severity} small>
                          {b.label}
                        </SeverityTag>
                        <span className="text-caption text-muted">
                          {ut("st.points").replace("{r}", `${b.minScore}–${b.maxScore}`)}
                        </span>
                        <span className={cx("ml-auto text-small", at ? "font-bold text-violet-ink" : "text-muted")}>
                          {at ? ut("st.reportRowN").replace("{n}", String(at)) : ut("st.inRest")}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <p className="m-0 flex items-center gap-1.5 text-small text-muted">
            <St.split size={14} />
            {ut("st.restHint")}
          </p>
        </div>
      )}
    </Panel>
  );
}

/* ─────────── питання ─────────── */

function QuestionCard({
  n,
  block,
  survey,
  taken,
  onChange,
  onRemove,
}: {
  n: number;
  block: QuestionBlock;
  survey: SurveyFull | null | undefined;
  taken: Set<string>;
  onChange: (next: QuestionBlock) => void;
  onRemove: () => void;
}) {
  const { ut } = useLang();
  const all = survey?.questions ?? [];
  const counted = all.filter((q) => COUNTED.has(q.type));
  const question = counted.find((q) => q.id === block.questionId);
  const options = (question?.options ?? []).filter((o) => o.kind === "option");
  const order = options.map((o) => o.id);
  const label = `${ut("st.question")} ${n}`;
  return (
    <section aria-label={label} className="rounded-panel border border-border px-4 py-3.5">
      <div className="flex items-end gap-2">
        <Field label={label} className="mb-0 min-w-0 flex-1">
          <Select
            value={block.questionId}
            disabled={!survey}
            /* смена вопроса сбрасывает ответы: варианты принадлежат вопросу */
            onChange={(e) => onChange({ ...block, questionId: e.target.value, options: [] })}
          >
            <option value="">{ut("st.pickQuestion")}</option>
            {block.questionId && !question ? <option value={block.questionId}>{ut("st.questionGone")}</option> : null}
            {counted
              .filter((q) => q.id === block.questionId || !taken.has(q.id))
              .map((q) => (
                <option key={q.id} value={q.id}>
                  {ut("st.itemNo").replace("{n}", String(all.indexOf(q) + 1))}. {q.title}
                </option>
              ))}
          </Select>
        </Field>
        <Button variant="quiet" size="icon" aria-label={`${ut("st.removeQuestion")} ${n}`} title={ut("st.removeQuestion")} onClick={onRemove}>
          <St.trash />
        </Button>
      </div>
      {question ? (
        <>
          <p className="m-0 mb-2 mt-2 text-small text-muted">
            {ut("st.optionsOf")
              .replace(
                "{type}",
                question.type === "multiple"
                  ? ut("st.typeMultiple")
                  : question.type === "yesno"
                    ? ut("st.typeYesNo")
                    : ut("st.typeSingle"),
              )
              .replace("{n}", String(options.length))}
          </p>
          <div className="flex flex-col gap-0.5">
            {options.map((o, oi) => {
              const row = block.options.find((x) => x.optionId === o.id);
              return (
                <div
                  key={o.id}
                  className={cx(
                    "grid min-h-[44px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-control px-3",
                    row ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-sunk",
                  )}
                >
                  <label className="m-0 flex min-w-0 cursor-pointer items-center gap-3 py-1.5">
                    <Checkbox checked={!!row} onChange={() => onChange(toggleOption(block, o.id, order))} />
                    <span className="min-w-0">
                      <small className="block text-[11.5px] leading-[14px] text-muted">
                        {ut("st.answer")} {oi + 1}
                      </small>
                      <span className="block text-text">{o.text}</span>
                    </span>
                  </label>
                  <Switch
                    label={ut("st.vshr")}
                    checked={!!row?.highRisk}
                    disabled={!row}
                    onChange={(v) => onChange(setOptionRisk(block, o.id, v))}
                  />
                </div>
              );
            })}
          </div>
          <p className="m-0 mt-2 flex items-start gap-1.5 text-small text-muted">
            <St.shieldAlert size={14} className="mt-0.5 shrink-0 text-risk-ink" />
            <span>{ut("st.vshrHint")}</span>
          </p>
        </>
      ) : null}
    </section>
  );
}

/* ─────────── рядки звіту ─────────── */

/** Строки отчёта деревом: шкала и её смуги, вопрос и его варианты, «Решта», «ВШР» */
function Tree({ rows }: { rows: ReportRow[] }) {
  const { ut } = useLang();
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => {
        switch (r.kind) {
          case "scale":
            return (
              <div key={r.key} className={cx("mb-1 flex items-center gap-2 text-[13px] font-bold text-text", i > 0 && "mt-3")}>
                {r.code ? <b className="font-extrabold">{r.code}</b> : null}
                <span className="truncate">{r.title}</span>
              </div>
            );
          case "question":
            return (
              <div key={r.key} className={cx("mb-1 flex items-center gap-2 text-[13px] font-bold text-text", i > 0 && "mt-3")}>
                {r.number ? <b className="font-extrabold">{ut("st.itemNo").replace("{n}", String(r.number))}</b> : null}
                <span className="truncate">{r.title}</span>
              </div>
            );
          case "risk":
            return (
              <div key={r.key} className="mt-3 flex items-center gap-2 text-[13px] font-bold text-text">
                <St.shieldAlert size={14} className="text-risk-ink" />
                {ut("st.vshrRow")}
              </div>
            );
          default:
            return (
              <div
                key={r.key}
                className={cx(
                  "ml-2 flex min-h-[26px] items-center gap-2 border-l-[1.5px] border-border pl-3 text-small",
                  r.kind === "rest" ? "text-muted" : "text-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {r.kind === "band" ? r.label : r.kind === "option" ? r.text : ut("st.rest")}
                </span>
                {r.kind === "option" && r.highRisk ? <VshrMark /> : null}
              </div>
            );
        }
      })}
    </div>
  );
}
