import { Hono } from "hono";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { t } from "@quizzy/shared";
import { db } from "../db";
import {
  batteries,
  pathwayInstances,
  pathwayProgress,
  pathways,
  pathwaySteps,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, forbidden, langOf, notFound, parseBody } from "../lib/http";
import { accessiblePatientIds, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const pathwayRoutes = new Hono<AppEnv>();
pathwayRoutes.use("*", requireAuth, requireStaff);

/**
 * Маршруты помощи.
 *
 * Смысл не в том, чтобы записать шаги, а в том, чтобы застрявший стал виден.
 * Поэтому у каждого шага есть срок, а у списка — сортировка по просрочке: не
 * «что назначено», а «где стоим».
 *
 * Шаблон и его исполнение разделены намеренно. Правка шаблона не должна
 * менять историю тех, кто уже прошёл по нему: их шаги остаются такими,
 * какими были в момент начала, — ровно как версии методик.
 */

const stepSchema = z.object({
  title: z.record(z.string(), z.string()),
  kind: z.enum(["survey", "battery", "referral", "action", "decision"]),
  surveyId: z.string().uuid().nullable().optional(),
  batteryId: z.string().uuid().nullable().optional(),
  dueDays: z.number().int().min(0).max(3650).nullable().optional(),
  required: z.boolean().optional(),
});

const pathwaySchema = z.object({
  title: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  steps: z.array(stepSchema).min(1).max(40),
});

/* ── шаблоны ── */

pathwayRoutes.get("/", async (c) => {
  const lang = langOf(c);
  const rows = await db
    .select()
    .from(pathways)
    .where(eq(pathways.active, true))
    .orderBy(desc(pathways.createdAt));

  const steps = rows.length
    ? await db
        .select()
        .from(pathwaySteps)
        .where(inArray(pathwaySteps.pathwayId, rows.map((r) => r.id)))
        .orderBy(asc(pathwaySteps.position))
    : [];

  return c.json({
    items: rows.map((p) => ({
      id: p.id,
      title: t(p.title as never, lang),
      description: p.description ? t(p.description as never, lang) : null,
      groupId: p.groupId,
      steps: steps
        .filter((s) => s.pathwayId === p.id)
        .map((s) => ({
          id: s.id,
          title: t(s.title as never, lang),
          kind: s.kind,
          surveyId: s.surveyId,
          batteryId: s.batteryId,
          dueDays: s.dueDays,
          required: s.required,
        })),
    })),
  });
});

pathwayRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.role !== "admin") forbidden();
  const input = await parseBody(c.req.raw, pathwaySchema);

  const id = crypto.randomUUID();
  await db.insert(pathways).values({
    id,
    title: input.title,
    description: input.description ?? null,
    groupId: input.groupId ?? null,
    createdBy: user.id,
  });
  await db.insert(pathwaySteps).values(
    input.steps.map((s, i) => ({
      id: crypto.randomUUID(),
      pathwayId: id,
      position: i,
      title: s.title,
      kind: s.kind,
      surveyId: s.surveyId ?? null,
      batteryId: s.batteryId ?? null,
      dueDays: s.dueDays ?? null,
      required: s.required ?? true,
    })),
  );

  await audit(c, { action: "pathway.create", resourceType: "pathway", resourceId: id });
  return c.json({ id }, 201);
});

/* ── ведение человека по маршруту ── */

