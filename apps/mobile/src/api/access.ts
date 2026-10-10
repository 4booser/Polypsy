/**
 * Отказ доступа и что с ним делать (#126).
 *
 * Без react-native и без клиента запросов: правило общее у клиента (кэш
 * обхода при отказе не отдаётся, api/client.ts, offlineFallback) и у экранов
 * обхода (уже показанное сбрасывается) и проверяется тестом
 * (test/roundsAccess.test.ts).
 */

/**
 * Сервер отказал в доступе: 403 или 401. 401 доходит сюда только тогда,
 * когда продлить сессию не удалось (сервер отверг refresh) — если продлению
 * помешала сеть, наружу идёт её status 0 (api/client.ts, request).
 */
export function isAccessDenied(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * Что экран держит после неудачной загрузки.
 *
 * Сети нет или сервер сбоит — показанное остаётся: по нему работают, и сбой
 * связи не делает его неверным. Отказ доступа — сбрасывается: пациента
 * вывели из зоны, учётку выключили, и карта, открытая минуту назад, не
 * должна оставаться на экране с баллами.
 */
export function shownAfterFailure<T>(shown: T | null, error: unknown): T | null {
  return isAccessDenied(error) ? null : shown;
}
