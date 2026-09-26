import { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  filterPresetInputSchema,
  filterPresetListQuery,
  filterPresetUpdateSchema,
  type FilterPreset,
  type FilterPresetListItem,
} from "@quizzy/shared";
import { db } from "../db";
import { filterPresets } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, parseBody, parseQuery } from "../lib/http";
import { assertFilterPresetAccess, isSuperadmin } from "../lib/scope";
import { assertFilterRefs } from "../lib/statModels";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Пресеты фильтров выборки — «Створення фільтра» и «Пресети фільтрів»
 * (кадр f25).
 *
 * Пресет — именованный набор строк-критериев (дата, пациент, возраст
 * от–до, пол, населённый пункт, группа пациентов), который колонка
 * статистической модели берёт по ссылке вместо собственных фильтров. Один
 * срез нужен многим моделям, и правка среза обязана доходить до всех.
 *
 * Пресет личный, как группа пациентов: видит и правит владелец, суперадмин
 * — всё. Не отделение и не группа методик: срез выражает вопрос одного
 * аналитика, а коллега прочитал бы его как принятый в отделении
 * (подробнее — миграция 0085).
 *
 * Права: statistics.read на весь набор. Пресет без модели ничего не
 * считает и ничего не показывает, а модель закрыта тем же правом; второе
 * право «на фильтры» выдавали бы вместе с первым в первый же день.
 */
export const filterPresetRoutes = new Hono<AppEnv>();

filterPresetRoutes.use("*", requireAuth, requireStaff, requirePermission("statistics.read"));

/** Сколько моделей ссылаются на пресет — экран показывает это до нажатия «—» */
const modelCount = sql<number>`(select count(*)::int from stat_models m
  where exists (select 1 from jsonb_array_elements(m.columns) c
                 where c->>'presetId' = "filter_presets"."id"))`;

function toItem(row: typeof filterPresets.$inferSelect, count: number): FilterPresetListItem {
  return { ...toPreset(row), modelCount: Number(count ?? 0) };
}

function toPreset(row: typeof filterPresets.$inferSelect): FilterPreset {
  return {
    id: row.id,
    title: row.title,
    criteria: row.criteria,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Свои пресеты; ?q= — поиск по названию. Страниц нет: у одного человека их
 * десятки, не тысячи, а «Пресети фільтрів» на макете — сетка без пейджера.
 *
 * Чужих в выдаче нет вовсе — условие по владельцу стоит в запросе, а не
 * отфильтровано после. Суперадмин видит все: разбирать чужие экраны ему
 * больше нечем.
 */
filterPresetRoutes.get("/", async (c) => {
  const user = c.get("user");
  const query = parseQuery(c, filterPresetListQuery);

  // подстановочные знаки экранируются: «100%» в запросе — это проценты
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const rows = await db
    .select({ row: filterPresets, modelCount })
    .from(filterPresets)
    .where(
      and(
        isSuperadmin(user) ? undefined : eq(filterPresets.ownerId, user.id),
        pattern ? sql`${filterPresets.title} ilike ${pattern} escape '\\'` : undefined,
      ),
    )
    // в порядке заведения: сетка пресетов не должна перестраиваться от правки
    .orderBy(asc(filterPresets.createdAt), asc(filterPresets.id));

  return c.json({ items: rows.map((r) => toItem(r.row, r.modelCount)) });
});

/**
 * «Зберегти» на экране «Створення фільтра».
 *
 * Ссылки внутри критериев проверяются при сохранении, а не только при
 * расчёте: чужая группа в пресете — «не найдено» сразу, а не через неделю
 * при первом «Оновити», когда уже непонятно, откуда она там.
 */
filterPresetRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, filterPresetInputSchema);
  await assertFilterRefs(user, input.criteria);

  const [row] = await db
    .insert(filterPresets)
    .values({ id: crypto.randomUUID(), ownerId: user.id, title: input.title, criteria: input.criteria })
    .returning();

  await audit(c, {
    action: "filter_preset.create",
    resourceType: "filter_preset",
    resourceId: row!.id,
    details: { title: row!.title, criteria: Object.keys(input.criteria) },
  });
  return c.json(toPreset(row!), 201);
});

filterPresetRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const row = await assertFilterPresetAccess(user, c.req.param("id"));
  const [count] = await db.select({ modelCount }).from(filterPresets).where(eq(filterPresets.id, row.id));
  return c.json(toItem(row, count?.modelCount ?? 0));
});

/**
 * Правка названия и критериев. Критерии заменяются целиком, а не
 * сливаются: «—» на макете убирает строку, и слияние вернуло бы её назад.
 * Владельца сменить нельзя — его нет во входной схеме, и это решение, как
 * у групп пациентов.
 */
filterPresetRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const preset = await assertFilterPresetAccess(user, c.req.param("id"));
  const input = await parseBody(c.req.raw, filterPresetUpdateSchema);
  if (input.criteria) await assertFilterRefs(user, input.criteria);

  const changes = {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.criteria !== undefined && { criteria: input.criteria }),
  };
  // пустое тело — не ошибка и не пустой UPDATE (drizzle на нём падает)
  if (Object.keys(changes).length === 0) return c.json(toPreset(preset));

  const [row] = await db
    .update(filterPresets)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(filterPresets.id, preset.id))
    .returning();

  await audit(c, {
    action: "filter_preset.update",
    resourceType: "filter_preset",
    resourceId: preset.id,
    details: { fields: Object.keys(changes) },
  });
  return c.json(toPreset(row!));
});

/**
 * Удалить пресет, на который никто не ссылается.
 *
 * Занятому отказываем и называем число моделей. Удалить с отвязкой было
 * бы проще и хуже: колонка, потерявшая пресет, молча стала бы «вся
 * выборка», и модель «чоловіки 25–45 проти жінок» превратилась бы в «усі
 * проти жінок» без единого признака на экране.
 */
filterPresetRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const preset = await assertFilterPresetAccess(user, c.req.param("id"));

  const [count] = await db.select({ modelCount }).from(filterPresets).where(eq(filterPresets.id, preset.id));
  const used = Number(count?.modelCount ?? 0);
  if (used > 0) badRequest("err.filterPresetInUse", { count: used });

  await db.delete(filterPresets).where(eq(filterPresets.id, preset.id));
  await audit(c, {
    action: "filter_preset.delete",
    resourceType: "filter_preset",
    resourceId: preset.id,
    details: { title: preset.title },
  });
  return c.body(null, 204);
});
