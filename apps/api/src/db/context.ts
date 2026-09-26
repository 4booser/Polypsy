import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { db as DbType } from "./index";
import { log } from "../lib/log";

/**
 * Контекст выполнения запросов к БД.
 *
 * RLS-политики читают current_setting('app.user_id'/'app.role'). Эти GUC
 * действуют на СОЕДИНЕНИЕ, а у нас пул — поэтому контекст живёт только внутри
 * транзакции (set_config(..., true) = SET LOCAL) и пробрасывается через
 * AsyncLocalStorage: любой db.* внутри охваченного участка уходит в ту же
 * транзакцию с тем же контекстом.
 *
 * Три вида контекста:
 *   — запрос аутентифицированного пользователя: его id и роль;
 *   — system: фоновые процессы (планировщик, рассыльщик, ретенция) и
 *     публичные конвейеры (киоск, регистрация) — политики дают им полный
 *     доступ, но факт «системности» явный, а не дыра по умолчанию;
 *   — отсутствие контекста: политики не дают ничего. Забытый requireAuth
 *     в новом маршруте упирается в пустые выборки, а не в чужие данные.
 */

type Tx = Parameters<Parameters<typeof DbType.transaction>[0]>[0];

export const dbContext = new AsyncLocalStorage<Tx>();

export interface RlsIdentity {
  userId: string | null;
  role: "superadmin" | "admin" | "user" | "system";
}

/** Выполнить fn в транзакции с установленным контекстом */
export async function withDbContext<T>(
  base: typeof DbType,
  identity: RlsIdentity,
  fn: () => Promise<T>,
): Promise<T> {
  return base.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${identity.userId ?? ""}, true),
                 set_config('app.role', ${identity.role}, true)`,
    );
    return dbContext.run(tx as Tx, fn);
  });
}

/** Системный контекст для фоновых процессов и публичных конвейеров */
export function systemContext<T>(base: typeof DbType, fn: () => Promise<T>): Promise<T> {
  return withDbContext(base, { userId: null, role: "system" }, fn);
}

/**
 * Выполнить fn под системной ролью, НЕ выходя из текущей транзакции.
 *
 * Для автоматики поверх действия человека: случай для дежурного
 * (alert_cases), срабатывание правила (rule_hits), каскад назначений,
 * закрытие батарей. Их таблицы закрыты пациенту политиками намеренно — ему
 * нечего видеть в очереди разбора, — но рождает эти строки именно его
 * отправка. До этого случай писался под ролью пациента, PostgreSQL отвечал
 * «new row violates row-level security policy for table "alert_cases"»,
 * транзакция запроса откатывалась целиком — и прохождение с критическим
 * пунктом, то самое, ради которого тревоги существуют, не сохранялось
 * вовсе (лог прода 2026-09-24: 500 на POST /surveys/:id/responses). Сюита
 * этого не видела: тесты ходят владельцем базы, а владелец политики обходит;
 * теперь путь прогоняется под боевой ролью (submissionRls.test.ts).
 *
 * Отвергнуто: политика «пациент вставляет случай о себе». Вставки мало —
 * открытый случай ищется и обновляется, а для этого пациент должен ВИДЕТЬ
 * свои случаи, то есть узнать, что его разбирают как риск. Отвергнут и
 * отдельный systemContext(): это другая транзакция на другом соединении —
 * случай мог закоммититься при откате прохождения, а незакоммиченная
 * строка прохождения ему не видна.
 *
 * Роль подменяется только на время fn и возвращается в finally:
 * set_config(..., true) живёт до конца транзакции, а не блока, и без
 * возврата остаток запроса шёл бы под системной ролью. Вне контекста
 * (тесты владельцем базы) и уже под системной ролью — просто fn.
 */
export async function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  const tx = dbContext.getStore();
  if (!tx) return fn();
  const [row] = (await tx.execute(sql`select current_setting('app.role', true) as role`)) as unknown as {
    role: string | null;
  }[];
  const previous = row?.role ?? "";
  if (previous === "system") return fn();
  await tx.execute(sql`select set_config('app.role', 'system', true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`select set_config('app.role', ${previous}, true)`);
  }
}

/* ─────────── Транзакция запроса и записи, которые обязаны её пережить ─────────── */

