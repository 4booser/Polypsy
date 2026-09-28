import { Hono } from "hono";
import { and, asc, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { serverText } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { devices, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { langOf, notFound, parseBody } from "../lib/http";
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
  /*
   * Версия приложения и номер сборки (миграция 0091). Необязательны: старая
   * сборка их не шлёт, и отказывать ей в отметке — значит перестать стирать
   * потерянные устройства ровно у тех, кто не обновился.
   *
   * Форма — цифры и точки (с хвостом вроде «-beta»): версия уходит в
   * техпанель как есть, и строке сюда незачем быть чем-то ещё.
   */
  appVersion: z
    .string()
    .max(32)
    .regex(/^[0-9][0-9A-Za-z.+-]*$/)
    .nullable()
    .optional(),
  appBuild: z
    .string()
    .max(32)
    .regex(/^[0-9A-Za-z.+-]+$/)
    .nullable()
    .optional(),
  /**
   * Что лежит в офлайн-очереди устройства: только числа, без содержимого.
   * Сервер иначе не видит сдач, которые до него не дошли (см. 0091).
   */
  queue: z
    .object({
      pending: z.number().int().min(0).max(10_000),
      rejected: z.number().int().min(0).max(10_000),
    })
    .nullable()
    .optional(),
});

/**
 * Отметка устройства о себе. Вызывается приложением при запуске и при
 * возвращении сети; отвечает, надо ли стереть локальные данные.
 */
deviceRoutes.post("/checkin", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, checkinSchema);
  const now = new Date().toISOString();
  /*
   * Поля, которых устройство не прислало, не затираются: старая сборка не
   * знает про версию, и её отметка не должна стирать то, что прислала новая
   * на том же устройстве до отката.
   */
  const reported = {
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    ...(input.appBuild !== undefined ? { appBuild: input.appBuild } : {}),
    ...(input.queue !== undefined
      ? { queuePending: input.queue?.pending ?? null, queueRejected: input.queue?.rejected ?? null }
      : {}),
  };

  /*
   * Строка — пара «установка + учётная запись» (миграция 0113), и каждый
   * отмечается в СВОЮ. До неё строка была одна на установку и принадлежала
   * тому, кто вошёл первым: второй сотрудник на общем планшете обновлял
   * чужую строку (волна 13: сначала пятисотка под ролью приложения, потом
   * системная роль и владелец, который не меняется), своей не получал, и его
   * устройство не попадало ни в его список, ни под стирание (внешний разбор,
   * волна 15, п. 12). Теперь отметка пишет только свою строку — политика
   * devices это и разрешает, системная роль не нужна.
   */
  const [row] = await db
    .insert(devices)
    .values({
      id: input.deviceId,
      userId: user.id,
      label: input.label ?? null,
      platform: input.platform ?? null,
      lastSeenAt: now,
      ...reported,
    })
    .onConflictDoUpdate({
      target: [devices.id, devices.userId],
      set: { lastSeenAt: now, label: input.label ?? null, platform: input.platform ?? null, ...reported },
    })
    .returning();

  /*
   * Команда — у привязки: стирание, запрошенное для одного человека, другому
   * на том же планшете не приходит. Два сотрудника могли по очереди войти на
   * одном планшете, и стирание по чужому запросу выглядело бы как случайная
   * потеря работы.
   */
  const wipe = !!row && !!row.wipeRequestedAt && !row.wipedAt;

  return c.json({ wipe });
});

/**
 * Подтверждение стирания — приходит от устройства ПОСЛЕ проверенной очистки
 * (мобилка, offline/wipe.ts).
 *
 * Принимается только от привязки, которой команда была дана и ещё не
 * исполнена: «стёрто» без команды — не сведение, а шум, и мобилка на 404
 * снимает свой след («подтверждения не ждут»).
 */
deviceRoutes.post("/wiped", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, z.object({ deviceId: z.string() }));
  const now = new Date().toISOString();

  const [row] = await db
    .update(devices)
    .set({ wipedAt: now })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.userId, user.id),
        isNotNull(devices.wipeRequestedAt),
        isNull(devices.wipedAt),
      ),
    )
    .returning();
  if (!row) notFound("err.deviceNotFound");

  /*
   * Команда — у привязки, а очистка — у установки: приложение стирает всё
   * своё хранилище, вместе с офлайн-данными других людей, входивших на этот
   * планшет. Их привязки отмечаются стёртыми тем же моментом — это правда о
   * том, что на установке больше ничего нет, и без неё в их списках
   * устройство висело бы «активным» навсегда (после стирания приложение
   * представляется новым идентификатором). Команд им это не приписывает:
   * wipe_requested_* не трогаются.
   *
   * Системной ролью, потому что строки чужие; узко — только эта установка и
   * только после того, как своя команда найдена и закрыта условием выше.
   */
  await asSystem(() =>
    db
      .update(devices)
      .set({ wipedAt: now })
      .where(and(eq(devices.id, input.deviceId), ne(devices.userId, user.id), isNull(devices.wipedAt))),
  );

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
    .orderBy(desc(devices.lastSeenAt), asc(devices.id));

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

/**
 * Запросить стирание для привязки «установка + учётная запись».
 *
 * Учётная запись называется явно: на общем планшете у установки несколько
 * привязок, и команда без адресата либо досталась бы всем (стирание по
 * чужому запросу), либо первой попавшейся. Консоль открывает список
 * устройств по человеку (pages/ops/UserDevices.tsx) и знает, чьё стирает.
 */
const wipeSchema = z.object({ userId: z.string().min(1).max(64) });

deviceRoutes.post("/:id/wipe", requireSuperadmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, wipeSchema);

  const [row] = await db
    .update(devices)
    .set({ wipeRequestedAt: new Date().toISOString(), wipeRequestedBy: user.id, wipedAt: null })
    .where(and(eq(devices.id, id), eq(devices.userId, input.userId), isNull(devices.wipedAt)))
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
    note: serverText("device.wipeNote", langOf(c)),
  });
});
