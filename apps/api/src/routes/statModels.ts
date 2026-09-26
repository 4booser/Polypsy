import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  statModelInputSchema,
  statModelListQuery,
  statModelRunSchema,
  statModelUpdateSchema,
  type StatModel,
  type StatModelListItem,
  type StatModelListPage,
  type StatRunColumn,
  type StatRunResult,
} from "@quizzy/shared";
import { db } from "../db";
import { statModels } from "../db/schema";
import { audit } from "../lib/audit";
import { langOf, parseBody, parseQuery } from "../lib/http";
import { SMALL_CELL_FLOOR } from "../lib/privacy";
import { assertStatModelAccess, isSuperadmin } from "../lib/scope";
import { resolveColumns, runColumns } from "../lib/statModels";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Статистические модели — раздел «Статистика» (кадры f06, f07, f14, f21,
 * f26, f28).
 *
 * Модель — название, короткое описание и колонки-выборки: у каждой свои
 * фильтры (или пресет), своя методика с версией и показатели — полосы
 * результата и варианты ответа на выбранные вопросы, каждый с пометкой
 * «ВШР». «Порівняти» считает по колонкам и ставит их рядом; «Оновити» на
 * экране «Статистика» — то же по сохранённой модели.
 *
 * Не путать с /api/analytics (методика целиком: распределения,
 * психометрика, качество данных) и с /api/cohorts (правило отбора,
 * умеющее отдать людей поимённо). Статистика имён не отдаёт никогда —
 * только доли с подавлением малых ячеек, и это устройство, а не
 * договорённость: у маршрутов ниже нет ни одного ответа с именем.
 *
 * Модель личная, как пресет и группа пациентов: видит и правит владелец,
 * суперадмин — всё; чужая отвечает «не найдено». Право — statistics.read
 * на весь набор, включая расчёт: расчёт и есть то, ради чего право
 * выдают, а модель без расчёта — набор ссылок.
 */
export const statModelRoutes = new Hono<AppEnv>();

statModelRoutes.use("*", requireAuth, requireStaff, requirePermission("statistics.read"));

function toModel(row: typeof statModels.$inferSelect): StatModel {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerId: row.ownerId,
    columns: row.columns,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * След расчёта в журнале: по каждой колонке — методика, версия, пресет,
 * ФАКТИЧЕСКИЕ фильтры и размер выборки без подавления.
 *
 * Фильтры обязательны, и именно применённые, а не ссылка на пресет.
 * Проверка восстановимости закрывает утечки внутри ОДНОГО ответа;
 * композицию РАЗНЫХ запросов («сегодня Київ, завтра Київ без групи») она
 * не видит по построению, и закрывается она журналом: разбор должен
 * увидеть, как фильтры сжимали выборку от запроса к запросу. Пресет правят
 * задним числом, поэтому ссылка на него в журнале показала бы сегодняшний
 * срез вместо того, что был посчитан.
 *
 * Отвергнуто: маскировать шумом. Шум в долях портит клинический отчёт
 * каждому читателю ради одного злоумышленника, а против усреднения
 * повторных запросов всё равно нужен счётчик — то есть тот же журнал.
 */
function runTrail(columns: StatRunColumn[], sizes: number[]) {
  return columns.map((col, i) => ({
    surveyId: col.surveyId,
    versionId: col.versionId,
    presetId: col.presetId,
    filters: col.filters,
    size: sizes[i],
  }));
}

/**
 * Перечень моделей (кадр f06): поиск по названию и описанию, страницы —
 * как у каталога методик: без ?limit= весь список (экран «Статистика» на
 * f26 выбирает модель из списка и о страницах знать не должен), с ним —
 * страница и total по тем же условиям.
 *
 * Колонки в перечень не входят: в строке списка стоят название и описание,
 * а колонки нужны только на экране модели.
 */
statModelRoutes.get("/", async (c) => {
  const user = c.get("user");
  const query = parseQuery(c, statModelListQuery);

  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const where = and(
    isSuperadmin(user) ? undefined : eq(statModels.ownerId, user.id),
    pattern
      ? sql`(${statModels.title} ilike ${pattern} escape '\\'
          or coalesce(${statModels.description}, '') ilike ${pattern} escape '\\')`
      : undefined,
  );

  const listing = db
    .select({
      id: statModels.id,
      title: statModels.title,
      description: statModels.description,
      ownerId: statModels.ownerId,
      columnCount: sql<number>`jsonb_array_length(${statModels.columns})`,
      createdAt: statModels.createdAt,
      updatedAt: statModels.updatedAt,
    })
    .from(statModels)
    .where(where)
    // свежие выше, идентификатор вторым ключом — ради страниц: посев кладёт
    // модели одной секундой, и без него одна могла бы попасть на две страницы
    .orderBy(desc(statModels.createdAt), desc(statModels.id))
    .$dynamic();
  const rows = await (query.limit === undefined ? listing : listing.limit(query.limit).offset(query.offset));

  // total — вторым запросом и только когда просили страницу, как у методик
  const total =
    query.limit === undefined
      ? rows.length
      : Number((await db.select({ n: sql<number>`count(*)::int` }).from(statModels).where(where))[0]?.n ?? 0);

  const items: StatModelListItem[] = rows.map((r) => ({ ...r, columnCount: Number(r.columnCount ?? 0) }));
  return c.json({ items, total } satisfies StatModelListPage);
});

/**
 * «Створити»: колонки проверяются и нормализуются до записи — версия
 * методики записывается, показатели сверяются с её содержимым, чужой
 * пресет или чужая группа в фильтрах отвечают «не найдено». Модель, которая
 * сохранилась, но не считается, — хуже отказа.
 */
statModelRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, statModelInputSchema);
  const columns = await resolveColumns(user, input.columns);

  const [row] = await db
    .insert(statModels)
    .values({
      id: crypto.randomUUID(),
      ownerId: user.id,
      title: input.title,
      description: input.description ?? null,
      columns,
    })
    .returning();

  await audit(c, {
    action: "stat_model.create",
    resourceType: "stat_model",
    resourceId: row!.id,
    details: { title: row!.title, columns: columns.length, surveys: [...new Set(columns.map((x) => x.surveyId))] },
  });
  return c.json(toModel(row!), 201);
});

