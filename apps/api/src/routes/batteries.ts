import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  assignBatterySchema,
  batteryInputSchema,
  t,
  type Battery,
  type BatteryAssignment,
  type BatteryItem,
  type BatteryStep,
  type Administration,
  type Lang,
} from "@quizzy/shared";
import { db } from "../db";
import {
  batteries,
  batteryAssignments,
  batteryItems,
  responses,
  surveyAccess,
  surveyGroups,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, forbidden, notFound, parseBody } from "../lib/http";
import { accessibleGroupIds, assertGroupAccess, assertSurveyAccess, isStaff } from "../lib/scope";
import { requireAuth, type AppEnv } from "../middleware/auth";
import { parseTs } from "../lib/time";

/** Язык из запроса: всё, кроме украинского, отдаём по-русски */
const langOf = (raw: string | undefined): Lang => (raw === "uk" ? "uk" : "ru");

export const batteryRoutes = new Hono<AppEnv>();

batteryRoutes.use("*", requireAuth);

/** Батарея видна тем же, кому видна её группа */
async function assertBatteryAccess(user: Parameters<typeof accessibleGroupIds>[0], batteryId: string) {
  const row = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!row) notFound("Батарея не найдена");
  if (row.groupId) await assertGroupAccess(user, row.groupId);
  else if (!isStaff(user)) forbidden("Нет доступа к батарее");
  return row;
}

/** Состав батарей одним запросом: без него список из десяти батарей — это 10 запросов */
async function loadItems(batteryIds: string[], lang: Lang): Promise<Map<string, BatteryItem[]>> {
  const result = new Map<string, BatteryItem[]>();
  if (!batteryIds.length) return result;

  const rows = await db
    .select({
      batteryId: batteryItems.batteryId,
      surveyId: batteryItems.surveyId,
      position: batteryItems.position,
      required: batteryItems.required,
      title: surveys.title,
      administration: surveys.administration,
      questionCount: sql<number>`(select count(*) from questions q
        where q.version_id = "surveys"."current_version_id" and q.type <> 'info')`,
      // ориентир длительности берём из фактических прохождений, а не из
      // предположений: реальная медиана расходится с ожиданиями в разы
      medianMs: sql<number | null>`(select percentile_cont(0.5) within group (order by r.duration_ms)
        from responses r where r.survey_id = "surveys"."id" and r.status = 'completed' and r.duration_ms > 0)`,
    })
    .from(batteryItems)
    .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
    .where(inArray(batteryItems.batteryId, batteryIds))
    .orderBy(batteryItems.position);

  for (const r of rows) {
    const list = result.get(r.batteryId) ?? [];
    list.push({
      surveyId: r.surveyId,
      title: t(r.title, lang),
      position: r.position,
      required: r.required,
      administration: r.administration as Administration,
      questionCount: Number(r.questionCount ?? 0),
      medianMinutes: r.medianMs ? Math.round((Number(r.medianMs) / 60000) * 10) / 10 : null,
    });
    result.set(r.batteryId, list);
  }
  return result;
}

/** Список батарей, доступных сотруднику */
batteryRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!isStaff(user)) forbidden("Доступ только для персонала");
  const lang = langOf(c.req.query("lang"));
  const groupIds = await accessibleGroupIds(user);

  const rows = await db
    .select({
      battery: batteries,
      groupTitle: surveyGroups.title,
      activeAssignments: sql<number>`(select count(*) from battery_assignments a
        where a.battery_id = "batteries"."id" and a.completed_at is null and a.cancelled_at is null)`,
    })
    .from(batteries)
    .leftJoin(surveyGroups, eq(surveyGroups.id, batteries.groupId))
    .where(
      groupIds === null
        ? undefined
        : groupIds.length
          ? sql`("batteries"."group_id" in ${groupIds} or "batteries"."group_id" is null)`
          : isNull(batteries.groupId),
    )
    .orderBy(desc(batteries.createdAt));

  const items = await loadItems(rows.map((r) => r.battery.id), lang);
  const result: Battery[] = rows.map((r) => ({
    id: r.battery.id,
    title: r.battery.title,
    description: r.battery.description,
    groupId: r.battery.groupId,
    groupTitle: r.groupTitle ? t(r.groupTitle, lang) : null,
    strictOrder: r.battery.strictOrder,
    archived: r.battery.archived,
    createdAt: r.battery.createdAt,
    items: items.get(r.battery.id) ?? [],
    activeAssignments: Number(r.activeAssignments ?? 0),
  }));
  return c.json(result);
});

