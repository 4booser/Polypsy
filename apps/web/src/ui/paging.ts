/*
 * Арифметика страниц «елементів на сторінці · сторінка 1 з N».
 *
 * Жила в каталоге тестов (pages/constructor/catalogue.ts), пока постраничный
 * блок был у одного экрана. С группами пациентов он стоит уже на четырёх, и
 * держать ступени селекта и разбор адреса в каталоге значило бы, что экран
 * пациентов зависит от конструктора — связь, которой по смыслу нет. Каталог
 * по-прежнему отдаёт эти имена наружу (re-export), поэтому его проверки и
 * импорты не тронуты.
 */

/** Ступени селекта «елементів на сторінці»; 10 — значение с макета */
export const PER_PAGE = [10, 20, 50, 100] as const;
export const DEFAULT_PER = 10;

/**
 * Чужое число в адресе — не ошибка, а умолчание.
 *
 * «?per=7» из старой закладки или руки не должен ронять экран и не должен
 * просить у сервера семь строк: список селекта — единственный источник
 * допустимых ступеней, и адрес ему подчиняется, а не наоборот.
 */
export function perFrom(raw: string | null): number {
  const n = Number(raw);
  return (PER_PAGE as readonly number[]).includes(n) ? n : DEFAULT_PER;
}