pathwayRoutes.post("/:id/start", async (c) => {
  const staff = c.get("user");
  const pathwayId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const userId = typeof body?.userId === "string" ? body.userId : null;
  if (!userId) badRequest("Нужен пациент");

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient || patient.role !== "user") notFound("Пациент не найден");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("Пациент не найден");

  const template = await db.query.pathways.findFirst({ where: eq(pathways.id, pathwayId) });
  if (!template) notFound("Маршрут не найден");

  const steps = await db
    .select()
    .from(pathwaySteps)
    .where(eq(pathwaySteps.pathwayId, pathwayId))
    .orderBy(asc(pathwaySteps.position));
  if (!steps.length) badRequest("В маршруте нет шагов");

  /*
   * Второй открытый маршрут того же вида — почти всегда ошибка: человек не
   * может одновременно идти двумя одинаковыми путями, и два списка шагов
   * рядом невозможно разобрать.
   */
  const existing = await db.query.pathwayInstances.findFirst({
    where: and(
      eq(pathwayInstances.pathwayId, pathwayId),
      eq(pathwayInstances.userId, userId),
      isNull(pathwayInstances.closedAt),
    ),
  });
  if (existing) badRequest("Этот маршрут у пациента уже открыт");

  const instanceId = crypto.randomUUID();
  const startedAt = new Date();

  await db.insert(pathwayInstances).values({
    id: instanceId,
    pathwayId,
    userId,
    startedBy: staff.id,
    startedAt: startedAt.toISOString(),
  });
  await db.insert(pathwayProgress).values(
    steps.map((s) => ({
      id: crypto.randomUUID(),
      instanceId,
      stepId: s.id,
      // срок считается от начала маршрута: «через 14 дней» — это от старта,
      // а не от предыдущего шага, иначе просрочка одного сдвигает все
      dueAt:
        s.dueDays === null
          ? null
          : new Date(startedAt.getTime() + s.dueDays * 86_400_000).toISOString(),
    })),
  );

  await audit(c, {
    action: "pathway.start",
    resourceType: "pathway",
    resourceId: instanceId,
    subjectUserId: userId,
    details: { pathwayId, steps: steps.length },
  });
  return c.json({ id: instanceId }, 201);
});

/** Открытые маршруты в зоне ответственности: просроченные сверху */
pathwayRoutes.get("/instances", async (c) => {
  const staff = c.get("user");
  const lang = langOf(c);
  const all = c.req.query("all") === "1";

  const allowed = await accessiblePatientIds(staff);
  if (allowed && allowed.size === 0) return c.json({ items: [] });

  const rows = await db
    .select({ instance: pathwayInstances, pathway: pathways, patient: users })
    .from(pathwayInstances)
    .innerJoin(pathways, eq(pathways.id, pathwayInstances.pathwayId))
    .leftJoin(users, eq(users.id, pathwayInstances.userId))
    .where(
      and(
        all ? undefined : isNull(pathwayInstances.closedAt),
        allowed ? inArray(pathwayInstances.userId, [...allowed]) : undefined,
      ),
    )
    .orderBy(desc(pathwayInstances.startedAt))
    .limit(200);

  if (!rows.length) return c.json({ items: [] });

  const progress = await db
    .select({ p: pathwayProgress, s: pathwaySteps })
    .from(pathwayProgress)
    .innerJoin(pathwaySteps, eq(pathwaySteps.id, pathwayProgress.stepId))
    .where(inArray(pathwayProgress.instanceId, rows.map((r) => r.instance.id)))
    .orderBy(asc(pathwaySteps.position));

  const now = new Date().toISOString();

  return c.json({
    items: rows.map(({ instance, pathway, patient }) => {
      const mine = progress.filter((x) => x.p.instanceId === instance.id);
      const done = mine.filter((x) => x.p.state !== "pending").length;
      const overdue = mine.filter(
        (x) => x.p.state === "pending" && x.p.dueAt !== null && x.p.dueAt < now,
      ).length;
      // «где стоим» — первый незакрытый шаг: он и есть ответ на вопрос
      const current = mine.find((x) => x.p.state === "pending");

      return {
        id: instance.id,
        pathwayTitle: t(pathway.title as never, lang),
        userId: instance.userId,
        userName: patient ? fullNameOf(patient) : "—",
        unit: patient?.unit ?? null,
        startedAt: instance.startedAt,
        closedAt: instance.closedAt,
        outcome: instance.outcome,
        total: mine.length,
        done,
        overdue,
        currentStep: current ? t(current.s.title as never, lang) : null,
        currentDueAt: current?.p.dueAt ?? null,
      };
    }),
  });
});