/** Создание батареи */
batteryRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!isStaff(user)) forbidden("Доступ только для персонала");
  const input = await parseBody(c.req.raw, batteryInputSchema);
  if (input.groupId) await assertGroupAccess(user, input.groupId);
  // право на методику проверяем поштучно: иначе через батарею можно было бы
  // раздать доступ к чужой группе
  for (const item of input.items) await assertSurveyAccess(user, item.surveyId);

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(batteries).values({
      id,
      title: input.title,
      description: input.description ?? null,
      groupId: input.groupId ?? null,
      strictOrder: input.strictOrder ?? true,
      archived: input.archived ?? false,
      createdBy: user.id,
    });
    await tx.insert(batteryItems).values(
      input.items.map((item, i) => ({
        batteryId: id,
        surveyId: item.surveyId,
        position: i,
        required: item.required ?? true,
      })),
    );
  });

  await audit(c, {
    action: "battery.create",
    resourceType: "battery",
    resourceId: id,
    details: { title: input.title, items: input.items.length },
  });
  return c.json({ id }, 201);
});

/** Замена состава батареи целиком */
batteryRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  await assertBatteryAccess(user, batteryId);
  const input = await parseBody(c.req.raw, batteryInputSchema);
  if (input.groupId) await assertGroupAccess(user, input.groupId);
  for (const item of input.items) await assertSurveyAccess(user, item.surveyId);

  await db.transaction(async (tx) => {
    await tx
      .update(batteries)
      .set({
        title: input.title,
        description: input.description ?? null,
        groupId: input.groupId ?? null,
        strictOrder: input.strictOrder ?? true,
        archived: input.archived ?? false,
      })
      .where(eq(batteries.id, batteryId));
    await tx.delete(batteryItems).where(eq(batteryItems.batteryId, batteryId));
    await tx.insert(batteryItems).values(
      input.items.map((item, i) => ({
        batteryId,
        surveyId: item.surveyId,
        position: i,
        required: item.required ?? true,
      })),
    );
  });

  await audit(c, {
    action: "battery.update",
    resourceType: "battery",
    resourceId: batteryId,
    details: { title: input.title, items: input.items.length },
  });
  return c.json({ ok: true });
});

batteryRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  const row = await assertBatteryAccess(user, batteryId);

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, batteryId),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  // удаление утащило бы за собой историю назначений — вместо этого архивируем
  if (Number(count) > 0)
    badRequest(`Батарея назначена ${Number(count)} обследуемым. Снимите назначения или сдайте батарею в архив`);

  await db.delete(batteries).where(eq(batteries.id, batteryId));
  await audit(c, {
    action: "battery.delete",
    resourceType: "battery",
    resourceId: batteryId,
    details: { title: row.title },
  });
  return c.body(null, 204);
});

/**
 * Прогресс по назначению.
 *
 * Засчитываются только прохождения, завершённые после назначения: старое
 * обследование той же методикой не закрывает новое назначение, иначе повторный
 * замер закрывался бы сам собой в момент выдачи.
 */
function buildSteps(
  items: BatteryItem[],
  strictOrder: boolean,
  assignedAt: string,
  completions: { surveyId: string; responseId: string; submittedAt: string }[],
): BatteryStep[] {
  const done = new Map<string, { responseId: string; submittedAt: string }>();
  for (const r of completions) {
    if (r.submittedAt < assignedAt) continue;
    const prev = done.get(r.surveyId);
    if (!prev || r.submittedAt > prev.submittedAt) done.set(r.surveyId, r);
  }

  let blocked = false;
  return items.map((item) => {
    const hit = done.get(item.surveyId);
    let state: BatteryStep["state"];
    if (hit) state = "done";
    else if (item.administration === "clinician") {
      // параллельная дорожка специалиста: не занимает очередь и не блокирует её
      state = "available";
    } else if (blocked) state = "locked";
    else {
      state = "current";
      if (strictOrder) blocked = true;
    }
    if (!strictOrder && state === "current") state = "available";
    return {
      ...item,
      state,
      responseId: hit?.responseId ?? null,
      submittedAt: hit?.submittedAt ?? null,
    };
  });
}

