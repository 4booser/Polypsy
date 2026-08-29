import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, markOf, rowSummary, type QualityCell } from "../src/charts/quality";

/**
 * Чтение тепловой карты пунктов.
 *
 * Правило решает, на что человек посмотрит, и ошибка в нём стоит дорого в обе
 * стороны: слишком мягкий порог заливает карту метками и она перестаёт что-то
 * значить; слишком строгий прячет то, ради чего карта существует.
 */

const cell = (over: Partial<QualityCell> = {}): QualityCell => ({
  answered: true,
  rel: 1,
  run: 1,
  ...over,
});

describe("метка ячейки", () => {
  test("обычный ответ не помечается", () => {
    expect(markOf(cell())).toBe("none");
    expect(markOf(cell({ rel: 0.6 }))).toBe("none");
  });

  test("вдвое быстрее медианы — ещё не подозрительно", () => {
    /*
     * Половина медианы — это обычный разброс между людьми. Метка на половине
     * ячеек перестала бы что-либо значить.
     */
    expect(markOf(cell({ rel: 0.5 }))).toBe("none");
  });

  test("впятеро быстрее медианы — подозрительно", () => {
    expect(markOf(cell({ rel: 0.15 }))).toBe("fast");
  });

  test("короткая серия одинаковых ответов не помечается", () => {
    // в опроснике на двести пунктов серия из трёх встречается у всех
    expect(markOf(cell({ run: 3 }))).toBe("none");
    expect(markOf(cell({ run: DEFAULT_THRESHOLDS.runLength - 1 }))).toBe("none");
  });

  test("длинная серия помечается", () => {
    expect(markOf(cell({ run: DEFAULT_THRESHOLDS.runLength }))).toBe("run");
    expect(markOf(cell({ run: 40 }))).toBe("run");
  });

  test("два признака различаются от каждого по отдельности", () => {
    /*
     * Свести их в одно число значит спрятать от человека то, на что он
     * смотрит: быстрый ответ и серия — разные вещи с разными причинами.
     */
    expect(markOf(cell({ rel: 0.1, run: 20 }))).toBe("both");
    expect(markOf(cell({ rel: 0.1, run: 1 }))).toBe("fast");
    expect(markOf(cell({ rel: 1, run: 20 }))).toBe("run");
  });

  test("неотвеченный пункт — не «быстрый»", () => {
    // пропуск и мгновенный ответ читаются по-разному, и путать их нельзя
    expect(markOf(cell({ answered: false, rel: 0.01, run: 50 }))).toBe("missing");
  });

  test("отсутствие времени не делает ответ подозрительным", () => {
    // старые прохождения телеметрии не несут; «нет данных» — не «слишком быстро»
    expect(markOf(cell({ rel: null }))).toBe("none");
  });
});

describe("сводка по строке", () => {
  test("считает признаки раздельно, а совпадение — в оба", () => {
    const cells = [
      cell({ rel: 0.1 }),
      cell({ run: 20 }),
      cell({ rel: 0.1, run: 20 }),
      cell({ answered: false }),
      cell(),
    ];
    expect(rowSummary(cells)).toEqual({ fast: 2, run: 2, missing: 1 });
  });

  test("пустая строка даёт нули, а не пустоту", () => {
    expect(rowSummary([])).toEqual({ fast: 0, run: 0, missing: 0 });
  });
});
