import { describe, expect, test } from "bun:test";
import { classifyChange, comparability, rciForDisplay, reliableChange, type ComparableMark } from "../src/rci";

describe("RCI (Jacobson–Truax)", () => {
  test("классический расчёт руками: SD=10, r=0.9, сдвиг −10", () => {
    // SEM = 10·√0.1 = 3.1623; Sdiff = √2·SEM = 4.4721; RCI = −10/4.4721 = −2.24
    const rc = reliableChange(50, 40, 10, 0.9)!;
    // индекс точный; две цифры — у показа
    expect(rc.rci).toBeCloseTo(-2.236, 3);
    expect(rciForDisplay(rc.rci)).toBe(-2.24);
    expect(rc.sdiff).toBe(4.47);
    expect(rc.significant).toBe(true);
    expect(rc.direction).toBe("down");
  });

  test("тот же сдвиг при низкой надёжности — в пределах ошибки", () => {
    // r=0.5: SEM = 7.07, Sdiff = 10 → RCI = −1.0
    const rc = reliableChange(50, 40, 10, 0.5)!;
    expect(rc.rci).toBe(-1);
    expect(rc.significant).toBe(false);
  });

  test("граница критерия: ниже 1.96 не значимо, выше — значимо", () => {
    const sdiff = Math.sqrt(2) * 10 * Math.sqrt(1 - 0.5); // = 10
    const below = reliableChange(0, 1.95 * sdiff, 10, 0.5)!;
    expect(below.significant).toBe(false);
    const above = reliableChange(0, 1.97 * sdiff, 10, 0.5)!;
    expect(above.significant).toBe(true);
  });

  test("невычислимо: нулевой SD, r за пределами (0,1)", () => {
    expect(reliableChange(1, 2, 0, 0.8)).toBeNull();
    expect(reliableChange(1, 2, 10, 1)).toBeNull();
    expect(reliableChange(1, 2, 10, 0)).toBeNull();
    expect(reliableChange(1, 2, 10, -0.2)).toBeNull();
  });

  test("нет сдвига — flat и не значимо", () => {
    const rc = reliableChange(5, 5, 10, 0.8)!;
    expect(rc.direction).toBe("flat");
    expect(rc.significant).toBe(false);
  });
});

describe("ошибка одного измерения", () => {
  test("SEM отдаётся отдельно и связан с Sdiff множителем √2", () => {
    /*
     * Полоса ошибки на графике строится по SEM, а не по Sdiff: Sdiff — это
     * ошибка РАЗНОСТИ двух замеров, и рисовать её вокруг каждой точки значит
     * завысить неопределённость в полтора раза.
     */
    const rc = reliableChange(10, 16, 8, 0.75)!;
    expect(rc.sem).toBe(4);
    expect(rc.sdiff).toBeCloseTo(4 * Math.SQRT2, 1);
  });

  test("SEM растёт, когда надёжность падает", () => {
    const good = reliableChange(10, 16, 8, 0.9)!;
    const poor = reliableChange(10, 16, 8, 0.5)!;
    expect(poor.sem).toBeGreaterThan(good.sem);
  });
});

/*
 * Внешний разбор: «округление RCI даёт противоречивую классификацию».
 * Значимость решалась по точному индексу, а наружу уходил округлённый: 1,964
 * становился 1,96 с пометкой «достоверно», и classifyChange по тому же числу
 * отвечал «без змін». Теперь индекс точный, а округляет только показ — и так,
 * что показанное число не перескакивает через критерий.
 */
