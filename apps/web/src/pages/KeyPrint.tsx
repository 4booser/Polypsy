import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, download } from "../api";
import { useResource } from "../useResource";
import { useAction } from "../ui";
import { useLang } from "../lang";


/**
 * Печать ключей для сверки с пособием.
 *
 * Структурная проверка ловит форму ключа, но не содержание: если при переносе
 * перепутаны 47 и 74, она промолчит. Единственный способ поймать такое — сесть
 * с распечаткой и оригиналом, поэтому ключи выводятся в том же виде, в каком
 * они напечатаны в пособии.
 */
export default function KeyPrint() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [showItems, setShowItems] = useState(false);
  const run = useAction();
  const { data: sheet, error } = useResource(() => api.keySheet(id!), [id], { enabled: !!id });

  if (error) return <p className="error">{error}</p>;
  if (!sheet) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>{ut("kp.title")}</h1>
      <p className="sub">
        <Link to={`/surveys/${sheet.surveyId}`}>{sheet.title}</Link> · версия {sheet.version} ·{" "}
        {sheet.questionCount} пунктов
      </p>

      <div className="card">
        <p style={{ margin: 0 }}>
          Распечатайте и сверьте с пособием. Автоматическая проверка ловит структурные
          ошибки — выход номера за диапазон, противоречия, пересечения норм, — но перепутанные
          местами номера выглядят для неё совершенно законно.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => window.print()}>Печать</button>
          <button onClick={() => run(() => download(api.methodologyUrl(sheet.surveyId), "methodology.json"))}>
            Выгрузить JSON
          </button>
          <Link className="btn" to={`/surveys/${sheet.surveyId}/blank`}>Пустой бланк</Link>
          <button onClick={() => setShowItems((v) => !v)}>
            {showItems ? ut("kp.hideItems") : ut("kp.showItems")}
          </button>
        </div>
      </div>

      {sheet.scales.map((s) => (
        <div className="card" key={s.code}>
          <h2>
            {s.code} — {s.title}
          </h2>
          <p className="hint">
            {s.kind === "validity" ? ut("kp.validityScale") : ut("kp.clinicalScale")} ·{" "}
            {{ raw: ut("kp.rawScore"), ratio: ut("kp.ratio"), tscore: "T-баллы", sten: ut("kp.stens") }[s.normalization] ??
              s.normalization}{" "}
            · пунктов в ключе {s.itemCount}
          </p>
          <table>
            <tbody>
              {s.yes ? (
                <tr><td style={{ width: 130 }}>{ut("kp.answerYes")}</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{s.yes}</td></tr>
              ) : null}
              {s.no ? (
                <tr><td>{ut("kp.answerNo")}</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{s.no}</td></tr>
              ) : null}
              {s.scored ? (
                <tr><td>{ut("kp.byOptionScores")}</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{s.scored}</td></tr>
              ) : null}
              {s.corrections ? <tr><td>{ut("kp.corrections")}</td><td>{s.corrections}</td></tr> : null}
              {s.norms ? <tr><td>{ut("kp.norms")}</td><td>{s.norms}</td></tr> : null}
              {s.stens ? <tr><td>{ut("cs.sten")}</td><td style={{ fontVariantNumeric: "tabular-nums" }}>{s.stens}</td></tr> : null}
              {s.bands ? <tr><td>{ut("kp.interpretation")}</td><td className="muted">{s.bands}</td></tr> : null}
            </tbody>
          </table>
        </div>
      ))}

      {showItems ? (
        <div className="card scroll-x">
          <h2>{ut("kp.items")}</h2>
          <p className="hint">{ut("kp.itemsHint")}</p>
          <table>
            <tbody>
              {sheet.questions.map((q) => (
                <tr key={q.n}>
                  <td className="num" style={{ width: 50 }}>{q.n}</td>
                  <td>{q.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
