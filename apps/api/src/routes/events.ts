import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { surveys } from "../db/schema";
import { subscribe, type AppEvent } from "../lib/events";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const eventRoutes = new Hono<AppEnv>();
eventRoutes.use("*", requireAuth, requireStaff);

/**
 * Поток событий для консоли.
 *
 * Server-Sent Events, а не веб-сокеты: поток односторонний, переподключение
 * встроено в браузер, и он проходит через прокси, которые режут апгрейд
 * соединения. Веб-сокеты понадобятся только для совместного редактирования —
 * тогда и появятся, отдельно.
 *
 * Права проверяются на каждое событие, а не при подписке: зона
 * ответственности сотрудника может измениться посреди смены, и подписка,
 * выданная авансом, пережила бы это изменение.
 */
eventRoutes.get("/", async (c) => {
  const user = c.get("user");

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const allowed = new Set(scoped.map((s) => s.id));

  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    const unsubscribe = await subscribe((event: AppEvent) => {
      if (!alive) return;
      // событие без методики (системное) видно всем сотрудникам
      if (event.surveyId && !allowed.has(event.surveyId)) return;
      void stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
    });

    // первое сообщение сразу: клиент понимает, что канал живой, а прокси —
    // что ответ начался и его не надо буферизовать
    await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: new Date().toISOString() }) });

    try {
      /*
       * Пульс раз в двадцать пять секунд. Прокси и балансировщики закрывают
       * соединение, в котором долго ничего не шло, а тревог может не быть
       * часами — и тогда канал молча умирает именно в спокойное время.
       */
      while (alive) {
        await stream.sleep(25_000);
        if (!alive) break;
        await stream.writeSSE({ event: "ping", data: "1" });
      }
    } finally {
      unsubscribe();
    }
  });
});
