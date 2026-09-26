import { z } from "zod";

/**
 * Дата, пришедшая снаружи: из строки запроса или из тела.
 *
 * Внешний разбор кода 2026-09-26: «невалидные даты доходили до PostgreSQL →
 * HTTP 500 вместо 400». Дыр было три сорта, и все они здесь:
 *
 *  1. Строка вообще без проверки (`z.string()`): `?from=вчера` уходило в
 *     сравнение с меткой времени, и база отвечала «invalid input syntax».
 *  2. Проверка формата регулярным выражением: «2026-02-31» и «2026-13-01»
 *     формату соответствуют, а база их не принимает — «date/time field value
 *     out of range».
 *  3. Проверка через `new Date()`: JavaScript считает «0000-01-01» законным
 *     годом, а PostgreSQL года ноль не знает вовсе. Прежний `queryDate` стоял
 *     именно на этом и пропускал нулевой год в журнал, аналитику и «хто
 *     переглядав» — пятисоткой.
 *
 * Поэтому проверка — не «разбирается ли строка», а «примет ли её база так
 * же, как мы её поняли»: строгий ISO 8601 (день или момент), существующий
 * день месяца, год с первого по 9999-й, часы, минуты и смещение в границах.
 * Всё, что принимается, — строгое подмножество того, что PostgreSQL читает
 * однозначно, поэтому прошедшая проверку дата пятисотки дать не может.
 *
 * Лежит в общем пакете, а не в сервере: те же схемы разбирают параметры и на
 * клиенте, и расходиться в том, что такое «дата», им нельзя.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/*
 * Момент: день, «T» или пробел (так Postgres печатает метки сам), часы и
 * минуты, по желанию секунды с долями и смещение — Z, ±ЧЧ, ±ЧЧММ или ±ЧЧ:ММ.
 * Без смещения — местное время сессии базы; так было и до этой проверки.
 */
const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-](\d{2})(?::?(\d{2}))?)?$/;

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Примет ли PostgreSQL эту строку как дату (или момент) и поймёт ли её так же.
 *
 * `dayOnly` — только календарный день ГГГГ-ММ-ДД: для колонок date и для
 * параметров, которые сервер сам разворачивает в сутки («по 30 вересня»
 * включительно).
 */
export function isDateInput(value: unknown, opts: { dayOnly?: boolean } = {}): value is string {
  if (typeof value !== "string") return false;
  const m = DAY.exec(value) ?? (opts.dayOnly ? null : MOMENT.exec(value));
  if (!m) return false;
  const [, y, mo, d, hh, mm, ss, offH, offM] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // года ноль в PostgreSQL нет: «0000-01-01» — out of range
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return false;
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59)) return false;
  if (ss !== undefined && Number(ss) > 59) return false;
  // смещения шире ±15:59 база не принимает
  if (offH !== undefined && (Number(offH) > 15 || (offM !== undefined && Number(offM) > 59))) return false;
  return true;
}

/**
 * Ключ отказа для кривой даты.
 *
 * Едет параметром проблемы zod: parseQuery и parseBody (apps/api/src/lib/http.ts)
 * узнают по нему дату и отвечают переводимым отказом с именем поля, а не
 * отладочной строкой разбора.
 */
export const DATE_ERROR_KEY = "err.invalidDateParam";

const dateIssue = {
  message: "ожидается существующая дата ГГГГ-ММ-ДД или момент ISO 8601",
  params: { errorKey: DATE_ERROR_KEY },
};

/** День или момент ISO 8601 — строго то, что база прочтёт однозначно */
export const dateInput = z.string().refine((v) => isDateInput(v), dateIssue);

/** Только календарный день ГГГГ-ММ-ДД — для колонок date и суточных границ */
export const calendarDay = z.string().refine((v) => isDateInput(v, { dayOnly: true }), {
  message: "ожидается существующая дата ГГГГ-ММ-ДД",
  params: { errorKey: DATE_ERROR_KEY },
});