/**
 * «Порівняти» до «Створити»: расчёт по колонкам с формы, без сохранения.
 *
 * Свой адрес, а не флаг у POST /: сохранение и расчёт — разные действия с
 * разными записями в журнале, и «сохранил, потому что хотел посмотреть»
 * не должно случаться.
 */
statModelRoutes.post("/run", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, statModelRunSchema);
  const columns = await resolveColumns(user, input.columns);
  const { columns: result, sizes } = await runColumns(user, columns, langOf(c));

  await audit(c, { action: "stat_model.run", details: { preview: true, columns: runTrail(result, sizes) } });
  return c.json({
    modelId: null,
    title: input.title ?? "",
    ranAt: new Date().toISOString(),
    smallCellFloor: SMALL_CELL_FLOOR,
    columns: result,
  } satisfies StatRunResult);
});

statModelRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const row = await assertStatModelAccess(user, c.req.param("id"));
  return c.json(toModel(row));
});

/**
 * Правка названия, описания и колонок. Колонки заменяются целиком: экран
 * конструктора сохраняет всю форму одной кнопкой, и слияние по частям
 * вернуло бы убранную «—» колонку назад.
 */
statModelRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const model = await assertStatModelAccess(user, c.req.param("id"));
  const input = await parseBody(c.req.raw, statModelUpdateSchema);

  const changes = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description ?? null }),
    ...(input.columns !== undefined && { columns: await resolveColumns(user, input.columns) }),
  };
  if (Object.keys(changes).length === 0) return c.json(toModel(model));

  const [row] = await db
    .update(statModels)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(statModels.id, model.id))
    .returning();

  await audit(c, {
    action: "stat_model.update",
    resourceType: "stat_model",
    resourceId: model.id,
    details: { fields: Object.keys(changes) },
  });
  return c.json(toModel(row!));
});

/**
 * Удалить модель. Ничего не тянет за собой: пресеты остаются — на них
 * могут ссылаться другие модели, а прохождения к модели не привязаны вовсе.
 */
statModelRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const model = await assertStatModelAccess(user, c.req.param("id"));

  await db.delete(statModels).where(eq(statModels.id, model.id));
  await audit(c, {
    action: "stat_model.delete",
    resourceType: "stat_model",
    resourceId: model.id,
    details: { title: model.title },
  });
  return c.body(null, 204);
});

/**
 * «Оновити»: расчёт по сохранённой модели.
 *
 * Результат не сохраняется — считается заново каждый раз. Снимок отчёта
 * означал бы хранить распределения по людям, которые устаревают с каждым
 * прохождением и переживают передачу группы или перевод методики; а
 * стоимость расчёта — несколько запросов на колонку.
 */
statModelRoutes.post("/:id/run", async (c) => {
  const user = c.get("user");
  const model = await assertStatModelAccess(user, c.req.param("id"));
  const { columns, sizes } = await runColumns(user, model.columns, langOf(c));

  await audit(c, {
    action: "stat_model.run",
    resourceType: "stat_model",
    resourceId: model.id,
    details: { columns: runTrail(columns, sizes) },
  });
  return c.json({
    modelId: model.id,
    title: model.title,
    ranAt: new Date().toISOString(),
    smallCellFloor: SMALL_CELL_FLOOR,
    columns,
  } satisfies StatRunResult);
});
