import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  surveyFolderInputSchema,
  surveyFolderUpdateSchema,
  type SurveyFolderWithCounts,
} from "@quizzy/shared";
import { db } from "../db";
import { surveyFolders } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, parseBody } from "../lib/http";
import { accessibleGroupIds, assertGroupAccess, assertSurveyFolderAccess } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Папки МЕТОДИК — полки каталога: «Мої тести › Тести за 2023 › Тести за
 * лютий 2023».
 *
 * Не путать с /api/groups (группы методик — разграничение доступа) и с
 * /api/patient-groups (списки людей). Папка ничего не открывает и не
 * закрывает: кому она видна, решает её группа, и проверяет это та же
 * assertGroupAccess, что и у самих методик. Своего правила видимости у папок
 * нет — второе правило разошлось бы с первым на маршруте, который забыли
 * поправить.
 *
 * Права — те же, что у методик. Список читает тот, кто вправе видеть
 * методики (surveys.read): папки — структура каталога, без методик она
 * бессмысленна. Пишет тот, кто вправе править методики (surveys.edit):
 * разложить методики по полкам — часть их ведения, и отдельное право на
 * папки выдали бы всем с surveys.edit в первый же день, а потом забыли.
 *
 * Отдельный путь, а не /api/surveys/folders: тот столкнулся бы с
 * /api/surveys/:id — Hono отдал бы «folders» обработчику методики как её
 * идентификатор, — а читающий журнал доступа обязан понимать по адресу, о
 * чём речь, без знания порядка регистрации маршрутов.
 */
export const surveyFolderRoutes = new Hono<AppEnv>();

surveyFolderRoutes.use("*", requireAuth, requireStaff);

/**
 * Все видимые папки плоским списком с parentId; ?groupId= — одной группы.
 *
 * Плоский список, а не дерево и не «дети одной папки». Крошкам нужны предки,
 * экрану — дети, и плоский список отвечает на оба вопроса одним запросом:
 * дерево из него клиент собирает за один проход. Дерево с сервера пришлось
 * бы либо строить рекурсивно, либо резать по глубине, а «дети одной папки»
 * означали бы запрос на каждый шаг по крошкам. Папок у отделения десятки,
 * не тысячи, — грузить их разом дешевле любой из альтернатив.
 *
 * Чужая группа в ?groupId= даёт пустой список, а не отказ, — ровно как
 * ?groupId= у списка методик: условие по видимости стоит в запросе, и фильтр
 * может его только сузить.
 */
surveyFolderRoutes.get("/", requirePermission("surveys.read"), async (c) => {
  const user = c.get("user");
  const groupId = c.req.query("groupId") || undefined;
  const allowed = await accessibleGroupIds(user);

  const visible =
    allowed === null
      ? undefined
      : allowed.length
        ? inArray(surveyFolders.groupId, allowed)
        : sql`1 = 0`;
  const where = and(visible, groupId ? eq(surveyFolders.groupId, groupId) : undefined);

  const rows = await db
    .select({
      id: surveyFolders.id,
      groupId: surveyFolders.groupId,
      parentId: surveyFolders.parentId,
      title: surveyFolders.title,
      startsOn: surveyFolders.startsOn,
      position: surveyFolders.position,
      createdBy: surveyFolders.createdBy,
      createdAt: surveyFolders.createdAt,
      /*
       * Считаются методики в работе — столько человек увидит, открыв папку.
       * Снятые с использования в счётчик не входят, но папку с ними удалить
       * нельзя, см. DELETE ниже: там считается всё, что в ней лежит.
       */
      surveyCount: sql<number>`(select count(*)::int from surveys s
        where s.folder_id = "survey_folders"."id" and s.archived_at is null)`,
      childCount: sql<number>`(select count(*)::int from survey_folders f
        where f.parent_id = "survey_folders"."id")`,
    })
    .from(surveyFolders)
    .where(where)
    /*
     * Порядок задан в базе: сначала как расставили руками, затем свежие даты
     * выше — «Тести за 2024» над «Тести за 2023», как на макете. Равные
     * разводятся временем заведения, иначе порядок папок менялся бы от
     * запроса к запросу.
     */
    .orderBy(asc(surveyFolders.position), desc(surveyFolders.startsOn), asc(surveyFolders.createdAt));

  const items: SurveyFolderWithCounts[] = rows.map((r) => ({
    ...r,
    surveyCount: Number(r.surveyCount ?? 0),
    childCount: Number(r.childCount ?? 0),
  }));
  return c.json({ items });
});

/**
 * Завести папку. Группа задаётся здесь и дальше не меняется.
 *
 * Родитель, если задан, обязан быть из той же группы. Иначе крошки над папкой
 * вели бы в папку, которую читателю не видно, а папка группы Б показывала бы
 * вложенную полку группы А тем, кому методики А не положены.
 */
