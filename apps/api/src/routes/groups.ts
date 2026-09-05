import { Hono } from "hono";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { groupInputSchema, type GroupAdmin, type SurveyGroupWithCounts } from "@quizzy/shared";
import { db } from "../db";
import { groupAdmins, surveyGroups, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { hasPermission } from "../lib/permissions";
import { accessibleGroupIds, assertGroupAccess } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const groupRoutes = new Hono<AppEnv>();

/*
 * Здесь видно, зачем оси разведены. Список групп и переименование своей
 * группы правами не закрываются вовсе: кто какую группу видит — это область
 * ответственности, и её проверяет assertGroupAccess, а не справочник прав.
 *
 * Правом закрыто другое: завести группу, удалить её, назначить и снять
 * администратора. Раньше это требовало суперадмина; теперь требует
 * groups.manage, а суперадмин проходит потому, что обходит справочник
 * целиком. Поведение то же, но право стало выдаваемым — иначе заведующий
 * отделением, ради которого затевался справочник, так и остался бы без
 * возможности набрать себе людей.
 */
groupRoutes.use("*", requireAuth, requireStaff);

/**
 * Список групп. Суперадмин видит все, администратор — только те, на которые
 * назначен; состав администраторов приходит по каждой видимой группе.
 *
 * Снятые с использования приходят вместе с действующими, а не отфильтровываются
 * здесь. На экране групп их обязаны показать: расформированное отделение
 * никуда не делось, у него остались люди, прохождения и аналитика. А там, где
 * список работает выбором — конструктор методики, сборка батареи, — снятые
 * отсеиваются на месте выбора: только там известно, что выбранная группа уже
 * снята и её всё равно надо оставить в списке, иначе правка методики молча
 * перенесла бы её в первую попавшуюся группу.
 */
groupRoutes.get("/", async (c) => {
  const user = c.get("user");
  const allowed = await accessibleGroupIds(user);
  // право спрашивается один раз на запрос: оно одно на все группы читателя
  const manageable = await hasPermission(user, "groups.manage");

  const rows = await db
    .select({
      id: surveyGroups.id,
      title: surveyGroups.title,
      description: surveyGroups.description,
      color: surveyGroups.color,
      position: surveyGroups.position,
      createdBy: surveyGroups.createdBy,
      createdAt: surveyGroups.createdAt,
      archivedAt: surveyGroups.archivedAt,
      surveyCount: sql<number>`(select count(*) from surveys s where s.group_id = "survey_groups"."id")`,
      publishedCount: sql<number>`(select count(*) from surveys s where s.group_id = "survey_groups"."id" and s.status = 'published')`,
      responseCount: sql<number>`(select count(*) from responses r join surveys s on s.id = r.survey_id where s.group_id = "survey_groups"."id" and r.status = 'completed')`,
      /*
       * Людей считаем по завершённым прохождениям и различая по человеку:
       * «сколько людей прошло» и «сколько прохождений» расходятся тем
       * сильнее, чем больше в группе повторных замеров, а заведующему нужны
       * оба числа — иначе двадцать замеров одного человека читаются как
       * двадцать обследованных.
       */
      patientCount: sql<number>`(select count(distinct r.user_id) from responses r
        join surveys s on s.id = r.survey_id
        where s.group_id = "survey_groups"."id" and r.status = 'completed' and r.user_id is not null)`,
      /*
       * Открытые случаи считаются по сигналам, а не по колонке survey_id
       * случая: случай заводится на человека и собирает сигналы разных
       * методик, поэтому «случай этой группы» — тот, у которого есть хоть
       * один сигнал по её методике.
       */
      openCaseCount: sql<number>`(select count(distinct ac.id) from alert_cases ac
        join risk_alerts ra on ra.case_id = ac.id
        join surveys s on s.id = ra.survey_id
        where s.group_id = "survey_groups"."id" and ac.acknowledged_at is null)`,
    })
    .from(surveyGroups)
    .where(allowed === null ? undefined : allowed.length ? inArray(surveyGroups.id, allowed) : sql`1 = 0`)
    /*
     * Действующие впереди снятых. Порядок задан в базе, а не сортировкой на
     * экране: тот же список читает мобильное приложение и конструктор, и
     * договориться о порядке в одном месте дешевле, чем в трёх.
     */
    .orderBy(
      asc(sql`(${surveyGroups.archivedAt} is not null)`),
      asc(surveyGroups.position),
      asc(surveyGroups.createdAt),
    );

  const adminsByGroup = new Map<string, GroupAdmin[]>();
  /*
   * Состав администраторов приходит всем, кто вообще видит группу, а не
   * только суперадмину.
   *
   * Так уже отвечает `GET /api/groups/:id/admins`: кого видно — решает
   * область ответственности, и в этот список попадают только доступные
   * группы. Прежнее ограничение оставляло администратора группы перед
   * пустым разделом «администраторы» — не потому, что их нет, а потому, что
   * их не прислали, — и он не мог понять, кому писать о доступе. Отдельного
   * запроса на каждую группу ради того же ответа тоже не нужно.
   */
  if (rows.length) {
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
    patientCount: Number(r.patientCount ?? 0),
    openCaseCount: Number(r.openCaseCount ?? 0),
    admins: adminsByGroup.get(r.id) ?? [],
    manageable,
  }));
  return c.json({ items: result });
});

