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
