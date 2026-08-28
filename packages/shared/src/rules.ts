/**
 * Правила поддержки решений.
 *
 * Система предлагает, человек решает. Здесь — только вычисление: сработало ли
 * правило и почему. Ничего не назначается, никому не пишется; это делает
 * вызывающий код, и только после того, как специалист согласился.
 *
 * Функция чистая намеренно. Объяснение «сработало правило №12, потому что…» —
 * то, что человек прочитает в карте и на основании чего примет решение;
 * значит, оно должно проверяться тестом, а не разглядываться в логах.
 */

/** Условие по шкале только что сданной методики */
export interface ScaleCondition {
  kind: "scale";
  /** Методика: null — «любая», условие применяется к сданной */
  surveyId: string | null;
  scaleCode: string;
  /** Что сравниваем: сырой балл или нормированный (T, стен) */
  metric: "raw" | "normed";
  op: ">=" | "<=" | ">" | "<";
  value: number;
}

/** Условие по флагу риска, поднятому подсчётом */
export interface RiskCondition {
  kind: "risk";
  severity: "moderate" | "severe";
}

/** Условие по истории: сколько подобных срабатываний уже было */
export interface HistoryCondition {
  kind: "history";
  /** Сколько завершённых прохождений этой методики у человека уже есть */
  completedAtLeast: number;
}

export type RuleCondition = ScaleCondition | RiskCondition | HistoryCondition;

export type RuleAction =
  | { kind: "suggest_survey"; surveyId: string }
  | { kind: "suggest_pathway"; pathwayId: string }
  | { kind: "notify_duty" }
  | { kind: "advise"; text: string };

export interface DecisionRule {
  id: string;
  title: string;
  version: number;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

/** Что видел движок в момент проверки */
export interface RuleInput {
  surveyId: string;
  scores: { scaleCode: string; rawScore: number; normedScore: number | null }[];
  riskSeverity: "moderate" | "severe" | null;
  /** Сколько завершённых прохождений этой методики у человека уже есть */
  completedCount: number;
}

/** Почему условие выполнилось или не выполнилось — в человеческом виде */
export interface ConditionResult {
  met: boolean;
  text: string;
}

export interface RuleMatch {
  ruleId: string;
  ruleVersion: number;
  title: string;
  actions: RuleAction[];
  /** По одной строке на условие: объяснение целиком, а не «сработало» */
  because: ConditionResult[];
}

function scaleResult(c: ScaleCondition, input: RuleInput): ConditionResult {
  if (c.surveyId && c.surveyId !== input.surveyId) {
    return { met: false, text: `методика не та, к которой относится условие` };
  }
  const score = input.scores.find((s) => s.scaleCode === c.scaleCode);
  if (!score) return { met: false, text: `шкалы ${c.scaleCode} в этом прохождении нет` };

  const actual = c.metric === "raw" ? score.rawScore : score.normedScore;
  if (actual === null) {
    /*
     * Нормы не применились — например, у человека не указан пол. Условие по
     * нормированному баллу здесь не «не выполнено», а неприменимо, и это
     * важно написать: иначе правило молча не срабатывало бы, и никто не понял
     * бы почему.
     */
    return { met: false, text: `${c.scaleCode}: нормы не применились, сравнивать не с чем` };
  }

  const met =
    c.op === ">=" ? actual >= c.value
    : c.op === "<=" ? actual <= c.value
    : c.op === ">" ? actual > c.value
    : actual < c.value;

  const metricName = c.metric === "raw" ? "сырой балл" : "нормированный балл";
  return { met, text: `${c.scaleCode}: ${metricName} ${round(actual)} ${c.op} ${c.value}` };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

function conditionResult(c: RuleCondition, input: RuleInput): ConditionResult {
  switch (c.kind) {
    case "scale":
      return scaleResult(c, input);
    case "risk": {
      const met =
        c.severity === "moderate"
          ? input.riskSeverity !== null
          : input.riskSeverity === "severe";
      return {
        met,
        text: met
          ? `поднят флаг риска (${input.riskSeverity})`
          : `флага риска уровня «${c.severity}» нет`,
      };
    }
    case "history": {
      const met = input.completedCount >= c.completedAtLeast;
      return {
        met,
        text: `прохождений этой методики: ${input.completedCount} (нужно ${c.completedAtLeast})`,
      };
    }
  }
}

/**
 * Проверка правил. Условия соединяются «и»: правило без условий не
 * срабатывает никогда — иначе пустая заготовка, забытая в списке, начала бы
 * предлагать действия по каждому прохождению.
 */
export function evaluateRules(rules: DecisionRule[], input: RuleInput): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.conditions.length === 0 || rule.actions.length === 0) continue;

    const because = rule.conditions.map((c) => conditionResult(c, input));
    if (because.every((r) => r.met)) {
      matches.push({
        ruleId: rule.id,
        ruleVersion: rule.version,
        title: rule.title,
        actions: rule.actions,
        because,
      });
    }
  }

  return matches;
}