async function loadAssignments(where: SQL | undefined, lang: Lang) {
  const rows = await db
    .select({
      assignment: batteryAssignments,
      battery: batteries,
      user: users,
    })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .innerJoin(users, eq(users.id, batteryAssignments.userId))
    .where(where)
    .orderBy(desc(batteryAssignments.assignedAt));

  const items = await loadItems([...new Set(rows.map((r) => r.battery.id))], lang);
  const userIds = [...new Set(rows.map((r) => r.user.id))];
  const completions = userIds.length
    ? await db
        .select({
          userId: responses.userId,
          surveyId: responses.surveyId,
          responseId: responses.id,
          submittedAt: responses.submittedAt,
        })
        .from(responses)
        .where(and(inArray(responses.userId, userIds), eq(responses.status, "completed")))
    : [];

  const nowMs = Date.now();
  const result: BatteryAssignment[] = rows.map((r) => {
    const list = items.get(r.battery.id) ?? [];
    const mine = completions
      .filter((x) => x.userId === r.user.id && x.submittedAt)
      .map((x) => ({ surveyId: x.surveyId, responseId: x.responseId, submittedAt: x.submittedAt! }));
    const steps = buildSteps(list, r.battery.strictOrder, r.assignment.assignedAt, mine);
    const required = steps.filter((s) => s.required);
    const doneRequired = required.filter((s) => s.state === "done").length;
    return {
      id: r.assignment.id,
      batteryId: r.battery.id,
      batteryTitle: r.battery.title,
      userId: r.user.id,
      userName: fullNameOf(r.user),
      assignedAt: r.assignment.assignedAt,
      dueAt: r.assignment.dueAt,
      completedAt: r.assignment.completedAt,
      cancelledAt: r.assignment.cancelledAt,
      note: r.assignment.note,
      overdue:
        !!r.assignment.dueAt &&
        !r.assignment.completedAt &&
        !r.assignment.cancelledAt &&
        parseTs(r.assignment.dueAt) < nowMs,
      doneRequired,
      totalRequired: required.length,
      steps,
    };
  });
  return result;
}

/** Назначения по батарее */
batteryRoutes.get("/:id/assignments", async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  await assertBatteryAccess(user, batteryId);
  const result = await loadAssignments(
    eq(batteryAssignments.batteryId, batteryId),
    langOf(c.req.query("lang")),
  );
  await audit(c, {
    action: "battery.assignment_list",
    resourceType: "battery",
    resourceId: batteryId,
    details: { assignments: result.length },
  });
  return c.json(result);
});

/**
 * Назначение батареи обследуемому.
 *
 * Заодно выдаётся доступ к каждой методике набора: правила видимости живут в
 * survey_access, и обходить их отдельной веткой для батарей значило бы завести
 * второй источник истины о том, кто что видит.
 */
batteryRoutes.post("/:id/assign", async (c) => {
  const user = c.get("user");
  const batteryId = c.req.param("id");
  const battery = await assertBatteryAccess(user, batteryId);
  if (battery.archived) badRequest("Батарея в архиве, назначать её нельзя");
  const input = await parseBody(c.req.raw, assignBatterySchema);

  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!target) notFound("Обследуемый не найден");

  const items = await db.select().from(batteryItems).where(eq(batteryItems.batteryId, batteryId));
  if (!items.length) badRequest("В батарее нет методик");

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(batteryAssignments).values({
      id,
      batteryId,
      userId: input.userId,
      assignedBy: user.id,
      dueAt: input.dueAt ?? null,
      note: input.note ?? null,
    });
    await tx
      .insert(surveyAccess)
      .values(
        items.map((item) => ({
          surveyId: item.surveyId,
          userId: input.userId,
          grantedBy: user.id,
          expiresAt: input.dueAt ?? null,
          note: `Батарея «${battery.title}»`,
        })),
      )
      // назначение поверх существующего доступа не должно его отзывать
      .onConflictDoNothing();
  });

  await audit(c, {
    action: "battery.assign",
    resourceType: "battery",
    resourceId: batteryId,
    subjectUserId: input.userId,
    details: { surveys: items.length, dueAt: input.dueAt ?? null },
  });
  return c.json({ id }, 201);
});

/** Снятие назначения: запись сохраняется, проставляется отметка отмены */
batteryRoutes.post("/assignments/:assignmentId/cancel", async (c) => {
  const user = c.get("user");
  const assignmentId = c.req.param("assignmentId");
  const row = await db.query.batteryAssignments.findFirst({
    where: eq(batteryAssignments.id, assignmentId),
  });
  if (!row) notFound("Назначение не найдено");
  await assertBatteryAccess(user, row.batteryId);

  await db
    .update(batteryAssignments)
    .set({ cancelledAt: new Date().toISOString() })
    .where(eq(batteryAssignments.id, assignmentId));

  await audit(c, {
    action: "battery.cancel",
    resourceType: "battery",
    resourceId: row.batteryId,
    subjectUserId: row.userId,
    details: { assignmentId },
  });
  return c.json({ ok: true });
});

/** Мои батареи — то, что видит обследуемый в приложении */
batteryRoutes.get("/mine", async (c) => {
  const user = c.get("user");
  const result = await loadAssignments(
    and(eq(batteryAssignments.userId, user.id), isNull(batteryAssignments.cancelledAt)),
    langOf(c.req.query("lang")),
  );
  return c.json(result);
});
