import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { SurveyAnalytics } from "@quizzy/shared";
import { api, type AnalyticsSlice } from "../../../api";
import { duration } from "../../../format";
import { useLang } from "../../../lang";
import { Empty, KbdHints, Loading, useHotkeys } from "../../../ui";
import { Ic } from "../../../ui/icons";
import { Page } from "../../../ui/layout";
import { Button, Input, Segmented, Tabs } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { AIc } from "../icons";
import { SurveyActions } from "./actions";
import { ChipMenu, PatientPicker, SurveyPicker } from "./fields";
import {
  PRESETS,
  RESET_PATCH,
  VIEWS,
  dayText,
  defaultSurvey,
  fill,
  isFiltered,
  kyivDay,
  numText,
  patchParams,
  presetFrom,
  presetOf,
  readState,
  surveyPatch,
  type Param,
  type Preset,
  type QuestionSort,
  type View,
} from "./model";
import { PatientView } from "./patient";
import { OverviewView, QualityView, QuestionsView, ResponsesView, ScalesView, TimeView, nf } from "./views";

/*
 * «Аналітика тестів» — полная аналитика одной методики (analytics-tests,
 * analytics-tests-patient).
 *
 * Задача заказчика (2026-09-26): «глянуть прохождения пациента или всех
 * пациентов, статистику по вопросам, ответам, времени ответа, общее
 * состояние по разным шкалам всех пациентов». Экран заменяет прежнюю
 * страницу /surveys/:id; её адрес перенаправляется сюда с ?survey=, а все её
 * двери — выгрузки, нормы, назначения, конструктор, бланк, ключ,
 * «заповнити за пацієнта» — стоят у заголовка (actions.tsx).
 *
 *   шапка        «Аналітика тестів», сводка среза числами, «Вивантаження», «⋯»
 *   фильтры      Тест, Хто, Пацієнт | Група, Період, Версія; строка «Показано»
 *   содержимое   вкладки видов (для всех) либо панели одного человека
 *
 * Состояние целиком в адресе (?survey=&scope=&patient=&group=&from=&to=
 * &version=&view=&sort=), правка — `replace`: ссылку на «PHQ-9, один
 * пациент, з вересня» пересылают коллеге. Экран только смотрит — ничего на
 * нём не сохраняется, и строка «Показано» это говорит.
 */
