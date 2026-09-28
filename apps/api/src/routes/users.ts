import { Hono, type Context } from "hono";
import { and, desc, eq, ne } from "drizzle-orm";
import {
  createUserSchema,
  staffDirectoryQuery,
  userListQuery,
  type Page,
  type StaffDirectoryUser,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { audit } from "../lib/audit";
import { afterCursor, decodeExactCursor, encodeCursor, exactAt } from "../lib/cursor";
import { decryptField, encryptPersonFields } from "../lib/crypto";
import { hashPassword, toPublicUser } from "../lib/auth";
import { conflict, langOf, parseBody, parseQuery } from "../lib/http";
import { assertMayCreateClass, changeAccountClass } from "../lib/accountClass";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { ensureBuiltinRole } from "../lib/permissions";
import { placementsOf } from "../lib/staffDirectory";

export const userRoutes = new Hono<AppEnv>();

// учётные записи и роли — зона ответственности суперадмина
/*
 * requireSuperadmin заменён правом, а не дополнен им.
 *
 * Дополнить значило бы оставить право декоративным: маршрут всё равно
 * пускал бы одного суперадмина, и выдать users.manage кому-то ещё было бы
 * нельзя. Поведение сегодня прежнее — users.manage не входит во встроенную
 * роль, а суперадмин обходит справочник, — но право стало настоящим.
 */
userRoutes.use("*", requireAuth, requireStaff, requirePermission("users.manage"));

/**
 * Реестр учётных записей — страницами (`?limit=&cursor=`), свежие сверху.
 *
 * Прежде список отдавался целиком: каждый пациент учреждения, с
 * расшифрованным ФИО, на каждое открытие экрана групп — которому из всего
 * этого нужны были только сотрудники, и он отбрасывал остальных уже в
 * браузере. `?staff=1` отбирает сотрудников в SQL; без него — все учётки, но
 * по сотне. Справочник (`?directory=1`) — другой вопрос и прежний ответ:
 * только сотрудники, целиком, их десятки.
 */
userRoutes.get("/", async (c) => {
  const { directory } = parseQuery(c, staffDirectoryQuery);
  if (directory) return c.json({ items: await staffDirectory(c) });

  const { staff, limit, cursor: rawCursor } = parseQuery(c, userListQuery);
  const cursor = decodeExactCursor(rawCursor);
  const rows = await db
    .select({ u: users, at: exactAt(users.createdAt) })
    .from(users)
    .where(and(staff ? ne(users.role, "user") : undefined, afterCursor(users.createdAt, users.id, cursor)))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(limit + 1);

  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  await audit(c, { action: "user.list", details: { count: page.length, ...(staff ? { staff: true } : {}) } });

  const last = page[page.length - 1];
  return c.json({
    items: page.map((r) => toPublicUser(r.u)),
    nextCursor: more && last ? encodeCursor(last.at, last.u.id) : null,
  } satisfies Page<User>);
});

/**
 * Справочник сотрудников (`?directory=1`) — список «Лікарі» и
 * «Адміністратори» у того, кому открыт реестр.
 *
 * Прежде раздел брал весь реестр и отбрасывал пациентов уже в браузере: ради
 * десятка коллег сервер расшифровывал ФИО и даты рождения каждого пациента
 * учреждения и отдавал их наружу. Здесь пациентов нет вовсе — отбор в SQL.
 *
 * Телефон — расшифрованный, как в списке пациентов (решение заказчика
 * 2026-09-25, docs/REWRITE-PLAN.md §14; для сотрудников — 2026-09-26:
 * «фильтр по имени, номеру телефона и логину»). Ищет по нему экран: список
 * сотрудников отдаётся целиком, и отбор, сортировка и группы считаются там же,
 * где и значения выпадающих фильтров. Шифротекст наружу не уходит, а вопрос
 * «кто видел номера» отвечается журналом — пометкой `phones`, как у
 * access.patient_list.
 */
async function staffDirectory(c: Context<AppEnv>): Promise<StaffDirectoryUser[]> {
  const rows = await db.select().from(users).where(ne(users.role, "user")).orderBy(desc(users.createdAt));
  const placed = await placementsOf(
    rows.map((r) => r.id),
    langOf(c),
  );
  await audit(c, { action: "user.list", details: { count: rows.length, directory: true, phones: true } });
  return rows.map((r) => ({
    ...toPublicUser(r),
    phone: decryptField(r.phoneEnc),
    placement: placed.get(r.id) ?? null,
  }));
}

/** Единственный способ завести администратора или специалиста */
userRoutes.post("/", async (c) => {
  const input = await parseBody(c.req.raw, createUserSchema);
  const email = input.email.toLowerCase();
  /*
   * Суперадминистратора заводит только суперадминистратор (техпанель,
   * волна 10). users.manage выдаётся и заведующему; без этой проверки он
   * завёл бы суперадмина с паролем, который сам же и придумал, и вошёл бы
   * под ним — право вести учётки стало бы правом раздать себе всё. С волны
   * 15 правило общее со сменой класса (lib/accountClass.ts): заводят только
   * класс ниже собственного положения.
   */
  await assertMayCreateClass(c, input.role);

  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) conflict("err.emailExists");

  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email,
      ...encryptPersonFields({
        firstName: input.firstName,
        lastName: input.lastName,
        middleName: input.middleName ?? null,
      }),
      passwordHash: await hashPassword(input.password),
      role: input.role,
      /* пароль, сгенерированный техпанелью и показанный один раз, человек сменит при первом входе */
      mustChangePassword: input.mustChangePassword ?? false,
    })
    .returning();
  // администратор получает встроенную роль сразу: иначе он остался бы без
  // прав до следующего перезапуска приложения
  if (row!.role === "admin") await ensureBuiltinRole(row!.id);


  await audit(c, {
    action: "user.create",
    resourceType: "user",
    resourceId: row!.id,
    subjectUserId: row!.id,
    details: { role: row!.role, email, mustChangePassword: row!.mustChangePassword },
  });

  return c.json(toPublicUser(row!), 201);
});

/**
 * Смена класса учётной записи.
 *
 * Правило — полномочия, лестница, защищённые учётки, замок строки, обрыв
 * сессий, журнал — целиком в lib/accountClass.ts: его же зовёт команда
 * консоли `user role`. Прежде оно было записано здесь, и консоль его не
 * знала (внешний разбор 2026-09-27, п. 1): маршрут только разбирает ввод.
 */
userRoutes.patch("/:id/role", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { row } = await changeAccountClass(c, c.req.param("id"), body?.role, "http");
  return c.json(toPublicUser(row));
});
