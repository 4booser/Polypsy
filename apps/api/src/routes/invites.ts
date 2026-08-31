import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { createInviteSchema, type Invite, type InvitePreview } from "@quizzy/shared";
import { db } from "../db";
import { batteries, invites, inviteUses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { forbidden, notFound, parseBody } from "../lib/http";
import { findUsableInvite, hashInviteToken, newInviteCode, newInviteToken } from "../lib/invites";
import { assertGroupAccess, isStaff } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const inviteRoutes = new Hono<AppEnv>();

/**
 * Предпросмотр — единственный публичный маршрут: человек по ссылке ещё не
 * зарегистрирован. Наружу уходит только название батареи и подразделение,
 * никаких имён и внутренних id.
 */
inviteRoutes.get("/preview/:token", async (c) => {
  const lookup = await findUsableInvite(c.req.param("token"));
  if (!lookup.ok) {
    return c.json<InvitePreview>({ valid: false, reason: lookup.reason });
  }
  const battery = lookup.invite.batteryId
    ? await db.query.batteries.findFirst({ where: eq(batteries.id, lookup.invite.batteryId) })
    : null;
  return c.json<InvitePreview>({
    valid: true,
    batteryTitle: battery?.title ?? null,
    unit: lookup.invite.unit,
  });
});

inviteRoutes.use("*", requireAuth, requireStaff);

/** Приглашение привязано к батарее — права на него идут от группы батареи */
async function assertInviteBattery(user: Parameters<typeof assertGroupAccess>[0], batteryId: string | null) {
  if (!batteryId) {
    if (!isStaff(user)) forbidden("err.forStaffOnly");
    return;
  }
  const battery = await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) });
  if (!battery) notFound("err.batteryNotFound");
  if (battery.groupId) await assertGroupAccess(user, battery.groupId);
}

inviteRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db.select().from(invites).orderBy(desc(invites.createdAt));

  const visible: (typeof invites.$inferSelect)[] = [];
  for (const row of rows) {
    try {
      await assertInviteBattery(user, row.batteryId);
      visible.push(row);
    } catch {
      // чужие приглашения не показываем
    }
  }

  const batteryIds = [...new Set(visible.map((r) => r.batteryId).filter((x): x is string => !!x))];
  const batteryRows = batteryIds.length
    ? await db.select().from(batteries).where(inArray(batteries.id, batteryIds))
    : [];
  const titleOf = new Map(batteryRows.map((b) => [b.id, b.title]));

  const creatorIds = [...new Set(visible.map((r) => r.createdBy))];
  const creators = creatorIds.length
    ? await db.select().from(users).where(inArray(users.id, creatorIds))
    : [];
  const creatorOf = new Map(creators.map((u) => [u.id, fullNameOf(u)]));

  const useRows = visible.length
    ? await db
        .select({ use: inviteUses, user: users })
        .from(inviteUses)
        .innerJoin(users, eq(users.id, inviteUses.userId))
        .where(inArray(inviteUses.inviteId, visible.map((r) => r.id)))
    : [];

  const result: Invite[] = visible.map((r) => ({
    id: r.id,
    code: r.code,
    batteryId: r.batteryId,
    batteryTitle: r.batteryId ? (titleOf.get(r.batteryId) ?? null) : null,
    unit: r.unit,
    note: r.note,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    createdByName: creatorOf.get(r.createdBy) ?? "—",
    uses: useRows
      .filter((u) => u.use.inviteId === r.id)
      .map((u) => ({ userId: u.user.id, fullName: fullNameOf(u.user), usedAt: u.use.usedAt })),
  }));
  return c.json({ items: result });
});

/** Создание: токен показывается ОДИН раз — дальше в базе только хеш */
inviteRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createInviteSchema);
  await assertInviteBattery(user, input.batteryId ?? null);

  const rawToken = newInviteToken();
  const id = crypto.randomUUID();
  const code = newInviteCode();
  await db.insert(invites).values({
    id,
    tokenHash: hashInviteToken(rawToken),
    code,
    createdBy: user.id,
    batteryId: input.batteryId ?? null,
    unit: input.unit ?? null,
    note: input.note ?? null,
    maxUses: input.maxUses ?? 1,
    expiresAt: new Date(Date.now() + (input.ttlDays ?? 14) * 86_400_000).toISOString(),
  });

  await audit(c, {
    action: "invite.create",
    resourceType: "invite",
    resourceId: id,
    details: { batteryId: input.batteryId ?? null, maxUses: input.maxUses ?? 1, ttlDays: input.ttlDays ?? 14 },
  });
  return c.json({ id, token: rawToken, code }, 201);
});

inviteRoutes.post("/:id/revoke", async (c) => {
  const user = c.get("user");
  const row = await db.query.invites.findFirst({ where: eq(invites.id, c.req.param("id")) });
  if (!row) notFound("err.inviteNotFound");
  await assertInviteBattery(user, row.batteryId);

  await db.update(invites).set({ revokedAt: new Date().toISOString() }).where(eq(invites.id, row.id));
  await audit(c, {
    action: "invite.revoke",
    resourceType: "invite",
    resourceId: row.id,
    details: { usedCount: row.usedCount },
  });
  return c.json({ ok: true });
});
