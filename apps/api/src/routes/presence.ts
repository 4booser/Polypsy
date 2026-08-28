import { Hono } from "hono";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { presence, users } from "../db/schema";
import { fullNameOf } from "../lib/auth";
import { publish } from "../lib/events";
import { parseBody } from "../lib/http";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const presenceRoutes = new Hono<AppEnv>();
presenceRoutes.use("*", requireAuth, requireStaff);

/**
 * Присутствие: кто ещё смотрит на этот случай и кто пишет заключение.
 *
 * Мягко и намеренно. Жёсткая блокировка в клинике опаснее конфликта: человек,
 * взявший случай, уходит со смены, и запись остаётся запертой до тех пор, пока
 * кто-нибудь не полезет в базу. Поэтому здесь только предупреждение — а от
 * потери правок защищает проверка версии при сохранении, она уже есть.
 */

/** Пульс раз в двадцать секунд; запись считается живой минуту */
const TTL_MS = 60_000;

const heartbeatSchema = z.object({
  /** Что смотрим: `patient:<id>`, `case:<id>`, `note:<id>` */
  resource: z.string().min(3).max(120),
});

presenceRoutes.post("/", async (c) => {
  const user = c.get("user");
  const { resource } = await parseBody(c.req.raw, heartbeatSchema);
  const now = new Date().toISOString();

  await db
    .insert(presence)
    .values({ userId: user.id, resource, seenAt: now })
    .onConflictDoUpdate({
      target: [presence.userId, presence.resource],
      set: { seenAt: now },
    });

  /*
   * Событие шлётся при каждом пульсе, а не только при появлении: так уход
   * никого не требует отдельного сообщения — соседи просто перестают видеть
   * запись, когда она устареет. «Ушёл» по закрытию вкладки недостижим:
   * браузер не обязан ничего отправить.
   */
  await publish(db, {
    kind: "presence.changed",
    surveyIds: null,
    userId: user.id,
    at: now,
    resource,
  });

  return c.json({ ok: true });
});

presenceRoutes.get("/", async (c) => {
  const user = c.get("user");
  const resource = c.req.query("resource") ?? "";
  if (!resource) return c.json({ others: [] });

  const since = new Date(Date.now() - TTL_MS).toISOString();
  const rows = await db
    .select({ id: users.id, user: users })
    .from(presence)
    .innerJoin(users, eq(users.id, presence.userId))
    .where(
      and(
        eq(presence.resource, resource),
        gt(presence.seenAt, since),
        // себя в списке не показываем: «здесь вы» — не новость
        ne(presence.userId, user.id),
      ),
    );

  return c.json({
    others: rows.map((r) => ({ id: r.id, name: fullNameOf(r.user) })),
  });
});

/**
 * Уборка протухших строк.
 *
 * Отдельным проходом, а не при каждом чтении: чтение случается на каждом
 * событии канала, и превращать его в запись значит устроить себе запись на
 * каждый чужой пульс.
 */
export async function sweepPresence(olderThanMs = TTL_MS * 5): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const res = await db.execute(sql`delete from presence where seen_at < ${cutoff}`);
  return (res as unknown as { count?: number }).count ?? 0;
}
