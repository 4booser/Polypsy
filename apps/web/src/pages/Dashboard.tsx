import { Link } from "react-router-dom";
import { api } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { duration, day, severityColor, severityKey } from "../format";
import { PpvCard } from "../components/CalibrationPanel";
import { Screen } from "../ui";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Num, SectionLabel } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";
import { Suggestions } from "../components/Suggestions";
import { DutyNow } from "../components/DutyNow";

export default function Dashboard() {
  const { ut } = useLang();

  /*
   * Три запроса одной загрузкой: экран без любого из них неполон, и показывать
   * его по частям значит подсовывать сводку, в которой чего-то не хватает без
   * объяснения.
   */
  const res = useResource(async () => {
    const [overview, surveys, alerts, work] = await Promise.all([
      api.overview(),
      api.surveys(),
      api.alertCases({ limit: "6" }),
      // очередь работы — то, с чего начинается день; её отказ не должен
      // прятать остальную сводку
      api.worklist().catch(() => ({ items: [], total: 0, truncated: false })),
    ]);
    return {
      data: overview,
      surveys,
      cases: alerts.items,
      openCases: alerts.total ?? alerts.items.length,
      work,
    };
  }, []);
  // сводка дежурного стареет от чужих действий: сдача, тревога, тик расписания
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], res.reload);

  return (
    <Screen res={res} rows={5}>
      {({ data, surveys, cases, openCases, work }) => (
        <Page title={ut("dash.title")} sub={ut("dash.sub")}>
          <Stack>
            {/*
              Порядок экрана задан, а не сложился: сначала то, что требует
              действия сегодня, потом показатели, потом обоснование. Раньше
              первой шла подтверждаемость тревог — важный, но справочный
              показатель, который стоял даже выше заголовка страницы.
            */}
            <DutyNow />
            {/*
              Предложения правил стоят выше очереди работы, но ниже тревог:
              это подсказка, а не сигнал. Если предложений нет, блок не
              рисуется вовсе — постоянный пустой заголовок быстро становится
              невидимым.
            */}
            <Suggestions />

            {openCases ? (
              /*
                Полоса случаев — единственное место сводки, где уместен янтарь:
                это ровно «требует внимания». Раньше она была красной, но
                красный в этой системе занят выраженностью, и полоса выглядела
                так, будто сама по себе означает тяжёлое состояние.
              */
              <Link
                to="/alerts"
                className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-accent-soft px-5 py-4 no-underline"
              >
                <span className="font-mono text-stat leading-none tabular-nums text-accent">{openCases}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-text">{ut("dash.casesOpen")}</span>
                  <span className="block truncate text-caption text-muted">
                    {cases.slice(0, 3).map((c) => c.userName).join(" · ")}
                    {openCases > 3 ? ` ${ut("ui.andMore")} ${openCases - 3}` : ""}
                  </span>
                </span>
                <span className="btn primary shrink-0">{ut("dash.review")}</span>
              </Link>
            ) : null}

            <Grid min={380}>
              <Panel
                title={ut("work.title")}
                actions={
                  <Link to="/worklist" className="text-caption text-muted no-underline hover:text-text">
                    <Num>{work.total}</Num> →
                  </Link>
                }
                flush
              >
                {work.items.length === 0 ? (
                  <p className="m-0 px-5 pb-5 text-caption text-muted">{ut("work.nothing")}</p>
                ) : (
                  <div className="flex flex-col">
                    {work.items.slice(0, 7).map((i) => (
                      <Link
                        key={i.id}
                        to={i.href ?? "/worklist"}
                        className="flex h-[var(--row-h)] items-center gap-3 border-t border-hairline px-5 text-small no-underline hover:bg-surface-2"
                      >
                        <i
                          aria-hidden
                          className="size-2 shrink-0 rounded-full bg-border-strong"
                          style={i.severity ? { background: severityColor[i.severity] } : undefined}
                        />
                        {/*
                          Имя занимает столько, сколько ему нужно, а растягивается
                          повод. Наоборот было хуже: имя расталкивало строку, и
                          повод убегал к правому краю — глазу приходилось
                          прыгать через полэкрана, чтобы связать одно с другим.
                        */}
                        <span className="shrink-0 truncate text-text">{i.userName}</span>
                        <span className="min-w-0 flex-1 truncate text-caption text-muted">{i.title}</span>
                        {i.overdue ? <span className="badge bad shrink-0">{ut("cases.overdue")}</span> : null}
                      </Link>
                    ))}
                  </div>
                )}
              </Panel>

              {data.inProgress.length ? (
                /*
                 * Кто прямо сейчас за экраном. Смысл в оперативности: если
                 * человек застрял или закрыл приложение посреди методики,
                 * специалист узнаёт об этом сегодня, а не при разборе
                 * назначений через месяц.
                 */
                <Panel
                  title={ut("dash.inProgress")}
                  actions={<Num className="text-caption text-muted">{data.inProgress.length}</Num>}
                  flush
                >
                  <div className="flex flex-col">
                    {data.inProgress.slice(0, 6).map((r) => (
                      <div
                        key={r.responseId}
                        className="flex h-[var(--row-h)] items-center gap-3 border-t border-hairline px-5 text-small"
                      >
                        <span className="live-dot" />
                        <span className="min-w-0 flex-1 truncate">{r.surveyTitle}</span>
                        <Num className="text-caption text-muted">
                          {duration(Date.now() - new Date(r.lastSavedAt).getTime())}
                        </Num>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}
            </Grid>

            {/*
              Показатели — одной панелью с разделителями, а не четырьмя
              карточками. Четыре отдельные карточки читались как четыре
              самостоятельных блока; на деле это один ряд одного порядка, и
              сравнивают их между собой, а не с очередью работы.
            */}
            <Panel flush>
              <div className="grid grid-cols-2 divide-x divide-y divide-hairline md:grid-cols-4 md:divide-y-0">
                <Figure label={ut("dash.responses")} value={data.responseCount} hint={`${ut("dash.completion")} ${data.completionRate}%`} />
                <Figure label={ut("dash.respondents")} value={data.respondentCount} />
                <Figure label={ut("dash.surveys")} value={data.surveyCount} hint={`${ut("dash.published")} ${data.publishedCount}`} />
                <Figure label={ut("dash.avgTime")} value={duration(data.avgDurationMs)} />
              </div>
            </Panel>

            {/* подтверждаемость — справочный показатель качества скрининга:
                он объясняет цифры выше, а не требует действия */}
            <PpvCard />

            <Chart title={ut("dash.timeline")} hint={ut("dash.timelineHint")}>
              <LineChart
                area
                series={[{ label: ut("cl.responses"), points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]}
              />
            </Chart>

            <Grid min={380}>
              {data.severityBreakdown.length ? (
                <Chart title={ut("dash.severity")} hint={ut("dash.severityHint")}>
                  <Donut
                    center={String(data.severityBreakdown.reduce((s, x) => s + x.count, 0))}
                    centerLabel={ut("chart.results")}
                    slices={data.severityBreakdown.map((s) => ({
                      label: ut(severityKey[s.severity]),
                      value: s.count,
                      color: severityColor[s.severity],
                    }))}
                  />
                </Chart>
              ) : null}

              <Chart title={ut("dash.load")} hint={ut("dash.loadHint")}>
                <BarList
                  items={data.topSurveys.map((s) => ({
                    label: s.title,
                    value: s.responseCount,
                    caption: `${ut("chart.onAverage")} ${duration(s.avgDurationMs)}`,
                  }))}
                />
              </Chart>
            </Grid>

            <Panel title={ut("dash.allSurveys")} hint={ut("dash.allSurveysHint")} flush>
              <div className="overflow-x-auto px-5 pb-5">
                <table>
                  <thead>
                    <tr>
                      <th>{ut("dash.survey")}</th>
                      <th>{ut("cl.status")}</th>
                      <th>{ut("cl.visibility")}</th>
                      <th className="num">{ut("cl.questions")}</th>
                      <th className="num">{ut("cl.responses")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {surveys.map((s) => (
                      <tr key={s.id}>
                        <td><Link to={`/surveys/${s.id}`}>{s.title}</Link></td>
                        <td className="text-muted">{s.status}</td>
                        <td className="text-muted">
                          {s.visibility === "restricted" ? ut("cl.byGrant") : ut("dash.public")}
                        </td>
                        <td className="num">{s.questionCount}</td>
                        <td className="num">{s.responseCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </Stack>
        </Page>
      )}
    </Screen>
  );
}

/**
 * Показатель в ряду.
 *
 * Число первым, подпись под ним, пояснение ещё ниже. Порядок именно такой,
 * потому что ряд читают сканированием сверху вниз по числам, а подпись
 * нужна только там, где взгляд остановился.
 */
function Figure({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 p-4">
      <span className="font-mono text-stat leading-none tracking-[-0.03em] tabular-nums">{value}</span>
      <SectionLabel>{label}</SectionLabel>
      {hint ? <span className="text-caption text-muted">{hint}</span> : null}
    </div>
  );
}
