/**
 * Список пациентов (Patients.tsx): чистая часть — что из адреса уходит на
 * сервер, какая вкладка открыта и что стоит на месте сетки.
 *
 * Вынесено ради проверки без браузера (apps/web/test/patientsFilters.test.ts).
 * Все три решения тихие: ошибка в них не роняет экран, а показывает не то —
 * «нікого не знайдено» там, где люди есть, но не доехали, или чужую вкладку
 * по ссылке на свою. Глазом такое замечают, только когда уже поверили.
 */

import type { ListBody } from "../../ui/paging";

/** Предел поиска на сервере (respondentQuery: search ≤ 120) */
export const SEARCH_MAX = 120;

/**
 * Поиск, как он уходит на сервер: без пробелов по краям и не длиннее предела.
 *
 * Поле ввода длиннее не даст (maxLength), но адрес правят руками и
 * присылают ссылкой, и 121 знак в `?q=` означал отказ сервера (400) на
 * месте всего списка — с кнопкой «повторити», которая повторяла бы тот же
 * отказ. Пробелы по краям сервер срезает и сам; срезаются они и здесь, чтобы
 * пробел, набранный после фамилии, не был новой выборкой и новым запросом.
 */
export function searchOf(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX).trim();
}

export interface GroupTab<G> {
  /** Открытая группа; null — вкладка «Усі» */
  current: G | null;
  /** Группа в адресе, а список групп ещё не приехал: ждём его, не рисуя «Усі» */
  pending: boolean;
  /**
   * Группа в адресе есть, но среди своих её нет (чужая, удалённая, опечатка).
   * Экран показывает «Усі», и адрес обязан сказать то же: иначе пункт «Усі»
   * в шестерёнке погашен как «уже открыт», снять мёртвый параметр нечем, а
   * «Зберегти відбір» сохраняет вид с группой, которой на экране нет.
   */
  stale: boolean;
}

/**
 * Какая вкладка открыта по адресу.
 *
 * Отказ по списку групп — не повод терять группу из адреса: она, может быть,
 * и своя, просто список не пришёл. Тогда экран — «Усі» со строкой ошибки над
 * ним (как и было), а параметр остаётся: вернётся список — вернётся вкладка.
 */
export function groupTab<G extends { id: string }>(
  groupId: string | null,
  groups: readonly G[] | null,
  groupsError: string | null,
): GroupTab<G> {
  if (!groupId) return { current: null, pending: false, stale: false };
  if (!groups) return { current: null, pending: !groupsError, stale: false };
  const current = groups.find((g) => g.id === groupId) ?? null;
  return { current, pending: false, stale: current === null };
}

/**
 * Вкладка «Усі»: страница поверх курсора.
 *
 * «Порожньо» — только когда за страницей больше ничего не обещано. Пока
 * сервер обещает ещё, пустая страница значит «строки не доехали», а не
 * «никого нет»: порция в пути, ждёт связи (обрыв ставит запрос на паузу, и
 * «идёт подгрузка» тогда не поднят) или вот-вот будет попрошена. Раньше
 * здесь смотрели только на «идёт подгрузка», и человек, листнувший вперёд
 * при оборвавшейся связи, читал «нікого не знайдено» над списком, в котором
 * люди есть.
 *
 * Отказ — главнее всего: без кнопки «повторити» экран, не догрузивший
 * страницу, остался бы тупиком.
 */
export function allTabBody(s: {
  items: readonly unknown[] | null;
  error: string | null;
  rowsOnPage: number;
  hasMore: boolean;
  loadingMore: boolean;
}): ListBody {
  if (s.error) return "failed";
  if (!s.items) return "loading";
  if (s.rowsOnPage > 0) return "rows";
  return s.hasMore || s.loadingMore ? "loading" : "empty";
}

/**
 * Вкладка группы: состав приходит целиком. Пусто — одно из двух, и сказать
 * надо разное: «никого не нашли по запросу» или «в группе никого нет».
 */
export function groupTabBody(s: {
  hasCard: boolean;
  error: string | null;
  rowsOnPage: number;
  q: string;
}): ListBody | "noMatch" {
  if (s.error) return "failed";
  if (!s.hasCard) return "loading";
  if (s.rowsOnPage > 0) return "rows";
  return s.q.trim() ? "noMatch" : "empty";
}
