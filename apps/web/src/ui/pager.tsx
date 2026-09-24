import { useLang } from "../lang";
import { IconChevron } from "./index";
import { PER_PAGE } from "./paging";
import { Button, Select } from "./primitives";

/**
 * «елементів на сторінці [10 ▾] сторінка 1 з 10 ‹ ›» — правый край строки над
 * списком, замеры макета: подпись 10/400 в два рядка, селект 52×27, стрелки
 * глифами 16 вплотную друг к другу с областью нажатия 44
 * (Button size="glyph-sm").
 *
 * Переехал сюда из каталога тестов: тот же блок стоит над списком групп,
 * над пациентами, в карточке группы, на вкладке «Групи» карточки лікаря
 * (f35/f36) и над перечнем аналитики (f10). Шесть копий одной строки
 * разъехались бы на первой же правке замера, и заметить это можно было бы
 * только глазами. Ступени PER_PAGE и арифметика страниц — в ui/paging.ts, а
 * не в каталоге: ни люди, ни аналитика от конструктора не зависят.
 * Словарь у блока остался каталожный (cat.*): слова те же, а второй набор
 * ключей ради имени префикса означал бы два перевода одной подписи.
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
      {/*
        Стрелки стоят вплотную: на кадрах их чернила разнесены ровно на 16
        центр-к-центру (f07 1378…1381 и 1394…1397, f10 1380…1383 и 1396…1399,
        f11 1379…1382 и 1395…1398). Три кадра из трёх, где эта строка
        нарисована, согласны — значит это общий замер, а не особенность
        раздела. Отсюда ступень `glyph-sm` (видимый квадрат 16, нажимаемый
        по-прежнему 44) и своя коробка без зазора: общий `gap-[8px]` строки
        сюда не пускается.
      */}
      <div className="ml-[8px] flex items-center">
        <Button
          size="glyph-sm"
          variant="ghost"
          aria-label={ut("cat.prevPage")}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <span className="rotate-180 [&>svg]:size-[14px]">
            <IconChevron />
          </span>
        </Button>
        <Button
          size="glyph-sm"
          variant="ghost"
          aria-label={ut("cat.nextPage")}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <span className="[&>svg]:size-[14px]">
            <IconChevron />
          </span>
        </Button>
      </div>
    </div>
  );
}
