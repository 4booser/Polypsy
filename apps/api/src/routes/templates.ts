import { Hono } from "hono";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { specialistProfiles, textTemplates } from "../db/schema";
import { audit } from "../lib/audit";
import { parseBody } from "../lib/http";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use("*", requireAuth, requireStaff);

/**
 * Библиотека формулировок отделения.
 *
 * Таблица `text_templates` и экран, который её показывает, существовали по
 * отдельности: `TemplatePicker` ходил в `/api/templates`, маршрута не было,
 * и на 404 компонент честно рисовал «библиотека пуста». Специалист жал
 * «вставить из библиотеки», видел пустоту и делал единственный возможный
 * вывод — что её не заполнили. Заполнить её при этом было нечем: кнопка
 * «сохранить как формулировку» уходила в тот же 404.
 *
 * Отделение пишет одни и те же обороты десятками раз. Цена отсутствия
 * библиотеки — не только время: одно и то же состояние в двух заключениях
 * описано разными словами, и сравнить их потом нельзя.
 *
 * Два вида поведения, поэтому и два вида записей:
 *  — `conclusion` / `note` — заготовка документа, подставляется целиком;
 *  — `phrase` — оборот, вставляется в место курсора.
 * Различие хранится в базе, а не в интерфейсе: подставить заготовку поверх
 * написанного абзаца значит затереть работу, и решать это должен не цвет
 * кнопки.
 */

const createSchema = z.object({
  kind: z.enum(["conclusion", "note", "phrase"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
});

/** Отделение автора: у суперадмина профиля специалиста нет — значит, общая */
async function departmentOf(userId: string): Promise<string | null> {
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, userId),
  });
  return profile?.departmentId ?? null;
}

/**
 * Своя библиотека плюс общая.
 *
 * Чужое отделение не показывается: формулировки пишут под свой профиль
 * работы, и «рекомендован повторный замер через месяц» из наркологии в
 * списке психолога — это мусор, а не помощь. Общие (department_id = null)
 * видны всем: часть оборотов одинакова везде, и заводить их в каждом
 * отделении заново значит получить пять расходящихся копий.
 */
templateRoutes.get("/", async (c) => {
  const departmentId = await departmentOf(c.get("user").id);

  const rows = await db
    .select()
    .from(textTemplates)
    .where(
      and(
        // архивная запись остаётся в базе, но из подсказки уходит
        isNull(textTemplates.archivedAt),
        departmentId
          ? or(eq(textTemplates.departmentId, departmentId), isNull(textTemplates.departmentId))
          : isNull(textTemplates.departmentId),
      ),
    )
    .orderBy(asc(textTemplates.title));

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      departmentId: r.departmentId,
    })),
  });
});

/**
 * Пополнение библиотеки оттуда, где формулировка родилась.
 *
 * Специалист замечает нужный оборот в момент, когда его пишет, а не когда
 * заполняет справочники. Отделение берётся из профиля автора и не
 * принимается от клиента: иначе один специалист мог бы писать в библиотеку
 * чужого отделения, а разбираться, откуда взялась строка, пришлось бы по
 * журналу.
 */
templateRoutes.post("/", requirePermission("notes.write"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createSchema);

  const id = crypto.randomUUID();
  await db.insert(textTemplates).values({
    id,
    departmentId: await departmentOf(user.id),
    kind: input.kind,
    title: input.title.trim(),
    body: input.body.trim(),
    createdBy: user.id,
  });

  /*
   * Пишется в журнал, хотя данных о людях здесь нет. Библиотека общая: её
   * строки попадают в чужие заключения, и вопрос «кто это сюда добавил»
   * когда-нибудь будет задан.
   */
  await audit(c, {
    action: "template.create",
    resourceType: "template",
    resourceId: id,
    details: { kind: input.kind },
  });

  return c.json({ id }, 201);
});
