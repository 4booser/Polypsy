import { and, eq, isNull, or, sql } from "drizzle-orm";
import { evaluateRules, type DecisionRule, type RuleInput, type ScoreResult } from "@quizzy/shared";
import { db } from "../db";
import { decisionRules, responses, ruleHits, surveys } from "../db/schema";
import { auditSystem } from "./audit";
import { log } from "./log";

/**
 * Применение правил поддержки решений к только что сданному прохождению.
 *
 * Ничего не назначает и никого не лечит: пишет строки «предложено» с
 * объяснением. Принимает или отклоняет предложение человек, и это тоже
 * фиксируется. Иначе ответственность растворяется между правилом и врачом.
 *
 * Отказ движка не должен ронять сдачу: прохождение уже принято, а поддержка
 * решений — надстройка над ним.
 */
export async function applyRules(params: {
  responseId: string;
  surveyId: string;
  userId: string | null;
  scores: ScoreResult[];
  riskSeverity: "moderate" | "severe" | null;
}): Promise<number> {
  const { responseId, surveyId, userId, scores, riskSeverity } = params;
  // анонимное прохождение не с кем связывать: предложение адресуется человеку
  if (!userId) return 0;

  try {
    const survey = await db.query.surveys.findFirst({
      where: eq(surveys.id, surveyId),
      columns: { groupId: true },
    });

    const rows = await db
      .select()
      .from(decisionRules)
      .where(
        and(
          eq(decisionRules.enabled, true),
          // правило либо общее, либо той же группы, что и методика
          survey?.groupId
            ? or(isNull(decisionRules.groupId), eq(decisionRules.groupId, survey.groupId))
            : isNull(decisionRules.groupId),
        ),
      );
    if (!rows.length) return 0;

    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(responses)
      .where(
        and(
          eq(responses.userId, userId),
          eq(responses.surveyId, surveyId),
          eq(responses.status, "completed"),
        ),
      );

    const input: RuleInput = {
      surveyId,
      scores: scores.map((s) => ({
        scaleCode: s.scaleCode,
        rawScore: s.rawScore,
        /*
         * «Нормированный балл» — это T или стен. Для шкал в сырых баллах и
         * долях нормы нет, и подсовывать вместо неё сырое значение нельзя:
         * правило «T выше 70» сработало бы на доле 0.72.
         */
        normedScore: s.normalization === "tscore" || s.normalization === "sten" ? s.value : null,
      })),
      riskSeverity,
      completedCount: count,
    };

    const rules: DecisionRule[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      version: r.version,
      enabled: r.enabled,
      conditions: r.conditions as DecisionRule["conditions"],
      actions: r.actions as DecisionRule["actions"],
    }));

    const matches = evaluateRules(rules, input);
    for (const match of matches) {
      await db.insert(ruleHits).values({
        id: crypto.randomUUID(),
        ruleId: match.ruleId,
        ruleVersion: match.ruleVersion,
        responseId,
        userId,
        surveyId,
        explanation: { title: match.title, because: match.because, actions: match.actions },
      });

      await auditSystem({
        action: "rule.hit",
        resourceType: "rule",
        resourceId: match.ruleId,
        subjectUserId: userId,
        details: { responseId, title: match.title },
      });
    }

    return matches.length;
  } catch (error) {
    log.warn("rules.apply_failed", { responseId, error: String(error) });
    return 0;
  }
}
