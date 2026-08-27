import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { baseDb, db } from "../db";
import { withDbContext } from "../db/context";
import { users } from "../db/schema";
import { readToken, toPublicUser } from "../lib/auth";
import { forbidden, unauthorized } from "../lib/http";
import { audit } from "../lib/audit";
import type { User } from "@quizzy/shared";

export interface AppEnv {
  Variables: {
    user: User;
    /** Сквозной идентификатор запроса — ставится первым middleware */
    requestId: string;
  };
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) unauthorized();

  const claims = await readToken(header.slice("Bearer ".length).trim());
  if (!claims) unauthorized("Токен недействителен или истёк");

  const row = await db.query.users.findFirst({ where: eq(users.id, claims.sub) });
  if (!row) unauthorized("Пользователь не найден");

  c.set("user", toPublicUser(row));

  /*
   * Учётная запись «только просмотр» останавливается здесь, а не отдельным
   * middleware: отдельный пришлось бы помнить подключать к каждому новому
   * набору маршрутов, и однажды кто-то забыл бы. Проверяется метод запроса,
   * а не список эндпоинтов, — по той же причине: перечень безопасных
   * маршрутов устаревает с каждой новой возможностью.
   *
   * Отказ пишется в журнал: демонстрационная учётка, вдруг начавшая ломиться
   * в запись, — это либо ошибка в интерфейсе, либо чужие руки.
   */
  if (row.readOnly && c.req.method !== "GET" && c.req.method !== "HEAD") {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "route",
      resourceId: c.req.path,
      details: { method: c.req.method, reason: "read_only_account" },
    });
    forbidden("Учётная запись работает только на просмотр");
  }

  /*
   * Дальше запрос живёт в транзакции с app.user_id/app.role: RLS-политики
   * видят, кто работает. Ошибка обработчика откатывает транзакцию целиком —
   * для записи это правильнее прежней семантики, а не опаснее.
   */
  await withDbContext(baseDb, { userId: row.id, role: row.role }, () => next());
});

/** Доступ для персонала: администратор группы или суперадмин */
export const requireStaff = createMiddleware<AppEnv>(async (c, next) => {
  const role = c.get("user").role;
  if (role !== "admin" && role !== "superadmin") {
    // попытка обычного пользователя дотянуться до данных персонала — событие журнала
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "route",
      resourceId: c.req.path,
      details: { method: c.req.method, reason: "staff_required" },
    });
    forbidden("Доступно только сотрудникам");
  }
  await next();
});

/** Доступ только суперадмину: управление группами, админами и учётными записями */
export const requireSuperadmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "superadmin") {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "route",
      resourceId: c.req.path,
      details: { method: c.req.method, reason: "superadmin_required" },
    });
    forbidden("Доступно только суперадминистратору");
  }
  await next();
});
