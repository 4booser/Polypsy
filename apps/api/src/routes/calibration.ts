import { Hono } from "hono";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { roc, type RocResult } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, riskAlerts, scales, surveys } from "../db/schema";
import { audit } from "../lib/audit";
import { notFound } from "../lib/http";
import { percent, round } from "../lib/stats";
import { assertSurveyAccess, surveyScopeFilter } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const calibrationRoutes = new Hono<AppEnv>();

calibrationRoutes.use("*", requireAuth, requireStaff);

/** Минимум исходов КАЖДОГО вида на страту: ниже — кривая рисует шум */
const MIN_PER_OUTCOME = 30;

interface StratumRoc {
  stratum: string;
  confirmed: number;
  notConfirmed: number;
  enough: boolean;
  roc: RocResult | null;
  /** Действующий порог полосы риска, если он один */
  currentThreshold: number | null;
  /** Чувствительность/специфичность ДЕЙСТВУЮЩЕГО порога — с чем сравнивать */
  currentSensitivity: number | null;
  currentSpecificity: number | null;
}

/**
 * ROC-калибровка порогов (5.7).
 *
 * Пороги пособий получены на чужих популяциях. Когда накопятся клинические
 * исходы разбора тревог, система может ответить честно: «действующий порог
 * даёт у нас такую чувствительность и специфичность; вот кандидат по Юдену».
 *
 * Исход берётся из тревоги того же прохождения: confirmed → положительный
 * случай, not_confirmed → отрицательный. needs_followup НЕ используется:
 * «требует наблюдения» — это отложенное решение, а не диагноз, и
 * записывать его в любую из сторон значило бы подделывать данные.
 */
calibrationRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  // прохождения с разобранными тревогами и определённым исходом
  const outcomeRows = await db
    .select({
      responseId: riskAlerts.responseId,
      outcome: riskAlerts.outcome,
      sex: responses.respondentSex,
    })
    .from(riskAlerts)
    .innerJoin(responses, eq(responses.id, riskAlerts.responseId))
    .where(and(eq(riskAlerts.surveyId, surveyId), isNotNull(riskAlerts.outcome)));

  // одно прохождение — один исход: если тревог несколько, подтверждение
  // хотя бы одной делает случай положительным
  const outcomeOf = new Map<string, { positive: boolean; sex: string | null }>();
  for (const r of outcomeRows) {
    if (r.outcome === "needs_followup") continue;
    const prev = outcomeOf.get(r.responseId);
    const positive = r.outcome === "confirmed" || (prev?.positive ?? false);
    outcomeOf.set(r.responseId, { positive, sex: r.sex });
  }

  const scoreRows = outcomeOf.size
    ? await db
        .select({ score: responseScores, code: scales.code, scaleId: scales.id, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, [...outcomeOf.keys()]))
    : [];

  const result = survey.scales
    .filter((s) => s.kind === "clinical")
    .map((scale) => {
      const own = scoreRows.filter((r) => r.code === scale.code);

      // порог действующей интерпретации: нижняя граница первой полосы риска
      const riskBands = scale.bands
        .filter((b) => b.severity === "moderate" || b.severity === "severe")
        .sort((a, b) => a.minScore - b.minScore);
      const currentThreshold = riskBands[0]?.minScore ?? null;

      const strata: StratumRoc[] = (["all", "male", "female"] as const).map((stratum) => {
        const pairs = own
          .filter((r) => {
            const o = outcomeOf.get(r.score.responseId);
            if (!o) return false;
            return stratum === "all" || o.sex === stratum;
          })
          .map((r) => ({
            score: r.score.value,
            positive: outcomeOf.get(r.score.responseId)!.positive,
          }));

        const confirmed = pairs.filter((p) => p.positive).length;
        const notConfirmed = pairs.length - confirmed;
        const enough = confirmed >= MIN_PER_OUTCOME && notConfirmed >= MIN_PER_OUTCOME;

        // характеристики действующего порога считаем всегда, когда есть оба
        // исхода: даже на малой выборке это честнее, чем ничего не показать,
        // — но публикация кандидата разрешена только при enough
        let currentSensitivity: number | null = null;
        let currentSpecificity: number | null = null;
        if (currentThreshold !== null && confirmed > 0 && notConfirmed > 0) {
          const tp = pairs.filter((p) => p.positive && p.score >= currentThreshold).length;
          const fp = pairs.filter((p) => !p.positive && p.score >= currentThreshold).length;
          currentSensitivity = round(tp / confirmed, 3);
          currentSpecificity = round((notConfirmed - fp) / notConfirmed, 3);
        }

        return {
          stratum: stratum === "all" ? "вся выборка" : stratum === "male" ? "мужчины" : "женщины",
          confirmed,
          notConfirmed,
          enough,
          roc: enough ? roc(pairs) : null,
          currentThreshold,
          currentSensitivity,
          currentSpecificity,
        };
      });

      return {
        code: scale.code,
        title: scale.title,
        normalization: scale.normalization,
        strata: strata.filter((s) => s.confirmed + s.notConfirmed > 0),
      };
    })
    .filter((s) => s.strata.length > 0);

  await audit(c, {
    action: "analytics.calibration",
    resourceType: "survey",
    resourceId: surveyId,
    details: { cases: outcomeOf.size, scales: result.length },
  });

  return c.json({
    surveyId,
    title: survey.title,
    minPerOutcome: MIN_PER_OUTCOME,
    cases: outcomeOf.size,
    scales: result,
  });
});

/**
 * Мониторинг PPV скрининга (5.8).
 *
 * Доля подтверждённых среди разобранных тревог — по методикам и месяцам.
 * Падение PPV — ранний признак дрейфа выборки или усталости персонала от
 * ложных тревог: именно из-за неё скрининги тихо умирают.
 */
calibrationRoutes.get("/ppv", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  if (!scoped.length) return c.json({ overall: null, bySurvey: [], byMonth: [] });

  const rows = await db
    .select({
      surveyId: riskAlerts.surveyId,
      outcome: riskAlerts.outcome,
      month: sql<string>`to_char(${riskAlerts.acknowledgedAt}, 'YYYY-MM')`,
    })
    .from(riskAlerts)
    .where(
      and(
        inArray(riskAlerts.surveyId, scoped.map((s) => s.id)),
        isNotNull(riskAlerts.outcome),
        isNotNull(riskAlerts.acknowledgedAt),
      ),
    );

  const decided = rows.filter((r) => r.outcome !== "needs_followup");
  const ppvOf = (subset: typeof decided) => {
    if (!subset.length) return null;
    const confirmed = subset.filter((r) => r.outcome === "confirmed").length;
    return { n: subset.length, confirmed, ppv: percent(confirmed, subset.length) };
  };

  const titleOf = new Map(scoped.map((s) => [s.id, s.title]));
  const bySurvey = [...new Set(decided.map((r) => r.surveyId))]
    .map((id) => ({ surveyId: id, title: titleOf.get(id), ...ppvOf(decided.filter((r) => r.surveyId === id))! }))
    .sort((a, b) => b.n - a.n);

  const byMonth = [...new Set(decided.map((r) => r.month).filter(Boolean))]
    .sort()
    .map((month) => ({ month, ...ppvOf(decided.filter((r) => r.month === month))! }));

  await audit(c, { action: "analytics.calibration", details: { view: "ppv", decided: decided.length } });

  return c.json({
    overall: ppvOf(decided),
    /** Сколько тревог разобрано без определённого исхода — «слепая зона» */
    withoutOutcome: rows.length - decided.length,
    bySurvey,
    byMonth,
  });
});
