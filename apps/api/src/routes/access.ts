import { Hono } from "hono";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { grantAccessSchema, type SurveyGrant } from "@quizzy/shared";
import { db } from "../db";
import { surveyAccess, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { accessibleGroupIds, assertSurveyAccess, assertSurveysInUse, surveyInUse } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const accessRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
accessRoutes.use("*", requireAuth, requireStaff, requirePermission("assignments.manage"));

/** Кому назначена методика */
accessRoutes.get("/surveys/:id/grants", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);

  const rows = await db
    .select({
      userId: surveyAccess.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      email: users.email,
      grantedBy: surveyAccess.grantedBy,
      grantedAt: surveyAccess.grantedAt,
      expiresAt: surveyAccess.expiresAt,
      note: surveyAccess.note,
      attemptsAllowed: surveyAccess.attemptsAllowed,
      completed: sql<number>`(select count(*) from responses r where r.survey_id = ${surveyId} and r.user_id = "survey_access"."user_id" and r.status = 'completed')`,
    })
    .from(surveyAccess)
    .innerJoin(users, eq(users.id, surveyAccess.userId))
    .where(eq(surveyAccess.surveyId, surveyId));

  const grantorIds = rows.map((r) => r.grantedBy).filter((id): id is string => !!id);
  const grantorNames = new Map<string, string>();
  if (grantorIds.length) {
    const grantors = await db.select().from(users).where(inArray(users.id, grantorIds));
    for (const g of grantors) grantorNames.set(g.id, fullNameOf(g));
  }

  const result: SurveyGrant[] = rows.map((r) => ({
    userId: r.userId,
    fullName: fullNameOf(r),
    email: r.email,
    grantedBy: r.grantedBy,
    grantedByName: r.grantedBy ? (grantorNames.get(r.grantedBy) ?? null) : null,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    note: r.note,
    attemptsAllowed: r.attemptsAllowed,
    attemptsUsed: Number(r.completed ?? 0),
    completed: Number(r.completed ?? 0) > 0,
  }));

  await audit(c, {
    action: "access.grant_list",
    resourceType: "survey",
    resourceId: surveyId,
    details: { count: result.length },
  });
  return c.json({ items: result });
});

/** Назначить методику пациенту */
accessRoutes.post("/surveys/:id/grants", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  await assertSurveysInUse([surveyId]);
  const input = await parseBody(c.req.raw, grantAccessSchema);

  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!target) notFound("err.userNotFound");
  if (target.role !== "user") {
    badRequest("err.assignOnlyToPatient");
  }

  await db
    .insert(surveyAccess)
    .values({
      surveyId,
      userId: input.userId,
      grantedBy: c.get("user").id,
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
      attemptsAllowed: input.attemptsAllowed,
    })
    .onConflictDoUpdate({
      target: [surveyAccess.surveyId, surveyAccess.userId],
      set: {
        grantedBy: c.get("user").id,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
        attemptsAllowed: input.attemptsAllowed,
      },
    });

  await audit(c, {
    action: "access.grant",
    resourceType: "survey",
    resourceId: surveyId,
    subjectUserId: input.userId,
    details: {
      patient: target.email,
      expiresAt: input.expiresAt ?? null,
      attemptsAllowed: input.attemptsAllowed,
    },
  });

  return c.json({ surveyId, userId: input.userId }, 201);
});

accessRoutes.delete("/surveys/:id/grants/:userId", async (c) => {
  const surveyId = c.req.param("id");
  const userId = c.req.param("userId");
  await assertSurveyAccess(c.get("user"), surveyId);

  const deleted = await db
    .delete(surveyAccess)
    .where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, userId)))
    .returning();
  if (deleted.length === 0) notFound("err.assignmentNotFound");

  await audit(c, {
    action: "access.revoke",
    resourceType: "survey",
    resourceId: surveyId,
    subjectUserId: userId,
  });
  return c.body(null, 204);
});

/**
 * Пациенты, которым можно назначить методику.
 *
 * Список ограничен зоной ответственности: групповой админ видит только тех, кто
 * уже соприкасался с его группами — назначение, прохождение или доступ к методике
 * группы. Отдавать всех пациентов системы значило бы раскрывать каждому админу
 * состав чужих отделений. Суперадмин видит всех — ему назначать в любую группу.
 */
/*
 * Курсорная пагинация здесь не годится, и это следствие шифрования, а не
 * лень: список упорядочен по ФИО, а ФИО хранится зашифрованным — упорядочить
 * его в SQL нечем, а класть рядом открытую копию ради удобного запроса
 * значило бы обменять защиту персональных данных на пагинацию.
 *
 * Поэтому здесь поиск с потолком выдачи. Экран нужен, чтобы найти человека и
 * назначить ему методику, а не листать пять тысяч фамилий: расшифровать и
 * отфильтровать на сервере дешевле, чем передать всех клиенту.
 */
const PATIENT_LIMIT = 100;

accessRoutes.get("/patients", async (c) => {
  const user = c.get("user");
  const groupIds = await accessibleGroupIds(user);
  const search = (c.req.query("search") ?? "").trim().toLowerCase();
  const unit = c.req.query("unit") ?? "";

  let rows: (typeof users.$inferSelect)[];
  if (groupIds === null) {
    rows = await db.select().from(users).where(eq(users.role, "user"));
  } else if (!groupIds.length) {
    rows = [];
  } else {
    rows = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.role, "user"),
          sql`(
            exists (select 1 from survey_access sa
              join surveys s on s.id = sa.survey_id
              where sa.user_id = "users"."id" and s.group_id in ${groupIds})
            or exists (select 1 from responses r
              join surveys s on s.id = r.survey_id
              where r.user_id = "users"."id" and s.group_id in ${groupIds})
            or exists (select 1 from battery_assignments ba
              join batteries b on b.id = ba.battery_id
              where ba.user_id = "users"."id" and b.group_id in ${groupIds})
          )`,
        ),
      );
  }

  const all = rows
    .map((u) => ({ id: u.id, fullName: fullNameOf(u), email: u.email, unit: u.unit }))
    .filter((u) => (unit ? u.unit === unit : true))
    .filter((u) =>
      search ? `${u.fullName} ${u.email}`.toLowerCase().includes(search) : true,
    )
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  // чтение списка пациентов — доступ к персональным данным, фиксируем
  await audit(c, {
    action: "access.patient_list",
    details: { matched: all.length, returned: Math.min(all.length, PATIENT_LIMIT), scoped: groupIds !== null },
  });

  return c.json({
    items: all.slice(0, PATIENT_LIMIT),
    // клиент должен понимать, что видит не всё, и сузить поиск
    total: all.length,
    truncated: all.length > PATIENT_LIMIT,
  });
});

/**
 * Условие видимости методики для пациента: опубликована И
 * (общедоступна ИЛИ выдано персональное назначение, срок которого не истёк).
 */
export function patientVisibilityFilter(userId: string) {
  return and(
    eq(surveys.status, "published"),
    surveyInUse,
    // методику, которую заполняет специалист, пациенту предлагать нельзя:
    // часть её пунктов требует клинической оценки, а не самоотчёта
    eq(surveys.administration, "self"),
    or(
      eq(surveys.visibility, "public"),
      sql`exists (
        select 1 from survey_access sa
        where sa.survey_id = "surveys"."id"
          and sa.user_id = ${userId}
          and (sa.expires_at is null or sa.expires_at > now())
      )`,
    ),
  );
}
