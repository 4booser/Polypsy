import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { devices, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { notFound, parseBody } from "../lib/http";
import { isSuperadmin } from "../lib/scope";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

export const deviceRoutes = new Hono<AppEnv>();
deviceRoutes.use("*", requireAuth);

/**
 * Устройства и удалённое стирание.
 *
 * Планшет носят по отделению, и потерять его проще, чем ноутбук, а на нём
 * лежит кэш обхода: имена, баллы, планы безопасности.
 *
 * Ограничение записано прямо здесь, чтобы его не приняли за большее, чем оно
 * есть: стирание срабатывает, когда устройство в СЛЕДУЮЩИЙ РАЗ выйдет на
 * связь. Устройство, которое больше не включат, этой командой не очистить — от
 * этого защищает шифрование хранилища и блокировка экрана, и об этом сказано в
 * ответе на запрос стирания, а не только в документации.
 */

const checkinSchema = z.object({
  deviceId: z.string().min(8).max(64),
  label: z.string().max(120).nullable().optional(),
  platform: z.string().max(20).nullable().optional(),
});

/**
 * Отметка устройства о себе. Вызывается приложением при запуске и при
 * возвращении сети; отвечает, надо ли стереть локальные данные.
 */
deviceRoutes.post("/checkin", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, checkinSchema);
  const now = new Date().toISOString();

  const [row] = await db
    .insert(devices)
    .values({
      id: input.deviceId,
      userId: user.id,
      label: input.label ?? null,
      platform: input.platform ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: { lastSeenAt: now, label: input.label ?? null, platform: input.platform ?? null },
    })
    .returning();

  /*
   * Устройство, зарегистрированное на другого человека, стирать по этой
   * команде нельзя: два сотрудника могли по очереди войти на одном планшете, и
   * стирание по чужому запросу выглядело бы как случайная потеря работы.
   */
  const wipe = !!row && row.userId === user.id && !!row.wipeRequestedAt && !row.wipedAt;

  return c.json({ wipe });
});

/** Подтверждение стирания — приходит от устройства после очистки */
deviceRoutes.post("/wiped", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, z.object({ deviceId: z.string() }));

  const [row] = await db
    .update(devices)
    .set({ wipedAt: new Date().toISOString() })
    .where(and(eq(devices.id, input.deviceId), eq(devices.userId, user.id)))
    .returning();
  if (!row) notFound("err.deviceNotFound");

  await audit(c, {
    action: "device.wiped",
    resourceType: "device",
    resourceId: input.deviceId,
    subjectUserId: user.id,
  });
  return c.json({ ok: true });
});

/**
 * Свои устройства человек видит сам, чужие — только суперадмин.
 *
 * Список устройств сотрудника это сведения о нём: где он бывает и с чего
 * работает. Открывать их каждому групповому админу незачем.
 */
deviceRoutes.get("/", async (c) => {
  const user = c.get("user");
  const forUser = c.req.query("userId");
  if (forUser && forUser !== user.id && !isSuperadmin(user)) notFound("err.devicesNotFound");

  const rows = await db
    .select({ device: devices, owner: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.userId, forUser ?? user.id))
    .orderBy(desc(devices.lastSeenAt));

  return c.json({
    items: rows.map((r) => ({
      id: r.device.id,
      label: r.device.label,
      platform: r.device.platform,
      ownerName: fullNameOf(r.owner),
      lastSeenAt: r.device.lastSeenAt,
      wipeRequestedAt: r.device.wipeRequestedAt,
      wipedAt: r.device.wipedAt,
    })),
  });
});

deviceRoutes.post("/:id/wipe", requireSuperadmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [row] = await db
    .update(devices)
    .set({ wipeRequestedAt: new Date().toISOString(), wipeRequestedBy: user.id, wipedAt: null })
    .where(and(eq(devices.id, id), isNull(devices.wipedAt)))
    .returning();
  if (!row) notFound("err.deviceNotFoundOrWiped");

  await audit(c, {
    action: "device.wipe_requested",
    resourceType: "device",
    resourceId: id,
    subjectUserId: row.userId,
  });

  return c.json({
    ok: true,
    /*
     * Ответ говорит, чего команда не делает. Иначе её принимают за гарантию:
     * «стёрли» звучит как свершившийся факт, а на деле это заявка, которая
     * исполнится при следующем выходе устройства на связь.
     */
    note: "Данные будут стёрты, когда устройство в следующий раз выйдет на связь. Устройство, которое больше не включат, этой командой не очистить.",
  });
});
