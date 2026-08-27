import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { pChart, } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, scales, users } from "../db/schema";
import { audit } from "../lib/audit";
import { notFound } from "../lib/http";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const surveillanceRoutes = new Hono<AppEnv>();

surveillanceRoutes.use("*", requireAuth, requireStaff);

/** Меньше — карта из шума; недели с n<этого рисуются, но без сигналов */
const MIN_WEEK_N = 5;

/**
 * Эпиднадзор (5.6): p-карта доли высокого риска по неделям, по подразделениям.
 *
 * Событие — прохождение, где ХОТЬ ОДНА содержательная шкала легла в
 * moderate|severe. Пределы ±3σ от общего центра; правило серии — 8 точек по
 * одну сторону. Всплеск в роте виден на неделе всплеска, а не в квартальном
 * отчёте.
 */
surveillanceRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  const rows = await db
    .select({
      responseId: responses.id,
      week: sql<string>`to_char(date_trunc('week', ${responses.submittedAt}), 'YYYY-MM-DD')`,
      unit: users.unit,
    })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));

  const ids = rows.map((r) => r.responseId);
  const scored = ids.length
    ? await db
        .select({ responseId: responseScores.responseId, severity: responseScores.severity, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, ids))
    : [];
  const risky = new Set(
    scored
      .filter((s) => s.kind === "clinical" && (s.severity === "severe" || s.severity === "moderate"))
      .map((s) => s.responseId),
  );

  // группировка: подразделение × неделя (плюс сводная линия по всем)
  const series = new Map<string, Map<string, { n: number; x: number }>>();
  const put = (unit: string, week: string, isRisk: boolean) => {
    const weeks = series.get(unit) ?? new Map();
    const cell = weeks.get(week) ?? { n: 0, x: 0 };
    cell.n += 1;
    if (isRisk) cell.x += 1;
    weeks.set(week, cell);
    series.set(unit, weeks);
  };
  for (const r of rows) {
    if (!r.week) continue;
    const isRisk = risky.has(r.responseId);
    put("__all__", r.week, isRisk);
    if (r.unit?.trim()) put(r.unit.trim(), r.week, isRisk);
  }

  const result = [...series.entries()]
    .map(([unit, weeks]) => {
      const sortedWeeks = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const chart = pChart(sortedWeeks.map(([, cell]) => cell));
      if (!chart) return null;
      return {
        unit: unit === "__all__" ? null : unit,
        center: chart.center,
        weeks: sortedWeeks.map(([week, cell], i) => ({
          week,
          n: cell.n,
          x: cell.x,
          p: chart.rows[i]!.p,
          ucl: chart.rows[i]!.ucl,
          // сигналы только на достаточных неделях: карта из шума хуже её отсутствия
          beyondLimits: cell.n >= MIN_WEEK_N && chart.rows[i]!.beyondLimits,
          runSignal: cell.n >= MIN_WEEK_N && chart.rows[i]!.runSignal,
        })),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.unit ?? "").localeCompare(b.unit ?? ""));

  await audit(c, {
    action: "analytics.surveillance",
    resourceType: "survey",
    resourceId: surveyId,
    details: { units: result.length },
  });

  return c.json({ surveyId, title: survey.title, minWeekN: MIN_WEEK_N, series: result });
});
