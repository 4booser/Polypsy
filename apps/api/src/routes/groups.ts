import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { groupInputSchema, type GroupAdmin, type SurveyGroupWithCounts } from "@quizzy/shared";
import { db } from "../db";
import { groupAdmins, surveyGroups, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { accessibleGroupIds, assertGroupAccess, isSuperadmin } from "../lib/scope";
import { requireAuth, requireStaff, requireSuperadmin, type AppEnv } from "../middleware/auth";

export const groupRoutes = new Hono<AppEnv>();

groupRoutes.use("*", requireAuth, requireStaff);

/**
 * Список групп. Суперадмин видит все и с составом администраторов,
 * администратор — только те, на которые назначен, и без чужих админов.
 */
groupRoutes.get("/", async (c) => {
  const user = c.get("user");
  const allowed = await accessibleGroupIds(user);

  const rows = await db
    .select({
      id: surveyGroups.id,
      title: surveyGroups.title,
      description: surveyGroups.description,
      color: surveyGroups.color,
      position: surveyGroups.position,
      createdBy: surveyGroups.createdBy,
      createdAt: surveyGroups.createdAt,
      surveyCount: sql<number>`(select count(*) from surveys s where s.group_id = "survey_groups"."id")`,
      publishedCount: sql<number>`(select count(*) from surveys s where s.group_id = "survey_groups"."id" and s.status = 'published')`,
      responseCount: sql<number>`(select count(*) from responses r join surveys s on s.id = r.survey_id where s.group_id = "survey_groups"."id" and r.status = 'completed')`,
    })
    .from(surveyGroups)
    .where(allowed === null ? undefined : allowed.length ? inArray(surveyGroups.id, allowed) : sql`1 = 0`)
    .orderBy(asc(surveyGroups.position), asc(surveyGroups.createdAt));

  const adminsByGroup = new Map<string, GroupAdmin[]>();
  if (isSuperadmin(user) && rows.length) {
    const adminRows = await db
      .select({
        groupId: groupAdmins.groupId,
        userId: groupAdmins.userId,
        addedAt: groupAdmins.addedAt,
        addedBy: groupAdmins.addedBy,
        firstName: users.firstName,
        lastName: users.lastName,
        middleName: users.middleName,
        email: users.email,
      })
      .from(groupAdmins)
      .innerJoin(users, eq(users.id, groupAdmins.userId))
      .where(inArray(groupAdmins.groupId, rows.map((r) => r.id)));

    for (const a of adminRows) {
      const list = adminsByGroup.get(a.groupId) ?? [];
      list.push({
        userId: a.userId,
        fullName: fullNameOf(a),
        email: a.email,
        addedAt: a.addedAt,
        addedBy: a.addedBy,
      });
      adminsByGroup.set(a.groupId, list);
    }
  }

  const result: SurveyGroupWithCounts[] = rows.map((r) => ({
    ...r,
    surveyCount: Number(r.surveyCount ?? 0),
    publishedCount: Number(r.publishedCount ?? 0),
    responseCount: Number(r.responseCount ?? 0),
    admins: adminsByGroup.get(r.id) ?? [],
  }));
  return c.json(result);
});

/** Создавать группы может только суперадмин — это единица разграничения доступа */
groupRoutes.post("/", requireSuperadmin, async (c) => {
  const input = await parseBody(c.req.raw, groupInputSchema);
  const [row] = await db
    .insert(surveyGroups)
    .values({
      id: crypto.randomUUID(),
      title: input.title,
      description: input.description ?? null,
      color: input.color ?? null,
      position: input.position ?? 0,
      createdBy: c.get("user").id,
    })
    .returning();
  await audit(c, { action: "group.create", resourceType: "group", resourceId: row!.id, details: { title: row!.title } });
  return c.json(row, 201);
});

groupRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertGroupAccess(user, id);

  const input = await parseBody(c.req.raw, groupInputSchema.partial());
  const [row] = await db
    .update(surveyGroups)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description ?? null }),
      ...(input.color !== undefined && { color: input.color ?? null }),
      ...(input.position !== undefined && { position: input.position }),
    })
    .where(eq(surveyGroups.id, id))
    .returning();
  if (!row) notFound("Группа не найдена");
  await audit(c, { action: "group.update", resourceType: "group", resourceId: row.id });
  return c.json(row);
});

