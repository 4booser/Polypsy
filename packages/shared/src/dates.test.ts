import { describe, expect, test } from "bun:test";
import { calendarDay, dateInput, isDateInput } from "./dates";

/*
 * Граница проверена против самой базы: каждая строка из «отказа» PostgreSQL
 * не принимает (или принимает не так, как мы бы её поняли), каждая из
 * «законных» — принимает. Список держит именно те случаи, которые до волны 12
 * доезжали до базы пятисоткой.
 */
describe("дата снаружи", () => {
  test("отказ: то, что база не примет", () => {
    for (const bad of [
      "вчора",
      "",
      "2026-9-1",
      "0000-01-01", // года ноль в PostgreSQL нет, в JavaScript — есть
      "2026-02-29", // не високосный
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
      "2026-09-26T24:00:00Z",
      "2026-09-26T10:60:00Z",
      "2026-09-26T10:00:61Z",
      "2026-09-26T10:00:00+16:00",
      "2026-09-26Tgarbage",
      "99999-01-01",
    ]) {
      expect(isDateInput(bad), bad).toBe(false);
    }
    expect(isDateInput(null)).toBe(false);
    expect(isDateInput(20260926)).toBe(false);
  });

  test("законно: день, момент ISO, смещение у полуночи, печать самой базы", () => {
    for (const ok of [
      "2026-09-26",
      "2024-02-29",
      "2000-02-29",
      "0001-01-01",
      "2026-09-26T10:00",
      "2026-09-26T10:00:00Z",
      "2026-09-26T10:00:00.123Z",
      "2026-01-01T23:00:00-05:00", // прежний queryDate отвергал: по Гринвичу это уже 2-е
      "2026-09-26T10:00:00+0300",
      "2026-09-26 10:00:00+00", // так метку печатает сам Postgres
    ]) {
      expect(isDateInput(ok), ok).toBe(true);
    }
  });

  test("только день — для колонок date и суточных границ", () => {
    expect(isDateInput("2026-09-26", { dayOnly: true })).toBe(true);
    expect(isDateInput("2026-09-26T10:00:00Z", { dayOnly: true })).toBe(false);
    expect(calendarDay.safeParse("2026-09-26T10:00:00Z").success).toBe(false);
    expect(dateInput.safeParse("2026-09-26T10:00:00Z").success).toBe(true);
  });

  test("отказ схемы несёт ключ, по которому сервер собирает переводимый ответ", () => {
    const res = dateInput.safeParse("2026-02-31");
    expect(res.success).toBe(false);
    const issue = res.error!.issues[0] as { params?: { errorKey?: string } };
    expect(issue.params?.errorKey).toBe("err.invalidDateParam");
  });
});