export default function TestsAnalytics() {
  const { ut } = useLang();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readState(params), [params]);

  /* `replace`, а не push: фильтр — не шаг в истории браузера */
  const update = useCallback(
    (patch: Partial<Record<Param, string | null>>) => setParams((prev) => patchParams(prev, patch), { replace: true }),
    [setParams],
  );

  const surveys = useResource(() => api.surveys(), []);
  const choices = useMemo(
    () => surveys.data?.map((s) => ({ id: s.id, title: s.title, responseCount: s.responseCount })) ?? null,
    [surveys.data],
  );

  /* без ?survey — самая заполненная методика: пустой экран «оберіть тест» — лишнее нажатие на каждый вход */
  useEffect(() => {
    if (state.survey || !choices?.length) return;
    const id = defaultSurvey(choices);
    if (id) update(surveyPatch(id));
  }, [state.survey, choices, update]);

  const patientScope = state.scope === "patient";
  const slice: AnalyticsSlice = {
    from: state.from ?? undefined,
    to: state.to ?? undefined,
    /* группа — срез «всех», у одного человека она ничего не сужает */
    userId: patientScope ? (state.patient ?? undefined) : undefined,
    patientGroup: !patientScope ? (state.group ?? undefined) : undefined,
  };
  /*
   * Ответ помечается срезом, по которому он запрошен: useResource держит
   * последний пришедший ответ, пока едет следующий. Шапке это на руку
   * (версии и действия методики не мигают на каждую смену даты), а
   * содержимому — нет: графики «всех пациентов» под только что выбранным
   * «Один пацієнт» — чужие цифры под верной подписью. Поэтому содержимое
   * рисуется только по ответу своего среза, шапка — по любому ответу той же
   * методики.
   */
  const reqKey = JSON.stringify([state.survey, state.version, slice]);
  const ready = !!state.survey && (!patientScope || !!state.patient);
  const res = useResource(
    async () => ({ key: reqKey, body: await api.analytics(state.survey!, state.version ?? undefined, slice) }),
    [reqKey],
    { enabled: ready },
  );
  const known = res.data?.body.surveyId === state.survey ? res.data.body : null;
  const data = res.data?.key === reqKey ? res.data.body : null;

  /* группы пациентов — личные списки сотрудника; нет своих — нет и поля */
  const groups = useResource(() => api.patientGroups(), []);
  /* динамика человека — и для графиков, и для имени в поле «Пацієнт» */
  const dynamics = useResource(() => api.dynamics(state.patient!), [state.patient], {
    enabled: patientScope && !!state.patient,
  });
  const person = dynamics.data?.userId === state.patient ? dynamics.data : null;

  const surveyTitle = known?.title ?? choices?.find((c) => c.id === state.survey)?.title ?? "";
  const groupTitle = groups.data?.find((g) => g.id === state.group)?.title ?? null;
  const today = kyivDay();
  const preset = presetOf(state.from, state.to, today);
  const [customDates, setCustomDates] = useState(false);
  const showDates = customDates || ((!!state.from || !!state.to) && !preset);

  const PRESET_KEY: Record<Preset, "ant.p30" | "ant.p90" | "ant.p365"> = { "30": "ant.p30", "90": "ant.p90", "365": "ant.p365" };
  const periodText =
    state.from || state.to ? `${state.from ? dayText(state.from) : "…"} – ${state.to ? dayText(state.to) : "…"}` : ut("an.allHistory").toLowerCase();

  /* сводка среза числами — в мета-строке шапки, без плиток */
  const meta: [ReactNode, ReactNode] | undefined = !data
    ? undefined
    : patientScope
      ? [fill(ut("ant.metaPatient"), { n: nf(data.completed) }), `${person?.fullName ?? ut("ant.onePatient")}, ${periodText}`]
      : [
          fill(ut("ant.metaAll"), { n: nf(data.completed), p: nf(data.respondentCount) }),
          fill(ut("ant.metaAll2"), {
            s: nf(data.started),
            r: data.started ? `${numText(data.completionRate, 1)} %` : "—",
            t: data.medianDurationMs > 0 ? duration(data.medianDurationMs) : "—",
          }),
        ];

  const filters = (
    <section role="group" aria-label={ut("ant.filtersLabel")} className="rounded-panel border border-border bg-panel px-3.5 py-3 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <SurveyPicker
          className="w-[316px] max-[900px]:w-full"
          choices={choices}
          value={state.survey}
          valueTitle={surveyTitle}
          onChange={(id) => update(surveyPatch(id))}
        />
        <Segmented
          label={ut("ant.who")}
          value={state.scope}
          onChange={(scope) => update({ scope, patient: scope === "all" ? null : state.patient })}
          items={[
            { key: "all", label: ut("ant.allPatients") },
            { key: "patient", label: ut("ant.onePatient") },
          ]}
          className="self-center"
        />
        {patientScope ? (
          <PatientPicker
            className="w-[270px] max-[900px]:w-full"
            value={state.patient}
            valueName={person?.fullName ?? ""}
            onChange={(id) => update({ patient: id, version: null })}
          />
        ) : groups.data?.length ? (
          <ChipMenu
            label={ut("ant.groupChip")}
            value={groupTitle ?? ut("ant.anyGroupShort")}
            on={!!groupTitle}
            onClear={() => update({ group: null })}
            current={state.group ?? ""}
            onPick={(id) => update({ group: id || null })}
            options={[
              { key: "", label: ut("ant.anyGroup"), icon: <AIc.usersRound size={15} /> },
              ...groups.data.map((g) => ({ key: g.id, label: g.title, icon: <AIc.usersRound size={15} /> })),
            ]}
          />
        ) : null}
        <ChipMenu<Preset | "all" | "custom">
          label={ut("ant.periodChip")}
          value={preset ? ut(PRESET_KEY[preset]) : periodText}
          on={!!state.from || !!state.to}
          onClear={() => {
            setCustomDates(false);
            update({ from: null, to: null });
          }}
          head={ut("ant.periodChip")}
          current={preset ?? (state.from || state.to ? "custom" : "all")}
          onPick={(k) => {
            if (k === "custom") {
              setCustomDates(true);
              return;
            }
            setCustomDates(false);
            update(k === "all" ? { from: null, to: null } : { from: presetFrom(k, today), to: null });
          }}
          options={[
            ...PRESETS.map((p) => ({ key: p, label: ut(PRESET_KEY[p]), icon: <Ic.calendar size={15} /> })),
            { key: "all" as const, label: ut("an.allHistory"), icon: <Ic.calendar size={15} /> },
            { key: "custom" as const, label: ut("ant.pCustom"), icon: <Ic.calendar size={15} />, ruled: true },
          ]}
        />
        {showDates ? (
          <span className="flex items-center gap-1.5">
            <Input
              type="date"
              aria-label={ut("ant.from")}
              value={state.from ?? ""}
              max={state.to ?? undefined}
              onChange={(e) => update({ from: e.target.value || null })}
              className="w-[150px]"
            />
            <span aria-hidden className="text-muted">
              –
            </span>
            <Input
              type="date"
              aria-label={ut("ant.to")}
              value={state.to ?? ""}
              min={state.from ?? undefined}
              onChange={(e) => update({ to: e.target.value || null })}
              className="w-[150px]"
            />
          </span>
        ) : null}
        {/* версия — только когда их больше одной: выбирать из одной нечего */}
        {known && known.versions.length > 1 ? (
          <ChipMenu
            label={ut("an.version")}
            value={String(known.versionNumber)}
            on={!!state.version}
            onClear={() => update({ version: null })}
            head={fill(ut("ant.versionsOf"), { title: known.title })}
            current={known.versionId ?? ""}
            onPick={(v) => update({ version: v || null })}
            options={known.versions.map((v) => ({
              key: v.id,
              label: fill(ut("ant.versionN"), { n: v.version }),
              aside: nf(v.responseCount),
            }))}
          />
        ) : null}
      </div>
      <Shown
        title={surveyTitle}
        version={known ? fill(ut("ant.versionN"), { n: known.versionNumber }) : null}
        who={patientScope ? (person?.fullName ?? ut("ant.onePatient")) : ut("ant.allPatients").toLowerCase()}
        group={!patientScope && groupTitle ? groupTitle : null}
        period={periodText}
        groupNote={patientScope && !!groups.data?.length}
        canReset={isFiltered(state)}
        onReset={() => {
          setCustomDates(false);
          update(RESET_PATCH);
        }}
      />
    </section>
  );

  return (
    <Page title={ut("ant.title")} meta={meta} actions={known ? <SurveyActions data={known} /> : null}>
      {surveys.data && !surveys.data.length && !state.survey ? (
        <Empty title={ut("ant.noSurveyTitle")} hint={ut("ant.noSurvey")} icon={<Ic.gauge />} />
      ) : (
        <div className="flex flex-col gap-4">
          {filters}
          {patientScope && !state.patient ? (
            <Empty title={ut("ant.pickPatientTitle")} hint={ut("ant.pickPatient")} icon={<Ic.user />} />
          ) : res.error && !data ? (
            <Loading error={res.error} onRetry={res.reload} />
          ) : !data ? (
            <Loading rows={6} />
          ) : patientScope ? (
            <PatientView data={data} dynamics={person} slice={slice} />
          ) : (
            <AllPatients data={data} view={state.view} sort={state.sort} slice={slice} update={update} />
          )}
        </div>
      )}
    </Page>
  );
}

