import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canMarkNoShow,
  cancellable,
  certificateAvailable,
  startPath,
  undoStep,
} from "../src/pages/visitModel";

/**
 * Ход приёма с экрана приёма (pages/visitModel.ts) — по графу сервера.
 *
 * Сервер ведёт приём «записан → пришёл → начали → закончили» и не даёт
 * перепрыгнуть шаг (NEXT в routes/clinic.ts). Кнопка, которая всегда
 * кончается отказом, на экране не стоит, — поэтому каждое действие шапки
 * проверяется здесь против того же графа.
 */

/** Граф сервера — копия NEXT из routes/clinic.ts: расхождение увидит этот файл, а не человек у кнопки */
const NEXT: Record<string, string[]> = {
  booked: ["arrived", "no_show"],
  confirmed: ["arrived", "no_show"],
  arrived: ["in_progress", "no_show", "booked"],
  in_progress: ["done", "arrived"],
  no_show: ["arrived"],
};
const ALL = ["booked", "confirmed", "arrived", "in_progress", "done", "no_show", "cancelled"];

describe("ход приёма с экрана", () => {
  test("граф здесь — тот же, что на сервере", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../api/src/routes/clinic.ts"), "utf8");
    for (const [from, to] of Object.entries(NEXT)) {
      expect(src, from).toMatch(new RegExp(`\\n  ${from}: \\[${to.map((t) => `"${t}"`).join(", ")}\\],`));
    }
  });

  test("«Почати прийом» — только разрешёнными шагами, по одному", () => {
    for (const status of ALL) {
      let at = status;
      for (const step of startPath(status)) {
        expect(NEXT[at], `${status}: шаг ${at} → ${step}`).toContain(step);
        at = step;
      }
      // начинать — значит прийти к «начали»; закрытому и неявке начинать нечего
      if (startPath(status).length) expect(at).toBe("in_progress");
    }
    expect(startPath("booked")).toEqual(["arrived", "in_progress"]);
    expect(startPath("arrived")).toEqual(["in_progress"]);
    for (const closed of ["in_progress", "done", "no_show", "cancelled"]) expect(startPath(closed)).toEqual([]);
  });

  test("«Неявка» и шаг назад — только там, где сервер их примет", () => {
    for (const status of ALL) {
      if (canMarkNoShow(status)) expect(NEXT[status], status).toContain("no_show");
      const undo = undoStep(status);
      if (undo) expect(NEXT[status], status).toContain(undo.to);
    }
    expect(undoStep("arrived")?.to).toBe("booked");
    expect(undoStep("in_progress")?.to).toBe("arrived");
    expect(undoStep("booked")).toBeNull();
    /* пришедшему «Неявка» в шапке не предлагается: ошибочную явку снимают шагом назад в меню */
    expect(ALL.filter(canMarkNoShow)).toEqual(["booked", "confirmed"]);
    expect(undoStep("arrived")?.label).toBe("v2v.undoArrived");
  });

  test("справка — о состоявшемся приёме; отмена — всего, что не закрыто", () => {
    expect(ALL.filter(certificateAvailable)).toEqual(["arrived", "in_progress", "done"]);
    expect(ALL.filter(cancellable)).toEqual(["booked", "confirmed", "arrived", "in_progress", "no_show"]);
  });
});
