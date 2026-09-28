import { ageAt, LOCALE_OF, type Lang } from "@quizzy/shared";
import { env } from "../env";
import { dayOf } from "./day";

/**
 * Даты на печатных листах (волна 15, внешний разбор, п. 21).
 *
 * Лист печатал даты через toLocaleDateString(локаль) без пояса — то есть
 * по поясу ПРОЦЕССА сервера. Локаль задаёт вид даты, а не пояс: на сервере в
 * UTC обращение, открытое 28 сентября в 00:30 по Киеву, печаталось 27-м, а
 * время сдачи в листе прохождения шло по Гринвичу срезом ISO-строки. Бумага,
 * которую подшивают в дело, спорила с экраном консоли и с тем, что человек
 * помнил про свой день, — и спорила по-разному на разных стендах.
 *
 * Два разных вида дат — и две разные функции, потому что ошибаются они
 * противоположно:
 *  - МОМЕНТ (открыли обращение, сдали методику, подписали запись) —
 *    переводится в пояс учреждения (INSTITUTION_TZ, env.institutionTz — тот
 *    же, по которому считают «сегодня» сводка и аналитика, lib/day.ts), а
 *    приём — в пояс своего отделения (departments.timezone), как и справка о
 *    посещении: приём — событие конкретного кабинета;
 *  - ДАТА БЕЗ ВРЕМЕНИ (дата рождения) — никуда не переводится. «1990-05-01»
 *    — это день в календаре, а не полночь по Гринвичу: new Date() делал из
 *    неё полночь UTC, и западнее Гринвича человек рождался 30 апреля.
 */

/** Момент — днём в поясе: «28.09.2026» (вид — по языку листа) */
export function printDay(iso: string, lang: Lang, tz: string = env.institutionTz): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(LOCALE_OF[lang], { timeZone: tz });
}

/**
 * Дата без времени — как записана, в виде языка листа.
 *
 * Разбирается по числам и форматируется в UTC от полуночи UTC — единственный
 * способ сказать Intl «это день, а не момент». Строка не того вида
 * печатается как есть: лист не должен падать на старой записи.
 */
export function printCalendarDay(value: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.toLocaleDateString(LOCALE_OF[lang], { timeZone: "UTC" });
}

/**
 * Момент с минутами в поясе: «2026-09-28 00:30».
 *
 * Вид прежний — лист прохождения печатал так и раньше, только по Гринвичу:
 * вид менять незачем, неправ был пояс.
 */
export function printStamp(iso: string, tz: string = env.institutionTz): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * Полных лет на день момента — день по поясу учреждения, рождение — по
 * календарю.
 *
 * Общий ageAt (shared/types.ts) берёт числа месяца по часам процесса и у
 * рождения, и у момента: на сервере западнее Гринвича «1990-05-01» — это
 * 30 апреля, и накануне дня рождения на листе стоял уже следующий возраст;
 * на сервере в UTC сдача в 00:30 по Киеву в день рождения давала прежний.
 * Здесь обе даты — числами календаря, без часов процесса вовсе. null — то
 * же, что у ageAt: нет даты, не разбирается или возраст невозможный.
 * Рождение не в виде ГГГГ-ММ-ДД (схемы его другим не пускают, но старая
 * запись могла прийти мимо них) считается прежним ageAt: лист не падает и
 * не теряет возраст из-за вида строки.
 */
export function ageOnDay(birthDate: string | null, at: string | null, tz: string = env.institutionTz): number | null {
  if (!birthDate || !at) return null;
  const born = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate.trim());
  if (!born) return ageAt(birthDate, at);
  const day = dayOf(at, tz);
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = [Number(born[1]), Number(born[2]), Number(born[3])];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age >= 0 && age < 130 ? age : null;
}