/** Номер страницы с единицы; всё, что не разбирается или меньше, — первая */
export function pageFrom(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** «сторінка 1 з N»: пустой список — это одна пустая страница, а не ноль страниц */
export function pageCount(total: number, per: number): number {
  return Math.max(1, Math.ceil(total / per));
}

/** Строки страницы из списка, который приехал целиком */
export function slicePage<T>(items: readonly T[], page: number, per: number): T[] {
  const from = (page - 1) * per;
  return items.slice(from, from + per);
}

/**
 * Сколько страниц у списка, который приезжает курсором.
 *
 * Сервер отдаёт общее число только на первой странице и только без поиска;
 * с поиском известно лишь «сколько уже приехало» и «есть ли ещё». Тогда
 * страниц — столько, сколько приехало, плюс одна, если есть ещё: «сторінка
 * 1 з 2» честнее, чем «з 1» при живой стрелке вперёд, и честнее выдуманного
 * числа. Число растёт по мере листания — и это видно, а не спрятано.
 */
export function pagesOf(loaded: number, total: number | null | undefined, hasMore: boolean, per: number): number {
  if (total !== null && total !== undefined) return pageCount(total, per);
  return pageCount(loaded, per) + (hasMore ? 1 : 0);
}

/**
 * Страница N поверх курсора: просить ли ещё порцию и не пора ли вернуть
 * человека на последнюю существующую страницу.
 *
 * Экран с таким списком (пациенты, вкладка «Усі») добирает строки сам:
 * страница 3 при двух приехавших порциях просит третью. Раньше он делал это,
 * пока `loaded < page · per` и сервер обещает ещё, — и возвращал на
 * последнюю страницу, только когда обещать стало нечего. «?page=9999» из
 * руки или старой закладки при известном общем числе означал тысячу запросов
 * подряд, по порции за раз, ради того чтобы в конце показать страницу 500.
 * Общее число известно — значит известно и число страниц, и вернуть на
 * последнюю можно сразу, запросив ровно те порции, что до неё.
 *
 * Без общего числа (поиск) иначе нельзя: сколько страниц, станет ясно,
 * только когда сервер скажет «больше нет».
 */
export function cursorPagePlan(s: {
  page: number;
  per: number;
  loaded: number;
  total: number | null | undefined;
  hasMore: boolean;
}): { pages: number; clampTo: number | null; loadMore: boolean } {
  const pages = pagesOf(s.loaded, s.total, s.hasMore, s.per);
  const known = s.total !== null && s.total !== undefined;
  // до какой страницы добирать: при известном числе — не дальше последней
  const target = known ? Math.min(s.page, pages) : s.page;
  return {
    pages,
    clampTo: s.page > pages && (known || !s.hasMore) ? pages : null,
    loadMore: s.hasMore && s.loaded < target * s.per,
  };
}

/** Что стоит на месте списка */
export type ListBody = "failed" | "loading" | "empty" | "rows";

/**
 * Список, приезжающий курсором (очередь случаев, направления,
 * приглашения): загрузка, отказ, пусто, строки — и отказ поверх строк.
 *
 * Пока строк нет, отказ стоит на их месте с «повторити». Когда строки уже
 * есть, отказ перечитывания (после действия, по событию сервера) или
 * подгрузки «ще» на очереди случаев и в приглашениях не показывался вовсе:
 * список молча оставался прежним — дежурный разбирал очередь, не зная, что
 * она устарела, а кнопка «ще», отказав, просто снова становилась
 * нажимаемой. Такой отказ — строкой над строками (`stale`), а строки
 * остаются: устаревший список с пометкой полезнее пустого.
 *
 * Обрыв связи — не отказ: слой загрузки ошибкой его не считает
 * (useResource.ts, pagedState). Пока связи нет, на месте ещё не пришедших
 * строк скелет, у пришедших — они сами, а о связи говорит строка оболочки
 * (ui/ConnectionLine.tsx). «Порожньо» при обрыве не показывается никогда:
 * пустым список бывает только по ответу сервера.
 */
export function listBody(items: readonly unknown[] | null, error: string | null): { body: ListBody; stale: string | null } {
  if (!items) return { body: error ? "failed" : "loading", stale: null };
  return { body: items.length ? "rows" : "empty", stale: error };
}

/*
 * Правки адреса у списка со страницами.
 *
 * Правило одно на все такие экраны: смена отбора (поиск, группа, размер
 * страницы) возвращает на первую страницу. Страница 4 другого отбора — не
 * место в списке, а случайное число: по нему человек попадал бы на пустую
 * страницу («нікого не знайдено» при живых совпадениях на первой) или на
 * середину чужого среза. Раньше правило жило в каждом onChange отдельно, и
 * забыть его в новом поле было легко; здесь оно — в одном месте и под
 * проверкой (apps/web/test/patientsFilters.test.ts).
 */

/** Смена отбора: переданные параметры и сброс страницы */
export function refilter(patch: Record<string, string | null>): Record<string, string | null> {
  return { ...patch, page: null };
}

/** Переход на страницу: первая — без параметра, чтобы адрес не рос */
export function toPage(n: number): Record<string, string | null> {
  return { page: n > 1 ? String(n) : null };
}

/** Размер страницы: умолчание — без параметра; прежняя страница при другом размере значит другое */
export function toPer(n: number): Record<string, string | null> {
  return refilter({ per: n === DEFAULT_PER ? null : String(n) });
}

/**
 * Строка «показано не всё» над списком, который приезжает курсором.
 *
 * Список, обрезанный молча, выглядит полным — так реестр направлений терял
 * двести первое направление, и никто этого не видел. Поэтому, пока за
 * страницей есть продолжение, экран говорит об этом словами и называет, как
 * добраться до остального. Общее число известно не всегда (сервер считает
 * его только на первой странице), и без него строка говорит «перші N», а не
 * выдумывает «з N».
 *
 * Функция чистая и получает перевод снаружи — чтобы проверяться без экрана.
 */
export function shownNote(
  ut: (key: "lists.shownOf" | "lists.shownFirst") => string,
  shown: number,
  total: number | null | undefined,
  hasMore: boolean,
): string | null {
  if (!hasMore) return null;
  if (total !== null && total !== undefined && total > shown) {
    return ut("lists.shownOf").replace("{shown}", String(shown)).replace("{total}", String(total));
  }
  return ut("lists.shownFirst").replace("{shown}", String(shown));
}
