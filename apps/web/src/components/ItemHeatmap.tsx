import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { day } from "../format";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { DEFAULT_THRESHOLDS, markOf, rowSummary, type CellMark, type QualityCell } from "../charts/quality";
import { cx } from "../ui/cx";

/**
 * Тепловая карта пунктов: человек × вопрос.
 *
 * Небрежное заполнение выдаёт себя формой, а не средним. Двести пунктов,
 * отвеченных за четыре минуты, в таблице чисел видны плохо; сплошная полоса
 * одинаковых ответов от сорокового пункта до конца — сразу.
 *
 * Ячейка узкая намеренно (5×14 с просветом 1): карта на двести столбцов
 * должна помещаться целиком, иначе полоса, ради которой она нужна,
 * окажется за краем экрана. Широкая всё равно прокручивается в своём
 * контейнере, а не страницей.
 *
 * Цвета — не тяжесть. Прежняя редакция красила серию и «оба признака»
 * тонами --sev-moderate и --sev-severe, и карта качества заполнения читалась
 * как карта тяжести состояния — рядом с разделом шкал, где эти же тона
 * значат «помірна» и «тяжка». Теперь быстрота — янтарь (он и значит «стоит
 * посмотреть»), серия — фиолетовый, оба — янтарь в фиолетовой рамке, пропуск
 * — пустая клетка в рамке. Разные признаки — разные тона, а не оттенки
 * одного: оттенок читался бы как «сильнее/слабее», а это не так.
 */
const MARK: Record<CellMark, string> = {
  none: "bg-[var(--grid)]",
  fast: "bg-accent",
  run: "bg-primary",
  both: "border border-primary bg-accent",
  missing: "border border-hairline bg-transparent",
};

const CELL = "inline-block h-[14px] w-[5px] shrink-0 align-middle";

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

  if (!data) return <p className="m-0 text-[13px] text-muted">{res.error ?? ut("common.loading")}</p>;
  if (!data.rows.length) return <p className="m-0 text-[13px] text-muted">{ut("qh.empty")}</p>;

  const keys: [CellMark, string][] = [
    ["fast", ut("qh.fast")],
    ["run", ut("qh.run")],
    ["both", ut("qh.both")],
    ["missing", ut("qh.missing")],
  ];

  return (
    /* на монохромном принтере тона неразличимы — карта печати не подлежит */
    <div className="print:hidden">
      <div className="mb-[8px] flex flex-wrap items-center gap-x-[18px] gap-y-[6px]">
        <label className="mr-auto flex cursor-pointer items-center gap-[8px] text-[13px] text-text-2">
          <input
            type="checkbox"
            checked={sortByMarks}
            onChange={(e) => setSortByMarks(e.target.checked)}
            className="size-[16px] accent-[var(--primary)]"
          />
          {ut("qh.sortByMarks")}
        </label>
        {/* легенда рядом с картой: цвет без подписи здесь ничего не значит */}
        {keys.map(([mark, label]) => (
          <span key={mark} className="inline-flex items-center gap-[6px] text-[13px] text-muted">
            <i aria-hidden className={cx(CELL, MARK[mark])} />
            {label}
          </span>
        ))}
      </div>

      <p className="m-0 mb-[12px] max-w-[760px] text-[13px] leading-[18px] text-muted">
        {ut("qh.hint")} · {ut("qh.fastRule")} {DEFAULT_THRESHOLDS.fastRatio} · {ut("qh.runRule")} {DEFAULT_THRESHOLDS.runLength}
      </p>

      <div className="overflow-x-auto">
        <table className="border-collapse">
          <tbody>
            {rows.map((r) => (
              <tr key={r.responseId} className="hover:bg-primary-tint">
                <th scope="row" className="whitespace-nowrap py-[2px] pr-[12px] text-left text-[13px] font-normal">
                  {/*
                    Адрес прохождения — под методикой. Прежний `/responses/:id`
                    не существовал ни в одной таблице маршрутов: ссылка молча
                    уводила на сводку через запасной маршрут «*», и с тепловой
                    карты нельзя было открыть ни один протокол. Форму адреса
                    теперь сторожит apps/web/test/responseView.test.ts — он
                    эту ссылку и нашёл.
                  */}
                  <Link to={`/surveys/${surveyId}/responses/${r.responseId}`} className="text-primary no-underline hover:underline">
                    {day(r.submittedAt ?? "")}
                  </Link>
                </th>
                <td className="whitespace-nowrap py-[2px] leading-none">
                  <span className="flex gap-[1px]">
                    {r.cells.map((cell, i) => (
                      <i
                        key={i}
                        className={cx(CELL, MARK[markOf(cell as QualityCell)])}
                        title={`${ut("qh.item")} ${i + 1}${cell.rel !== null ? ` · ×${cell.rel}` : ""}${
                          cell.run > 1 ? ` · ${ut("qh.runOf")} ${cell.run}` : ""
                        }`}
                      />
                    ))}
                  </span>
                </td>
                <td className="py-[2px] pl-[12px] text-right font-mono text-[13px] tabular-nums">
                  {r.summary.fast + r.summary.run > 0 ? (
                    <span className="font-bold text-text">{r.summary.fast + r.summary.run}</span>
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
