import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";

// ключи: карта вне компонента, перевод берётся при отрисовке
const SEX_KEY = { male: "dq.men", female: "dq.women" } as const;

/**
 * Качество данных: кто доходит до конца, изменилась ли выборка, повторяемо ли
 * измерение. Вопросы, которые обычная аналитика не задаёт, — а без ответов на
 * них нормы и сравнения стоят на песке.
 */
export function DataQualityPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const sexLabel = (sex: string) =>
    sex in SEX_KEY ? ut(SEX_KEY[sex as keyof typeof SEX_KEY]) : sex;
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.dataQuality(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  const worst = data.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];

  return (
    <>
      <div className="card scroll-x">
        <div className="card-head">
          <h2>{ut("dq.completionTitle")}</h2>
          <span className="hint">
            {ut("dq.groupsSmallerThan")} {data.smallCellFloor} {ut("dq.areHidden")}
          </span>
        </div>
        {worst && (worst.completionRate ?? 100) < 80 ? (
          <p className="hint warn">
            {sexLabel(worst.sex)} {worst.band}: {ut("dq.reaches")} {worst.completionRate}%.{" "}
            {ut("dq.underrepresented")}
          </p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>{ut("dq.sex")}</th><th>{ut("dq.age")}</th><th className="num">{ut("dq.started")}</th>
              <th className="num">{ut("dq.finished")}</th><th className="num">{ut("dq.completion")}</th>
              <th className="num">{ut("dq.skippedItems")}</th>
            </tr>
          </thead>
          <tbody>
            {data.strata.map((s) => (
              <tr key={`${s.sex}-${s.band}`}>
                <td>{sexLabel(s.sex)}</td>
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
          <h2>{ut("dq.driftTitle")}</h2>
          <p className="hint">
            Насколько распределение баллов последнего месяца отличается от предыдущих (PSI).
            Больше 0.2 — выборка существенно изменилась, и локальные нормы, посчитанные
            раньше, могут ей не подходить.
          </p>
          <table>
            <thead>
              <tr><th>{ut("dq.scale")}</th><th>{ut("dq.month")}</th><th className="num">n</th><th className="num">PSI</th><th>{ut("dq.verdict")}</th></tr>
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
        <h2>{ut("dq.repeatTitle")}</h2>
        <p className="hint">
          ICC по парам замеров одного человека с интервалом {data.retestWindow.minDays}–
          {data.retestWindow.maxDays} дней: раньше — человек помнит ответы, позже — состояние
          реально меняется, и то и другое уже не про надёжность инструмента. Оценка независима
          от альфы: та говорит о согласованности пунктов, эта — о стабильности во времени.
        </p>
        <table>
          <thead>
            <tr><th>{ut("dq.scale")}</th><th className="num">{ut("dq.pairs")}</th><th className="num">ICC</th></tr>
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
