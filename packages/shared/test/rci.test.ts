import { describe, expect, test } from "bun:test";
import { reliableChange } from "../src/rci";

describe("RCI (Jacobson–Truax)", () => {
  test("классический расчёт руками: SD=10, r=0.9, сдвиг −10", () => {
    // SEM = 10·√0.1 = 3.1623; Sdiff = √2·SEM = 4.4721; RCI = −10/4.4721 = −2.24
    const rc = reliableChange(50, 40, 10, 0.9)!;
    expect(rc.rci).toBe(-2.24);
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
