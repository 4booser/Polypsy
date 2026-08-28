import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { scheduleInputSchema, type Schedule } from "@quizzy/shared";
import { db } from "../db";
import { batteries, scheduleRuns, scheduleTargets, schedules, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { runDueSchedules, scheduleReach } from "../lib/scheduler";
import { assertBatteryInUse, assertGroupAccess, isStaff } from "../lib/scope";
import { forbidden } from "../lib/http";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const scheduleRoutes = new Hono<AppEnv>();

scheduleRoutes.use("*", requireAuth, requireStaff);

/** Расписание наследует права от батареи, а та — от своей группы */
async function assertScheduleBattery(user: Parameters<typeof assertGroupAccess>[0], batteryId: string) {
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!battery) notFound("Батарея не найдена");
  if (battery.groupId) await assertGroupAccess(user, battery.groupId);
  else if (!isStaff(user)) forbidden("Нет доступа к батарее");
  return battery;
}

async function serialize(rows: (typeof schedules.$inferSelect)[]): Promise<Schedule[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const batteryRows = await db
    .select()
    .from(batteries)
    .where(inArray(batteries.id, [...new Set(rows.map((r) => r.batteryId))]));
  const titleOf = new Map(batteryRows.map((b) => [b.id, b.title]));

  const targetRows = await db
    .select({ scheduleId: scheduleTargets.scheduleId, user: users })
    .from(scheduleTargets)
    .innerJoin(users, eq(users.id, scheduleTargets.userId))
    .where(inArray(scheduleTargets.scheduleId, ids));

  const runRows = await db
    .select()
    .from(scheduleRuns)
    .where(inArray(scheduleRuns.scheduleId, ids))
    .orderBy(desc(scheduleRuns.ranAt));

  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      title: r.title,
      batteryId: r.batteryId,
      batteryTitle: titleOf.get(r.batteryId) ?? "—",
      scope: r.scope,
      unit: r.unit,
      intervalDays: r.intervalDays,
      dueDays: r.dueDays,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      active: r.active,
      lastRunAt: r.lastRunAt,
      nextRunAt: r.nextRunAt,
      createdAt: r.createdAt,
      targets: targetRows
        .filter((t) => t.scheduleId === r.id)
        .map((t) => ({ userId: t.user.id, fullName: fullNameOf(t.user) })),
      // охват считаем на лету: состав подразделения меняется, и цифра,
      // запомненная при создании, врала бы уже через неделю
      reach: (await scheduleReach(r)).length,
      runs: runRows
        .filter((run) => run.scheduleId === r.id)
        .slice(0, 10)
        .map((run) => ({
          id: run.id,
          ranAt: run.ranAt,
          assigned: run.assigned,
          skipped: run.skipped,
          note: run.note,
        })),
    })),
  );
}

scheduleRoutes.get("/", async (c) => {
  const rows = await db.select().from(schedules).orderBy(desc(schedules.createdAt));
  const visible: (typeof schedules.$inferSelect)[] = [];
  for (const row of rows) {
    try {
      await assertScheduleBattery(c.get("user"), row.batteryId);
      visible.push(row);
    } catch {
      // расписание на чужую батарею просто не показываем
    }
  }
  return c.json({ items: await serialize(visible) });
});

/** Подразделения, по которым можно строить охват */
scheduleRoutes.get("/units", async (c) => {
  const rows = await db
    .select({ unit: users.unit })
    .from(users)
    .where(eq(users.role, "user"))
    .groupBy(users.unit);
  return c.json({
    items: rows
      .map((r) => r.unit)
      .filter((u): u is string => !!u?.trim())
      .sort((a, b) => a.localeCompare(b, "ru")),
  });
});

scheduleRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, scheduleInputSchema);
  await assertScheduleBattery(user, input.batteryId);
  await assertBatteryInUse(input.batteryId);

  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  if (input.endsAt && new Date(input.endsAt) <= startsAt)
    badRequest("Дата окончания должна быть позже даты начала");

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(schedules).values({
      id,
      title: input.title,
      batteryId: input.batteryId,
      scope: input.scope,
      unit: input.scope === "unit" ? (input.unit ?? null) : null,
      intervalDays: input.intervalDays,
      dueDays: input.dueDays ?? 14,
      startsAt: startsAt.toISOString(),
      endsAt: input.endsAt ?? null,
      active: input.active ?? true,
      // первое срабатывание — в дату начала, а не через период: иначе
      // расписание, заведённое «с сегодня», молчит целый интервал
      nextRunAt: startsAt.toISOString(),
      createdBy: user.id,
    });
    if (input.scope === "users" && input.userIds?.length) {
      await tx
        .insert(scheduleTargets)
        .values(input.userIds.map((userId) => ({ scheduleId: id, userId })));
    }
  });

  await audit(c, {
    action: "schedule.create",
    resourceType: "schedule",
    resourceId: id,
    details: {
      title: input.title,
      scope: input.scope,
      intervalDays: input.intervalDays,
      unit: input.unit ?? null,
      targets: input.userIds?.length ?? 0,
    },
  });
  return c.json({ id }, 201);
});

scheduleRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!existing) notFound("Расписание не найдено");
  await assertScheduleBattery(user, existing.batteryId);

  const input = await parseBody(c.req.raw, scheduleInputSchema);
  await assertScheduleBattery(user, input.batteryId);
  await assertBatteryInUse(input.batteryId);

  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date(existing.startsAt);
  if (input.endsAt && new Date(input.endsAt) <= startsAt)
    badRequest("Дата окончания должна быть позже даты начала");

  // период изменился — пересчитываем ближайшее срабатывание от даты начала,
  // иначе новая частота вступит в силу только после старого срока
  const intervalChanged = input.intervalDays !== existing.intervalDays;

  await db.transaction(async (tx) => {
    await tx
      .update(schedules)
      .set({
        title: input.title,
        batteryId: input.batteryId,
        scope: input.scope,
        unit: input.scope === "unit" ? (input.unit ?? null) : null,
        intervalDays: input.intervalDays,
        dueDays: input.dueDays ?? 14,
        startsAt: startsAt.toISOString(),
        endsAt: input.endsAt ?? null,
        active: input.active ?? true,
        ...(intervalChanged
          ? { nextRunAt: nextFrom(startsAt, input.intervalDays, existing.lastRunAt) }
          : {}),
      })
      .where(eq(schedules.id, id));
    await tx.delete(scheduleTargets).where(eq(scheduleTargets.scheduleId, id));
    if (input.scope === "users" && input.userIds?.length) {
      await tx
        .insert(scheduleTargets)
        .values(input.userIds.map((userId) => ({ scheduleId: id, userId })));
    }
  });

  await audit(c, {
    action: "schedule.update",
    resourceType: "schedule",
    resourceId: id,
    details: { title: input.title, intervalDays: input.intervalDays, active: input.active ?? true },
  });
  return c.json({ ok: true });
});

/** Ближайшее срабатывание после смены периода */
function nextFrom(startsAt: Date, intervalDays: number, lastRunAt: string | null): string {
  const base = lastRunAt ? new Date(lastRunAt) : startsAt;
  const step = intervalDays * 86_400_000;
  let next = lastRunAt ? base.getTime() + step : base.getTime();
  const now = Date.now();
  while (next <= now) next += step;
  return new Date(next).toISOString();
}

scheduleRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!existing) notFound("Расписание не найдено");
  await assertScheduleBattery(user, existing.batteryId);

  // уже выданные назначения остаются: они часть истории обследования,
  // а не следствие того, что расписание всё ещё существует
  await db.delete(schedules).where(eq(schedules.id, id));
  await audit(c, {
    action: "schedule.delete",
    resourceType: "schedule",
    resourceId: id,
    details: { title: existing.title },
  });
  return c.body(null, 204);
});

/** Запуск вручную: удобно проверить охват, не дожидаясь срока */
scheduleRoutes.post("/:id/run", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!existing) notFound("Расписание не найдено");
  await assertScheduleBattery(user, existing.batteryId);
  if (!existing.active) badRequest("Расписание выключено");

  // сдвигаем срок в прошлое, чтобы общий проход подхватил именно это расписание
  await db
    .update(schedules)
    .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(schedules.id, id));
  await runDueSchedules();

  const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
  await audit(c, {
    action: "schedule.run",
    resourceType: "schedule",
    resourceId: id,
    details: { title: existing.title, manual: true },
  });
  return c.json((await serialize([row!]))[0]);
});
