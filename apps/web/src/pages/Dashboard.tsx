import { Link } from "react-router-dom";
import { api } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { duration, day, severityColor, severityKey, timeOfDay } from "../format";
import { PpvCard } from "../components/CalibrationPanel";
import { Badge, PageHead, Screen } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

export default function Dashboard() {
  const { ut } = useLang();

  /*
   * Три запроса одной загрузкой: экран без любого из них неполон, и показывать
   * его по частям значит подсовывать сводку, в которой чего-то не хватает без
   * объяснения.
   */
  const res = useResource(async () => {
    const [overview, surveys, alerts] = await Promise.all([
      api.overview(),
      api.surveys(),
      api.alertCases({ limit: "3" }),
    ]);
    return {
      data: overview,
      surveys,
      cases: alerts.items,
      openCases: alerts.total ?? alerts.items.length,
    };
  }, []);

  return (
    <Screen res={res} rows={5}>
      {({ data, surveys, cases, openCases }) => (
    <>
      {/*
        Порядок экрана задан, а не сложился: сначала то, что требует действия
        сегодня, потом показатели, потом обоснование. Раньше первой шла
        подтверждаемость тревог — важный, но справочный показатель, который
        стоял даже выше заголовка страницы.
      */}
      <PageHead title={ut("dash.title")} sub={ut("dash.sub")} />

      {cases.length ? (
        <div className="card alarm">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <div className="row tight">
              <Badge tone="bad">{ut("dash.needsReview")}</Badge>
              <strong>{ut("dash.casesOpen")}: {openCases}</strong>
            </div>
            <Link to="/alerts" className="btn primary">{ut("dash.review")}</Link>
          </div>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            {cases
              .map((c) => `${c.userName}${c.signalCount > 1 ? ` (сигналов ${c.signalCount})` : ""}`)
              .join(" · ")}
            {openCases > cases.length ? ` и ещё ${openCases - cases.length}` : ""}
          </p>
        </div>
      ) : null}

      {data.inProgress.length ? (
        /*
         * Кто прямо сейчас за экраном. Смысл в оперативности: если человек
         * застрял или закрыл приложение посреди методики, специалист узнаёт
         * об этом сегодня, а не при разборе незакрытых назначений через месяц.
         */
        <div className="card">
          <div className="card-head">
            <h2>{ut("dash.inProgress")}</h2>
            <span className="hint">{ut("dash.inProgressHint")} · {data.inProgress.length}</span>
          </div>
          {data.inProgress.slice(0, 8).map((r) => (
            <div className="row" key={r.responseId} style={{ padding: "5px 0", gap: 10 }}>
              <span className="live-dot" />
              <span style={{ flex: 1 }}>{r.surveyTitle}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                начал {timeOfDay(r.startedAt)} · сохранено {timeOfDay(r.lastSavedAt)}
              </span>
              {r.userId ? (
                <Link className="btn" to={`/patients/${r.userId}`}>{ut("dash.card")}</Link>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

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

      {/* подтверждаемость — справочный показатель качества скрининга: он
          объясняет цифры выше, а не требует действия, и место ему здесь */}
      <PpvCard />

      <Chart title={ut("dash.timeline")} hint={ut("dash.timelineHint")}>
        <LineChart
          area
          series={[{ label: "Прохождений", points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]}
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
        <h2>Все методики</h2>
        <p className="hint">Откройте методику, чтобы увидеть подробные срезы</p>
        <table>
          <thead>
            <tr>
              <th>Методика</th>
              <th>Статус</th>
              <th>Видимость</th>
              <th className="num">Вопросов</th>
              <th className="num">Прохождений</th>
            </tr>
          </thead>
          <tbody>
            {surveys.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/surveys/${s.id}`}>{s.title}</Link></td>
                <td className="muted">{s.status}</td>
                <td className="muted">{s.visibility === "restricted" ? "по назначению" : "общая"}</td>
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
