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
  return dayFormat(tz).format(at);
}

/*
 * Форматтер — один на пояс, а не новый на каждый вызов.
 *
 * Сборка Intl.DateTimeFormat стоит десятки микросекунд, а dayOf зовут на
 * каждое прохождение — лента по дням и недельные средние аналитики
 * методики. На 70 тыс. прохождений это было 6,5 с синхронной работы из
 * десяти, всё это время процесс не отвечал никому (#183). Форматтер
 * неизменяем, и делить его между вызовами безопасно.
 */
const dayFormats = new Map<string, Intl.DateTimeFormat>();

function dayFormat(tz: string): Intl.DateTimeFormat {
  let format = dayFormats.get(tz);
  if (!format) {
    /* en-CA даёт ровно YYYY-MM-DD — формат, в котором дни сравниваются строкой */
    format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, format);
  }
  return format;
}

/* ─── местное время учреждения ↔ момент (участок delivery, волна 12) ─── */

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** Что показывают часы пояса tz в данный момент */
function localParts(at: number, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    ms: ((at % 1000) + 1000) % 1000,
  };
}

/**
 * Момент, когда на часах пояса tz — заданные местные дата и время.
 *
 * Смещение пояса зависит от самого момента (летнее время), поэтому оно
 * уточняется вторым шагом: сначала берётся смещение «примерно тогда», потом —
 * в найденный момент. Дни и месяцы за пределами (32-е января, 13-й месяц)
 * переносятся так же, как у Date.UTC.
 */
export function zonedTime(p: LocalParts, tz: string = env.institutionTz): Date {
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
  const offset = (at: number) => {
    const l = localParts(at, tz);
    return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second, l.ms) - at;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/**
 * Конец календарного дня YYYY-MM-DD по поясу учреждения.
 *
 * Срок, заданный датой, — это «до конца этого дня там, где работает
 * учреждение». Голая дата, записанная в timestamptz как есть, становилась
 * полуночью по поясу сессии базы: в docker это UTC, то есть 02:00–03:00 по
 * Киеву. В сам день срока назначение с трёх ночи уже числилось просроченным,
 * а методика с таким сроком доступа пациенту уже не открывалась (404).
 */
export function endOfDay(day: string, tz: string = env.institutionTz): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  // полночь следующего дня минус миллисекунда: у дня перевода часов 23 или 25 часов
  const next = zonedTime({ year, month, day: date + 1, hour: 0, minute: 0, second: 0, ms: 0 }, tz);
  return new Date(next.getTime() - 1).toISOString();
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Срок из запроса: голая дата — конец этого дня по поясу учреждения, полная
 * метка времени — как есть, пусто — пусто. Клиенты шлют дату из поля
 * `type="date"`, и именно её надо понимать как «включительно».
 */
export function deadlineOf(value: string | null | undefined, tz: string = env.institutionTz): string | null {
  if (!value) return null;
  return BARE_DATE.test(value) ? endOfDay(value, tz) : value;
}

/**
 * Конец дня, отстоящего от дня момента `from` на `days` календарных дней, —
 * по поясу учреждения.
 *
 * Календарных, а не `days · 86 400 000` мс: сутки у дня перевода часов
 * длиной 23 или 25 часов, и прибавление миллисекунд у полуночи такого дня
 * теряло день или перескакивало через него — 25.10 00:30 плюс сутки давало
 * ещё 25-е в 23:30, а 28.03 23:30 — уже 30-е в 00:30 (внешний разбор, #23).
 * Сначала берётся местная дата момента, к ней прибавляется число дней (день
 * за пределами месяца переносит zonedTime), и считается конец получившегося
 * дня.
 */
export function endOfDayAfter(from: Date, days: number, tz: string = env.institutionTz): string {
  const l = localParts(from.getTime(), tz);
  const next = zonedTime({ year: l.year, month: l.month, day: l.day + days + 1, hour: 0, minute: 0, second: 0, ms: 0 }, tz);
  return new Date(next.getTime() - 1).toISOString();
}

/**
 * Через `months` месяцев от момента — то же местное время, а число — не
 * дальше последнего дня месяца.
 *
 * `setMonth` переполнял месяц: 31 января плюс месяц — это «31 февраля», то
 * есть 3 марта, и осмотр, положенный в феврале, уезжал в март. Считается по
 * часам учреждения, а не сервера: ночная отметка по Киеву — это ещё
 * вчерашний день по Гринвичу, и зажим по «вчерашнему» числу снова давал бы
 * не тот день.
 */
export function addMonths(from: Date, months: number, tz: string = env.institutionTz): Date {
  const l = localParts(from.getTime(), tz);
  const index = l.year * 12 + (l.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return zonedTime({ ...l, year, month, day: Math.min(l.day, lastDay) }, tz);
}
