import { describe, expect, test } from "bun:test";
import { evaluateRules, type DecisionRule, type RuleInput } from "./rules";

/**
 * Правила поддержки решений.
 *
 * Проверяется не только «сработало / не сработало», но и объяснение: именно
 * его прочитает специалист, принимая решение. Объяснение, которое врёт или
 * молчит, хуже отсутствующего правила.
 */

const input = (over: Partial<RuleInput> = {}): RuleInput => ({
  surveyId: "s1",
  scores: [
    { scaleCode: "Sr", rawScore: 0.72, normedScore: 8 },
    { scaleCode: "L", rawScore: 0.2, normedScore: null },
  ],
  riskSeverity: null,
  completedCount: 1,
  ...over,
});

const rule = (over: Partial<DecisionRule> = {}): DecisionRule => ({
  id: "r1",
  title: "Высокий риск",
  version: 3,
  enabled: true,
  conditions: [
    { kind: "scale", surveyId: "s1", scaleCode: "Sr", metric: "raw", op: ">=", value: 0.6 },
  ],
  actions: [{ kind: "notify_duty" }],
  ...over,
});

describe("движок правил", () => {
  test("срабатывает и объясняет чем", () => {
    const [hit] = evaluateRules([rule()], input());
    expect(hit?.ruleId).toBe("r1");
    expect(hit?.ruleVersion).toBe(3);
    expect(hit?.because[0]!.text).toBe("Sr: сырой балл 0.72 >= 0.6");
  });

  test("условия соединяются «и»", () => {
    const two = rule({
      conditions: [
        { kind: "scale", surveyId: "s1", scaleCode: "Sr", metric: "raw", op: ">=", value: 0.6 },
        { kind: "risk", severity: "severe" },
      ],
    });
    expect(evaluateRules([two], input())).toHaveLength(0);
    expect(evaluateRules([two], input({ riskSeverity: "severe" }))).toHaveLength(1);
  });

  test("правило без условий не срабатывает никогда", () => {
    /*
     * Иначе пустая заготовка, забытая в списке, начала бы предлагать действия
     * по каждому прохождению — и предложения перестали бы что-либо значить.
     */
    expect(evaluateRules([rule({ conditions: [] })], input())).toEqual([]);
  });

  test("правило без действий тоже не срабатывает", () => {
    expect(evaluateRules([rule({ actions: [] })], input())).toEqual([]);
  });

  test("выключенное правило пропускается", () => {
    expect(evaluateRules([rule({ enabled: false })], input())).toEqual([]);
  });

  test("отсутствующие нормы — не «не выполнено», а «сравнивать не с чем»", () => {
    /*
     * У человека не указан пол, нормы не применились. Молчаливое
     * несрабатывание здесь — худший исход: никто не поймёт, почему правило
     * не отработало на очевидном случае.
     */
    const normed = rule({
      conditions: [
        { kind: "scale", surveyId: "s1", scaleCode: "L", metric: "normed", op: ">=", value: 5 },
      ],
    });
    const hits = evaluateRules([normed], input());
    expect(hits).toHaveLength(0);

    // объяснение доступно и без срабатывания — через прямую проверку условия
    const [checked] = evaluateRules(
      [rule({ conditions: [{ kind: "scale", surveyId: "s1", scaleCode: "L", metric: "raw", op: ">=", value: 0.1 }] })],
      input(),
    );
    expect(checked?.because[0]!.text).toBe("L: сырой балл 0.2 >= 0.1");
  });

  test("условие чужой методики не срабатывает", () => {
    const foreign = rule({
      conditions: [
        { kind: "scale", surveyId: "s2", scaleCode: "Sr", metric: "raw", op: ">=", value: 0.1 },
      ],
    });
    expect(evaluateRules([foreign], input())).toEqual([]);
  });

  test("условие по истории считает завершённые прохождения", () => {
    const repeat = rule({
      conditions: [{ kind: "history", completedAtLeast: 2 }],
    });
    expect(evaluateRules([repeat], input({ completedCount: 1 }))).toHaveLength(0);
    const [hit] = evaluateRules([repeat], input({ completedCount: 2 }));
    expect(hit?.because[0]!.text).toBe("прохождений этой методики: 2 (нужно 2)");
  });

  test("«умеренный» риск покрывается и тяжёлым", () => {
    // порог, а не точное совпадение: правило «при любом флаге риска» не должно
    // молчать именно тогда, когда риск тяжёлый
    const any = rule({ conditions: [{ kind: "risk", severity: "moderate" }] });
    expect(evaluateRules([any], input({ riskSeverity: "severe" }))).toHaveLength(1);
    expect(evaluateRules([any], input({ riskSeverity: "moderate" }))).toHaveLength(1);
    expect(evaluateRules([any], input({ riskSeverity: null }))).toHaveLength(0);
  });
});
