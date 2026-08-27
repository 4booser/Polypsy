import { useEffect, useState } from "react";
import { api } from "../api";
import { Loading } from "../ui";

/**
 * Калибровка порогов по клиническим исходам.
 *
 * Показывает две вещи рядом: как работает ДЕЙСТВУЮЩИЙ порог пособия на нашей
 * выборке и какой порог предложил бы индекс Юдена. Публиковать кандидата
 * можно только при достаточном числе исходов обоих видов — иначе кривая
 * рисует шум, а не популяцию.
 */
export function CalibrationPanel({ surveyId }: { surveyId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.calibration>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.calibration(surveyId).then(setData).catch((e) => setError(e.message));
  }, [surveyId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading />;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Калибровка порогов по исходам</h2>
          <span className="hint">разобранных случаев: {data.cases}</span>
        </div>
        <p className="hint">
          Сравниваются баллы и клинические исходы разбора тревог. «Требует наблюдения» не
          учитывается: это отложенное решение, а не диагноз. Кандидатный порог показывается
          только при {data.minPerOutcome} подтверждённых и {data.minPerOutcome} не подтверждённых
          случаях в страте — на меньшем кривая описывает шум.
        </p>
        {data.cases === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Исходов пока нет. Они появляются, когда специалист при разборе тревоги указывает,
            подтвердился риск или нет.
          </p>
        ) : null}
      </div>

      {data.scales.map((scale) => (
        <div className="card scroll-x" key={scale.code}>
          <div className="card-head">
            <h2>{scale.code} — {scale.title}</h2>
            <span className="hint">
              {scale.normalization === "tscore" ? "T-баллы" : scale.normalization}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Страта</th>
                <th className="num">Подтв.</th>
                <th className="num">Не подтв.</th>
                <th className="num">Действующий порог</th>
                <th className="num">Чувств.</th>
                <th className="num">Специф.</th>
                <th className="num">AUC</th>
                <th className="num">Кандидат (Юден)</th>
              </tr>
            </thead>
            <tbody>
              {scale.strata.map((s) => (
                <tr key={s.stratum}>
                  <td>{s.stratum}</td>
                  <td className="num">{s.confirmed}</td>
                  <td className="num">{s.notConfirmed}</td>
                  <td className="num">{s.currentThreshold ?? "—"}</td>
                  <td className="num">{s.currentSensitivity ?? "—"}</td>
                  <td className="num">{s.currentSpecificity ?? "—"}</td>
                  <td className="num">{s.roc ? s.roc.auc : <span className="muted">мало данных</span>}</td>
                  <td className="num">
                    {s.roc ? (
                      <span title={`чувствительность ${s.roc.bestSensitivity}, специфичность ${s.roc.bestSpecificity}`}>
                        {s.roc.bestThreshold}
                        <span className="muted" style={{ fontSize: 11 }}>
                          {" "}({s.roc.bestSensitivity}/{s.roc.bestSpecificity})
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            AUC — насколько балл вообще отличает подтверждённые случаи от неподтверждённых:
            0.5 — не отличает, выше 0.8 — хорошо. Кандидатный порог не применяется
            автоматически: перенос порога — решение специалиста, и оно публикуется новой
            версией методики.
          </p>
        </div>
      ))}
    </>
  );
}

/** PPV скрининга: доля подтверждённых среди разобранных — для Сводки */
export function PpvCard() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.ppv>> | null>(null);

  useEffect(() => {
    api.ppv().then(setData).catch(() => {});
  }, []);

  if (!data?.overall) return null;
  const trend = data.byMonth.slice(-6);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Подтверждаемость тревог</h2>
        <span className="hint">
          {data.overall.confirmed} из {data.overall.n} разобранных
          {data.withoutOutcome ? ` · без исхода: ${data.withoutOutcome}` : ""}
        </span>
      </div>
      <div className="tiles">
        <div className="tile">
          <span className="label">Всего</span>
          <span className="value">{data.overall.ppv}%</span>
        </div>
        {trend.map((m) => (
          <div className="tile" key={m.month}>
            <span className="label">{m.month}</span>
            <span className="value" style={{ fontSize: 20 }}>{m.ppv}%</span>
            <span className="label">{m.n} случ.</span>
          </div>
        ))}
      </div>
      <p className="hint">
        Падение подтверждаемости — ранний признак того, что выборка изменилась или персонал
        привык к ложным тревогам. Именно из-за этого скрининги тихо перестают работать.
      </p>
    </div>
  );
}
