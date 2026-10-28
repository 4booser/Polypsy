import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  explanationFor,
  t,
  type Lang,
  type RuleHit,
  type StoredCondition,
  type StoredExplanation,
  type SuggestedSurvey,
} from "@quizzy/shared";
import { db } from "../db";
import { decisionRules, responses, ruleHits, scales, surveyAccess, surveys, users } from "../db/schema";
import { fullNameOf } from "./auth";

/**
 * Срабатывание правила для ответа сервера — одно на оба места, где их читают:
 * очередь предложений (routes/decisions.ts, GET /hits) и обстановку протокола
 * (routes/responseContext.ts). Раньше каждое собирало строку само.
 *
 * Кроме объяснения на языке читающего (explanationFor) — то, без чего строку
 * «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10» не собрать и не превратить в
 * одно нажатие:
 *
 *  - surveyTitle — методика, по которой сработало, названием;
 *  - basis — значения шкал из выполненных условий, шкала — названием той
 *    версии, которую человек проходил (код шкалы врачу ничего не говорит);
 *  - suggested — предложенные методики названием и с тем, что с ними уже
 *    сделано: назначена сейчас (до какого дня) и пройдена ли после
 *    срабатывания. Иначе строка предлагала бы назначить то, что человек уже
 *    проходит, а нажатие выдавало бы методику второй раз.
 *
 * Всё читается в контексте запроса: под ролью приложения политики строк
 * прячут чужое так же, как в остальных списках, — чего читающему не видно,
 * того в строке просто нет (название методики — пустое, назначения — нет).
 */

export interface HitRow {
  hit: typeof ruleHits.$inferSelect;
  rule: typeof decisionRules.$inferSelect;
  patient: typeof users.$inferSelect | null;
}

/** Значение шкалы из выполненного условия по шкале (rule.raw / rule.normed) */
function basisOf(stored: StoredExplanation): { code: string; value: number }[] {
  const out: { code: string; value: number }[] = [];
  for (const b of (stored.because ?? []) as StoredCondition[]) {
    if (!b.met || (b.code !== "rule.raw" && b.code !== "rule.normed")) continue;
    const scale = b.params?.scale;
    const actual = Number(b.params?.actual);
    if (typeof scale === "string" && Number.isFinite(actual)) out.push({ code: scale, value: actual });
  }
  return out;
}

export async function hitViews(rows: readonly HitRow[], lang: Lang): Promise<RuleHit[]> {
  if (!rows.length) return [];
  const stored = rows.map((r) => r.hit.explanation as StoredExplanation);
  const explained = stored.map((s) => explanationFor(s, lang));

  const targets = [
    ...new Set(explained.flatMap((e) => e.actions.flatMap((a) => (a.kind === "suggest_survey" ? [a.surveyId] : [])))),
  ];
  const people = [...new Set(rows.map((r) => r.hit.userId))];
  const surveyIds = [...new Set([...targets, ...rows.map((r) => r.hit.surveyId)])];
  const responseIds = [...new Set(rows.map((r) => r.hit.responseId))];

  const [surveyRows, grantRows, doneRows, scaleRows] = await Promise.all([
    db
      .select({ id: surveys.id, title: surveys.title, administration: surveys.administration })
      .from(surveys)
      .where(inArray(surveys.id, surveyIds)),
    targets.length
      ? db
          .select({ surveyId: surveyAccess.surveyId, userId: surveyAccess.userId, expiresAt: surveyAccess.expiresAt })
          .from(surveyAccess)
          .where(
            and(
              inArray(surveyAccess.userId, people),
              inArray(surveyAccess.surveyId, targets),
              // действующее назначение: без срока или срок ещё не прошёл
              or(isNull(surveyAccess.expiresAt), gt(surveyAccess.expiresAt, sql`now()`)),
            ),
          )
      : Promise.resolve([]),
    targets.length
      ? db
          .select({ surveyId: responses.surveyId, userId: responses.userId, submittedAt: responses.submittedAt })
          .from(responses)
          .where(and(inArray(responses.userId, people), inArray(responses.surveyId, targets), eq(responses.status, "completed")))
      : Promise.resolve([]),
    // шкалы той версии, которую человек проходил: название по коду из условия
    db
      .select({ responseId: responses.id, code: scales.code, title: scales.title, position: scales.position })
      .from(responses)
      .innerJoin(scales, eq(scales.versionId, responses.versionId))
      .where(inArray(responses.id, responseIds)),
  ]);

  const surveyById = new Map(surveyRows.map((s) => [s.id, s] as const));
  const pair = (userId: string | null, surveyId: string) => `${userId ?? ""}|${surveyId}`;
  const grantOf = new Map(grantRows.map((g) => [pair(g.userId, g.surveyId), g.expiresAt ?? null] as const));
  const doneOf = new Map<string, string[]>();
  for (const d of doneRows) {
    if (!d.submittedAt) continue;
    const k = pair(d.userId, d.surveyId);
    doneOf.set(k, [...(doneOf.get(k) ?? []), d.submittedAt]);
  }
  const scaleTitle = new Map(scaleRows.map((s) => [`${s.responseId}|${s.code}`, s.title] as const));
  // главная шкала прохождения — первая по порядку: её в строке не называют
  const mainScale = new Map<string, { code: string; position: number }>();
  for (const s of scaleRows) {
    const was = mainScale.get(s.responseId);
    if (!was || s.position < was.position) mainScale.set(s.responseId, { code: s.code, position: s.position });
  }

  return rows.map((r, i) => {
    const explanation = explained[i]!;
    const created = Date.parse(r.hit.createdAt);
    const suggested: SuggestedSurvey[] = explanation.actions.flatMap((a) => {
      if (a.kind !== "suggest_survey") return [];
      const row = surveyById.get(a.surveyId);
      const k = pair(r.hit.userId, a.surveyId);
      const after = (doneOf.get(k) ?? []).filter((at) => Date.parse(at) >= created).sort();
      return [
        {
          surveyId: a.surveyId,
          title: row ? t(row.title as never, lang) : "",
          clinician: row?.administration === "clinician",
          assigned: grantOf.has(k) ? { until: grantOf.get(k) ?? null } : null,
          doneAt: after.at(-1) ?? null,
        },
      ];
    });
    const source = surveyById.get(r.hit.surveyId);
    return {
      id: r.hit.id,
      ruleTitle: r.rule.title,
      ruleVersion: r.hit.ruleVersion,
      userId: r.hit.userId,
      userName: r.patient ? fullNameOf(r.patient) : "—",
      surveyId: r.hit.surveyId,
      responseId: r.hit.responseId,
      status: r.hit.status as RuleHit["status"],
      explanation,
      createdAt: r.hit.createdAt,
      surveyTitle: source ? t(source.title as never, lang) : "",
      basis: basisOf(stored[i]!).map((b) => {
        if (mainScale.get(r.hit.responseId)?.code === b.code) return { scale: null, value: b.value };
        const title = scaleTitle.get(`${r.hit.responseId}|${b.code}`);
        return { scale: title ? t(title as never, lang) : b.code, value: b.value };
      }),
      suggested,
    };
  });
}
