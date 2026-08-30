import { describe, expect, test } from "bun:test";
import { formatDuration, formatDay, formatDateTime } from "../src/format";

/**
 * Форматирование, общее для консоли и мобильного приложения.
 *
 * Держалось двумя копиями, и обе содержали одну и ту же ошибку: отрицательная
 * длительность показывалась числом. Тест здесь один — и он покрывает оба
 * приложения сразу.
 */
describe("длительность", () => {
  test("секунды с десятыми и запятой", () => {
    expect(formatDuration(4200)).toBe("4,2 с");
    expect(formatDuration(59_900)).toBe("59,9 с");
  });

  test("минуты и остаток секунд", () => {
    expect(formatDuration(60_000)).toBe("1 мин");
    expect(formatDuration(72_000)).toBe("1 мин 12 с");
    expect(formatDuration(3_600_000)).toBe("60 мин");
  });

  test("секунды не доезжают до шестидесяти", () => {
    /*
     * Остаток округлялся отдельно от минут, и 299,6 с показывались как
     * «4 мин 60 с». На сводке это выпадало каждый раз, когда среднее время
     * попадало в последнюю половину секунды перед круглой минутой.
     */
    expect(formatDuration(299_600)).toBe("5 мин");
    expect(formatDuration(299_500)).toBe("5 мин");
    expect(formatDuration(299_400)).toBe("4 мин 59 с");
    expect(formatDuration(119_900)).toBe("2 мин");
  });

  test("ноль — «не измерено», а не «нисколько»", () => {
    /*
     * Ноль бывает у прохождений, загруженных с бумаги. «0 с» читалось бы как
     * «ответил мгновенно» — и это не только неверно, но и повод для флага
     * небрежного заполнения.
     */
    expect(formatDuration(0)).toBe("—");
  });

  test("отрицательное не выдаётся за настоящее", () => {
    // рассинхронизация часов клиента и сервера даёт отрицательную разницу
    expect(formatDuration(-5000)).toBe("—");
  });

  test("не-число не превращается в NaN на экране", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("даты", () => {
  test("день и время режутся из ISO без разбора в Date", () => {
    // разбор в Date сдвинул бы время на часовой пояс браузера, а сервер
    // уже отдал момент в нужном виде
    expect(formatDay("2026-03-14T09:30:00Z")).toBe("2026-03-14");
    expect(formatDateTime("2026-03-14T09:30:00Z")).toBe("2026-03-14 09:30");
  });

  test("пустая дата — прочерк, а не «Invalid Date»", () => {
    expect(formatDay(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
  });
});