/**
 * Удаление группы. Разрешено только пустой.
 *
 * Группа — корень целой цепочки внешних ключей: батареи каскадом уходят
 * вместе с ней, а за ними история назначений, расписания и сеансы киоска.
 * Методики при этом остаются, но с `group_id = null`, то есть по правилам
 * scope.ts превращаются в личные черновики создателя — остальные админы
 * группы молча теряют к ним доступ.
 *
 * Ни то, ни другое не должно случаться как побочный эффект «прибраться в
 * списке групп»: сначала переносим содержимое, потом удаляем пустую.
 */
groupRoutes.delete("/:id", requireSuperadmin, async (c) => {
  const id = c.req.param("id");
  const group = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.id, id) });
  if (!group) notFound("Группа не найдена");

  const [counts] = await db
    .select({
      surveys: sql<number>`(select count(*)::int from surveys where group_id = ${id})`,
      batteries: sql<number>`(select count(*)::int from batteries where group_id = ${id})`,
    })
    .from(sql`(select 1) as _`);

  const inside: string[] = [];
  if (counts?.surveys) inside.push(`методик: ${counts.surveys}`);
  if (counts?.batteries) inside.push(`батарей: ${counts.batteries}`);
  if (inside.length) {
    badRequest(
      `Группа не пуста (${inside.join(", ")}). Перенесите содержимое в другую группу — ` +
        `удаление утащило бы за собой батареи вместе с историей назначений`,
    );
  }

  await db.delete(surveyGroups).where(eq(surveyGroups.id, id));
  await audit(c, { action: "group.delete", resourceType: "group", resourceId: id });
  return c.body(null, 204);
});

/* ─────────── Администраторы группы ─────────── */

groupRoutes.get("/:id/admins", async (c) => {
  const user = c.get("user");
  const groupId = c.req.param("id");
  await assertGroupAccess(user, groupId);

  const rows = await db
    .select({
      userId: groupAdmins.userId,
      addedAt: groupAdmins.addedAt,
      addedBy: groupAdmins.addedBy,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      email: users.email,
    })
    .from(groupAdmins)
    .innerJoin(users, eq(users.id, groupAdmins.userId))
    .where(eq(groupAdmins.groupId, groupId));

  return c.json(rows.map((r) => ({ ...r, fullName: fullNameOf(r) })) satisfies GroupAdmin[]);
});

/** Назначение администратора на группу — прерогатива суперадмина */
groupRoutes.post("/:id/admins", requireSuperadmin, async (c) => {
  const groupId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const userId = String(body?.userId ?? "");
  if (!userId) badRequest("Не указан userId");

  const group = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.id, groupId) });
  if (!group) notFound("Группа не найдена");

  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target) notFound("Пользователь не найден");
  if (target.role === "user") {
    badRequest("Назначить можно только сотрудника — сначала выдайте роль администратора");
  }

  await db
    .insert(groupAdmins)
    .values({ groupId, userId, addedBy: c.get("user").id })
    .onConflictDoNothing();

  await audit(c, {
    action: "group.admin_assign",
    resourceType: "group",
    resourceId: groupId,
    subjectUserId: userId,
    details: { group: group.title, admin: target.email },
  });

  return c.json({ groupId, userId }, 201);
});

groupRoutes.delete("/:id/admins/:userId", requireSuperadmin, async (c) => {
  const groupId = c.req.param("id");
  const userId = c.req.param("userId");
  const deleted = await db
    .delete(groupAdmins)
    .where(and(eq(groupAdmins.groupId, groupId), eq(groupAdmins.userId, userId)))
    .returning();
  if (deleted.length === 0) notFound("Назначение не найдено");

  await audit(c, {
    action: "group.admin_revoke",
    resourceType: "group",
    resourceId: groupId,
    subjectUserId: userId,
  });
  return c.body(null, 204);
});
