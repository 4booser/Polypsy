import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { SurveyAnalytics } from "@quizzy/shared";
import { api, type AnalyticsSlice } from "../../../api";
import { useLang } from "../../../lang";
import { Loading, OfflineBar } from "../../../ui";
import { Page } from "../../../ui/layout";
import { Button, Input, Tabs } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { AnalyticsTabs } from "../tabs";
import { SurveyActions } from "./actions";
import { FillSelect, PatientPicker, ScopeSwitch, SurveyPicker } from "./fields";
import {
  RESET_PATCH,
  VIEWS,
  dayText,
  defaultSurvey,
  fill,
  isFiltered,
  patchParams,
  readState,
  surveyPatch,
  type Param,
  type QuestionSort,
  type View,
} from "./model";
import { PatientView } from "./patient";
import { OverviewView, QualityView, QuestionsView, ResponsesList, ScalesView, TimeView, useResponsePages } from "./views";

/*
 * «Аналітика → Тести» — полная аналитика одной методики.
 *
 * Задача заказчика (2026-09-26, к кадру f10): «вкладку с полной аналитикой
 * по тестам, чтобы можно было глянуть прохождения пациента или всех
 * пациентов, статистику по вопросам, ответам, времени ответа, общее
 * состояние по разным шкалам всех пациентов». Экран заменяет прежнюю
 * страницу /surveys/:id (оформление «Пульта»: плитки, кольца, голые
 * таблицы); её адрес перенаправляется сюда с ?survey=, и все её двери —
 * выгрузки, нормы, назначения, конструктор, бланк, ключ, «заповнити за
 * пацієнта» — стоят в шестерёнке у заголовка (actions.tsx).
 *
 * Как устроен экран:
 *
 *   шапка (прибита)   вкладки раздела · «Аналітика тестів» + ⚙ · строка
 *                     фильтров: Тест, Хто, Пацієнт|Група, період, версія
 *   содержимое        «Показано: …» + «Скинути» → вкладки видов (для всех)
 *                     либо разделы одного человека (patient.tsx)
 *
 * Состояние целиком в адресе (?survey=&scope=&patient=&group=&from=&to=
 * &version=&view=&sort=), правка — `replace`: ссылку на «PHQ-9, один
 * пациент, с сентября» пересылают коллеге, а каждая буква поиска шагом в
 * истории браузера не становится.
 *
 * Две строки шапки не укладываются в рамку Page с одной строкой — как у
 * перечня статистики (statistics/List.tsx), заголовок отдан рамке скрытым
 * (`titleHidden`, <h1> для диктора), а видимая строка с именем экрана и
 * строка фильтров печатаются в полосе инструментов. Просветы строки — `snug`,
 * как у перечня моделей f10: вкладки раздела стоят на обоих экранах в одном
 * и том же месте.
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
   * Ответ помечается срезом, по которому он запрошен.
   *
   * useResource держит последний пришедший ответ, пока едет следующий. Для
   * шапки это хорошо (версии и шестерёнка методики не мигают на каждую
   * смену даты), а для содержимого — нет: графики «всех пациентов» под
   * только что выбранным «Один пацієнт» — это чужие цифры под верной
   * подписью. Поэтому содержимое рисуется только по ответу своего среза, а
   * шапка — по любому ответу той же методики.
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

  const toolbar = (
    <div className="flex w-full min-w-0 flex-col gap-[13px]">
      <div className="flex min-h-9 items-center justify-between gap-[24px]">
        {/* видимое имя экрана — не второй <h1>: тот уже объявлен рамке скрытым ровно этими словами */}
        <p aria-hidden className="m-0 flex items-baseline gap-[10px] text-[24px] font-bold leading-tight text-primary">
          {ut("ant.title")}
          {known ? <span className="font-mono text-[13px] font-normal tabular-nums text-muted">{known.completed}</span> : null}
        </p>
        {known ? <SurveyActions data={known} /> : null}
      </div>
      <div role="group" aria-label={ut("ant.filtersLabel")} className="flex flex-wrap items-center gap-x-[13px] gap-y-[8px]">
        <SurveyPicker
          className="w-[300px] max-[900px]:w-full"
          choices={choices}
          value={state.survey}
          valueTitle={surveyTitle}
          onChange={(id) => update(surveyPatch(id))}
        />
        <ScopeSwitch value={state.scope} onChange={(scope) => update({ scope, patient: scope === "all" ? null : state.patient })} />
        {patientScope ? (
          <PatientPicker
            className="w-[260px] max-[900px]:w-full"
            value={state.patient}
            valueName={person?.fullName ?? ""}
            onChange={(id) => update({ patient: id, version: null })}
          />
        ) : groups.data?.length ? (
          <FillSelect
            label={ut("ant.group")}
            value={state.group ?? ""}
            onChange={(v) => update({ group: v || null })}
            className="w-[200px] max-[900px]:w-full"
          >
            <option value="">{ut("ant.anyGroup")}</option>
            {groups.data.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </FillSelect>
        ) : null}
        <div className="flex items-center gap-[6px]">
          <Input
            look="fill"
            type="date"
            aria-label={ut("ant.from")}
            value={state.from ?? ""}
            max={state.to ?? undefined}
            onChange={(e) => update({ from: e.target.value || null })}
            className="w-[160px] font-mono tabular-nums"
          />
          <span aria-hidden className="text-muted">
            –
          </span>
          <Input
            look="fill"
            type="date"
            aria-label={ut("ant.to")}
            value={state.to ?? ""}
            min={state.from ?? undefined}
            onChange={(e) => update({ to: e.target.value || null })}
            className="w-[160px] font-mono tabular-nums"
          />
        </div>
        {/* версия — только когда их больше одной: выбирать из одной нечего */}
        {known && known.versions.length > 1 ? (
          <FillSelect
            label={ut("an.version")}
            value={known.versionId ?? ""}
            onChange={(v) => update({ version: v || null })}
            className="w-[150px]"
          >
            {known.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {fill(ut("ant.versionN"), { n: v.version })} · {v.responseCount}
              </option>
            ))}
          </FillSelect>
        ) : null}
      </div>
    </div>
  );

  /* строка «что показано»: срез словами, чтобы скриншот экрана говорил сам за себя */
  const shown = [
    surveyTitle,
    known ? fill(ut("ant.versionN"), { n: known.versionNumber }) : null,
    patientScope ? (person?.fullName ?? ut("ant.onePatient")) : ut("ant.allPatients"),
    !patientScope && groupTitle ? groupTitle : null,
    state.from || state.to ? `${state.from ? dayText(state.from) : "…"} – ${state.to ? dayText(state.to) : "…"}` : ut("an.allHistory"),
  ].filter(Boolean);

  return (
    <Page title={ut("ant.title")} titleHidden snug crumbs={<AnalyticsTabs />} toolbar={toolbar}>
      {surveys.data && !surveys.data.length && !state.survey ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ant.noSurvey")}</p>
      ) : (
        <>
          <div className="mb-[18px] mt-[10px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px]">
            <p className="m-0 min-w-0 text-[13px] leading-[18px] text-muted">
              {ut("ant.active")} <span className="text-text-2">{shown.join(" · ")}</span>
            </p>
            <Button variant="quiet" disabled={!isFiltered(state)} onClick={() => update(RESET_PATCH)}>
              {ut("ant.reset")}
            </Button>
          </div>

          {res.offline && known ? <OfflineBar onRetry={res.reload} busy={res.refreshing} /> : null}

          {patientScope && !state.patient ? (
            <p className="m-0 max-w-[640px] py-[12px] text-[15px] leading-[21px] text-muted">{ut("ant.pickPatient")}</p>
          ) : res.error && !data ? (
            <Loading error={res.error} onRetry={res.reload} />
          ) : !data ? (
            <Loading rows={6} />
          ) : patientScope ? (
            <PatientView data={data} dynamics={person} slice={slice} />
          ) : (
            <AllPatients data={data} view={state.view} sort={state.sort} slice={slice} update={update} />
          )}
        </>
      )}
    </Page>
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
 * Срез «Усі пацієнти»: вкладки видов и один вид под ними.
 *
 * Вкладки — кнопочный вид Tabs (role=tablist), а не ссылки: вид живёт в
 * параметре адреса (?view=), а NavLink сравнивает только путь — ссылочные
 * вкладки подсвечивались бы все разом (тот же довод у списка пациентов).
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
  return (
    <>
      <Tabs
        label={ut("ant.views")}
        items={VIEWS.map((v) => ({
          label: ut(VIEW_KEY[v]),
          active: v === view,
          onSelect: () => update({ view: v }),
          id: `tests-view-${v}`,
          controls: panel,
        }))}
      />
      <div id={panel} role="tabpanel" aria-labelledby={`tests-view-${view}`} className="pt-[24px]">
        {view === "overview" ? <OverviewView data={data} /> : null}
        {view === "scales" ? <ScalesView data={data} /> : null}
        {view === "questions" ? <QuestionsView data={data} sort={sort} onSort={(s) => update({ sort: s })} /> : null}
        {view === "time" ? <TimeView data={data} /> : null}
        {view === "quality" ? <QualityView data={data} /> : null}
        {view === "responses" ? <AllResponses data={data} slice={slice} /> : null}
      </div>
    </>
  );
}

/** Список прохождений под срезом экрана — той же версии, что и графики над ним */
function AllResponses({ data, slice }: { data: SurveyAnalytics; slice: AnalyticsSlice }) {
  const pages = useResponsePages(data.surveyId, { ...slice, versionId: data.versionId ?? undefined });
  return <ResponsesList pages={pages} surveyId={data.surveyId} />;
}
