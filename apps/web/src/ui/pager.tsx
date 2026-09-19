import { useLang } from "../lang";
import { PER_PAGE } from "../pages/constructor/catalogue";
import { IconChevron } from "./index";
import { Button, Select } from "./primitives";

/**
 * «елементів на сторінці [10 ▾] сторінка 1 з 10 ‹ ›» — правый край строки
 * над списком, замеры макета: подпись 10/400 в два рядка, селект 52×27,
 * стрелки глифами с областью нажатия 44 (Button size="glyph").
 *
 * Переехал сюда из каталога тестов (SurveyList.tsx): тот же блок нарисован
 * на вкладке «Групи» карточки лікаря (кадры f35/f36), а ступени «10 · 20 ·
 * 50 · 100» и арифметика страниц у обоих экранов одни — они и остались в
 * catalogue.ts. Вторая копия блока означала бы, что подпись на одном экране
 * однажды разойдётся с подписью на другом на пиксель, и заметить это можно
 * только глазами.
 */
export function Pager({
  page,
  pages,
  per,
  onPer,
  onPage,
}: {
  page: number;
  pages: number;
  per: number;
  onPer: (per: number) => void;
  onPage: (page: number) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex items-center gap-[8px]">
      {/* ширина колонки и есть перенос «елементів / на сторінці» — ключ один */}
      <span className="w-[56px] text-right text-[10px] leading-[12px] text-muted">{ut("cat.perPage")}</span>
      <Select
        aria-label={ut("cat.perPage")}
        value={String(per)}
        onChange={(e) => onPer(Number(e.target.value))}
        /*
         * Размер места — стилем, а не классом: у Select в списке классов уже
         * стоят h-9 и text-[17px], а cx конфликты не разрешает, и какой из
         * двух классов победит, решал бы порядок в собранном CSS. Стиль
         * побеждает всегда. Отступ справа сжат до 16: каретка селекта стоит в
         * 10–14,5px от края, и «100» при 13-м кегле должно уместиться до неё.
         */
        style={{ height: 27, width: 52, fontSize: 13, paddingRight: 16 }}
      >
        {PER_PAGE.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      <span className="ml-[9px] whitespace-nowrap text-[10px] text-muted">
        {ut("cat.page")} {page} {ut("common.of")} {pages}
      </span>
      <Button
        size="glyph"
        variant="ghost"
        className="ml-[5px]"
        aria-label={ut("cat.prevPage")}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <span className="rotate-180 [&>svg]:size-[14px]">
          <IconChevron />
        </span>
      </Button>
      <Button size="glyph" variant="ghost" aria-label={ut("cat.nextPage")} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <span className="[&>svg]:size-[14px]">
          <IconChevron />
        </span>
      </Button>
    </div>
  );
}
