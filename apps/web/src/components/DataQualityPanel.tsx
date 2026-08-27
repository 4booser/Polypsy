import { useEffect, useState } from "react";
import { api } from "../api";
import { Loading } from "../ui";

const SEX_LABEL: Record<string, string> = { male: "мужчины", female: "женщины" };

/**
 * Качество данных: кто доходит до конца, изменилась ли выборка, повторяемо ли
 * измерение. Вопросы, которые обычная аналитика не задаёт, — а без ответов на
 * них нормы и сравнения стоят на песке.
 */
export function DataQualityPanel({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.dataQuality>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dataQuality(surveyId).then(setData).catch((e) => setError(e.message));
  }, [surveyId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  const worst = data.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];

  return (
    <>
      <div className="card scroll-x">
        <div className="card-head">
          <h2>Доходимость по группам</h2>
          <span className="hint">группы меньше {data.smallCellFloor} скрыты</span>
        </div>
        {worst && (worst.completionRate ?? 100) < 80 ? (
          <p className="hint warn">
            {SEX_LABEL[worst.sex] ?? worst.sex} {worst.band}: доходит {worst.completionRate}%. Эта
            группа недопредставлена в нормах — их баллы посчитаны по тем, кто дошёл.
          </p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Пол</th><th>Возраст</th><th className="num">Начали</th>
              <th className="num">Завершили</th><th className="num">Доходимость</th>
              <th className="num">Пропущено пунктов</th>
            </tr>
          </thead>
          <tbody>
            {data.strata.map((s) => (
              <tr key={`${s.sex}-${s.band}`}>
                <td>{SEX_LABEL[s.sex] ?? s.sex}</td>
                <td className="muted">{s.band}</td>
                {s.suppressed ? (
                  <td colSpan={4} className="muted">
                    меньше {data.smallCellFloor} — не показывается
                  </td>
                ) : (
                  <>
                    <td className="num">{s.started}</td>
                    <td className="num">{s.completed}</td>
                    <td className="num">{s.completionRate}%</td>
                    <td className="num muted">{s.avgSkipped}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.drift.length ? (
        <div className="card scroll-x">
          <h2>Дрейф выборки</h2>
          <p className="hint">
            Насколько распределение баллов последнего месяца отличается от предыдущих (PSI).
            Больше 0.2 — выборка существенно изменилась, и локальные нормы, посчитанные
            раньше, могут ей не подходить.
          </p>
          <table>
            <thead>
              <tr><th>Шкала</th><th>Месяц</th><th className="num">n</th><th className="num">PSI</th><th>Вывод</th></tr>
            </thead>
            <tbody>
              {data.drift.map((d) => (
                <tr key={d.code}>
                  <td>{d.code} — {d.title}</td>
                  <td className="muted">{d.month}</td>
                  <td className="num">{d.n}</td>
                  <td className="num">{d.psi}</td>
                  <td style={{ color: d.psi > 0.2 ? "var(--sev-mild)" : undefined }}>{d.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card scroll-x">
        <h2>Повторяемость измерения</h2>
        <p className="hint">
          ICC по парам замеров одного человека с интервалом {data.retestWindow.minDays}–
          {data.retestWindow.maxDays} дней: раньше — человек помнит ответы, позже — состояние
          реально меняется, и то и другое уже не про надёжность инструмента. Оценка независима
          от альфы: та говорит о согласованности пунктов, эта — о стабильности во времени.
        </p>
        <table>
          <thead>
            <tr><th>Шкала</th><th className="num">Пар</th><th className="num">ICC</th></tr>
          </thead>
          <tbody>
            {data.retest.map((r) => (
              <tr key={r.code}>
                <td>{r.code} — {r.title}</td>
                <td className="num">{r.pairs}</td>
                <td className="num">
                  {r.icc === null ? (
                    <span className="muted">нужно ≥{data.retestWindow.minPairs} пар</span>
                  ) : (
                    r.icc
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
