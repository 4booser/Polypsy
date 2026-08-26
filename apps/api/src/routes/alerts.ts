import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { t } from "@quizzy/shared";
import type { RiskAlert } from "@quizzy/shared";
import { db } from "../db";
import { questions, riskAlerts, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { notFound } from "../lib/http";
import { canAccessSurvey, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const alertRoutes = new Hono<AppEnv>();

alertRoutes.use("*", requireAuth, requireStaff);

/** Тревоги по методикам, доступным этому сотруднику. По умолчанию — только неразобранные. */
alertRoutes.get("/", async (c) => {
  const user = c.get("user");
  const includeAcknowledged = c.req.query("all") === "1";

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (surveyIds.length === 0) return c.json([]);

  const rows = await db
    .select({
      alert: riskAlerts,
      surveyTitle: surveys.title,
      escalateMinutes: surveys.alertEscalateMinutes,
      questionTitle: questions.title,
      respondentFirst: users.firstName,
      respondentLast: users.lastName,
      respondentMiddle: users.middleName,
    })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .innerJoin(questions, eq(questions.id, riskAlerts.questionId))
    .leftJoin(users, eq(users.id, riskAlerts.userId))
    // условия строим средствами drizzle: подстановка массива в шаблон sql``
    // зависит от драйвера и легко ломается при смене СУБД
    .where(
      includeAcknowledged
        ? inArray(riskAlerts.surveyId, surveyIds)
        : and(inArray(riskAlerts.surveyId, surveyIds), isNull(riskAlerts.acknowledgedAt)),
    )
    .orderBy(desc(riskAlerts.at));

  const ackIds = rows.map((r) => r.alert.acknowledgedBy).filter((id): id is string => !!id);
  const ackNames = new Map<string, string>();
  if (ackIds.length) {
    const ackRows = await db.select().from(users).where(inArray(users.id, ackIds));
    for (const u of ackRows) ackNames.set(u.id, fullNameOf(u));
  }

  const now = Date.now();
  const result: RiskAlert[] = rows.map((r) => {
    /*
     * Просроченность считаем на чтении, а не фоновым заданием: правило зависит
     * только от времени и настройки методики, и лишний планировщик здесь
     * добавил бы точку отказа, ничего не дав.
     */
    const openedMs = r.alert.acknowledgedAt
      ? new Date(r.alert.acknowledgedAt).getTime() - new Date(r.alert.at).getTime()
      : now - new Date(r.alert.at).getTime();
    const minutesOpen = Math.max(0, Math.round(openedMs / 60_000));
    const overdue =
      !r.alert.acknowledgedAt &&
      r.escalateMinutes !== null &&
      minutesOpen >= r.escalateMinutes;

    return {
    id: r.alert.id,
    responseId: r.alert.responseId,
    surveyId: r.alert.surveyId,
    surveyTitle: t(r.surveyTitle as never),
    questionId: r.alert.questionId,
    questionTitle: t(r.questionTitle as never),
    userId: r.alert.userId,
    respondent: r.respondentLast ? fullNameOf({ firstName: r.respondentFirst!, lastName: r.respondentLast, middleName: r.respondentMiddle }) : null,
    label: r.alert.label,
    severity: r.alert.severity,
    at: r.alert.at,
    acknowledgedBy: r.alert.acknowledgedBy,
    acknowledgedByName: r.alert.acknowledgedBy ? (ackNames.get(r.alert.acknowledgedBy) ?? null) : null,
    acknowledgedAt: r.alert.acknowledgedAt,
    note: r.alert.note,
    minutesOpen,
    overdue,
    };
  });

  // просроченные — первыми: их и надо разбирать раньше всех
  result.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.at.localeCompare(a.at));

  await audit(c, {
    action: "alert.list",
    details: {
      count: result.length,
      overdue: result.filter((a) => a.overdue).length,
      includeAcknowledged,
    },
  });
  return c.json(result);
});

/** Пометить тревогу разобранной — с указанием, кто и что предпринял */
alertRoutes.patch("/:id/acknowledge", async (c) => {
  const user = c.get("user");
  const alert = await db.query.riskAlerts.findFirst({ where: eq(riskAlerts.id, c.req.param("id")) });
  if (!alert) notFound("Тревога не найдена");
  if (!(await canAccessSurvey(user, alert.surveyId))) notFound("Тревога не найдена");

  const body = await c.req.json().catch(() => ({}));
  const [row] = await db
    .update(riskAlerts)
    .set({
      acknowledgedBy: user.id,
      acknowledgedAt: new Date().toISOString(),
      note: typeof body?.note === "string" ? body.note.slice(0, 1000) : null,
    })
    .where(eq(riskAlerts.id, alert.id))
    .returning();

  await audit(c, {
    action: "alert.acknowledge",
    resourceType: "alert",
    resourceId: alert.id,
    subjectUserId: alert.userId,
    details: { label: alert.label, note: row!.note },
  });

  return c.json(row);
});
