import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Предпросмотр дня в форме исключения (волна 27, perf-day).
 *
 * «Записи в этот день видны до сохранения»: форма спрашивает неделю на один
 * день, и сервер пишет clinic.today на каждый такой запрос. Поле даты меняет
 * значение на каждую цифру года и каждое нажатие стрелки — и каждое было
 * запросом и строкой журнала. Теперь день спрашивается, когда дата постояла,
 * и показывается ответ только на ту дату, что в поле сейчас.
 *
 * Хук задержки — useDebounced (useResource.ts); React без DOM эффектов в
 * тестовом процессе не выполняет, поэтому здесь сторож устройства формы.
 */

const src = readFileSync(resolve(import.meta.dir, "../src/pages/schedule/Exceptions.tsx"), "utf8");

describe("предпросмотр дня исключения", () => {
  test("спрашивает устоявшуюся дату, а не каждое изменение поля", () => {
    expect(src).toContain("useDebounced(form.date, DATE_SETTLE_MS)");
    expect(src).toContain("api.scheduleWeek(settled, 1), [settled]");
    expect(src).not.toMatch(/api\.scheduleWeek\(form\.date/);
  });

  test("показывает ответ только на дату в поле: прежний день под новой подписью был бы чужим", () => {
    expect(src).toContain("day.data.from === form.date");
    expect(src).not.toMatch(/day\.data!?\.(appointments|tz)/);
  });

  test("пауза — заметная для набора года, но не дольше секунды", () => {
    const ms = Number(/export const DATE_SETTLE_MS = (\d+);/.exec(src)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThanOrEqual(1000);
  });
});
