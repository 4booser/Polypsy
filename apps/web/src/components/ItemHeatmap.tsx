import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { day, timeOfDay } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { DEFAULT_THRESHOLDS, markOf, rowSummary, type CellMark, type QualityCell } from "../charts/quality";
import { fillIn } from "../charts/kit";
import { Loading } from "../ui";
import { cx } from "../ui/cx";
import { withCount } from "../ui/plural";
import { Button, CheckLabel, Checkbox } from "../ui/primitives";
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
 *
 * Карту читают ради отметок. Прежде она печатала все прохождения подряд —
 * четыреста одинаковых строк «28 жовт.» без часа и без номеров пунктов, —
 * и единственная отмеченная строка терялась в чистых. Теперь по умолчанию
 * видны только прохождения с отметками, у столбцов — номера пунктов (у
 * длинного опросника — каждый десятый), у строки — день и время; нет ни
 * одной отметки — так и сказано словами.
 */
const MARK: Record<CellMark, string> = {
  none: "bg-track",
  fast: "bg-warn",
  run: "bg-violet",
  both: "bg-warn shadow-[inset_0_0_0_1.5px_var(--v)]",
  missing: "bg-transparent shadow-[inset_0_0_0_1px_var(--ctl)]",
};

const CELL = "inline-block h-[16px] shrink-0 rounded-[2px] align-middle";
/** До сорока пунктов номер стоит над каждым столбцом; у длинного опросника — над каждым десятым */
const WIDE = 40;

export function ItemHeatmap({ surveyId }: { surveyId: string }) {
  const { ut, lang } = useLang();
  /* доли — на языке экрана: «0,2» в uk и ru */
  const share = (v: number) => fixedIn(lang, v, 2, false);
  const res = useResource(() => api.itemQuality(surveyId), [surveyId]);
  const [onlyMarked, setOnlyMarked] = useState(true);

  const data = res.data;

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows
      .map((r) => ({ ...r, summary: rowSummary(r.cells as QualityCell[]) }))
      .sort((a, b) => b.summary.fast + b.summary.run - (a.summary.fast + a.summary.run));
  }, [data]);

  if (!data) return res.error ? <Loading bare rows={2} error={res.error} onRetry={res.reload} /> : <Loading bare rows={3} />;
  if (!data.rows.length) return <p className="m-0 text-small text-muted">{ut("qh.empty")}</p>;

  const keys: [CellMark, string][] = [
    ["fast", ut("qh.fast")],
    ["run", ut("qh.run")],
    ["both", ut("qh.both")],
    ["missing", ut("qh.missing")],
  ];
  const marked = rows.filter((r) => r.summary.fast + r.summary.run > 0);
  const shown = onlyMarked ? marked : rows;
  const items = data.questions.length || (rows[0]?.cells.length ?? 0);
  const wide = items <= WIDE;
  const cellW = wide ? "w-[14px]" : "w-[8px]";
  const titleOf = (i: number) => data.questions[i]?.title ?? "";

  return (
    <div className="print:hidden">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <CheckLabel
          className="mr-auto"
          control={<Checkbox checked={onlyMarked} onChange={(e) => setOnlyMarked(e.target.checked)} />}
          label={ut("qh.onlyMarked")}
        />
        {/* легенда рядом с картой: цвет без подписи здесь ничего не значит */}
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
          {keys.map(([mark, label]) => (
            <li key={mark} className="inline-flex items-center gap-1.5 text-caption font-semibold text-text-2">
              <i aria-hidden className={cx(CELL, "w-[8px]", MARK[mark])} />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <p className="m-0 max-w-[80ch] text-small text-text-2">
        {fillIn(ut("qh.summary"), { marked: marked.length, of: withCount(ut("qh.ofResponses"), rows.length, lang) })}
      </p>
      <p className="m-0 mb-3 mt-1 text-caption text-muted">
        {ut("qh.hint")}; {fillIn(ut("qh.fastRule"), { r: share(DEFAULT_THRESHOLDS.fastRatio) })}; {fillIn(ut("qh.runRule"), { n: DEFAULT_THRESHOLDS.runLength })}
      </p>

      {shown.length ? (
        <div className="overflow-x-auto">
          <table className="border-collapse">
            <thead>
              <tr>
                <th scope="col" className="static h-auto border-0 bg-transparent pb-1 pr-3 text-left text-caption font-bold tracking-normal normal-case text-muted">
                  {ut("qh.colResponse")}
                </th>
                <th scope="col" className="static h-auto border-0 bg-transparent p-0 pb-1 align-bottom">
                  <span className="flex gap-[2px]" aria-label={ut("qh.colItems")}>
                    {Array.from({ length: items }, (_, i) => (
                      <span
                        key={i}
                        title={titleOf(i) ? `${i + 1}. ${titleOf(i)}` : undefined}
                        className={cx("inline-block shrink-0 text-center text-[10px] leading-[12px] font-bold text-muted tabular-nums", cellW)}
                      >
                        {wide || (i + 1) % 10 === 0 ? i + 1 : ""}
                      </span>
                    ))}
                  </span>
                </th>
                <th scope="col" className="static h-auto border-0 bg-transparent pb-1 pl-3 text-right text-caption font-bold tracking-normal whitespace-nowrap normal-case text-muted">
                  {ut("qh.colMarks")}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.responseId} className="hover:bg-sunk">
                  <th scope="row" className="h-auto border-0 whitespace-nowrap py-[3px] pr-3 pl-0 text-left text-small font-semibold">
                    {/*
                      Адрес прохождения — под методикой: прежний `/responses/:id`
                      не существовал ни в одной таблице маршрутов. Форму адреса
                      сторожит apps/web/test/responseView.test.ts.
                    */}
                    <Link
                      to={`/surveys/${surveyId}/responses/${r.responseId}`}
                      className="text-violet-ink no-underline hover:underline hover:decoration-violet-line"
                    >
                      {r.submittedAt ? `${day(r.submittedAt)}, ${timeOfDay(r.submittedAt)}` : "—"}
                    </Link>
                  </th>
                  <td className="h-auto border-0 whitespace-nowrap px-0 py-[3px] leading-none">
                    <span className="flex gap-[2px]">
                      {r.cells.map((cell, i) => (
                        <i
                          key={i}
                          className={cx(CELL, cellW, MARK[markOf(cell as QualityCell)])}
                          title={`${ut("qh.item")} ${i + 1}${titleOf(i) ? `. ${titleOf(i)}` : ""}${cell.rel !== null ? `, ×${share(cell.rel)}` : ""}${
                            cell.run > 1 ? `, ${ut("qh.runOf")} ${cell.run}` : ""
                          }`}
                        />
                      ))}
                    </span>
                  </td>
                  <td className="h-auto border-0 py-[3px] pr-0 pl-3 text-right text-small tabular-nums">
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
      ) : null}
      {onlyMarked && marked.length < rows.length ? (
        <Button variant="quiet" size="xs" className="mt-2" onClick={() => setOnlyMarked(false)}>
          {withCount(ut("qh.showClean"), rows.length - marked.length, lang)}
        </Button>
      ) : null}
    </div>
  );
}