/**
 * Строка «Показано»: срез словами — скриншот экрана говорит сам за себя, —
 * пометка «лише перегляд» и «Скинути». Сброс снимает всё, кроме методики и
 * открытого вида: их выбирали не как фильтр.
 */
function Shown({
  title,
  version,
  who,
  group,
  period,
  groupNote,
  canReset,
  onReset,
}: {
  title: string;
  version: string | null;
  who: string;
  group: string | null;
  period: string;
  groupNote: boolean;
  canReset: boolean;
  onReset: () => void;
}) {
  const { ut } = useLang();
  const rest = [version, who, group, period].filter(Boolean).join(", ");
  /* пока методика не пришла, строка начинается со среза, а не с запятой */
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-divider pt-2.5 text-small text-text-2">
      <Ic.eye size={14} className="text-muted" />
      <span className="text-muted">{ut("ant.shown")}</span>
      <span className="min-w-0 flex-1">
        {title ? <b className="font-extrabold text-text">{title}</b> : null}
        {title ? (rest ? `, ${rest}.` : ".") : `${rest}.`}
        {groupNote ? ` ${ut("ant.groupNotInPatient")}` : null}
      </span>
      <span className="text-caption text-muted">{ut("ant.readOnly")}</span>
      <Button variant="quiet" size="xs" icon={<AIc.rotateCcw />} disabled={!canReset} onClick={onReset}>
        {ut("ant.reset")}
      </Button>
    </div>
  );
}