pathwayRoutes.get("/instances/:id", async (c) => {
  const staff = c.get("user");
  const lang = langOf(c);

  const [row] = await db
    .select({ instance: pathwayInstances, pathway: pathways, patient: users })
    .from(pathwayInstances)
    .innerJoin(pathways, eq(pathways.id, pathwayInstances.pathwayId))
    .leftJoin(users, eq(users.id, pathwayInstances.userId))
    .where(eq(pathwayInstances.id, c.req.param("id")));
  if (!row) notFound("Маршрут не найден");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(row.instance.userId)) notFound("Маршрут не найден");

  const steps = await db
    .select({ p: pathwayProgress, s: pathwaySteps, by: users })
    .from(pathwayProgress)
    .innerJoin(pathwaySteps, eq(pathwaySteps.id, pathwayProgress.stepId))
    .leftJoin(users, eq(users.id, pathwayProgress.doneBy))
    .where(eq(pathwayProgress.instanceId, row.instance.id))
    .orderBy(asc(pathwaySteps.position));

  await audit(c, {
    action: "response.read",
    resourceType: "pathway",
    resourceId: row.instance.id,
    subjectUserId: row.instance.userId,
    details: { view: "pathway" },
  });

  return c.json({
    id: row.instance.id,
    pathwayTitle: t(row.pathway.title as never, lang),
    userId: row.instance.userId,
    userName: row.patient ? fullNameOf(row.patient) : "—",
    startedAt: row.instance.startedAt,
    closedAt: row.instance.closedAt,
    outcome: row.instance.outcome,
    note: row.instance.note,
    steps: steps.map(({ p, s, by }) => ({
      id: p.id,
      title: t(s.title as never, lang),
      kind: s.kind,
      surveyId: s.surveyId,
      batteryId: s.batteryId,
      required: s.required,
      state: p.state,
      dueAt: p.dueAt,
      doneAt: p.doneAt,
      doneByName: by ? fullNameOf(by) : null,
      note: p.note,
    })),
  });
});

const progressSchema = z.object({
  state: z.enum(["pending", "done", "skipped"]),
  note: z.string().max(2000).optional(),
});

pathwayRoutes.patch("/progress/:id", async (c) => {
  const staff = c.get("user");
  const input = await parseBody(c.req.raw, progressSchema);

  const [row] = await db
    .select({ p: pathwayProgress, i: pathwayInstances, s: pathwaySteps })
    .from(pathwayProgress)
    .innerJoin(pathwayInstances, eq(pathwayInstances.id, pathwayProgress.instanceId))
    .innerJoin(pathwaySteps, eq(pathwaySteps.id, pathwayProgress.stepId))
    .where(eq(pathwayProgress.id, c.req.param("id")));
  if (!row) notFound("Шаг не найден");
  if (row.i.closedAt) badRequest("Маршрут уже закрыт");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(row.i.userId)) notFound("Шаг не найден");

  /*
   * Пропуск обязательного шага требует объяснения. Без него запись «шаг
   * пропущен» ничего не значит через месяц, а именно к ней возвращаются,
   * когда разбирают, почему человек не дошёл до помощи.
   */
  if (input.state === "skipped" && row.s.required && !input.note?.trim()) {
    badRequest("Пропуск обязательного шага нужно объяснить");
  }

  await db
    .update(pathwayProgress)
    .set({
      state: input.state,
      note: input.note?.trim() || row.p.note,
      doneAt: input.state === "pending" ? null : new Date().toISOString(),
      doneBy: input.state === "pending" ? null : staff.id,
    })
    .where(eq(pathwayProgress.id, row.p.id));

  await audit(c, {
    action: "pathway.step",
    resourceType: "pathway",
    resourceId: row.i.id,
    subjectUserId: row.i.userId,
    details: { state: input.state, kind: row.s.kind },
  });

  return c.json({ ok: true });
});

const closeSchema = z.object({
  outcome: z.enum(["resolved", "referred", "ongoing", "dropped"]),
  note: z.string().max(2000).optional(),
});

pathwayRoutes.post("/instances/:id/close", async (c) => {
  const staff = c.get("user");
  const input = await parseBody(c.req.raw, closeSchema);

  const row = await db.query.pathwayInstances.findFirst({
    where: eq(pathwayInstances.id, c.req.param("id")),
  });
  if (!row) notFound("Маршрут не найден");
  if (row.closedAt) badRequest("Маршрут уже закрыт");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(row.userId)) notFound("Маршрут не найден");

  await db
    .update(pathwayInstances)
    .set({
      closedAt: new Date().toISOString(),
      closedBy: staff.id,
      outcome: input.outcome,
      note: input.note?.trim() || null,
    })
    .where(eq(pathwayInstances.id, row.id));

  await audit(c, {
    action: "pathway.close",
    resourceType: "pathway",
    resourceId: row.id,
    subjectUserId: row.userId,
    details: { outcome: input.outcome },
  });

  return c.json({ ok: true });
});

void surveyScopeFilter;
void surveys;
void batteries;
void sql;
