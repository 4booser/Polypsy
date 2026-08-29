import { describe, expect, test } from "bun:test";
import type { Answer, Question } from "@quizzy/shared";
import { missedBefore } from "../src/runner/progress";

/**
 * Пропущенные обязательные пункты.
 *
 * Ошибка здесь дорога в обе стороны: недосчитать — человек упрётся в отказ
 * сервера в конце двухсотпунктового опросника; пересчитать — приложение будет
 * звать назад к пунктам, которые никто не пропускал.
 */

const q = (id: string, over: Partial<Question> = {}): Question =>
  ({
    id,
    type: "single",
    required: true,
    title: id,
    options: [{ id: `${id}o1`, kind: "option", text: "да" }],
    logic: [],
    ...over,
  }) as unknown as Question;

const answered = (ids: string[]): Map<string, Answer> =>
  new Map(ids.map((id) => [id, { questionId: id, optionIds: [`${id}o1`] } as Answer]));

describe("пропущенные позади", () => {
  const list = [q("a"), q("b"), q("c"), q("d")];

  test("считаются только оставшиеся позади", () => {
    /*
     * Пункты впереди ещё не пропущены. Считать их пропусками значит пугать
     * человека его собственным будущим.
     */
    expect(missedBefore(list, answered([]), 2)).toEqual([0, 1]);
    expect(missedBefore(list, answered([]), 0)).toEqual([]);
  });

  test("текущий пункт не считается пропущенным", () => {
    // на нём стоят, а не прошли мимо
    expect(missedBefore(list, answered([]), 1)).toEqual([0]);
  });

  test("отвеченные не считаются", () => {
    expect(missedBefore(list, answered(["a"]), 3)).toEqual([1, 2]);
    expect(missedBefore(list, answered(["a", "b", "c"]), 3)).toEqual([]);
  });

  test("необязательные пропускают намеренно", () => {
    /*
     * Звать обратно к необязательному пункту значит требовать того, чего
     * методика не требует.
     */
    const withOptional = [q("a"), q("b", { required: false }), q("c")];
    expect(missedBefore(withOptional, answered([]), 3)).toEqual([0, 2]);
  });

  test("информационные экраны не пункты", () => {
    const withInfo = [q("a", { type: "info", required: true }), q("b")];
    expect(missedBefore(withInfo, answered([]), 2)).toEqual([1]);
  });

  test("первый в списке — тот, к которому вернут", () => {
    // возврат к последнему пропущенному оставил бы более ранние позади снова
    expect(missedBefore(list, answered(["b"]), 4)[0]).toBe(0);
  });
});
