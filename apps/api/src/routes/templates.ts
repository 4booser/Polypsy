import { Hono } from "hono";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { departments, specialistProfiles, textTemplates, } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, notFound, parseBody, parseQuery } from "../lib/http";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Библиотека шаблонов и формулировок.
 *
 * Шаблон — заготовка документа целиком: «структура заключения по первичному
 * приёму». Формулировка — оборот на одну строку: «жалоб на момент осмотра не
 * предъявляет». Разница не в длине, а в том, что с ними делают: шаблон
 * подставляют вместо пустого текста, формулировку вставляют в место курсора,
 * не трогая написанного вокруг.
 */
export const templateRoutes = new Hono<AppEnv>();

templateRoutes.use("*", requireAuth, requireStaff);

const listQuery = z.object({
  kind: z.enum(["conclusion", "note", "phrase"]).optional(),
});

const saveSchema = z.object({
  kind: z.enum(["conclusion", "note", "phrase"]),
  title: z.string().min(2).max(200),
  body: z.string().min(2).max(20_000),
  /** null — библиотека учреждения, а не отделения */
  departmentId: z.string().nullish(),
});

/** Отделение, в котором человек принимает; null — он не привязан ни к одному */
async function ownDepartment(userId: string): Promise<string | null> {
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, userId),
  });
  return profile?.departmentId ?? null;
}

/**
 * Что видно этому сотруднику.
 *
 * Своё отделение плюс общие для учреждения. Чужие библиотеки не отдаются: в
 * них лежат обороты, привязанные к работе конкретного отдела, и подставлять
 * их не глядя — верный способ написать в заключении не то.
 */
templateRoutes.get("/", requirePermission("patients.read"), async (c) => {
  const q = parseQuery(c, listQuery);
  const mine = await ownDepartment(c.get("user").id);

  const rows = await db
    .select()
    .from(textTemplates)
    .where(
      and(
        isNull(textTemplates.archivedAt),
        q.kind ? eq(textTemplates.kind, q.kind) : undefined,
        mine
          ? or(isNull(textTemplates.departmentId), eq(textTemplates.departmentId, mine))
          : isNull(textTemplates.departmentId),
      ),
    )
    .orderBy(asc(textTemplates.kind), asc(textTemplates.title));

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

/*
 * Заводит и правит тот, кто пишет заключения.
 *
 * Не администратор: библиотека, которую наполняет только администратор,
 * остаётся пустой — специалист замечает нужный оборот в момент, когда пишет,
 * а не когда заполняет справочники. Плата известна: библиотека со временем
 * разрастается. Гасится она не запретом, а тем, что снятое не удаляется, а
 * убирается из списка, и вернуть его можно.
 */
templateRoutes.post("/", requirePermission("conclusions.write"), async (c) => {
  const input = await parseBody(c.req.raw, saveSchema);
  const me = c.get("user");

  /*
   * В чужое отделение шаблон не заводится. Это не столько защита, сколько
   * защита от опечатки: выбрал не тот идентификатор — и формулировка уехала
   * в соседний отдел, где её никто не заказывал.
   */
  if (input.departmentId) {
    const department = await db.query.departments.findFirst({
      where: eq(departments.id, input.departmentId),
    });
    if (!department) notFound("err.departmentNotFound");
    const mine = await ownDepartment(me.id);
    if (mine !== input.departmentId && me.role !== "superadmin") {
      badRequest("err.templateForeignDepartment");
    }
  }

  const id = crypto.randomUUID();
  await db.insert(textTemplates).values({
    id,
    kind: input.kind,
    title: input.title,
    body: input.body,
    departmentId: input.departmentId ?? null,
    createdBy: me.id,
  });

  await audit(c, {
    action: "template.create",
    resourceType: "template",
    resourceId: id,
    details: { kind: input.kind, title: input.title },
  });
  return c.json({ id }, 201);
});

/**
 * Снятие с использования, а не удаление.
 *
 * Формулировка, которой уже написаны заключения, не должна исчезать: по ней
 * потом разбираются, откуда взялась фраза. Из списка убирается, из базы —
 * нет.
 */
templateRoutes.delete("/:id", requirePermission("conclusions.write"), async (c) => {
  const row = await db.query.textTemplates.findFirst({
    where: eq(textTemplates.id, c.req.param("id")),
  });
  if (!row || row.archivedAt) notFound("err.templateNotFound");

  await db
    .update(textTemplates)
    .set({ archivedAt: new Date().toISOString() })
    .where(eq(textTemplates.id, row.id));

  await audit(c, {
    action: "template.archive",
    resourceType: "template",
    resourceId: row.id,
    details: { title: row.title },
  });
  return c.json({ ok: true });
});
