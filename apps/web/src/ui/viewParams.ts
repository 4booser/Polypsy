/**
 * Сохранённый вид — это отбор, а не место в списке.
 *
 * Вид хранит строку запроса (saved_views.params), и прежний компонент
 * (ui/SavedViews.tsx) клал туда адрес целиком: вместе с отбором в вид
 * попадали номер страницы и число строк на ней. Вид «Вечірня група», сохранённый
 * на третьей странице, открывался на третьей странице — а после того, как
 * человек перелистнул, уже не узнавался как открытый: адрес с ?page=2 не
 * совпадал с сохранённым ни одним символом, и удалить открытый вид было
 * нечем. Здесь вид — только параметры отбора, в одном порядке, и сравнение
 * идёт по ним же.
 *
 * Старые виды, сохранённые с ?page и ?per, работают как прежде: лишние
 * параметры при сравнении и открытии просто не читаются.
 */

/** Отбор из строки запроса: только названные параметры, непустые, по алфавиту */
export function viewParams(search: string, keep: readonly string[]): string {
  const from = new URLSearchParams(search.replace(/^\?/, ""));
  const out = new URLSearchParams();
  for (const key of [...keep].sort()) {
    const value = from.get(key);
    if (value) out.set(key, value);
  }
  return out.toString();
}

/**
 * Адрес, который открывает вид: отбор из вида, остальное — как было.
 *
 * Параметры отбора, которых в виде нет, снимаются (вид «вся група» после
 * поиска по фамилии поиск убирает), страница — всегда с первой: страница
 * другого отбора — это не место, а случайное число. Прочее, что к отбору не
 * относится (строк на странице, открытая панель), остаётся за человеком.
 */
export function viewSearch(current: string, params: string, keep: readonly string[], reset: readonly string[] = ["page"]): string {
  const next = new URLSearchParams(current.replace(/^\?/, ""));
  for (const key of [...keep, ...reset]) next.delete(key);
  const chosen = new URLSearchParams(params);
  for (const key of keep) {
    const value = chosen.get(key);
    if (value) next.set(key, value);
  }
  return next.toString();
}

/** Какой из видов сейчас открыт: тот, чей отбор совпадает с отбором адреса */
export function activeView<T extends { params: string }>(views: readonly T[], search: string, keep: readonly string[]): T | undefined {
  const now = viewParams(search, keep);
  return views.find((v) => viewParams(v.params, keep) === now);
}

/**
 * Совпадают ли две строки запроса как отбор: порядок параметров не важен,
 * пустые значения — всё равно что их нет.
 *
 * Общий компонент видов (ui/SavedViews.tsx — очередь случаев, направления)
 * сравнивал адрес с видом посимвольно. А порядок параметров в адресе — это
 * порядок, в котором человек трогал фильтры: «важкі», потом «на мені» дают
 * `severity=severe&assigned=me`, наоборот — `assigned=me&severity=severe`.
 * Вид, сохранённый одним путём и собранный руками другим, переставал
 * узнаваться как открытый — а удалить его или открыть коллегам можно только
 * открытый. Та же ошибка, что уже была исправлена у списка пациентов
 * (viewParams выше), — здесь для видов, которые хранят адрес целиком.
 */
export function sameParams(a: string, b: string): boolean {
  const norm = (raw: string) =>
    [...new URLSearchParams(raw.replace(/^\?/, "")).entries()]
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .sort()
      .join("&");
  return norm(a) === norm(b);
}

/** Открытый вид у видов, хранящих адрес целиком (ui/SavedViews.tsx) */
export function openView<T extends { params: string }>(views: readonly T[], search: string): T | undefined {
  return views.find((v) => sameParams(v.params, search));
}

/** Правка адреса: имя → значение; пустое, null или undefined снимает параметр */
export type ParamPatch = Record<string, string | null | undefined>;

/**
 * Применить правку к строке запроса — чистая часть всех `update`/`patch`
 * экранов со списками.
 *
 * Жила копией в каждом экране (пациенты, группы, карточка группы, очередь
 * случаев). Прочие параметры адреса не трогаются — размер страницы,
 * сортировка таблицы остаются за человеком; прежний объект не меняется
 * (React Router отдаёт его и другим читателям).
 */
export function patchParams(prev: URLSearchParams | string, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(typeof prev === "string" ? prev.replace(/^\?/, "") : prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") next.delete(k);
    else next.set(k, v);
  }
  return next;
}
