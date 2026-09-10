import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db";
import { surveys } from "../db/schema";
import { subscribe, type AppEvent } from "../lib/events";
import { accessiblePatientIds, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const eventRoutes = new Hono<AppEnv>();
/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
eventRoutes.use("*", requireAuth, requireStaff, requirePermission("alerts.review"));

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

  async function readScope(): Promise<Set<string>> {
    const scope = await surveyScopeFilter(user);
    const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
    return new Set(scoped.map((s) => s.id));
  }

  /**
   * Кого этот сотрудник вправе видеть.
   *
   * Нужна отдельно от зоны по методикам: событие общего потока «action»
   * относится не к методике, а к человеку, и сузить его по методикам нечем.
   * `null` — суперадмин, видит всех.
   */
  async function readPatients(): Promise<Set<string> | null> {
    return accessiblePatientIds(user);
  }

  let allowed = await readScope();
  let patients = await readPatients();

  return streamSSE(c, async (stream) => {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    const unsubscribe = await subscribe((event: AppEvent) => {
      if (!alive) return;
      // событие без методик (системное) видно всем сотрудникам
      if (event.surveyIds && !event.surveyIds.some((id) => allowed.has(id))) return;
      /*
       * Событие БЕЗ методики, но о человеке, — только тому, кто вправе
       * видеть человека.
       *
       * У событий с методикой правило своё и достаточное: зона по методикам,
       * условие выше. А общий поток «action» выпускается с surveyIds: null —
       * то есть проходил фильтр насквозь и шёл всем сотрудникам без разбора.
       * Комментарий рядом с его выпуском обосновывал это тем, что «имён и
       * содержимого в нём нет». Имён нет, а идентификатор пациента есть — и
       * он сообщает ровно то, что система в остальном бережёт: что с этим
       * человеком работают по риску, ставят на учёт, разбивают ради него
       * стекло. Заодно поток раздавал идентификаторы, которых у получателя
       * не было ниоткуда, — готовый вход для захвата чужой карты.
       */
      if (!event.surveyIds && event.userId && patients && !patients.has(event.userId)) return;
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
        /*
         * Заодно перечитываем зону ответственности. Смена длится часами, а
         * доступ к методике могут отозвать посреди неё; подписка, выданная
         * авансом при открытии вкладки, пережила бы это отзыв.
         */
        allowed = await readScope();
        await stream.writeSSE({ event: "ping", data: "1" });
      }
    } finally {
      unsubscribe();
    }
  });
});
