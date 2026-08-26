import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RespondentDynamics } from "@quizzy/shared";
import { api, openInTab } from "../api";
import { Chart, LineChart } from "../charts";
import { Radar, SeverityTag } from "../charts/advanced";
import { day, severityColor } from "../format";
import { useAction } from "../ui";

export function PatientList() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.respondents>> | null>(null);
  useEffect(() => {
    api.respondents().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>Пациенты</h1>
      <p className="sub">Только те, кто проходил методики ваших групп</p>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>ФИО</th><th>Email</th><th className="num">Прохождений</th><th>Последнее</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td><Link to={`/patients/${r.userId}`}>{r.fullName}</Link></td>
                <td className="muted">{r.email}</td>
                <td className="num">{r.count}</td>
                <td className="muted">{r.last?.slice(0, 10) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function PatientDynamics() {
  const { userId } = useParams<{ userId: string }>();
  const [data, setData] = useState<RespondentDynamics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useAction();

  useEffect(() => {
    if (!userId) return;
    api.dynamics(userId).then(setData).catch((e) => setError(e.message));
  }, [userId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>{data.fullName}</h1>
      <p className="sub">{data.email} · <Link to="/patients">все пациенты</Link></p>

      {data.surveys.length === 0 ? <p className="muted">Завершённых прохождений нет</p> : null}

      {data.surveys.map((sv) => (
        <div key={sv.surveyId}>
          <div className="card">
            <h2>{sv.title}</h2>
            <p className="hint">
              {sv.responseCount} замеров · с {sv.firstAt?.slice(0, 10)} по {sv.lastAt?.slice(0, 10)}
            </p>
          </div>

          {sv.scales.length >= 3 ? (
            <Chart title="Профиль по субшкалам" hint="Последний замер против первого">
              <Radar
                axes={sv.scales.map((sc) => {
                  const p = sc.points.at(-1);
                  return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                })}
                compare={
                  sv.scales.some((sc) => sc.points.length > 1)
                    ? sv.scales.map((sc) => {
                        const p = sc.points[0];
                        return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                      })
                    : undefined
                }
              />
            </Chart>
          ) : null}

          <div className="grid cols-2">
            {sv.scales.map((sc) => {
              const last = sc.points.at(-1);
              return (
                <Chart
                  key={sc.scaleId}
                  title={sc.title}
                  hint={rciHint(sc)}
                >
                  <LineChart
                    yMax={last?.maxScore}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((p) => ({
                        x: day(p.submittedAt),
                        y: p.rawScore,
                        tone: p.severity ? severityColor[p.severity] : undefined,
                      })),
                    }]}
                  />
                  {last ? (
                    <table style={{ marginTop: 10 }}>
                      <tbody>
                        <tr><td>Последний замер</td><td className="num">{last.rawScore} из {last.maxScore}</td></tr>
                        {last.severity ? <tr><td>Интерпретация</td><td className="num"><SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} /></td></tr> : null}
                        {sc.reliableChange ? (
                          <tr>
                            <td>Достоверность сдвига</td>
                            <td className="num">
                              {sc.reliableChange.significant ? (
                                <strong style={{ color: "var(--accent)" }}>
                                  достоверный ({sc.reliableChange.direction === "up" ? "рост" : "снижение"}, RCI {sc.reliableChange.rci})
                                </strong>
                              ) : (
                                <span className="muted">в пределах ошибки (RCI {sc.reliableChange.rci})</span>
                              )}
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td>Перцентиль</td>
                          <td className="num">
                            {last.percentile === null ? <span className="muted">выборка мала</span> : `выше, чем у ${last.percentile}%`}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : null}
                  {last ? (
                    <button style={{ marginTop: 10 }} onClick={() => run(() => openInTab(api.reportUrl(last.responseId)))}>
                      Заключение
                    </button>
                  ) : null}
                </Chart>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Подпись под графиком: сырая дельта плюс вердикт достоверности.
 *
 * Дельта без RCI вводит в заблуждение: сдвиг на 13 T-баллов при широком
 * разбросе выборки — шум, а на 0.23 доли при α=0.92 — реальное изменение.
 */
function rciHint(sc: {
  delta: number | null;
  reliableChange: { rci: number; significant: boolean; basis: { sd: number; alpha: number; sampleN: number } } | null;
}): string {
  if (sc.delta === null) return "нужен второй замер для динамики";
  const base = `изменение: ${sc.delta > 0 ? "+" : ""}${sc.delta}`;
  const rc = sc.reliableChange;
  if (!rc) return `${base} · достоверность не оценить (мало выборки или одно-пунктовая шкала)`;
  return rc.significant
    ? `${base} · превышает ошибку измерения (RCI ${rc.rci}, α ${rc.basis.alpha})`
    : `${base} · в пределах ошибки измерения (RCI ${rc.rci}, α ${rc.basis.alpha})`;
}
