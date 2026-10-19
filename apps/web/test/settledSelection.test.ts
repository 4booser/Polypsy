import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SETTLE_MS, settler } from "../src/components/settledSelection";

/**
 * Шаг клавишами по списку не пишет журнал на каждой строке (волна 26,
 * клинический разбор): запись человека — сводка, основание сигнала,
 * карточка, хронология — читается, когда курсор остановился; нажатие
 * мышью — сразу. То же правило заказчик принял для подготовки к сессии
 * на «Сьогодні».
 */

/** Подставные часы: таймеры срабатывают, когда тест сдвигает время */
function clock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        seq += 1;
        pending.set(seq, { at: now + ms, fn });
        return seq;
      },
      clear: (h: unknown) => void pending.delete(h as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(h);
          t.fn();
        }
      }
    },
  };
}

describe("выбор, на котором остановились", () => {
  test("мышью — запись читается сразу", () => {
    const c = clock();
    const seen: string[] = [];
    const s = settler<string>((v) => seen.push(v), SETTLE_MS, c.timers);
    s.select("a", "click");
    expect(seen).toEqual(["a"]);
  });

  test("J/K подряд — одна запись, у строки, где курсор остановился", () => {
    const c = clock();
    const seen: string[] = [];
    const s = settler<string>((v) => seen.push(v), SETTLE_MS, c.timers);
    for (const id of ["b", "c", "d", "e"]) {
      s.select(id, "key");
      c.advance(150);
    }
    // шли по списку — ни одной записи
    expect(seen).toEqual([]);
    c.advance(SETTLE_MS);
    expect(seen).toEqual(["e"]);
    c.advance(SETTLE_MS * 3);
    expect(seen).toEqual(["e"]);
  });

  test("нажатие мышью снимает ожидание шага: прежняя строка не дочитывается", () => {
    const c = clock();
    const seen: string[] = [];
    const s = settler<string>((v) => seen.push(v), SETTLE_MS, c.timers);
    s.select("b", "key");
    c.advance(200);
    s.select("x", "click");
    c.advance(SETTLE_MS * 2);
    expect(seen).toEqual(["x"]);
  });

  test("порог — около 600 мс", () => {
    expect(SETTLE_MS).toBe(600);
  });
});

describe("экраны списка и записи шагают клавишами без журнала на каждой строке", () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dir, "../src", p), "utf8");

  test("очередь случаев: J/K — шаг, строка мышью — выбор; запись — у остановившегося курсора", () => {
    const src = read("pages/Alerts.tsx");
    expect(src).toContain('if (next) sel.select(next.id, "key");');
    expect(src).toContain('onPick={() => sel.select(c.id, "click")}');
    expect(src).toContain("const settled = sel.isSettled ? selected : null;");
    // случаи человека (alert.list) — тоже по остановившейся строке
    expect(src).toContain("many && settled");
  });

  test("колонка «Мої пацієнти»: J/K ведут курсор, карточка открывается на остановке", () => {
    const src = read("pages/patientCard/PatientList.tsx");
    expect(src).toContain('sel.select(next, "key")');
    expect(src).toContain("if (sel.settled && sel.settled !== currentId) navigate(`/patients/${sel.settled}`);");
    expect(src).not.toContain("navigate(`/patients/${next}`)");
  });

  test("«Хто це» реестра: шаг J/K и стрелками — клавишей, записи ждут остановки", () => {
    const page = read("pages/Patients.tsx");
    expect(page).toContain('whoVia.current = "key";');
    expect(page).toContain("via: whoVia.current,");
    const pane = read("pages/patients/QuickView.tsx");
    expect(pane).toContain("const settledId = useSettledValue(person?.id ?? null, via);");
    expect(pane).toContain("const enabled = !!person && settledId === person.id;");
  });
});
