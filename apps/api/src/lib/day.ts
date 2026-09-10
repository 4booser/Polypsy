import { env } from "../env";

/**
 * Календарный день замера в поясе учреждения.
 *
 * Не `iso.slice(0, 10)`: это день по Гринвичу, а не по Киеву. Для замера в
 * 22:30 по Киеву разница ровно в сутки — всё, сданное вечером, уезжало во
 * вчера, и «сегодня приняли» на сводке не совпадало с тем, что человек
 * помнил про свой день.
 *
 * И не пояс сессии Postgres: он берётся от машины, где запущена база. В
 * docker-compose там UTC, у разработчика — местный, то есть поведение
 * зависело от стенда, а не от учреждения.
 */
export function dayOf(iso: string | null | undefined, tz: string = env.institutionTz): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  /* en-CA даёт ровно YYYY-MM-DD — формат, в котором дни сравниваются строкой */
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