/** Заводить группы — по праву `groups.manage`: группа есть единица разграничения доступа */
groupRoutes.post("/", requirePermission("groups.manage"), async (c) => {
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
  if (!row) notFound("err.groupNotFound");
  await audit(c, { action: "group.update", resourceType: "group", resourceId: row.id });
  return c.json(row);
});

/**
 * Снять группу с использования или вернуть в работу.
 *
 * Мягкая альтернатива удалению — и единственная возможная для группы, в
 * которой что-то есть. Расформированное отделение удалить нельзя: за ним
 * годы прохождений, а удаление разрешено только пустой группе. Оставлять же
 * его в списке наравне с действующими значит предлагать его при заведении
 * каждой новой методики.
 *
 * Снятие НИЧЕГО не отбирает: администраторы группы продолжают видеть её
 * методики и данные, аналитика считается, прохождения открываются. Это
 * пометка «не предлагать», а не запрет — иначе снятие группы стало бы
 * скрытым отзывом доступа у людей, которых об этом никто не спрашивал.
 *
 * Одно тело на оба направления, а не два маршрута: возврат в работу — то же
 * действие с другим знаком, и разводить их значило бы дважды написать одну
 * проверку прав.
 */
groupRoutes.post("/:id/archive", requirePermission("groups.manage"), async (c) => {
  const id = c.req.param("id");
  const group = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.id, id) });
  if (!group) notFound("err.groupNotFound");

  const body = await c.req.json().catch(() => ({}));
  // умолчание — снять: маршрут называется archive, и пустое тело должно делать то, что написано
  const archived = body?.archived !== false;

  const [row] = await db
    .update(surveyGroups)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(eq(surveyGroups.id, id))
    .returning();

  await audit(c, {
    action: archived ? "group.archive" : "group.restore",
    resourceType: "group",
    resourceId: id,
    details: { title: group.title },
  });
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
groupRoutes.delete("/:id", requirePermission("groups.manage"), async (c) => {
  const id = c.req.param("id");
  const group = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.id, id) });
  if (!group) notFound("err.groupNotFound");

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
    badRequest("err.groupNotEmpty", { details: inside.join(", ") });
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

  return c.json({ items: rows.map((r) => ({ ...r, fullName: fullNameOf(r) })) satisfies GroupAdmin[] });
});

/** Назначение администратора на группу — прерогатива суперадмина */
groupRoutes.post("/:id/admins", requirePermission("groups.manage"), async (c) => {
  const groupId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const userId = String(body?.userId ?? "");
  if (!userId) badRequest("err.userIdRequired");

  const group = await db.query.surveyGroups.findFirst({ where: eq(surveyGroups.id, groupId) });
  if (!group) notFound("err.groupNotFound");

  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target) notFound("err.userNotFound");
  if (target.role === "user") {
    badRequest("err.assignStaffOnly");
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

groupRoutes.delete("/:id/admins/:userId", requirePermission("groups.manage"), async (c) => {
  const groupId = c.req.param("id");
  const userId = c.req.param("userId");
  const deleted = await db
    .delete(groupAdmins)
    .where(and(eq(groupAdmins.groupId, groupId), eq(groupAdmins.userId, userId)))
    .returning();
  if (deleted.length === 0) notFound("err.assignmentNotFound");

  await audit(c, {
    action: "group.admin_revoke",
    resourceType: "group",
    resourceId: groupId,
    subjectUserId: userId,
  });
  return c.body(null, 204);
});