describe("RCI на границе критерия", () => {
  // SD=10, r=0.5 → Sdiff = 10, и RCI равен сдвигу, делённому на десять
  const at = (rci: number) => reliableChange(0, rci * 10, 10, 0.5)!;

  test("1,964: значимо — и классификация говорит то же, а не «без змін»", () => {
    const rc = at(1.964);
    expect(rc.significant).toBe(true);
    expect(classifyChange({ rci: rc.rci, higherIsWorse: false, firstClinical: null, lastClinical: null })).toBe(
      "improved",
    );
    expect(classifyChange({ rci: -rc.rci, higherIsWorse: true, firstClinical: true, lastClinical: false })).toBe(
      "recovered",
    );
  });

  test("показ: две цифры, но 1,964 не превращается в 1,96", () => {
    const shown = rciForDisplay(at(1.964).rci);
    expect(shown).toBe(1.964);
    expect(Math.abs(shown) > 1.96).toBe(at(1.964).significant);
    // и показанное число классифицируется так же, как точное
    expect(classifyChange({ rci: shown, higherIsWorse: false, firstClinical: null, lastClinical: null })).toBe(
      "improved",
    );
    expect(rciForDisplay(-1.9642)).toBe(-1.964);
    expect(rciForDisplay(1.96001)).toBe(1.96001);
  });

  test("вдали от критерия — обычные две цифры; ниже критерия — не значимо ни так, ни эдак", () => {
    expect(rciForDisplay(2.2361)).toBe(2.24);
    expect(rciForDisplay(-0.333)).toBe(-0.33);
    const below = at(1.9591);
    expect(below.significant).toBe(false);
    // и снизу «1,96» не пишется: на критерии стоит только то, что на нём и есть
    expect(rciForDisplay(below.rci)).toBe(1.959);
    expect(classifyChange({ rci: below.rci, higherIsWorse: false, firstClinical: null, lastClinical: null })).toBe(
      "unchanged",
    );
  });

  test("точно на критерии — не значимо и показывается как есть", () => {
    expect(rciForDisplay(1.96)).toBe(1.96);
    expect(classifyChange({ rci: 1.96, higherIsWorse: false, firstClinical: null, lastClinical: null })).toBe(
      "unchanged",
    );
  });
});

/*
 * Одно правило сравнимости двух замеров — для динамики, сводки случая и
 * экрана прохождения (внешний и клинический разборы: сравнение неприведённых
 * версий, сырой балл против T-балла, недостоверный протокол как база).
 */
describe("сравнимость двух замеров", () => {
  const v = (version: number | null, extra: Partial<ComparableMark> = {}): ComparableMark => ({
    version,
    normalized: true,
    normalization: "tscore",
    reliable: true,
    ...extra,
  });

  test("одна версия, одни единицы — сравнимы", () => {
    expect(comparability(v(2), v(2))).toBeNull();
    // обе сырые (норм нет ни у одной) — тоже одни единицы
    expect(comparability(v(2, { normalized: false }), v(2, { normalized: false }))).toBeNull();
    // до версионирования: неизвестная версия у обоих — одна и та же
    expect(comparability(v(null), v(null))).toBeNull();
  });

  test("сырой против нормированного — units, даже в одной версии", () => {
    expect(comparability(v(2, { normalized: false }), v(2))).toBe("units");
    expect(comparability(v(2, { normalization: "ratio" }), v(2))).toBe("units");
  });

  test("недостоверный протокол не годится в концы сравнения", () => {
    expect(comparability(v(2, { reliable: false }), v(2))).toBe("unreliable");
    expect(comparability(v(2), v(3, { reliable: false }), { equated: true })).toBe("unreliable");
  });

  test("разные версии — только через приведение, и приводятся только нормированные", () => {
    expect(comparability(v(1), v(3))).toBe("version");
    expect(comparability(v(1), v(3), { equated: true })).toBeNull();
    // приведение переводит и единицы: доля старой версии к T новой — через моменты
    expect(comparability(v(1, { normalization: "ratio" }), v(3), { equated: true })).toBeNull();
    expect(comparability(v(1, { normalized: false }), v(3), { equated: true })).toBe("units");
    expect(comparability(v(1, { normalized: false }), v(3, { normalized: false }))).toBe("version");
  });

  test("поля нет (старый ответ, кэш мобильного) — считается «да», как и раньше", () => {
    expect(comparability({ version: 2 }, { version: 2 })).toBeNull();
  });
});
