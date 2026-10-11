import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type UiKey, uiText } from "@quizzy/shared";
import { ApiError } from "../src/api";
import * as home from "../src/patient/Home";

/**
 * Кабинет пациента: «Скасувати» с вопросом и предупреждением о поздней
 * отмене, переходы приёма перечитывают экран и на отказе (#178).
 *
 * «Скасувати» стоял рядом с «Підтвердити» и отменял приём одним нажатием;
 * о том, что отмена позже чем за сутки видна специалисту (сервер ставит
 * cancelledLate), кабинет не говорил — мобилка спрашивает и предупреждает.
 * После отказа сервера (409 приём уже изменили, 400 уже закрыт) экран
 * оставался со старыми кнопками. Файл грузится и на коде до правки —
 * проверки там падают по существу.
 */

const ut = (key: UiKey) => uiText(key, "uk");
const HOUR = 3600000;
const NOW = Date.parse("2026-10-11T09:00:00Z");
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

type Deps = {
  ask: (question: string) => boolean;
  cancel: (id: string) => Promise<unknown>;
  reload: () => void;
  ut: (key: UiKey) => string;
  now?: number;
};
const m = home as {
  LATE_CANCEL_HOURS?: number;
  lateCancel?: (startsAt: string, now?: number) => boolean;
  cancelVisit?: (visit: { id: string; startsAt: string }, deps: Deps) => Promise<boolean>;
};

describe("поздняя отмена — правило сервера", () => {
  test("меньше суток до начала — поздняя; сутки и больше, или приём уже начался — нет", () => {
    expect(m.lateCancel).toBeFunction();
    expect(m.lateCancel!(at(23), NOW)).toBe(true);
    expect(m.lateCancel!(at(0.5), NOW)).toBe(true);
    expect(m.lateCancel!(at(24), NOW)).toBe(false);
    expect(m.lateCancel!(at(48), NOW)).toBe(false);
    expect(m.lateCancel!(at(-1), NOW)).toBe(false);
  });

  test("число и условие — те же, что у сервера (routes/clinic.ts)", () => {
    const clinic = readFileSync(resolve(import.meta.dir, "../../api/src/routes/clinic.ts"), "utf8");
    const serverHours = Number(/const LATE_CANCEL_HOURS = (\d+);/.exec(clinic)?.[1]);
    expect(m.LATE_CANCEL_HOURS).toBe(serverHours);
    expect(clinic.includes("const hoursLeft = (new Date(slot!.startsAt).getTime() - Date.now()) / 3600000;")).toBe(true);
    expect(clinic.includes("const late = hoursLeft < LATE_CANCEL_HOURS && hoursLeft > 0;")).toBe(true);
  });
});

describe("«Скасувати» спрашивает", () => {
  function deps(answer: boolean, refuse?: ApiError) {
    const calls = { asked: [] as string[], cancelled: [] as string[], reloads: 0 };
    const d: Deps = {
      ask: (q) => {
        calls.asked.push(q);
        return answer;
      },
      cancel: async (id) => {
        calls.cancelled.push(id);
        if (refuse) throw refuse;
        return { ok: true, late: false };
      },
      reload: () => calls.reloads++,
      ut,
      now: NOW,
    };
    return { d, calls };
  }

  test("отказался — ничего не уходит, и «скасовано» не показывается", async () => {
    expect(m.cancelVisit).toBeFunction();
    const { d, calls } = deps(false);
    expect(await m.cancelVisit!({ id: "a1", startsAt: at(72) }, d)).toBe(false);
    expect(calls.asked).toHaveLength(1);
    expect(calls.cancelled).toEqual([]);
  });

  test("меньше суток — в вопросе предупреждение о поздней отмене", async () => {
    expect(m.cancelVisit).toBeFunction();
    const { d, calls } = deps(true);
    expect(await m.cancelVisit!({ id: "a1", startsAt: at(5) }, d)).toBe(true);
    expect(calls.asked[0]).toContain("Скасувати прийом?");
    expect(calls.asked[0]).toContain("фахівець це побачить");
    expect(calls.cancelled).toEqual(["a1"]);
    expect(calls.reloads).toBe(1);
  });

  test("положительный контроль: за трое суток — вопрос без предупреждения", async () => {
    expect(m.cancelVisit).toBeFunction();
    const { d, calls } = deps(true);
    await m.cancelVisit!({ id: "a1", startsAt: at(72) }, d);
    expect(calls.asked[0]).toBe("Скасувати прийом?");
  });

  test("отказ сервера (409) — экран перечитывается, отказ доходит до тоста", async () => {
    expect(m.cancelVisit).toBeFunction();
    const { d, calls } = deps(true, new ApiError("Прийом уже змінили", 409));
    const outcome = await m.cancelVisit!({ id: "a1", startsAt: at(5) }, d).then(
      () => "ok",
      (e: Error) => e.message,
    );
    expect(outcome).toBe("Прийом уже змінили");
    expect(calls.reloads).toBe(1);
  });
});

describe("экран кабинета", () => {
  const src = readFileSync(resolve(import.meta.dir, "../src/patient/Home.tsx"), "utf8");

  test("«Підтвердити» и «Скасувати» не перечитывают только на успехе", () => {
    expect(/\.then\(visits\.reload\)/.test(src), ".then(visits.reload) — перечитывание только на успехе").toBe(false);
    expect(src.includes("moveAndReload(() => api.confirmAppointment(id), visits.reload)")).toBe(true);
  });

  test("отмена идёт через вопрос", () => {
    expect(src.includes("cancelVisit(visit, {")).toBe(true);
    expect(src.includes("ask: (question) => window.confirm(question)")).toBe(true);
  });
});
