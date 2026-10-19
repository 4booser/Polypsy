import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api } from "../src/api";
import * as visitModel from "../src/pages/visitModel";

/**
 * Переход приёма перечитывает экран и на отказе (#178).
 *
 * «Сьогодні» и экран приёма перечитывались только на успехе. Отказ
 * перехода — знак того, что строка устарела: приём уже перевёл коллега
 * (409 err.appointmentChanged) или его закрыли (400 err.appointmentClosed).
 * Экран оставался со старыми кнопками, и следующее нажатие упиралось в тот
 * же отказ. Файл грузится и на коде до правки — проверки там падают по
 * существу.
 */

const CHANGED = "Прийом уже змінили — оновіть сторінку";
const CLOSED = "Прийом уже закрито";

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

beforeEach(() => {
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/clinic/appointments/changed/status") return reply(409, { error: CHANGED });
    if (path === "/api/clinic/appointments/closed/status") return reply(400, { error: CLOSED });
    if (path === "/api/clinic/appointments/fresh/status") return reply(200, { ok: true });
    return reply(404, { error: "unexpected" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

type Move = <T>(move: () => Promise<T>, reload: () => void) => Promise<T>;
const moveAndReload = (visitModel as { moveAndReload?: Move }).moveAndReload;

describe("перечитывание после перехода", () => {
  for (const [id, words, status] of [
    ["changed", CHANGED, 409],
    ["closed", CLOSED, 400],
  ] as const) {
    test(`${status}: экран перечитывается, а отказ доходит до тоста словами сервера`, async () => {
      expect(moveAndReload).toBeFunction();
      let reloads = 0;
      const outcome = await moveAndReload!(() => api.appointmentStatus(id, "arrived"), () => reloads++).then(
        () => "ok",
        (e: Error) => e.message,
      );
      expect(outcome).toBe(words);
      expect(reloads).toBe(1);
    });
  }

  test("положительный контроль: на успехе — тоже перечитывание, и ответ сервера возвращается", async () => {
    expect(moveAndReload).toBeFunction();
    let reloads = 0;
    expect(await moveAndReload!(() => api.appointmentStatus("fresh", "done"), () => reloads++)).toEqual({ ok: true });
    expect(reloads).toBe(1);
  });

  test("перенос из календаря недели — тоже через moveAndReload: отказ перечитывает неделю, а окна переноса — заново", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages", "Schedule.tsx"), "utf8");
    expect(src).toContain("moveAndReload(() => api.rescheduleAppointment(");
    expect(src).not.toMatch(/await api\.rescheduleAppointment\(/);
    expect(src).toContain("<MoveSlots key={slotsRev}");
  });

  test("«Сьогодні» и экран приёма переходят через moveAndReload, а не `.then(reload)`", () => {
    for (const f of ["Today.tsx", "Visit.tsx"]) {
      const src = readFileSync(resolve(import.meta.dir, "../src/pages", f), "utf8");
      expect(src, f).not.toMatch(/appointmentStatus\([^)]*\)\.then\(reload\)/);
      expect(src, f).toContain("moveAndReload(() => api.appointmentStatus(");
    }
  });
});
