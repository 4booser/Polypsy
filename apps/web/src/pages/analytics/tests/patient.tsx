import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { AnswerMatrix, RespondentDynamics, SurveyAnalytics, SurveyResponse } from "@quizzy/shared";
import { api, type AnalyticsSlice } from "../../../api";
import { HBars } from "../../../charts/clinical";
import { CourseChart } from "../../../charts/course";
import { betterOf, changeVerdict, courseEventsFromTimeline, courseFromDynamics, reliableThreshold, type ChangeVerdict } from "../../../charts/courseModel";
import { RowTip, TipHead, TipRow } from "../../../charts/kit";
import { day, duration, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Avatar, DataTable, type Column, Loading, signed } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { ButtonLink, NoData, Segmented } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { cellTone, chartsHref, fill, numText, toneStep } from "./model";
import { ResponseActions, ScoresCell, rungsOf, shortDateTime, useResponsePages } from "./views";

/*
 * Срез «Один пацієнт» (analytics-tests-patient): как этот человек проходил
 * эту методику.
 *
 * Порядок — порядок разговора на приёме: кто это → его прохождения с
 * изменением от старта и время каждого → куда двигались баллы по лестнице
 * каждой шкалы (график курса карточки) → какие ответы менялись от раза к
 * разу.
 */

const VERDICT_KEY: Record<ChangeVerdict, "course.v.better" | "course.v.worse" | "course.v.changed" | "kit.withinError" | "course.v.unknown"> = {
  better: "course.v.better",
  worse: "course.v.worse",
  changed: "course.v.changed",
  within: "kit.withinError",
  unknown: "course.v.unknown",
};

export function PatientView({
  data,
  dynamics,
  slice,
}: {
  data: SurveyAnalytics;
  dynamics: RespondentDynamics | null;
  slice: AnalyticsSlice;
}) {
  const { ut } = useLang();
  const sid = data.surveyId;
  const pages = useResponsePages(sid, { ...slice, versionId: data.versionId ?? undefined });
  const mine = dynamics?.surveys.find((s) => s.surveyId === sid);
  /* сигналы на оси курса — из хронологии человека, как в его карточке */
  const timeline = useResource(() => api.timeline(slice.userId!), [slice.userId], { enabled: !!slice.userId && !!mine?.scales.length });
  const events = useMemo(() => courseEventsFromTimeline(timeline.data ?? []), [timeline.data]);
  const timed = pages.rows.filter((r) => r.status === "completed" && r.durationMs > 0);

  /*
   * Ни одного прохождения под фильтрами — одна фраза вместо четырёх пустых
   * панелей: четыре «даних поки немає» подряд читаются как поломка экрана.
   */
  if (data.started === 0) {
    return (
      <div className="flex flex-col gap-4">
        {dynamics ? <PersonHead dynamics={dynamics} /> : null}
        <Panel>
          <p className="m-0 text-body text-text-2">{ut("ant.noPatientResponses")}</p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {dynamics ? <PersonHead dynamics={dynamics} /> : null}

      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-stretch gap-4 max-[1280px]:grid-cols-[minmax(0,1fr)_340px] max-[1100px]:grid-cols-1">
        <Panel title={ut("ant.patientResponses")} icon={<Ic.list />} count={pages.rows.length || null} flush>
          <PatientResponses rows={pages.rows} loading={pages.loading} error={pages.error} onRetry={pages.reload} surveyId={sid} dynamics={mine?.scales ?? []} data={data} />
        </Panel>
        <Panel title={ut("ant.timeByResponse")} icon={<Ic.timer />} sub={ut("ant.newestFirst")}>
          {timed.length ? (
            <HBars
              items={timed.map((r) => ({
                key: r.id,
                label: day(r.submittedAt ?? r.startedAt),
                value: r.durationMs,
                text: duration(r.durationMs),
              }))}
            />
          ) : (
            <NoData />
          )}
          <p className="m-0 mt-3 text-small text-text-2">
            {data.quality.length ? fill(ut("ant.patientFastSome"), { n: data.quality.length, of: data.completed }) : ut("ant.patientFastNone")}
          </p>
        </Panel>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_520px] items-start gap-4 max-[1360px]:grid-cols-1">
        <Panel title={ut("ant.patientDynamics")} icon={<Ic.chart />} sub={ut("ant.dynamicsSub")} hint={ut("ant.dynamicsCaption")}>
          {mine?.scales.length ? (
            <div className="flex flex-col gap-6">
              {mine.scales.map((sc, i) => {
                /* лестница — по коду шкалы: id у версий разные, код один */
                const scale = data.scales.find((s) => s.code === sc.code);
                const rungs = scale ? rungsOf(scale) : [];
                const course = courseFromDynamics(sc, rungs);
                return (
                  <section key={sc.code} className={cx(i > 0 && "border-t border-divider pt-5")} aria-label={sc.title}>
                    <p className="m-0 mb-2 flex items-baseline gap-2">
                      <b className="text-h3 font-extrabold text-text">{sc.title}</b>
                      <span className="text-caption text-muted">{sc.code}</span>
                    </p>
                    <CourseChart
                      title={sc.title}
                      points={course.points}
                      rungs={course.rungs}
                      max={rungs.length ? null : (scale?.maxPossible ?? sc.points[0]?.maxScore ?? null)}
                      rc={course.rc}
                      better={course.better}
                      normalization={course.normalization}
                      events={events}
                    />
                  </section>
                );
              })}
            </div>
          ) : (
            <NoData />
          )}
        </Panel>
        <AnswersPanel data={data} surveyId={sid} />
      </div>
    </div>
  );
}