surveyFolderRoutes.post("/", requirePermission("surveys.edit"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, surveyFolderInputSchema);
  await assertGroupAccess(user, input.groupId);

  if (input.parentId) {
    const parent = await assertSurveyFolderAccess(user, input.parentId);
    if (parent.groupId !== input.groupId) badRequest("err.surveyFolderOtherGroup");
  }

  const [row] = await db
    .insert(surveyFolders)
    .values({
      id: crypto.randomUUID(),
      groupId: input.groupId,
      parentId: input.parentId ?? null,
      title: input.title,
      // без даты остаётся умолчание базы — сегодня
      ...(input.startsOn !== undefined && { startsOn: input.startsOn }),
      position: input.position ?? 0,
      createdBy: user.id,
    })
    .returning();

  await audit(c, {
    action: "survey_folder.create",
    resourceType: "survey_folder",
    resourceId: row!.id,
    details: { title: row!.title, groupId: row!.groupId, parentId: row!.parentId },
  });
  return c.json(row, 201);
});

/**
 * Есть ли `candidate` среди потомков `rootId` — на любой глубине.
 *
 * Обход в базе рекурсивным запросом, а не в приложении по загруженному
 * списку: список пришлось бы грузить целиком на каждую правку, а правило
 * жило бы в двух местах — здесь и в клиенте, который строит дерево.
 */
async function isDescendant(rootId: string, candidate: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    with recursive below as (
      select id from survey_folders where parent_id = ${rootId}
      union all
      select f.id from survey_folders f join below b on f.parent_id = b.id
    )
    select id from below where id = ${candidate} limit 1
  `);
  return [...rows].length > 0;
}

/**
 * Правка названия, даты, места и родителя.
 *
 * Родителя нельзя выбрать среди собственных потомков: «2023» внутри «лютий
 * 2023», который внутри «2023», — кольцо, и крошки по нему ходили бы
 * бесконечно. Само в себя запрещает ещё и база (CHECK в миграции 0080),
 * длинные кольца — только обход здесь.
 *
 * Обе папки на время проверки заперты (FOR UPDATE, в порядке
 * идентификаторов, чтобы два встречных переноса не заклинили друг друга
 * насмерть). Без замка две одновременные правки «А в Б» и «Б в А» каждая
 * увидели бы, что кольца нет, — и получили бы его вдвоём: под READ COMMITTED
 * чужая незакоммиченная строка невидима. С замком вторая ждёт первую и
 * проверяет уже по её итогу.
 */
surveyFolderRoutes.patch("/:id", requirePermission("surveys.edit"), async (c) => {
  const user = c.get("user");
  const folder = await assertSurveyFolderAccess(user, c.req.param("id"));
  const input = await parseBody(c.req.raw, surveyFolderUpdateSchema);

  if (input.parentId) {
    if (input.parentId === folder.id) badRequest("err.surveyFolderCycle");
    const parent = await assertSurveyFolderAccess(user, input.parentId);
    if (parent.groupId !== folder.groupId) badRequest("err.surveyFolderOtherGroup");
    await db.execute(
      sql`select id from survey_folders where id in (${folder.id}, ${parent.id}) order by id for update`,
    );
    if (await isDescendant(folder.id, parent.id)) badRequest("err.surveyFolderCycle");
  }

  const changes = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.startsOn !== undefined && { startsOn: input.startsOn }),
    ...(input.parentId !== undefined && { parentId: input.parentId ?? null }),
    ...(input.position !== undefined && { position: input.position }),
  };
  // пустое тело — не ошибка и не пустой UPDATE (drizzle на нём падает)
  if (Object.keys(changes).length === 0) return c.json(folder);

  const [row] = await db
    .update(surveyFolders)
    .set(changes)
    .where(eq(surveyFolders.id, folder.id))
    .returning();

  await audit(c, {
    action: "survey_folder.update",
    resourceType: "survey_folder",
    resourceId: folder.id,
    details: { fields: Object.keys(changes), parentId: row!.parentId },
  });
  return c.json(row);
});

/**
 * Удалить пустую папку.
 *
 * Непустой отказываем и называем, что внутри: методики — в том числе снятые
 * с использования, они по-прежнему лежат в ней, — и вложенные папки.
 * Удалить с содержимым, сбросив методики в корень, было бы проще и хуже: на
 * экране это «папка исчезла, методики остались», и в каталоге на триста
 * методик найти рассыпавшиеся из «лютого 2023» уже некому. База страхует
 * то же самое (RESTRICT на вложенных, SET NULL на методиках), но отказ
 * оттуда — пятисотка без объяснения, а отсюда — фраза с числами.
 */
surveyFolderRoutes.delete("/:id", requirePermission("surveys.edit"), async (c) => {
  const user = c.get("user");
  const folder = await assertSurveyFolderAccess(user, c.req.param("id"));

  const [counts] = await db
    .select({
      surveys: sql<number>`(select count(*)::int from surveys where folder_id = ${folder.id})`,
      children: sql<number>`(select count(*)::int from survey_folders where parent_id = ${folder.id})`,
    })
    .from(sql`(select 1) as _`);

  const inside: string[] = [];
  if (counts?.surveys) inside.push(`методик: ${counts.surveys}`);
  if (counts?.children) inside.push(`папок: ${counts.children}`);
  if (inside.length) badRequest("err.surveyFolderNotEmpty", { details: inside.join(", ") });

  await db.delete(surveyFolders).where(eq(surveyFolders.id, folder.id));
  await audit(c, {
    action: "survey_folder.delete",
    resourceType: "survey_folder",
    resourceId: folder.id,
    details: { title: folder.title, groupId: folder.groupId },
  });
  return c.body(null, 204);
});
