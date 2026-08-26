/**
 * Сравнение меток времени.
 *
 * В коде живут два строковых формата: toISOString() («2026-08-26T14:00:00Z»)
 * и текст timestamptz из Postgres («2026-08-26 17:00:00+03»). Лексикографное
 * сравнение между ними врёт: пробел < «T», и любая метка из БД «меньше» любой
 * ISO-метки того же дня. Однажды это уронило киоск («сеанс истёк» сразу после
 * создания). Все сравнения смешанных источников — только через parseTs.
 */
export function parseTs(value: string): number {
  return new Date(value).getTime();
}

export function isPast(value: string): boolean {
  return parseTs(value) < Date.now();
}
