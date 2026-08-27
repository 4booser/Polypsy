import { useEffect, useState } from "react";
import type { UnitReport as Report } from "@quizzy/shared";
import { api } from "../api";
import { severityColor, severityKey } from "../format";
import { useLang } from "../lang";
import { Empty, Loading, PageHead, useUrlState } from "../ui";

/**
 * Состояние подразделения за период.
 *
 * Отвечает на вопрос начальника отделения — «что с людьми», — не давая при
 * этом посмотреть на конкретного человека: для этого есть карта пациента, и
 * она под другим доступом.
 *
 * Малые ячейки скрыты и помечены прочерком, а не нулём. В роте на двенадцать
 * человек строка «выраженная: 1» указывает на конкретного, и по ней его
 * узнают сослуживцы; ноль же читался бы как «таких нет».
 */
export default function UnitReportPage() {
  const { ut } = useLang();
  const [unit, setUnit] = useUrlState("unit");
  const [from, setFrom] = useUrlState("from");
  const [to, setTo] = useUrlState("to");
  const [units, setUnits] = useState<string[]>([]);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.unitReportUnits().then(setUnits).catch(() => {});
  }, []);

  useEffect(() => {
    if (!unit) {
      setData(null);
      return;
    }
    setError(null);
    api
      .unitReport(unit, from || undefined, to || undefined)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [unit, from, to]);

  return (
    <>
      <PageHead
        title="Состояние подразделения"
        sub="Свод по людям подразделения. Отдельного человека здесь не видно — для этого есть его карта"
        actions={
          <div className="date-range">
            <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={ut("ui.unit")}>
              <option value="">— {ut("ui.unit")} —</option>
              {units.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <label>
              <span>с</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Начало периода" />
            </label>
            <label>
              <span>по</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Конец периода" />
            </label>
            {data ? <button onClick={() => window.print()}>Печать</button> : null}
          </div>
        }
      />

      {!unit ? (
        <Empty title="Выберите подразделение" hint="Отчёт строится по одному подразделению за период" />
      ) : error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <Loading rows={5} />
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <div className="tile">
              <div className="label">Охват</div>
              <div className="value">{data.coverage}%</div>
              <div className="hint">обследовано {data.measured} из {data.people}</div>
            </div>
            <div className="tile">
              <div className="label">Прохождений</div>
              <div className="value">{data.responses}</div>
            </div>
            <div className={`tile ${data.atRisk ? "alarm" : ""}`}>
              <div className="label">В тяжёлой полосе</div>
              <div className="value">{data.atRisk ?? "—"}</div>
              <div className="hint">
                {data.atRisk === null
                  ? `меньше ${data.smallCellFloor} человек — не показываем`
                  : "хотя бы по одной шкале"}
              </div>
            </div>
            <div className="tile">
              <div className="label">Методик</div>
              <div className="value">{data.surveys.length}</div>
            </div>
          </div>

          <div className="card scroll-x">
            <div className="card-head">
              <h2>Распределение по шкалам</h2>
              <span className="hint">
                Ячейки меньше {data.smallCellFloor} человек скрыты: по единичному значению
                человека узнают сослуживцы
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Шкала</th>
                  <th className="num">Замеров</th>
                  <th>Распределение</th>
                </tr>
              </thead>
              <tbody>
                {data.scales.map((s) => (
                  <tr key={s.code}>
                    <td>
                      <strong>{s.code}</strong> <span className="muted">{s.title}</span>
                    </td>
                    <td className="num">{s.total}</td>
                    <td>
                      <div className="sev-bar-row">
                        {s.breakdown.map((b) => (
                          <span
                            key={b.severity}
                            className="sev-seg"
                            style={{ width: `${b.percent}%`, background: severityColor[b.severity] }}
                            title={`${ut(severityKey[b.severity])}: ${b.count ?? "скрыто"} (${b.percent}%)`}
                          />
                        ))}
                      </div>
                      <div className="sev-legend">
                        {s.breakdown.map((b) => (
                          <span key={b.severity}>
                            <i style={{ background: severityColor[b.severity] }} />
                            {ut(severityKey[b.severity])} {b.count === null ? "—" : b.count} · {b.percent}%
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.scales.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Замеров за период меньше {data.smallCellFloor} — свод не строится
              </p>
            ) : null}
          </div>

          <div className="card scroll-x">
            <h2>Методики</h2>
            <table>
              <thead>
                <tr><th>Методика</th><th className="num">Прохождений</th><th className="num">Человек</th></tr>
              </thead>
              <tbody>
                {data.surveys.map((s) => (
                  <tr key={s.surveyId}>
                    <td>{s.title}</td>
                    <td className="num">{s.responses}</td>
                    <td className="num">{s.people}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
