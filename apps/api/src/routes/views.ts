import { Hono } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { savedViews, users } from "../db/schema";
import { fullNameOf } from "../lib/auth";
import { badRequest, forbidden, notFound, parseBody } from "../lib/http";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const viewRoutes = new Hono<AppEnv>();
viewRoutes.use("*", requireAuth, requireStaff);

/**
 * Сохранённые виды экрана.
 *
 * Фильтры уже живут в адресе и передаются ссылкой; здесь снимается вторая
 * половина работы — не собирать «мои просроченные по третьей роте» заново
 * каждое утро.
 *
 * Хранятся параметры, а не данные, и в этом вся безопасность общих видов:
 * открыв чужой вид, сотрудник увидит тот же фильтр, но выборку сервер
 * соберёт по ЕГО правам. Вид не может показать больше, чем человеку
 * положено.
 */

const saveSchema = z.object({
  scope: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  /** Строка запроса без «?»; пустая — это тоже вид, «всё без фильтров» */
  params: z.string().max(600),
  shared: z.boolean().optional(),
});

viewRoutes.get("/", async (c) => {
  const user = c.get("user");
  const scope = c.req.query("scope");

  const rows = await db
    .select({ view: savedViews, owner: users })
    .from(savedViews)
    .leftJoin(users, eq(users.id, savedViews.ownerId))
    .where(
      and(
        scope ? eq(savedViews.scope, scope) : undefined,
        // свои и общие: чужой личный вид — чужое рабочее место
        or(eq(savedViews.ownerId, user.id), eq(savedViews.shared, true)),
      ),
    )
    .orderBy(desc(savedViews.createdAt));

  return c.json({
    items: rows.map(({ view, owner }) => ({
      id: view.id,
      scope: view.scope,
      name: view.name,
      params: view.params,
      shared: view.shared,
      mine: view.ownerId === user.id,
      ownerName: owner ? fullNameOf(owner) : "—",
      createdAt: view.createdAt,
    })),
  });
});

viewRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, saveSchema);

  /*
   * Конфликт разрешается запросом, а не исключением: каждый запрос идёт в
   * транзакции (её открывает RLS-контекст), и упавшая вставка отравляет её
   * целиком — пойманная ошибка всё равно обернулась бы пятисоткой на
   * коммите. Уникальность по (владелец, экран, имя): второй «мои
   * просроченные» сбивал бы с толку сильнее, чем отказ.
   */
  const id = crypto.randomUUID();
  const [saved] = await db
    .insert(savedViews)
    .values({
      id,
      ownerId: user.id,
      scope: input.scope,
      name: input.name.trim(),
      params: input.params,
      shared: input.shared ?? false,
    })
    .onConflictDoNothing()
    .returning({ id: savedViews.id });

  if (!saved) badRequest("err.viewNameTaken");
  return c.json({ id }, 201);
});

viewRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const row = await db.query.savedViews.findFirst({ where: eq(savedViews.id, c.req.param("id")) });
  if (!row) notFound("err.viewNotFound");
  if (row.ownerId !== user.id) forbidden("err.viewEditOwnerOnly");

  const body = await c.req.json().catch(() => ({}));
  await db
    .update(savedViews)
    .set({
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name,
      shared: typeof body.shared === "boolean" ? body.shared : row.shared,
      params: typeof body.params === "string" ? body.params : row.params,
    })
    .where(eq(savedViews.id, row.id));

  return c.json({ ok: true });
});

viewRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const row = await db.query.savedViews.findFirst({ where: eq(savedViews.id, c.req.param("id")) });
  if (!row) notFound("err.viewNotFound");
  if (row.ownerId !== user.id) forbidden("err.viewDeleteOwnerOnly");

  await db.delete(savedViews).where(eq(savedViews.id, row.id));
  return c.body(null, 204);
});
