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
