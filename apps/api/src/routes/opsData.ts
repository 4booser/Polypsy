import { Hono } from "hono";
import { z } from "zod";
import { screenViewsSchema } from "@quizzy/shared";
import { asSystem } from "../db/context";
import { audit } from "../lib/audit";
import { runDataChecks } from "../lib/dataChecks";
import { langOf, parseBody, parseQuery } from "../lib/http";
import { mobileReport, pushReport, recordScreenViews, usageReport } from "../lib/opsData";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Техпанель, группа «Дані й продукт»: качество данных, использование,
 * мобильное приложение, пуш-уведомления.
 *
 * Право — ops.read, рядом со старой проверкой персонала: смотреть, как
 * работает система, и ничего в ней не менять. Действий здесь нет вовсе —
 * проверки качества называют несостыковки, но ничего не чинят (клиническое
 * не исправляется молча, см. lib/dataChecks.ts).
 *
 * ═══ Почему под asSystem ═══
 *
 * Числа техпанели — про всю систему. Прочитай их в зоне ответственности
 * смотрящего (политики строк, lib/scope.ts), и администратор группы с
 * выданным ops.read увидел бы «брошенных прохождений: 3» по своим методикам
 * и решил бы, что это вся база; суперадмин — другое число о том же.
 * Инструмент, чьи показания зависят от того, кто на него смотрит, врёт.
 *
 * Обход зоны ответственности здесь безопасен по устройству ответа, а не по
 * доверию: наружу выходят только счёты, голые идентификаторы прохождений и
 * методик и названия методик. Ни имени, ни ответа, ни балла; по ссылке из
 * примера человек попадает на обычный экран, где его права проверят заново.
 *
 * Каждое чтение — строка журнала (ops.data_read): это агрегаты по людям и
 * идентификаторы клинических записей, и «кто и когда смотрел» здесь такой
 * же вопрос, как у аналитики.
 */
export const opsDataRoutes = new Hono<AppEnv>();
opsDataRoutes.use("*", requireAuth, requireStaff, requirePermission("ops.read"));

/** Окно — одно из трёх: панель сравнивает окна между собой, и произвольное число ей ни к чему */
const windowQuery = (fallback: 7 | 30 | 90) =>
  z.object({
    days: z.coerce
      .number()
      .int()
      .refine((v) => v === 7 || v === 30 || v === 90, { message: "days: 7, 30 or 90" })
      .default(fallback),
  });

opsDataRoutes.get("/quality", async (c) => {
  const checks = await asSystem(() => runDataChecks(langOf(c)));
  await audit(c, {
    action: "ops.data_read",
    resourceType: "ops",
    resourceId: "quality",
    details: { fired: checks.filter((x) => x.count > 0).map((x) => x.key) },
  });
  return c.json({ checkedAt: new Date().toISOString(), checks });
});

opsDataRoutes.get("/usage", async (c) => {
  const { days } = parseQuery(c, windowQuery(30));
  const report = await asSystem(() => usageReport(days));
  await audit(c, { action: "ops.data_read", resourceType: "ops", resourceId: "usage", details: { days } });
  return c.json(report);
});

opsDataRoutes.get("/mobile", async (c) => {
  const { days } = parseQuery(c, windowQuery(90));
  const report = await asSystem(() => mobileReport(days));
  await audit(c, { action: "ops.data_read", resourceType: "ops", resourceId: "mobile", details: { days } });
  return c.json(report);
});

opsDataRoutes.get("/push", async (c) => {
  const { days } = parseQuery(c, windowQuery(30));
  const report = await asSystem(() => pushReport(days));
  await audit(c, { action: "ops.data_read", resourceType: "ops", resourceId: "push", details: { days } });
  return c.json(report);
});

/**
 * Приём счётчиков открытия экранов.
 *
 * Отдельным набором и отдельным путём, а не под /api/ops: пишут сюда все,
 * кто вошёл, — сотрудник из консоли, пациент из кабинета и из приложения, —
 * а под /api/ops всё закрыто правом ops.read. Пациенту это право не
 * выдаётся никогда, и его экраны не считались бы вовсе.
 *
 * Проверка формы — схемой из shared (isRouteTemplate): шаблон маршрута, а не
 * адрес, и никаких полей сверх перечисленных. Запись — под asSystem: таблица
 * закрыта политикой строк для всех, кроме системы, чтобы писать в неё можно
 * было только через эту проверку.
 *
 * В журнал не пишется. Журнал — хэш-цепочка, где каждая строка что-то
 * значит; строка на каждую пачку счётчиков утопила бы в нём чтения карт.
 * Сами счётчики ни о ком ничего не говорят — записывать тут нечего.
 */
export const usageRoutes = new Hono<AppEnv>();
usageRoutes.use("*", requireAuth);

usageRoutes.post("/screens", async (c) => {
  const input = await parseBody(c.req.raw, screenViewsSchema);
  const routes = await asSystem(() => recordScreenViews(input));
  return c.json({ ok: true, routes });
});
