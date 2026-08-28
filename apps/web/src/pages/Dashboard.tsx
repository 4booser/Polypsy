import { Link } from "react-router-dom";
import { api } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { duration, day, severityColor, severityKey } from "../format";
import { PpvCard } from "../components/CalibrationPanel";
import { PageHead, Screen } from "../ui";
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
    <>
      {/*
        Порядок экрана задан, а не сложился: сначала то, что требует действия
        сегодня, потом показатели, потом обоснование. Раньше первой шла
        подтверждаемость тревог — важный, но справочный показатель, который
        стоял даже выше заголовка страницы.
      */}
      <PageHead title={ut("dash.title")} sub={ut("dash.sub")} />

      {/*
        Панель дежурного: слева — то, что требует действия сегодня, справа —
        показатели. Раньше экран был колонкой карточек, и «разобрать случай»
        стояло рядом со справочной подтверждаемостью тревог, будто это дела
        одного порядка.
      */}
      <div className="duty">
        <section className="duty-now">
          {/*
            Предложения правил стоят выше очереди работы, но ниже тревог:
            это подсказка, а не сигнал. Если предложений нет, блок не рисуется
            вовсе — постоянный пустой заголовок быстро становится невидимым.
          */}
          <DutyNow />
          <Suggestions />

          {openCases ? (
            <Link to="/alerts" className="duty-alarm">
              <span className="duty-alarm-num">{openCases}</span>
              <span className="duty-alarm-text">
                <strong>{ut("dash.casesOpen")}</strong>
                <span className="hint">
                  {cases
                    .slice(0, 3)
                    .map((c) => c.userName)
                    .join(" · ")}
                  {openCases > 3 ? ` ${ut("ui.andMore")} ${openCases - 3}` : ""}
                </span>
              </span>
              <span className="btn primary">{ut("dash.review")}</span>
            </Link>
          ) : null}

          <div className="card duty-work">
            <div className="card-head">
              <h2>{ut("work.title")}</h2>
              <Link to="/worklist" className="hint">
                {work.total} →
              </Link>
            </div>
            {work.items.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>{ut("work.nothing")}</p>
            ) : (
              work.items.slice(0, 7).map((i) => (
                <Link key={i.id} to={i.href ?? "/worklist"} className="duty-row">
                  <i
                    className="duty-dot"
                    style={i.severity ? { background: severityColor[i.severity] } : undefined}
                  />
                  <span className="grow">{i.userName}</span>
                  <span className="muted">{i.title}</span>
                  {i.overdue ? <span className="badge bad">{ut("cases.overdue")}</span> : null}
                </Link>
              ))
            )}
          </div>

          {data.inProgress.length ? (
            /*
             * Кто прямо сейчас за экраном. Смысл в оперативности: если человек
             * застрял или закрыл приложение посреди методики, специалист узнаёт
             * об этом сегодня, а не при разборе назначений через месяц.
             */
            <div className="card">
              <div className="card-head">
                <h2>{ut("dash.inProgress")}</h2>
                <span className="hint">{data.inProgress.length}</span>
              </div>
              {data.inProgress.slice(0, 6).map((r) => (
                <div className="duty-row" key={r.responseId}>
                  <span className="live-dot" />
                  <span className="grow">{r.surveyTitle}</span>
                  <span className="muted">{duration(Date.now() - new Date(r.lastSavedAt).getTime())}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="duty-figures">
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="tile">
          <div className="label">{ut("dash.responses")}</div>
          <div className="value">{data.responseCount}</div>
          <div className="hint">{ut("dash.completion")} {data.completionRate}%</div>
        </div>
        <div className="tile">
          <div className="label">{ut("dash.respondents")}</div>
          <div className="value">{data.respondentCount}</div>
        </div>
        <div className="tile">
          <div className="label">{ut("dash.surveys")}</div>
          <div className="value">{data.surveyCount}</div>
          <div className="hint">{ut("dash.published")} {data.publishedCount}</div>
        </div>
        <div className="tile">
          <div className="label">{ut("dash.avgTime")}</div>
          <div className="value">{duration(data.avgDurationMs)}</div>
        </div>
      </div>

          {/* подтверждаемость — справочный показатель качества скрининга:
              он объясняет цифры выше, а не требует действия */}
          <PpvCard />
        </section>
      </div>

      <Chart title={ut("dash.timeline")} hint={ut("dash.timelineHint")}>
        <LineChart
          area
          series={[{ label: ut("cl.responses"), points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]}
        />
      </Chart>

      <div className="grid cols-2">
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
          <BarList items={data.topSurveys.map((s) => ({ label: s.title, value: s.responseCount, caption: `${ut("chart.onAverage")} ${duration(s.avgDurationMs)}` }))} />
        </Chart>
      </div>

      <div className="card">
        <h2>{ut("dash.allSurveys")}</h2>
        <p className="hint">{ut("dash.allSurveysHint")}</p>
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
                <td className="muted">{s.status}</td>
                <td className="muted">{s.visibility === "restricted" ? ut("cl.byGrant") : ut("dash.public")}</td>
                <td className="num">{s.questionCount}</td>
                <td className="num">{s.responseCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
      )}
    </Screen>
  );
}