const VIEW_KEY: Record<View, "ant.viewOverview" | "an.tabScales" | "an.tabQuestions" | "an.time" | "an.tabQuality" | "an.tabResponses"> = {
  overview: "ant.viewOverview",
  scales: "an.tabScales",
  questions: "an.tabQuestions",
  time: "an.time",
  quality: "an.tabQuality",
  responses: "an.tabResponses",
};

/**
 * Срез «Усі пацієнти»: вкладки видов с числами и один вид под ними;
 * клавиши 1–6 переключают вкладки.
 *
 * Вкладки — кнопочный вид Tabs (role=tablist), а не ссылки: вид живёт в
 * параметре адреса (?view=), а NavLink сравнивает только путь.
 */
function AllPatients({
  data,
  view,
  sort,
  slice,
  update,
}: {
  data: SurveyAnalytics;
  view: View;
  sort: QuestionSort;
  slice: AnalyticsSlice;
  update: (patch: Partial<Record<Param, string | null>>) => void;
}) {
  const { ut } = useLang();
  const panel = "tests-view-panel";
  const counts: Partial<Record<View, number>> = {
    scales: data.scales.length,
    questions: data.questions.length,
    quality: data.quality.length,
    responses: data.completed,
  };
  const go = (v: View) => update({ view: v });
  useHotkeys(Object.fromEntries(VIEWS.map((v, i) => [String(i + 1), () => go(v)])));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Tabs
          label={ut("ant.views")}
          items={VIEWS.map((v) => ({
            label: ut(VIEW_KEY[v]),
            active: v === view,
            onSelect: () => go(v),
            id: `tests-view-${v}`,
            controls: panel,
            count: counts[v] ?? null,
          }))}
        />
        <KbdHints
          keys={[
            ["1–6", ut("ant.kViews")],
            ["E", ut("ant.kExports")],
          ]}
        />
      </div>
      <div id={panel} role="tabpanel" aria-labelledby={`tests-view-${view}`}>
        {view === "overview" ? <OverviewView data={data} slice={slice} onView={go} /> : null}
        {view === "scales" ? <ScalesView data={data} /> : null}
        {view === "questions" ? <QuestionsView data={data} sort={sort} onSort={(s) => update({ sort: s })} /> : null}
        {view === "time" ? <TimeView data={data} /> : null}
        {view === "quality" ? <QualityView data={data} /> : null}
        {view === "responses" ? <ResponsesView data={data} slice={slice} /> : null}
      </div>
    </>
  );
}
