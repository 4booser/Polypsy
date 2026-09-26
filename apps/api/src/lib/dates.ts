import { isDateInput } from "@quizzy/shared";
import { badRequest } from "./http";

/**
 * Дата из строки запроса, прочитанная мимо parseQuery.
 *
 * Где параметры разбираются схемой, даты проверяют `queryDate` / `dateInput`
 * / `calendarDay` из общего пакета (packages/shared/src/dates.ts), и отказ
 * собирает parseQuery. Здесь — для тех немногих мест, где один параметр
 * читается напрямую (`c.req.query("date")`): проверка та же, отказ тот же,
 * «err.invalidDateParam» с именем поля. Раньше такая строка уходила в SQL
 * как есть, и `?date=вчора` на приёмах дня отвечало пятисоткой.
 */
export function requireDateParam(value: string, field: string, opts: { dayOnly?: boolean } = {}): string {
  if (!isDateInput(value, opts)) badRequest("err.invalidDateParam", { field });
  return value;
}
