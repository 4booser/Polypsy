import { describe, expect, test } from "bun:test";
import { versionMarks } from "../src/charts/marks";

/**
 * Отметки смены версии методики.
 *
 * Скачок сразу после правки ключей — артефакт, а не изменение состояния.
 * Прочесть его как улучшение стоит дороже, чем лишний пунктир на графике.
 */

const point = (day: string, versionNo: number | null) => ({
  submittedAt: `2026-0${day}-01T10:00:00.000Z`,
  versionNo,
});

describe("отметки версий", () => {
  test("первая версия в начале ряда не отмечается", () => {
    // «версия 1» в начале — не событие, а условие задачи
    expect(versionMarks([point("1", 1), point("2", 1)])).toEqual([]);
  });

  test("отмечается первый замер новой версии", () => {
    const marks = versionMarks([point("1", 1), point("2", 2), point("3", 2)]);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.label).toBe("v2");
  });

  test("несколько смен подряд отмечаются каждая", () => {
    const marks = versionMarks([point("1", 1), point("2", 2), point("3", 3)]);
    expect(marks.map((m) => m.label)).toEqual(["v2", "v3"]);
  });

  test("замеры без версии не создают ложных отметок", () => {
    /*
     * Версия неизвестна у старых прохождений. Считать «неизвестно» сменой
     * значило бы рисовать пунктир там, где ничего не менялось.
     */
    expect(versionMarks([point("1", 1), point("2", null), point("3", 1)])).toEqual([]);
  });

  test("возврат к прежней версии тоже отмечается", () => {
    // откат ключей — такое же событие, как и правка
    const marks = versionMarks([point("1", 2), point("2", 1)]);
    expect(marks.map((m) => m.label)).toEqual(["v1"]);
  });
});