/**
 * Кто это: кружок, имя (на карточку), возраст и сколько раз проходил эту
 * методику. Строки открытого (сигнал, неявка, сообщение) здесь нет: у
 * аналитики нет одного запроса на всё открытое по человеку, а собирать её
 * из пяти — работа карточки пациента, куда ведёт кнопка.
 */
function PersonHead({ dynamics }: { dynamics: RespondentDynamics }) {
  const { ut } = useLang();
  const to = `/patients/${dynamics.userId}`;
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-3.5">
        <Avatar name={dynamics.fullName} size={44} />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 text-[22px] font-extrabold leading-7 tracking-[-0.02em] text-text">
            <Link to={to} className="text-text no-underline hover:text-violet-ink hover:underline">
              {dynamics.fullName}
            </Link>
          </h2>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-2">
            {dynamics.age !== null ? (
              <span className="inline-flex items-center gap-1.5">
                <Ic.user size={14} className="text-muted" />
                <b className="font-extrabold text-text">{fill(ut("ant.ageN"), { n: dynamics.age })}</b>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Ic.clipboard size={14} className="text-muted" />
              {fill(ut("ant.testsTaken"), { n: dynamics.surveys.length })}
            </span>
          </span>
        </div>
        <ButtonLink to={to} className="ml-auto">
          <Ic.external size={15} />
          {ut("ant.openCard")}
        </ButtonLink>
      </div>
    </Panel>
  );
}

type Dyn = RespondentDynamics["surveys"][number]["scales"][number];

/**
 * Прохождения человека: дата с днём недели и версией, время, баллы и —
 * под баллом главной шкалы — сдвиг от первого замера со словом надёжности
 * (тот же порог, что у графика курса).
 */
function PatientResponses({
  rows,
  loading,
  error,
  onRetry,
  surveyId,
  dynamics,
  data,
}: {
  rows: SurveyResponse[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  surveyId: string;
  dynamics: Dyn[];
  data: SurveyAnalytics;
}) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const main = dynamics[0] ?? null;
  const points = main ? [...main.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)) : [];
  const first = points[0] ?? null;
  const scale = main ? data.scales.find((s) => s.code === main.code) : undefined;
  const rc = main ? reliableThreshold(main) : null;
  const better = scale ? betterOf(rungsOf(scale)) : null;

  if (error && !rows.length) return <Loading bare error={error} onRetry={onRetry} />;
  if (loading) return <Loading bare rows={3} />;
  if (!rows.length) return <p className="m-0 px-4 pb-4 pt-1 text-small text-muted">{ut("ant.noResponses")}</p>;

  const changeOf = (r: SurveyResponse) => {
    if (!first || r.status !== "completed") return null;
    const p = points.find((x) => x.responseId === r.id);
    if (!p) return null;
    if (p.responseId === first.responseId) return ut("kit.courseStart");
    const delta = Math.round((p.rawScore - first.rawScore) * 100) / 100;
    return `${fill(ut("ant.fromStart"), { d: signed(delta), date: day(first.submittedAt) })}, ${ut(VERDICT_KEY[changeVerdict(delta, rc, better)])}`;
  };
  const weekday = (iso: string) => new Date(iso).toLocaleDateString(locale(), { weekday: "short" });

  const columns: Column<SurveyResponse>[] = [
    {
      key: "date",
      header: ut("ant.colDate"),
      required: true,
      width: 150,
      render: (r) => (
        <span className="flex flex-col">
          <Link to={chartsHref(surveyId, r.id)} className="whitespace-nowrap font-bold text-violet-ink no-underline hover:underline">
            {shortDateTime(r.submittedAt ?? r.startedAt)}
          </Link>
          <small className="text-caption text-muted">
            {weekday(r.submittedAt ?? r.startedAt)}
            {r.versionNumber ? `, ${fill(ut("ant.versionN"), { n: r.versionNumber })}` : ""}
          </small>
        </span>
      ),
    },
    { key: "time", header: ut("an.time"), required: true, width: 96, render: (r) => <span className="whitespace-nowrap text-text-2">{duration(r.durationMs)}</span> },
    {
      key: "scores",
      header: ut("an.scores"),
      required: true,
      render: (r) => {
        const change = changeOf(r);
        return (
          <span className="flex flex-col gap-0.5">
            <ScoresCell r={r} />
            {change ? <small className="text-caption text-muted">{change}</small> : null}
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      label={ut("ant.patientResponses")}
      onRowClick={(r) => navigate(chartsHref(surveyId, r.id))}
      rowActions={(r) => <ResponseActions surveyId={surveyId} r={r} />}
      sticky={false}
    />
  );
}

/**
 * Тон клетки матрицы — ступени лестницы h1…h5 набора (та же, что у
 * тепловой таблицы), текст — её пара h1i…h5i: читается в обеих темах.
 */
const TONE = [
  "bg-[var(--h1)] text-[var(--h1i)]",
  "bg-[var(--h2)] text-[var(--h2i)]",
  "bg-[var(--h3)] text-[var(--h3i)]",
  "bg-[var(--h4)] text-[var(--h4i)]",
  "bg-[var(--h5)] text-[var(--h5i)]",
] as const;

/** «Як змінювались відповіді»: матрица с отбором «лише змінені» */
function AnswersPanel({ data, surveyId }: { data: SurveyAnalytics; surveyId: string }) {
  const { ut } = useLang();
  const [only, setOnly] = useState<"all" | "changed">("all");
  const m = data.answerMatrix;
  return (
    <Panel
      title={ut("ant.answersChange")}
      icon={<Ic.list />}
      flush
      actions={
        m?.responses.length ? (
          <Segmented
            label={ut("ant.answersPick")}
            value={only}
            onChange={setOnly}
            items={[
              { key: "all", label: ut("ant.answersAll") },
              { key: "changed", label: ut("ant.answersChanged") },
            ]}
          />
        ) : null
      }
    >
      {m?.responses.length ? (
        <>
          <p className="m-0 px-4 pb-3 text-small text-text-2">{fill(ut("ant.answersCaption"), { n: m.responses.length })}</p>
          <Matrix matrix={m} surveyId={surveyId} onlyChanged={only === "changed"} />
        </>
      ) : (
        <div className="px-4 pb-4">
          <NoData />
        </div>
      )}
    </Panel>
  );
}

/**
 * «Пункт × прохождение»: что человек выбирал от раза к разу.
 *
 * В клетке — балл выбранного варианта, тон — балл от максимума пункта
 * ступенями лестницы; наведение и фокус дают сам вариант словами. Кольцо —
 * «змінював відповідь перед здачею»: это пометка о сомнении, а не тяжесть,
 * поэтому формой, а не цветом. Последняя колонка — сдвиг от первого
 * прохождения к последнему.
 */
function Matrix({ matrix, surveyId, onlyChanged }: { matrix: AnswerMatrix; surveyId: string; onlyChanged: boolean }) {
  const { ut } = useLang();
  const rows = onlyChanged ? matrix.rows.filter((r) => r.cells.some((c) => c?.changed)) : matrix.rows;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-small">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] border-y border-divider bg-panel-2 py-2 pl-4 pr-3 text-left text-caption font-bold text-muted">
              {ut("an.item")}
            </th>
            {matrix.responses.map((r) => (
              <th key={r.id} scope="col" className="w-[64px] border-y border-divider bg-panel-2 px-1 py-2 text-center text-caption font-bold text-muted">
                <Link to={chartsHref(surveyId, r.id)} className="text-muted no-underline hover:text-violet-ink">
                  {r.submittedAt ? new Date(r.submittedAt).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" }) : "—"}
                </Link>
              </th>
            ))}
            <th scope="col" className="w-[64px] border-y border-divider bg-panel-2 py-2 pl-1 pr-4 text-center text-caption font-bold text-muted">
              {ut("ant.colChange")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const scored = row.cells.filter((c) => c && !c.skipped && c.score !== null);
            const firstScore = scored[0]?.score ?? null;
            const lastScore = scored.at(-1)?.score ?? null;
            const delta = scored.length > 1 && firstScore !== null && lastScore !== null ? lastScore - firstScore : null;
            return (
              <tr key={row.questionId}>
                <th scope="row" className="sticky left-0 z-[1] max-w-[260px] border-b border-divider bg-panel py-1.5 pl-4 pr-3 text-left font-semibold text-text-2">
                  <span className="flex items-baseline gap-2">
                    <span className="w-5 shrink-0 text-caption tabular-nums text-muted">{row.position + 1}</span>
                    <span className="line-clamp-2">{row.title}</span>
                  </span>
                </th>
                {row.cells.map((c, i) => {
                  const tone = c ? cellTone(c.score, row.maxScore) : null;
                  const answer = c === null ? "—" : c.skipped ? ut("ant.cellSkipped") : (c.label ?? ut("ant.cellHidden"));
                  return (
                    <td key={matrix.responses[i]?.id ?? i} className="border-b border-divider px-1 py-1.5 text-center">
                      <span
                        tabIndex={0}
                        data-tone={tone === null ? undefined : toneStep(tone)}
                        className={cx(
                          "group/row relative mx-auto grid h-[26px] w-[34px] cursor-default place-items-center rounded-[7px] text-caption font-extrabold outline-none",
                          "hover:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)] focus-visible:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)]",
                          c === null
                            ? "text-muted shadow-[inset_0_0_0_1px_var(--border)]"
                            : c.skipped
                              ? "bg-sunk italic text-muted"
                              : tone === null
                                ? "bg-sunk text-text-2"
                                : TONE[toneStep(tone)],
                          c?.changed && "ring-[1.5px] ring-text-2 ring-offset-2 ring-offset-panel",
                        )}
                      >
                        {c === null ? "—" : c.skipped ? "·" : c.score !== null ? numText(c.score) : <Ic.check size={12} />}
                        <RowTip>
                          <TipHead note={matrix.responses[i]?.submittedAt ? day(matrix.responses[i]!.submittedAt!) : undefined}>
                            {`${row.position + 1}. ${row.title}`}
                          </TipHead>
                          <TipRow value={answer} />
                          {c?.changed ? <TipRow value={ut("ant.cellChanged")} /> : null}
                        </RowTip>
                      </span>
                    </td>
                  );
                })}
                <td className="border-b border-divider py-1.5 pl-1 pr-4 text-center text-caption font-extrabold tabular-nums text-text-2">
                  {delta === null ? "" : delta === 0 ? "0" : signed(delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 px-4 py-3 text-caption font-semibold text-text-2">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cx("grid h-[18px] w-[22px] place-items-center rounded-[5px] text-[11px] font-extrabold", TONE[0])}>
            0
          </span>
          {ut("ant.legendLow")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cx("grid h-[18px] w-[22px] place-items-center rounded-[5px] text-[11px] font-extrabold", TONE[4])}>
            ↑
          </span>
          {ut("ant.legendHigh")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="grid h-[18px] w-[22px] place-items-center rounded-[5px] bg-sunk text-[11px] ring-[1.5px] ring-text-2 ring-offset-1 ring-offset-panel" />
          {ut("ant.cellChanged")}
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="grid h-[18px] w-[22px] place-items-center rounded-[5px] bg-sunk text-[11px] italic text-muted">
            ·
          </span>
          {ut("ant.cellSkipped")}
        </li>
      </ul>
    </div>
  );
}
