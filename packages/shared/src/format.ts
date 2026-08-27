/**
 * Форматирование, общее для консоли и мобильного приложения.
 *
 * Держалось двумя копиями — в `format.ts` консоли и `theme.ts` мобилки — и
 * копии уже разошлись бы: ошибку с отрицательной длительностью пришлось бы
 * чинить дважды, а нашли бы её один раз.
 */

/**
 * Длительность прохождения по-человечески: «4,2 с», «1 мин 12 с».
 *
 * Неположительное значение — это «не измерено», а не «нисколько». Ноль бывает
 * у прохождений, загруженных с бумаги; отрицательное даёт рассинхронизация
 * часов клиента и сервера. И то и другое, показанное числом, читается как
 * «ответил мгновенно» — прямо противоположный вывод, да ещё и повод для
 * флага небрежного заполнения.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1).replace(".", ",")} с`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  return rest ? `${min} мин ${rest} с` : `${min} мин`;
}

/** Календарный день: «2026-03-14» */
export function formatDay(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** Дата и время без секунд: «2026-03-14 09:30» */
export function formatDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}
