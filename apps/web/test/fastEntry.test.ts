import { describe, expect, test } from "bun:test";
import type { Option, Question } from "@quizzy/shared";
import { choicesOf, keyBase, planPaste } from "../src/components/FastEntry";
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
    expect(ids(planPaste(asked, "0\t2\t3"))).toEqual(want);
    expect(ids(planPaste(asked, "0,2,3"))).toEqual(want);
    expect(ids(planPaste(asked, "0, 2 ,3"))).toEqual(want);
    expect(ids(planPaste(asked, "0 2 3"))).toEqual(want);
    expect(ids(planPaste(asked, "023"))).toEqual(want);
    expect(ids(planPaste(asked, "  0\t2\t3\n"))).toEqual(want);
  });

  test("цифра — номер варианта среди ответов: критический ответ уходит своим вариантом", () => {
    const plan = planPaste(asked, "0\t0\t3");
    expect(plan?.ok).toBe(true);
    const last = plan && plan.ok ? plan.planned[2]![1].optionIds![0] : null;
    const option = choicesOf(asked[2]!).find((o) => o.id === last);
    expect(option?.riskFlag, "критический вариант не тот").toBe(true);
    expect(option?.text).toBe("Майже щодня");
  });

  test("не та длина — отказ с числами, ничего не применяется", () => {
    expect(planPaste(asked, "0\t2")).toEqual({ ok: false, error: { kind: "count", got: 2, need: 3 } });
    expect(planPaste(asked, "0,2,3,1")).toEqual({ ok: false, error: { kind: "count", got: 4, need: 3 } });
  });

  test("несуществующий вариант или не число — отказ с номером пункта и значением", () => {
    expect(planPaste(asked, "0\t4\t3")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "4" } });
    expect(planPaste(asked, "0,9,3")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "9" } });
    expect(planPaste(asked, "0,x,3")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "x" } });
    expect(planPaste(asked, "0,2.5,3")).toEqual({ ok: false, error: { kind: "bad", at: 2, value: "2.5" } });
  });

  test("числовой пункт берёт число, пустая строка — не отказ, а ничего", () => {
    const mixed = [likert(0), scaleQuestion(1, 10)];
    const plan = planPaste(mixed, "2\t7");
    expect(plan && plan.ok ? plan.planned[1]![1] : null).toEqual({ number: 7 });
    expect(planPaste(mixed, "   ")).toBeNull();
  });
});

describe("с какого числа нумеруются варианты (keyBase)", () => {
  /*
   * На бланке HAM-D и PHQ-9 у вариантов напечатаны баллы с нуля: с единицы
   * специалист прибавлял бы единицу в уме, и ошибка молча ложилась в балл.
   */
  const scored = (position: number, scores: number[]): Question => {
    const q = likert(position);
    const opts = scores.map((score, k) => ({ ...choicesOf(q)[0]!, id: `${q.id}-s${k}`, score, position: k + 1, riskFlag: false }));
    return { ...q, options: opts };
  };

  test("шкалы подряд с нуля — с нуля, и строка читается так же", () => {
    expect(keyBase(asked)).toBe(0);
    // обратный пункт (4..0) — те же колонки бланка, нумерация методики не ломается
    expect(keyBase([scored(0, [0, 1, 2, 3, 4]), scored(1, [4, 3, 2, 1, 0]), scored(2, [0, 1, 2])])).toBe(0);
  });

  test("«так / ні», шкалы с единицы и неравные баллы — с единицы, как прежде", () => {
    expect(keyBase([yesNoQuestion(0), yesNoQuestion(1)])).toBe(1);
    expect(keyBase([scored(0, [1, 2, 3, 4, 5, 6, 7])])).toBe(1);
    expect(keyBase([scored(0, [0, 2, 3, 4, 6])])).toBe(1);
    // одна методика — одна нумерация: пункт «так / ні» среди шкал возвращает единицу всей методике
    expect(keyBase([likert(0), yesNoQuestion(1)])).toBe(1);
    const yn = [yesNoQuestion(0), yesNoQuestion(1)];
    const plan = planPaste(yn, "1 2");
    expect(plan && plan.ok ? plan.planned.map(([, a]) => a.optionIds?.[0]) : plan).toEqual([`${yn[0]!.id}-yes`, `${yn[1]!.id}-no`]);
  });
});
