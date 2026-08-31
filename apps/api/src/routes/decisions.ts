import { Hono } from "hono";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { crisisPeriods, decisionRules, dutyShifts, ruleHits, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { currentCrisis } from "../lib/crisis";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { accessibleGroupIds, isSuperadmin, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const decisionRoutes = new Hono<AppEnv>();
/*
 * Три разных права в одном наборе, и это не разнобой.
 *
 * Правила и срабатывания читает и разбирает тот, кто вообще разбирает риск.
 * Заступить на дежурство — отдельное право: дежурство временная нагрузка,
 * а не свойство должности, и выдаётся исключением на срок смены. Менять сами
 * правила и включать кризисный режим — decisions.manage; раньше это требовало
 * суперадмина, теперь требует права, и суперадмин проходит потому, что
 * обходит справочник целиком.
 */
decisionRoutes.use("*", requireAuth, requireStaff);

/**
 * Поддержка решений и дежурная смена.
 *
 * Правило ничего не делает само: оно порождает предложение с объяснением, а
 * принимает его человек — и это фиксируется. Отклонение фиксируется наравне с
 * принятием: «правило предложило, специалист отказался и вот почему» — такая
 * же часть истории случая, как и согласие.
 */

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scale"),
    surveyId: z.string().nullable(),
    scaleCode: z.string().min(1).max(40),
    metric: z.enum(["raw", "normed"]),
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
  }),
  z.object({ kind: z.literal("risk"), severity: z.enum(["moderate", "severe"]) }),
  z.object({ kind: z.literal("history"), completedAtLeast: z.number().int().min(0).max(100) }),
]);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suggest_survey"), surveyId: z.string() }),
  z.object({ kind: z.literal("suggest_pathway"), pathwayId: z.string() }),
  z.object({ kind: z.literal("notify_duty") }),
  z.object({ kind: z.literal("advise"), text: z.string().min(1).max(2000) }),
]);

const ruleSchema = z.object({
  title: z.string().min(1).max(200),
  groupId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(conditionSchema).min(1),
  actions: z.array(actionSchema).min(1),
  note: z.string().max(2000).nullable().optional(),
});

/* ── правила ── */

decisionRoutes.get("/rules", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  const groups = await accessibleGroupIds(user);

  const rows = await db
    .select()
    .from(decisionRules)
    .where(
      groups === null
        ? undefined
        : groups.length
          ? or(isNull(decisionRules.groupId), inArray(decisionRules.groupId, groups))
          : isNull(decisionRules.groupId),
    )
    .orderBy(desc(decisionRules.createdAt));

  return c.json({ items: rows });
});

/*
 * Правило заводит только суперадмин. Оно действует на все прохождения своей
 * группы и подсказывает клинические шаги — это уровень настройки учреждения,
 * а не рабочий инструмент дежурного.
 */
decisionRoutes.post("/rules", requirePermission("decisions.manage"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, ruleSchema);

  const id = crypto.randomUUID();
  await db.insert(decisionRules).values({
    id,
    title: input.title,
    groupId: input.groupId ?? null,
    enabled: input.enabled ?? true,
    conditions: input.conditions,
    actions: input.actions,
    note: input.note ?? null,
    createdBy: user.id,
  });

  await audit(c, { action: "rule.save", resourceType: "rule", resourceId: id, details: { created: true } });
  return c.json({ id }, 201);
});

decisionRoutes.patch("/rules/:id", requirePermission("decisions.manage"), async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, ruleSchema.partial());

  const row = await db.query.decisionRules.findFirst({ where: eq(decisionRules.id, id) });
  if (!row) notFound("err.ruleNotFound");

  /*
   * Правка поднимает версию. Срабатывания хранят версию, при которой сработали:
   * правило потом поправят, а объяснение должно остаться верным для случая,
   * который уже разобрали.
   */
  await db
    .update(decisionRules)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      version: row!.version + 1,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(decisionRules.id, id));

  await audit(c, { action: "rule.save", resourceType: "rule", resourceId: id, details: { version: row!.version + 1 } });
  return c.json({ ok: true, version: row!.version + 1 });
});

/* ── срабатывания ── */

decisionRoutes.get("/hits", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [] });

  const status = c.req.query("status") ?? "suggested";
  const rows = await db
    .select({ hit: ruleHits, rule: decisionRules, patient: users })
    .from(ruleHits)
    .innerJoin(decisionRules, eq(decisionRules.id, ruleHits.ruleId))
    .leftJoin(users, eq(users.id, ruleHits.userId))
    .where(and(inArray(ruleHits.surveyId, surveyIds), eq(ruleHits.status, status)))
    .orderBy(desc(ruleHits.createdAt))
    .limit(100);

  return c.json({
    items: rows.map((r) => ({
      id: r.hit.id,
      ruleTitle: r.rule.title,
      ruleVersion: r.hit.ruleVersion,
      userId: r.hit.userId,
      userName: r.patient ? fullNameOf(r.patient) : "—",
      surveyId: r.hit.surveyId,
      responseId: r.hit.responseId,
      status: r.hit.status,
      explanation: r.hit.explanation,
      createdAt: r.hit.createdAt,
    })),
  });
});

