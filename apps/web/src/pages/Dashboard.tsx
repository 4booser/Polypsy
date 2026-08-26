import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OverviewAnalytics, RiskAlert, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { BarList, Chart, Donut, LineChart } from "../charts";
import { duration, day, severityColor, severityLabel } from "../format";

export default function Dashboard() {
  const [data, setData] = useState<OverviewAnalytics | null>(null);
  const [surveys, setSurveys] = useState<SurveyListItem[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.overview(), api.surveys(), api.alerts()])
      .then(([o, s, a]) => {
        setData(o);
        setSurveys(s);
        setAlerts(a);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>Сводка</h1>
      <p className="sub">По методикам, доступным вам</p>

      {alerts.length ? (
        <div className="card" style={{ borderColor: "var(--sev-severe)" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <i className="dot" style={{ background: "var(--sev-severe)" }} />
              <strong>Неразобранных тревог: {alerts.length}</strong>
            </div>
            <Link to="/alerts" className="btn">Разобрать</Link>
          </div>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{alerts[0]!.label}</p>
        </div>
      ) : null}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="tile">
          <div className="label">Прохождений</div>
          <div className="value">{data.responseCount}</div>
          <div className="hint">доходимость {data.completionRate}%</div>
        </div>
        <div className="tile">
          <div className="label">Респондентов</div>
          <div className="value">{data.respondentCount}</div>
        </div>
        <div className="tile">
          <div className="label">Методик</div>
          <div className="value">{data.surveyCount}</div>
          <div className="hint">опубликовано {data.publishedCount}</div>
        </div>
        <div className="tile">
          <div className="label">Среднее время</div>
          <div className="value">{duration(data.avgDurationMs)}</div>
        </div>
      </div>

      <Chart title="Динамика прохождений" hint="Завершённые прохождения по дням">
        <LineChart
          area
          series={[{ label: "Прохождений", points: data.timeline.map((t) => ({ x: day(t.date), y: t.count })) }]}
        />
      </Chart>

      <div className="grid cols-2">
        {data.severityBreakdown.length ? (
          <Chart title="Выраженность по всем шкалам" hint="Сколько результатов попало в каждую категорию норм">
            <Donut
              center={String(data.severityBreakdown.reduce((s, x) => s + x.count, 0))}
              centerLabel="результатов"
              slices={data.severityBreakdown.map((s) => ({
                label: severityLabel[s.severity],
                value: s.count,
                color: severityColor[s.severity],
              }))}
            />
          </Chart>
        ) : null}

        <Chart title="Нагрузка по методикам" hint="Число завершённых прохождений">
          <BarList items={data.topSurveys.map((s) => ({ label: s.title, value: s.responseCount, caption: `в среднем ${duration(s.avgDurationMs)}` }))} />
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
  );
}