/**
 * Транзакция запроса, которую ошибочный ответ откатывает.
 *
 * Дефект, ради которого это написано (волна 12, заказчик воспроизвёл):
 * requireAuth открывал транзакцию вокруг next(), а Hono ловит исключение
 * обработчика ВНУТРИ next() — compose вызывает onError и возвращает
 * управление как ни в чём не бывало. Транзакция поэтому фиксировалась при
 * любом исходе: badRequest посреди сдачи оставлял в базе всё, что обработчик
 * успел сделать до отказа. Сдача сначала удаляет черновик, а ответы проверяет
 * потом — пациент, получивший 400 «не отвечен обязательный вопрос», терял
 * черновик вместе с ответами. Комментарий над вызовом обещал «ошибка
 * обработчика откатывает транзакцию целиком», и это было неправдой с первого
 * дня: исключение до транзакции просто не долетало.
 *
 * Поэтому решение принимается не по исключению, а по ИСХОДУ: `failed()`
 * спрашивают после next(), и неудачный ответ — статус от 400, в том числе
 * собранный onError из исключения, — откатывает транзакцию. Правило общее
 * для всех маршрутов, а не для сдачи: маршрут, который «отказывает ответом,
 * а не исключением» (opsAccounts, opsPeople, secondFactor), откатывается
 * точно так же, как бросивший.
 *
 * Отвергнуто: бросать ошибку из onError дальше. onError — общая точка
 * перевода отказа на язык читающего; заставлять его ещё и управлять
 * транзакцией значило бы, что `return c.json(…, 409)` из обработчика
 * по-прежнему коммитит. Отвергнут и откат по одному c.error: ответ 4xx без
 * исключения ничем не отличается по смыслу — запрос не выполнен.
 */
class RequestFailed extends Error {
  constructor() {
    super("request failed — transaction rolled back");
  }
}

interface RequestScope {
  /** Транзакция запроса — чтобы отличить её от вложенного systemContext */
  tx: Tx | null;
  /** Записи, которые повторяются после отката (см. durable) */
  survivors: (() => Promise<unknown>)[];
}

const requestScope = new AsyncLocalStorage<RequestScope>();

export async function withRequestContext(
  base: typeof DbType,
  identity: RlsIdentity,
  run: () => Promise<void>,
  failed: () => boolean,
): Promise<void> {
  const scope: RequestScope = { tx: null, survivors: [] };
  try {
    await requestScope.run(scope, () =>
      withDbContext(base, identity, async () => {
        scope.tx = dbContext.getStore() ?? null;
        await run();
        if (failed()) throw new RequestFailed();
      }),
    );
  } catch (err) {
    /*
     * Откат по любой причине — нашей (неудачный ответ) или чужой (исключение
     * мимо onError, сбой фиксации) — одинаково уносит и записи отказа.
     * Повторяем их в любом случае, а пробрасываем только чужое.
     */
    await replaySurvivors(base, scope.survivors);
    if (err instanceof RequestFailed) return;
    throw err;
  }
}

/**
 * Запись, которая обязана остаться, даже если запрос откатится.
 *
 * Отказ пишет след: строку журнала «доступ запрещён», отметку неудачной
 * попытки в счётчике перебора. Раньше этот след выживал случайно — вместе
 * с дефектом выше: транзакция запроса фиксировалась всегда. Маршруты,
 * которые специально «отказывали ответом, а не исключением», чтобы строка
 * журнала не откатилась, защищались от поведения, которого не было; с
 * честным откатом они потеряли бы ровно то, ради чего так написаны.
 *
 * Как устроено. Запись выполняется СРАЗУ, в текущей транзакции: остаток
 * запроса её видит, а при успехе она фиксируется вместе со всем — порядок
 * строк журнала и его хэш-цепочка те же, что прежде. Одновременно запись
 * запоминается, и если транзакция запроса откатывается, выполняется ещё
 * раз, уже после отката, своей системной транзакцией.
 *
 * Отвергнуто: писать сразу мимо транзакции запроса, отдельным соединением.
 * Голову хэш-цепочки журнал берёт под advisory-замком транзакции, и если
 * запрос уже писал в журнал (замок держит ЕГО соединение до конца), вторая
 * запись с другого соединения ждала бы замка, который не отпустится, пока
 * мы её ждём, — вечное ожидание, которого база не распознает как
 * взаимоблокировку. После отката замка уже нет.
 *
 * Повтор идёт системной ролью: у отказа нет «своего» контекста, в котором
 * его стоит писать, а счётчику попыток (login_attempts) политика и так
 * разрешает одну систему. Содержимое записи зафиксировано в замыкании и от
 * роли не зависит.
 *
 * Вне всякого контекста (до транзакции запроса — отказы requireAuth и входа
 * «от имени») запись идёт своей системной транзакцией: без контекста
 * политика журнала (app_role() IS NOT NULL) не пропустила бы её, и под
 * боевой ролью базы строка отказа терялась бы молча — audit глотает ошибку.
 * Внутри чужой транзакции (systemContext входа) — просто выполняется: там
 * отказ возвращается наружу и транзакция фиксируется.
 */
export async function durable<T>(write: () => Promise<T>): Promise<T> {
  const tx = dbContext.getStore();
  if (!tx) {
    const { baseDb } = await import("./index");
    return systemContext(baseDb, write);
  }
  const scope = requestScope.getStore();
  if (scope && scope.tx === tx) scope.survivors.push(write);
  return write();
}

async function replaySurvivors(base: typeof DbType, survivors: (() => Promise<unknown>)[]): Promise<void> {
  for (const write of survivors) {
    try {
      // каждая своей транзакцией: сбой одной не должен уносить остальные
      await systemContext(base, write);
    } catch (error) {
      log.error("request.durable_replay_failed", { error: String(error) });
    }
  }
}
