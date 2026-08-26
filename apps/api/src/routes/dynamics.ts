import { Hono } from "hono";
import { and, asc, eq, inArray } from "drizzle-orm";
import { t } from "@quizzy/shared";
import type { RespondentDynamics, ScaleDynamics } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, scales, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { notFound } from "../lib/http";
import { percentileOf } from "../lib/norms";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const dynamicsRoutes = new Hono<AppEnv>();

dynamicsRoutes.use("*", requireAuth, requireStaff);

/** Пациенты, проходившие методики в зоне ответственности сотрудника */
dynamicsRoutes.get("/respondents", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json([]);

  const rows = await db
    .select({
      userId: responses.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      email: users.email,
      surveyId: responses.surveyId,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .innerJoin(users, eq(users.id, responses.userId))
    .where(and(inArray(responses.surveyId, surveyIds), eq(responses.status, "completed")));

  const byUser = new Map<string, { fullName: string; email: string; count: number; last: string | null }>();
  for (const r of rows) {
    if (!r.userId) continue;
    const cur = byUser.get(r.userId) ?? { fullName: fullNameOf(r), email: r.email, count: 0, last: null };
    cur.count++;
    if (!cur.last || (r.submittedAt ?? "") > cur.last) cur.last = r.submittedAt;
    byUser.set(r.userId, cur);
  }

  return c.json(
    [...byUser.entries()]
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")),
  );
});

/**
 * Динамика одного пациента: как менялись баллы по субшкалам от замера к замеру.
 *
 * Субшкалы разных версий методики сопоставляются по коду, а не по id —
 * иначе правка методики разрывала бы график пополам.
 */
dynamicsRoutes.get("/respondents/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("Пациент не найден");

  const scope = await surveyScopeFilter(staff);
  const scoped = await db.select().from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) {
    return c.json({ userId, fullName: fullNameOf(patient), email: patient.email, surveys: [] });
  }

  const responseRows = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(asc(responses.submittedAt));

  if (!responseRows.length) {
    return c.json({ userId, fullName: fullNameOf(patient), email: patient.email, surveys: [] });
  }

  const scoreRows = await db
    .select()
    .from(responseScores)
    .where(inArray(responseScores.responseId, responseRows.map((r) => r.id)));

  const scaleRows = await db
    .select()
    .from(scales)
    .where(inArray(scales.id, [...new Set(scoreRows.map((s) => s.scaleId))]));
  const scaleById = new Map(scaleRows.map((s) => [s.id, s]));

  // нормативная выборка: все баллы по субшкалам с тем же кодом в той же методике
  const sampleByKey = new Map<string, number[]>();
  const allScores = await db
    .select({ score: responseScores, surveyId: responses.surveyId, scaleCode: scales.code })
    .from(responseScores)
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(and(inArray(responses.surveyId, surveyIds), eq(responses.status, "completed")));
  for (const row of allScores) {
    const key = `${row.surveyId}:${row.scaleCode}`;
    const list = sampleByKey.get(key) ?? [];
    list.push(row.score.value);
    sampleByKey.set(key, list);
  }

  const scoresByResponse = new Map<string, typeof scoreRows>();
  for (const s of scoreRows) {
    const list = scoresByResponse.get(s.responseId) ?? [];
    list.push(s);
    scoresByResponse.set(s.responseId, list);
  }

  const bySurvey = new Map<string, typeof responseRows>();
  for (const r of responseRows) {
    const list = bySurvey.get(r.surveyId) ?? [];
    list.push(r);
    bySurvey.set(r.surveyId, list);
  }

  const result: RespondentDynamics = {
    userId,
    fullName: fullNameOf(patient),
    email: patient.email,
    surveys: [...bySurvey.entries()].map(([surveyId, list]) => {
      const survey = scoped.find((s) => s.id === surveyId)!;

      // группируем по КОДУ шкалы: id меняется от версии к версии
      const byCode = new Map<string, ScaleDynamics>();
      for (const response of list) {
        for (const score of scoresByResponse.get(response.id) ?? []) {
          const scale = scaleById.get(score.scaleId);
          if (!scale) continue;
          const entry = byCode.get(scale.code) ?? {
            scaleId: scale.id,
            code: scale.code,
            title: t(scale.title as never),
            points: [],
            delta: null,
            direction: null,
          };
          entry.points.push({
            responseId: response.id,
            submittedAt: response.submittedAt ?? response.startedAt,
            rawScore: score.value,
            maxScore: score.maxScore,
            percent: score.percent,
            bandLabel: score.bandLabel,
            severity: score.severity,
            percentile: percentileOf(score.rawScore, sampleByKey.get(`${surveyId}:${scale.code}`) ?? []),
          });
          byCode.set(scale.code, entry);
        }
      }

      for (const entry of byCode.values()) {
        entry.points.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
        if (entry.points.length >= 2) {
          const first = entry.points[0]!.rawScore;
          const last = entry.points[entry.points.length - 1]!.rawScore;
          entry.delta = Math.round((last - first) * 100) / 100;
          entry.direction = entry.delta > 0 ? "up" : entry.delta < 0 ? "down" : "flat";
        }
      }

      return {
        surveyId,
        title: t(survey.title as never),
        responseCount: list.length,
        firstAt: list[0]?.submittedAt ?? null,
        lastAt: list[list.length - 1]?.submittedAt ?? null,
        scales: [...byCode.values()],
      };
    }),
  };

  await audit(c, {
    action: "response.read",
    resourceType: "respondent",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "dynamics", surveys: result.surveys.length },
  });

  return c.json(result);
});