const decisionSchema = z.object({
  status: z.enum(["accepted", "declined"]),
  note: z.string().max(2000).nullable().optional(),
});

decisionRoutes.patch("/hits/:id", requirePermission("alerts.review"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, decisionSchema);

  const row = await db.query.ruleHits.findFirst({ where: eq(ruleHits.id, id) });
  if (!row) notFound("err.hitNotFound");
  if (row!.status !== "suggested") badRequest("err.hitAlreadyDecided");

  /*
   * Отклонение требует объяснения, принятие — нет. Принять предложение
   * значит согласиться с уже написанным объяснением правила; отклонить —
   * возразить ему, и возражение должно быть записано, иначе разобрать потом,
   * почему сигнал проигнорировали, будет не по чему.
   */
  if (input.status === "declined" && !input.note?.trim()) {
    badRequest("err.declineNeedsNote");
  }

  await db
    .update(ruleHits)
    .set({
      status: input.status,
      decidedBy: user.id,
      decidedAt: new Date().toISOString(),
      decisionNote: input.note?.trim() || null,
    })
    .where(eq(ruleHits.id, id));

  await audit(c, {
    action: "rule.decide",
    resourceType: "rule_hit",
    resourceId: id,
    subjectUserId: row!.userId,
    details: { status: input.status },
  });

  return c.json({ ok: true });
});

/* ── дежурная смена ── */

const shiftSchema = z.object({
  userId: z.string(),
  groupId: z.string().nullable().optional(),
  startsAt: z.string(),
  endsAt: z.string(),
});

decisionRoutes.get("/duty", requirePermission("duty.take"), async (c) => {
  const now = new Date().toISOString();
  const rows = await db
    .select({ shift: dutyShifts, person: users })
    .from(dutyShifts)
    .innerJoin(users, eq(users.id, dutyShifts.userId))
    .where(and(lte(dutyShifts.startsAt, now), gt(dutyShifts.endsAt, now)))
    .orderBy(dutyShifts.endsAt);

  return c.json({
    items: rows.map((r) => ({
      id: r.shift.id,
      userId: r.shift.userId,
      name: fullNameOf(r.person),
      groupId: r.shift.groupId,
      startsAt: r.shift.startsAt,
      endsAt: r.shift.endsAt,
    })),
  });
});

decisionRoutes.post("/duty", requirePermission("duty.take"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, shiftSchema);

  if (input.endsAt <= input.startsAt) badRequest("err.shiftInvalidRange");
  if (!isSuperadmin(user) && input.userId !== user.id) {
    badRequest("err.shiftOthersSuperadminOnly");
  }

  const id = crypto.randomUUID();
  await db.insert(dutyShifts).values({
    id,
    userId: input.userId,
    groupId: input.groupId ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    createdBy: user.id,
  });

  await audit(c, {
    action: "duty.assign",
    resourceType: "duty_shift",
    resourceId: id,
    subjectUserId: input.userId,
    details: { startsAt: input.startsAt, endsAt: input.endsAt },
  });

  return c.json({ id }, 201);
});

/* ── кризисный режим ── */

const crisisSchema = z.object({ reason: z.string().min(3).max(300) });

decisionRoutes.get("/crisis", requirePermission("alerts.review"), async (c) => c.json(await currentCrisis()));

decisionRoutes.post("/crisis", requirePermission("decisions.manage"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, crisisSchema);

  const open = await currentCrisis();
  if (open.active) badRequest("err.crisisAlreadyActive");

  const id = crypto.randomUUID();
  await db.insert(crisisPeriods).values({
    id,
    reason: input.reason,
    startedBy: user.id,
  });

  await audit(c, {
    action: "crisis.start",
    resourceType: "crisis",
    resourceId: id,
    details: { reason: input.reason },
  });

  return c.json({ ok: true }, 201);
});

decisionRoutes.delete("/crisis", requirePermission("decisions.manage"), async (c) => {
  const user = c.get("user");

  const [row] = await db
    .select()
    .from(crisisPeriods)
    .where(isNull(crisisPeriods.endedAt))
    .limit(1);
  if (!row) badRequest("err.crisisNotActive");

  await db
    .update(crisisPeriods)
    .set({ endedAt: new Date().toISOString(), endedBy: user.id })
    .where(eq(crisisPeriods.id, row!.id));

  await audit(c, { action: "crisis.end", resourceType: "crisis", resourceId: row!.id });
  return c.json({ ok: true });
});
