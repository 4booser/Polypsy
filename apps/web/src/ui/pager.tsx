import { useLang } from "../lang";
import { cx } from "./cx";
import { Ic } from "./icons";
import { PER_PAGE } from "./perPage";

/**
 * Номера страниц, которые видны в пейджере: первая, последняя и соседи
 * текущей; разрывы — "gap". Семь и меньше страниц — все подряд.
 *
 *   pageList(1, 10)  → 1 2 3 … 10
 *   pageList(5, 10)  → 1 … 4 5 6 … 10
 *   pageList(10, 10) → 1 … 8 9 10
 */
export function pageList(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1);
  const at = Math.min(Math.max(page, 1), pages);
  const keep = new Set([1, pages, at - 1, at, at + 1]);
  if (at <= 3) [2, 3].forEach((n) => keep.add(n));
  if (at >= pages - 2) [pages - 2, pages - 1].forEach((n) => keep.add(n));
  const nums = [...keep].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1]! > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

/** «1–25» для «Показано 1–25 з 248» */
export function shownRange(page: number, per: number, total: number): string {
  if (total <= 0) return "0";
  const from = (page - 1) * per + 1;
  const to = Math.min(page * per, total);
  return from >= to ? String(to) : `${from}–${to}`;
}

/**
 * Пейджер набора (.pager): «Показано 1–25 з 248», «По 25 на сторінці», номера
 * страниц с разрывами и стрелки. Текущая — тонированной плашкой и
 * aria-current; у каждого номера подпись «Сторінка N» для диктора.
 *
 * `total` — сколько всего записей; без него строки «Показано» нет (число
 * неизвестно, например при подгрузке курсором).
 */
export function Pager({
  page,
  pages,
  per,
  onPer,
  onPage,
  total,
  sizes = PER_PAGE,
  className,
}: {
  page: number;
  pages: number;
  per: number;
  onPer: (per: number) => void;
  onPage: (page: number) => void;
  total?: number | null;
  /** Размеры страницы на выбор; по умолчанию — списков консоли (paging.ts) */
  sizes?: readonly number[];
  className?: string;
}) {
  const { ut } = useLang();
  const [before, after] = ut("kit.perPage").split("{n}");
  const btn = cx(
    "inline-grid h-8 min-h-0 min-w-8 cursor-pointer place-items-center rounded-[9px] border-0 bg-transparent px-1.5",
    "text-small font-bold text-text-2 tabular-nums hover:bg-sunk hover:text-text",
    "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-control",
  );
  return (
    <div className={cx("pager flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 text-small text-muted", className)}>
      {total !== undefined && total !== null ? (
        <span className="whitespace-nowrap">
          {ut("kit.shown")
            .split(/(\{range\}|\{total\})/)
            .map((part, i) =>
              part === "{range}" ? (
                <b key={i} className="font-extrabold text-text">
                  {shownRange(page, per, total)}
                </b>
              ) : part === "{total}" ? (
                <b key={i} className="font-extrabold text-text">
                  {total}
                </b>
              ) : (
                part
              ),
            )}
        </span>
      ) : null}
      <label className="m-0 inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-control pl-2 text-small text-muted hover:bg-sunk">
        {before}
        <select
          aria-label={ut("cat.perPage")}
          value={String(per)}
          onChange={(e) => onPer(Number(e.target.value))}
          className="h-8 min-h-0 w-auto cursor-pointer appearance-none border-0 bg-transparent p-0 px-0.5 text-small font-bold text-text-2 outline-none focus-visible:outline-2 focus-visible:outline-focus"
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {after}
        <Ic.chevronDown size={13} className="mr-2" />
      </label>
      <nav aria-label={ut("kit.pages")} className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          className={btn}
          aria-label={ut("cat.prevPage")}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <Ic.chevronLeft size={15} />
        </button>
        {pageList(page, pages).map((n, i) =>
          n === "gap" ? (
            <span key={`gap-${i}`} aria-hidden className="inline-grid h-8 min-w-4 place-items-center text-muted">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              aria-label={ut("kit.pageN").replace("{n}", String(n))}
              aria-current={n === page ? "page" : undefined}
              onClick={() => n !== page && onPage(n)}
              className={cx(btn, n === page && "bg-violet-tint font-extrabold text-violet-ink hover:bg-violet-tint hover:text-violet-ink")}
            >
              {n}
            </button>
          ),
        )}
        <button
          type="button"
          className={btn}
          aria-label={ut("cat.nextPage")}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <Ic.chevronRight size={15} />
        </button>
      </nav>
    </div>
  );
}
