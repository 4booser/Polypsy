import { AsyncLocalStorage } from "node:async_hooks";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { baseDb, db } from "../db";
import { dbContext, withDbContext } from "../db/context";
import { surveys } from "../db/schema";
import { subscribe, type AppEvent } from "../lib/events";
import { log } from "../lib/log";
import { isSuperadmin, patientsInScope, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const eventRoutes = new Hono<AppEnv>();

/** Пульс и перечитывание зоны доступа; тесты укорачивают, чтобы не ждать по 25 секунд */
export const eventStreamTiming = { pulseMs: 25_000 };
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
 * выданная авансом, пережила бы это изменение. Зона по методикам
 * перечитывается с каждым пульсом; о человеке база спрашивается, когда о нём
 * пришло событие, и ответ живёт до следующего пульса.
 */
eventRoutes.get("/", async (c) => {
  const user = c.get("user");
  /* контекст строк этого сотрудника — тот же, что ставит requireAuth */
  const identity = { userId: user.id, role: user.role };

  async function readScope(): Promise<Set<string>> {
    const scope = await surveyScopeFilter(user);
    const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
    return new Set(scoped.map((s) => s.id));
  }

  /* первое чтение — ещё в транзакции запроса: она жива, пока обработчик не вернул ответ */
  let allowed = await readScope();

  /**
   * Вправе ли сотрудник видеть этого человека.
   *
   * Нужна отдельно от зоны по методикам: событие общего потока «action»
   * относится не к методике, а к человеку, и сузить его по методикам нечем.
   *
   * Вопросом о человеке, о котором пришло событие, а не списком всей зоны
   * (#181). Список строился при открытии вкладки и заново с каждым пульсом:
   * на учреждении в пять тысяч пациентов — секунды и соединение пула на
   * вкладку каждые двадцать пять секунд. Шестьдесят открытых консолей
   * держали занятыми все десять соединений, и лёгкий запрос ждал минуту.
   * События о людях без методики редки, поэтому база спрашивается о
   * человеке, когда о нём пришло событие, — своей короткой транзакцией, как
   * перечитывание ниже, — а ответ помнится до следующего пульса: отзыв
   * доступа доходит до потока в прежний срок.
   */
  let decided = new Map<string, boolean>();
  async function maySee(patientId: string): Promise<boolean> {
    if (isSuperadmin(user)) return true;
    const memo = decided;
    const known = memo.get(patientId);
    if (known !== undefined) return known;
    const visible = await withDbContext(baseDb, identity, () => patientsInScope(user, [patientId]));
    const ok = visible === null || visible.has(patientId);
    memo.set(patientId, ok);
    return ok;
  }

  /*
   * Перечитывание зоны — каждый раз своей короткой транзакцией с контекстом
   * строк сотрудника (внешний разбор 2026-09-26).
   *
   * streamSSE отдаёт ответ раньше, чем кончается колбэк потока, и
   * транзакция авторизации коммитится сразу после ответа. Колбэк же
   * унаследовал её в хранилище контекста и продолжал перечитывать зону
   * через неё — через завершённую транзакцию, соединение которой уже
   * вернулось в пул. Запросы при этом проходили (проверено: пульс шёл, ни
   * одной ошибки), то есть исполнялись на соединении, которое в этот
   * момент мог держать кто угодно, — без гарантии, что под ним стоит
   * контекст этого сотрудника, а не чужой или никакой.
   *
   * Держать одну транзакцию на весь поток — не выход: поток живёт часами,
   * а соединений в пуле десять (db/index.ts). Короткая транзакция на
   * каждое перечитывание стоит одно соединение на миллисекунды раз в
   * двадцать пять секунд.
   */
  const reread = () => withDbContext(baseDb, identity, readScope);

  /*
   * Колбэк потока — вне хранилища контекста запроса (dbContext.exit): всё,
   * что в нём пойдёт в базу мимо reread, уйдёт без контекста, и политики
   * строк ответят пустотой, а не молча исполнят запрос на чужом
   * соединении. Второй замок на тот же случай: забытый reread должен
   * ломаться заметно.
   */
  return streamSSE(c, (stream) => dbContext.exit(() => pump(stream)));

  async function pump(stream: Parameters<Parameters<typeof streamSSE>[1]>[0]): Promise<void> {
    let alive = true;
    stream.onAbort(() => {
      alive = false;
    });

    /*
     * Доставка — по очереди и в контексте потока.
     *
     * Проверка человека идёт в базу, и событие, ждущее ответа, не должно
     * пропускать вперёд следующее: консоль читает поток по порядку. А
     * обработчик шины зовётся из чужого контекста — того, где открыт LISTEN,
     * — поэтому доставка возвращается в контекст потока: тот же пул, что у
     * перечитывания зоны.
     */
    const inStream = AsyncLocalStorage.snapshot();
    let line: Promise<void> = Promise.resolve();
    const unsubscribe = await subscribe((event: AppEvent) => {
      if (!alive) return;
      line = line
        .then(() => inStream(() => deliver(event)))
        .catch((error: unknown) => log.warn("events.deliver_failed", { error: String(error) }));
    });

    async function deliver(event: AppEvent): Promise<void> {
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
      if (!event.surveyIds && event.userId && !(await maySee(event.userId))) return;
      if (!alive) return;
      await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) });
    }

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
        await stream.sleep(eventStreamTiming.pulseMs);
        if (!alive) break;
        /*
         * Заодно перечитываем зону ответственности — методики заново, а
         * ответы о людях забываем. Смена длится часами, а доступ к методике
         * или к человеку могут отозвать посреди неё; подписка, выданная
         * авансом при открытии вкладки, пережила бы этот отзыв. Людей раньше
         * не перечитывали вовсе (внешний разбор 2026-09-26): события общего
         * потока «action» о человеке, к которому доступ уже отозван, шли до
         * переподключения.
         */
        allowed = await reread();
        decided = new Map();
        await stream.writeSSE({ event: "ping", data: "1" });
      }
    } finally {
      unsubscribe();
    }
  }
});
