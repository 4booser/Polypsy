import { describe, expect, test } from "bun:test";
import type { Option, Question } from "@quizzy/shared";
import { choicesOf, planPaste } from "../src/components/FastEntry";
import { scaleQuestion, yesNoQuestion } from "../../../packages/shared/test/fixtures";

/**
 * Быстрый ввод бланка: строка ответов целиком (FastEntry, planPaste).
 *
 * Ошибка здесь не роняет ничего — она молча пишет не тот балл: «2» уходит не
 * в тот вариант, обрыв строки — в соседний пункт. Поэтому строка либо
 * ложится целиком, либо не ложится вовсе и называет причину.
 */

/** Пункт PHQ-9: четыре ответа с баллом, четвёртый — критический, плюс строка матрицы (не вариант) */
function likert(position: number, critical = false): Question {
  const q = yesNoQuestion(position, { type: "single" });
  const texts = ["Зовсім ні", "Кілька днів", "Більше половини днів", "Майже щодня"];
  const options: Option[] = texts.map((text, k) => ({
    id: `${q.id}-o${k + 1}`,
    questionId: q.id,
    text,
    keyCode: null,
    score: k,
    kind: "option",
    position: k + 1,
    riskFlag: critical && k === 3,
    riskSeverity: critical && k === 3 ? "severe" : null,
    riskLabel: null,
  }));
  /* строка матрицы впереди вариантов: номер варианта считается только среди ответов */
  const row: Option = { ...options[0]!, id: `${q.id}-row`, text: "рядок", kind: "row", position: 0 };
  return { ...q, options: [row, ...options] };
}

const asked = [likert(0), likert(1), likert(2, true)];
const ids = (plan: ReturnType<typeof planPaste>) =>
  plan && plan.ok ? plan.planned.map(([, a]) => a.optionIds?.[0]) : plan;

describe("строка ответов целиком", () => {
  test("строка из таблицы — с табуляциями — ложится так же, как через запятую, пробел или подряд", () => {
    const want = [asked[0]!.id + "-o1", asked[1]!.id + "-o3", asked[2]!.id + "-o4"];
    // Excel и LibreOffice копируют строку ячеек с табуляциями; прежде она уходила в «вставлено 5 з 3»
    expect(ids(planPaste(asked, "1\t3\t4"))).toEqual(want);
    expect(ids(planPaste(asked, "1,3,4"))).toEqual(want);
    expect(ids(planPaste(asked, "1, 3 ,4"))).toEqual(want);
    expect(ids(planPaste(asked, "1 3 4"))).toEqual(want);
    expect(ids(planPaste(asked, "134"))).toEqual(want);
    expect(ids(planPaste(asked, "  1\t3\t4\n"))).toEqual(want);
  });

  test("цифра — номер варианта среди ответов: критический ответ уходит своим вариантом", () => {
    const plan = planPaste(asked, "1\t1\t4");
    expect(plan?.ok).toBe(true);
    const last = plan && plan.ok ? plan.planned[2]![1].optionIds![0] : null;
    const option = choicesOf(asked[2]!).find((o) => o.id === last);
    expect(option?.riskFlag, "критический вариант не тот").toBe(true);
    expect(option?.text).toBe("Майже щодня");
  });

  test("не та длина — отказ с числами, ничего не применяется", () => {
    expect(planPaste(asked, "1\t3")).toEqual({ ok: false, error: { kind: "count", got: 2, need: 3 } });
    expect(planPaste(asked, "1,3,4,2")).toEqual({ ok: false, error: { kind: "count", got: 4, need: 3 } });
  });

  test("несуществующий вариант или не число — отказ с номером пункта и значением", () => {
    expect(planPaste(asked, "1\t5\t4")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "5" } });
    expect(planPaste(asked, "1,0,4")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "0" } });
    expect(planPaste(asked, "1,x,4")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "x" } });
    expect(planPaste(asked, "1,2.5,4")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "2.5" } });
  });

  test("числовой пункт берёт число, пустая строка — не отказ, а ничего", () => {
    const mixed = [likert(0), scaleQuestion(1, 10)];
    const plan = planPaste(mixed, "2\t7");
    expect(plan && plan.ok ? plan.planned[1]![1] : null).toEqual({ number: 7 });
    expect(planPaste(mixed, "   ")).toBeNull();
  });
});
