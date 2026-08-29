import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { DEFAULT_THRESHOLDS, markOf, rowSummary, type QualityCell } from "../charts/quality";

/**
 * Тепловая карта пунктов: человек × вопрос.
 *
 * Небрежное заполнение выдаёт себя формой, а не средним. Двести пунктов,
 * отвеченных за четыре минуты, в таблице чисел видны плохо; сплошная полоса
 * одинаковых ответов от сорокового пункта до конца — сразу.
 *
 * Ячейка узкая намеренно: карта на двести столбцов должна помещаться целиком,
 * иначе полоса, ради которой она нужна, окажется за краем экрана.
 */
export function ItemHeatmap({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.itemQuality(surveyId), [surveyId]);
  const [sortByMarks, setSortByMarks] = useState(true);

  const data = res.data;

  const rows = useMemo(() => {
    if (!data) return [];
    const withSummary = data.rows.map((r) => ({
      ...r,
      summary: rowSummary(r.cells as QualityCell[]),
    }));
    if (!sortByMarks) return withSummary;
    /*
     * Сортировка по числу меток, а не по дате: на двухстах пунктах строку
     * глазами не оценить, и наверх должно попасть то, что стоит открыть.
     */
    return withSummary.sort(
      (a, b) => b.summary.fast + b.summary.run - (a.summary.fast + a.summary.run),
    );
  }, [data, sortByMarks]);

  if (!data) return <p className="muted">{ut("common.loading")}</p>;
  if (!data.rows.length) return <p className="muted">{ut("qh.empty")}</p>;

  return (
    <div>
      <div className="row tight">
        <label className="row tight">
          <input
            type="checkbox"
            checked={sortByMarks}
            onChange={(e) => setSortByMarks(e.target.checked)}
          />
          <span>{ut("qh.sortByMarks")}</span>
        </label>
        <div style={{ flex: 1 }} />
        {/* легенда рядом с картой: цвет без подписи здесь ничего не значит */}
        <span className="qh-key">
          <i className="qh-cell m-fast" /> {ut("qh.fast")}
        </span>
        <span className="qh-key">
          <i className="qh-cell m-run" /> {ut("qh.run")}
        </span>
        <span className="qh-key">
          <i className="qh-cell m-both" /> {ut("qh.both")}
        </span>
        <span className="qh-key">
          <i className="qh-cell m-missing" /> {ut("qh.missing")}
        </span>
      </div>

      <p className="hint">
        {ut("qh.hint")} · {ut("qh.fastRule")} {DEFAULT_THRESHOLDS.fastRatio} ·{" "}
        {ut("qh.runRule")} {DEFAULT_THRESHOLDS.runLength}
      </p>

      <div className="scroll-x">
        <table className="qh">
          <tbody>
            {rows.map((r) => (
              <tr key={r.responseId}>
                <th scope="row">
                  <Link to={`/responses/${r.responseId}`}>{day(r.submittedAt ?? "")}</Link>
                </th>
                <td className="qh-cells">
                  {r.cells.map((cell, i) => (
                    <i
                      key={i}
                      className={`qh-cell m-${markOf(cell as QualityCell)}`}
                      title={`${ut("qh.item")} ${i + 1}${
                        cell.rel !== null ? ` · ×${cell.rel}` : ""
                      }${cell.run > 1 ? ` · ${ut("qh.runOf")} ${cell.run}` : ""}`}
                    />
                  ))}
                </td>
                <td className="num qh-sum">
                  {r.summary.fast + r.summary.run > 0 ? (
                    <strong>{r.summary.fast + r.summary.run}</strong>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
