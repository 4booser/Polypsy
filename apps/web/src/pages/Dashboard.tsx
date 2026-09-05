import { Link } from "react-router-dom";
import { api } from "../api";
import { BarList, Chart, Donut, LineChart, StackedArea } from "../charts";
import { duration, day, severityColor, severityKey } from "../format";
import { Screen } from "../ui";
import { Panel, Grid, Stack } from "../ui/layout";
import { Num, SectionLabel } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";
import { Suggestions } from "../components/Suggestions";

export default function Dashboard() {
  const { ut } = useLang();

  /*
   * Три запроса одной загрузкой: экран без любого из них неполон, и показывать
   * его по частям значит подсовывать сводку, в которой чего-то не хватает без
   * объяснения.
   */
  const res = useResource(async () => {
    const [overview, surveys, alerts, work, trend] = await Promise.all([
      api.overview(),
      api.surveys(),
      api.alertCases({ limit: "6" }),
      // очередь работы — то, с чего начинается день; её отказ не должен
      // прятать остальную сводку
      api.worklist().catch(() => ({ items: [], total: 0, truncated: false })),
      // то же и с рядом по неделям: он объясняет кольцо рядом, а не заменяет
      // сводку, и его отказ не повод прятать всё остальное
      api.severityTrend().catch(() => ({ weeks: [], unbanded: 0 })),
    ]);
    return {
      data: overview,
      surveys,
      trend,
      /*
       * Не имена, а то, что помогает решить, идти ли разбирать сейчас.
       *
       * Сами случаи со сводки больше не нужны: имена людей со сработавшей
       * тревогой на первом экране — это раскрытие того самого факта, ради
       * сокрытия которого в системе есть коды вместо имён и спрятанный
       * телефон.
       */
      urgentCases: alerts.items.filter((x) => x.severity === "severe").length,
      oldestCaseDays: alerts.items.length
        ? Math.max(
            ...alerts.items.map((x) =>
              Math.floor((Date.now() - new Date(x.openedAt).getTime()) / 86_400_000),
            ),
          )
        : 0,
      openCases: alerts.total ?? alerts.items.length,
      work,
    };
  }, []);
  // сводка дежурного стареет от чужих действий: сдача, тревога, тик расписания
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], res.reload);

  return (
    <Screen res={res} rows={5}>
      {({ data, surveys, trend, urgentCases, oldestCaseDays, openCases, work }) => (
        <>
          <Stack>
            {/*
              Порядок экрана задан, а не сложился: сначала то, что требует
              действия сегодня, потом показатели, потом обоснование. Раньше
              первой шла подтверждаемость тревог — важный, но справочный
              показатель, который стоял даже выше заголовка страницы.
            */}
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
                  {/*
                    Здесь стояли три фамилии людей со сработавшей тревогой
                    риска — на стартовом экране, который открывается первым и
                    висит на мониторе весь день.

                    Система в остальном бережёт ровно этот факт: анонимный
                    аккаунт виден специалисту как «Респондент А-4821», телефон
                    спрятан из списков, а его показ пишется в журнал. Три
                    фамилии людей с суицидальным риском для любого, кто
                    прошёл мимо, отменяли всё это одной строкой.

                    Вместо имён — то, что помогает решить, идти ли разбирать
                    прямо сейчас: сколько срочных и сколько ждёт самый давний.
                    Имена в двух нажатиях, на экране разбора, куда просто так
                    не заглядывают.
                  */}
                  <span className="block truncate text-caption text-muted">
                    {urgentCases > 0
                      ? `${ut("dash.casesUrgent").replace("{n}", String(urgentCases))} · `
                      : ""}
                    {ut("dash.casesOldest").replace("{n}", String(oldestCaseDays))}
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
                        {/*
                          Сначала то, что различает строки, потом общее.
                          На экране очереди это уже сделано, а здесь осталась
                          своя отрисовка: семь строк подряд с одинаковой
                          методикой и одинаковой точкой, различающиеся только
                          фамилией. Выбрать, за что взяться, по такому списку
                          нельзя — а открывают именно сводку.
                        */}
                        <span className="shrink-0 truncate text-text">{i.userName}</span>
                        {i.signals ? (
                          <span className="shrink-0 text-caption text-muted">
                            <Num>{i.signals}</Num>
                          </span>
                        ) : null}
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

            <Chart title={ut("dash.timeline")} hint={ut("dash.timelineHint")}>
              <LineChart
                area
                series={[{ label: ut("cl.responses"), points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]}
              />
            </Chart>

            {/*
              Кольцо ниже отвечает на вопрос «сколько тяжёлых всего», и это не
              тот вопрос, который задают на планёрке. Спрашивают, становится ли
              их больше, — а одно и то же кольцо получается и когда тяжёлые
              копились полгода ровно, и когда все пришли на прошлой неделе.
              Поэтому ряд по неделям стоит выше кольца, а не вместо него: итог
              за всё время тоже нужен, но вторым.
            */}
            {trend.weeks.length > 1 ? (
              <Chart title={ut("dash.severityTrend")} hint={ut("dash.severityTrendHint")}>
                <StackedArea
                  x={trend.weeks.map((w) => day(w.week))}
                  total={ut("dash.severityTrendTotal")}
                  /*
                   * Снизу вверх — от спокойных к срочным. Порядок не по
                   * величине: степени выраженности упорядочены сами по себе, и
                   * перестановка слоёв ради «покрасивее» сломала бы главное
                   * свойство графика — узнаваемость с одного взгляда. Срочные
                   * сверху ещё и потому, что верхняя кромка читается лучше
                   * прочих, а следят именно за ними.
                   */
                  series={(["none", "mild", "moderate", "severe"] as const).map((sev) => ({
                    label: ut(severityKey[sev]),
                    color: severityColor[sev],
                    values: trend.weeks.map((w) => w[sev]),
                  }))}
                />
                {trend.unbanded > 0 ? (
                  /* прохождения без полос норм не попадают ни в один слой:
                     промолчать о них значило бы занизить все четыре */
                  <p className="hint">
                    {ut("dash.severityTrendUnbanded")}: <Num>{trend.unbanded}</Num>
                  </p>
                ) : null}
              </Chart>
            ) : null}

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
        </>
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
