import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { DEFAULT_THRESHOLDS, markOf, rowSummary, type CellMark, type QualityCell } from "../charts/quality";
import { Loading } from "../ui";
import { cx } from "../ui/cx";
import { CheckLabel, Checkbox } from "../ui/primitives";
import { fixedIn } from "../pages/methods/model";

/**
 * Карта пунктов методики: строка — прохождение, столбец — пункт, отметки
 * быстрых ответов и серий одинаковых (Polypsy 2.0, токены «Виразної»).
 *
 * Цвет — по смыслу: «швидше медіани пункту» — янтарь (требует внимания),
 * «серія однакових» — фиолетовый, оба сразу — янтарь в фиолетовом кольце,
 * без ответа — пустая рамка, обычный ответ — тихая дорожка. Цвет нигде не
 * один: легенда словами рядом, число отметок — в конце строки, подробности
 * клетки — в подписи наведения.
 */
const MARK: Record<CellMark, string> = {
  none: "bg-track",
  fast: "bg-warn",
  run: "bg-violet",
  both: "bg-warn shadow-[inset_0_0_0_1.5px_var(--v)]",
  missing: "bg-transparent shadow-[inset_0_0_0_1px_var(--ctl)]",
};

const CELL = "inline-block h-[14px] w-[6px] shrink-0 rounded-[2px] align-middle";

export function ItemHeatmap({ surveyId }: { surveyId: string }) {
  const { ut, lang } = useLang();
  /* доли — на языке экрана: «0,2» в uk и ru */
  const share = (v: number) => fixedIn(lang, v, 2, false);
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
    return withSummary.sort((a, b) => b.summary.fast + b.summary.run - (a.summary.fast + a.summary.run));
  }, [data, sortByMarks]);

  if (!data) return res.error ? <Loading bare rows={2} error={res.error} onRetry={res.reload} /> : <Loading bare rows={3} />;
  if (!data.rows.length) return <p className="m-0 text-small text-muted">{ut("qh.empty")}</p>;

  const keys: [CellMark, string][] = [
    ["fast", ut("qh.fast")],
    ["run", ut("qh.run")],
    ["both", ut("qh.both")],
    ["missing", ut("qh.missing")],
  ];

  return (
    <div className="print:hidden">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <CheckLabel
          className="mr-auto"
          control={<Checkbox checked={sortByMarks} onChange={(e) => setSortByMarks(e.target.checked)} />}
          label={ut("qh.sortByMarks")}
        />
        {/* легенда рядом с картой: цвет без подписи здесь ничего не значит */}
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
          {keys.map(([mark, label]) => (
            <li key={mark} className="inline-flex items-center gap-1.5 text-caption font-semibold text-text-2">
              <i aria-hidden className={cx(CELL, MARK[mark])} />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <p className="m-0 max-w-[80ch] text-small text-text-2">{ut("qh.hint")}</p>
      <p className="m-0 mb-3 mt-1 text-caption text-muted">
        {ut("qh.fastRule")} {share(DEFAULT_THRESHOLDS.fastRatio)}; {ut("qh.runRule")} {DEFAULT_THRESHOLDS.runLength}
      </p>

      <div className="overflow-x-auto">
        <table className="border-collapse">
          <tbody>
            {rows.map((r) => (
              <tr key={r.responseId} className="hover:bg-sunk">
                <th scope="row" className="whitespace-nowrap py-[3px] pr-3 text-left text-small font-semibold">
                  {/*
                    Адрес прохождения — под методикой: прежний `/responses/:id`
                    не существовал ни в одной таблице маршрутов. Форму адреса
                    сторожит apps/web/test/responseView.test.ts.
                  */}
                  <Link
                    to={`/surveys/${surveyId}/responses/${r.responseId}`}
                    className="text-violet-ink no-underline hover:underline hover:decoration-violet-line"
                  >
                    {day(r.submittedAt ?? "")}
                  </Link>
                </th>
                <td className="whitespace-nowrap py-[3px] leading-none">
                  <span className="flex gap-[2px]">
                    {r.cells.map((cell, i) => (
                      <i
                        key={i}
                        className={cx(CELL, MARK[markOf(cell as QualityCell)])}
                        title={`${ut("qh.item")} ${i + 1}${cell.rel !== null ? `, ×${share(cell.rel)}` : ""}${
                          cell.run > 1 ? `, ${ut("qh.runOf")} ${cell.run}` : ""
                        }`}
                      />
                    ))}
                  </span>
                </td>
                <td className="py-[3px] pl-3 text-right text-small tabular-nums">
                  {r.summary.fast + r.summary.run > 0 ? (
                    <span className="font-extrabold text-text">{r.summary.fast + r.summary.run}</span>
                  ) : (
                    <span className="text-muted">—</span>
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
