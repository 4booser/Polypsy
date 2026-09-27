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

import { renderCoded, type ServerTextKey, type TextParams } from "./serverStrings";
import type { Lang } from "./types";

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

/**
 * Почему условие выполнилось или не выполнилось.
 *
 * Кодом и подстановками, а не готовой фразой (волна 13). Объяснение
 * хранится в rule_hits.explanation и читается потом — другим человеком, на
 * его языке, иногда через месяц. Фраза, собранная здесь по-русски, так и
 * лежала бы русской в базе навсегда. Текстом объяснение становится при
 * отдаче (explanationFor ниже, маршрут /api/decisions/hits).
 */
export interface ConditionResult {
  met: boolean;
  code: ServerTextKey;
  params: TextParams;
}

/**
 * Условие так, как оно лежит в базе.
 *
 * Новые записи — `code` и `params`. Записанные до волны 13 — только `text`,
 * по-русски: показываются как есть, перевести готовую фразу не из чего, а
 * переписывать объяснение задним числом нельзя — по нему принимали решение.
 */
export interface StoredCondition {
  met: boolean;
  code?: string;
  params?: TextParams;
  text?: string;
}

/** Объяснение срабатывания в хранимом виде — rule_hits.explanation */
export interface StoredExplanation {
  title: string;
  because: StoredCondition[];
  actions: RuleAction[];
}

/**
 * Объяснение на языке того, кто его читает: одна строка на условие.
 *
 * Форма ответа прежняя — `{ met, text }`: клиент (карточка предложения,
 * заключение) показывает `text` и о кодах не знает.
 */
export function explanationFor(
  stored: StoredExplanation,
  lang: Lang,
): { title: string; because: { met: boolean; text: string }[]; actions: RuleAction[] } {
  return {
    title: stored.title,
    because: (stored.because ?? []).map((b) => ({ met: b.met, text: renderCoded(b, lang) })),
    actions: stored.actions ?? [],
  };
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
    return { met: false, code: "rule.otherSurvey", params: {} };
  }
  const score = input.scores.find((s) => s.scaleCode === c.scaleCode);
  if (!score) return { met: false, code: "rule.noScale", params: { scale: c.scaleCode } };

  const actual = c.metric === "raw" ? score.rawScore : score.normedScore;
  if (actual === null) {
    /*
     * Нормы не применились — например, у человека не указан пол. Условие по
     * нормированному баллу здесь не «не выполнено», а неприменимо, и это
     * важно написать: иначе правило молча не срабатывало бы, и никто не понял
     * бы почему.
     */
    return { met: false, code: "rule.noNorms", params: { scale: c.scaleCode } };
  }

  const met =
    c.op === ">=" ? actual >= c.value
    : c.op === "<=" ? actual <= c.value
    : c.op === ">" ? actual > c.value
    : actual < c.value;

  return {
    met,
    code: c.metric === "raw" ? "rule.raw" : "rule.normed",
    params: { scale: c.scaleCode, actual: round(actual), op: c.op, value: c.value },
  };
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
      /*
       * Уровень — ключом словаря, а не кодом «moderate»: прежде он так и
       * печатался английским словом посреди русской фразы. Ключ в
       * подстановке renderCoded переводит тем же языком, что и фразу.
       */
      return met
        ? { met, code: "rule.riskRaised", params: { severity: `rule.sev.${input.riskSeverity ?? c.severity}` } }
        : { met, code: "rule.riskAbsent", params: { severity: `rule.sev.${c.severity}` } };
    }
    case "history": {
      const met = input.completedCount >= c.completedAtLeast;
      return {
        met,
        code: "rule.history",
        params: { count: input.completedCount, need: c.completedAtLeast },
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
