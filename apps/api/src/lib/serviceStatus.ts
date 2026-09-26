import { createMiddleware } from "hono/factory";
import { desc } from "drizzle-orm";
import {
  MAINTENANCE_CODE,
  renderError,
  type PublicServiceStatus,
  type ServiceAnnouncement,
  type ServiceStatus,
  type ServiceStatusInput,
} from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { serviceAnnouncements } from "../db/schema";
import { langOf } from "./http";
import { currentRequestId } from "./log";

/**
 * Состояние системы и режим обслуживания.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункты 8 и 10): режим
 * обслуживания одной кнопкой — баннер всем, запись закрыта, чтение открыто;
 * страница статуса «працює / обслуговування / збої».
 *
 * Состояние — последняя строка service_announcements (миграция 0090). Оно в
 * базе, а не в памяти процесса: переживает перезапуск и одинаково для всех
 * процессов API. В памяти — только короткий кэш, чтобы не спрашивать базу на
 * каждую запись.
 */

export type AnnouncementRow = typeof serviceAnnouncements.$inferSelect;

/*
 * Три секунды кэша.
 *
 * Закрытая запись проверяется на каждом изменяющем запросе, и без кэша это
 * лишняя транзакция на каждое сохранение. С кэшем другой процесс узнаёт о
 * включении не позже чем через три секунды — меньше, чем человек успевает
 * перейти от техпанели к форме. Свой процесс узнаёт сразу: запись
 * объявления кладёт его в кэш (см. announce).
 */
const CACHE_MS = 3_000;
let cache: { at: number; row: AnnouncementRow | null } | null = null;

/**
 * Последнее, что удалось прочитать из базы — на случай, когда база молчит.
 *
 * Страница статуса именно тогда и нужнее всего. Показать «идут работы до
 * 21:30» по последнему известному объявлению честнее, чем пустую страницу:
 * объявление было, и сервер его читал.
 */
let lastKnown: { latest: AnnouncementRow | null; history: AnnouncementRow[] } | null = null;

/** Сбросить кэш: так выглядит перезапуск процесса (тесты «переживает перезапуск») */
export function resetStatusCache(): void {
  cache = null;
  lastKnown = null;
}

async function readLatest(): Promise<AnnouncementRow | null> {
  /*
   * Системным контекстом: проверка стоит до requireAuth (запись закрывается
   * и для запросов без токена), и политики строк без контекста не отдали бы
   * ничего — режим выглядел бы выключенным всегда, но только в бою, где
   * приложение ходит ролью без прав владельца.
   */
  const [row] = await systemContext(baseDb, () =>
    db.select().from(serviceAnnouncements).orderBy(desc(serviceAnnouncements.createdAt)).limit(1),
  );
  return row ?? null;
}

/** Действующее объявление; null — объявлений не было, система работает */
export async function currentAnnouncement(): Promise<AnnouncementRow | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.row;
  const row = await readLatest();
  cache = { at: Date.now(), row };
  return row;
}

/**
 * Записать объявление от имени человека.
 *
 * В транзакции запроса, а не системной: политика строк проверяет, что
 * автор — тот, кто вошёл (created_by = app_uid()), и объявить работы от
 * имени коллеги не выйдет даже в обход маршрута.
 */
export async function announce(authorId: string, input: ServiceStatusInput): Promise<AnnouncementRow> {
  const [row] = await db
    .insert(serviceAnnouncements)
    .values({
      id: crypto.randomUUID(),
      status: input.status,
      message: input.message?.trim() || null,
      expectedEnd: input.expectedEnd ? new Date(input.expectedEnd).toISOString() : null,
      createdBy: authorId,
    })
    .returning();
  /*
   * Кэш — сразу новой строкой, а не сбросом. Сброс заставил бы следующий
   * запрос читать базу, пока эта транзакция ещё не закоммичена, и он
   * положил бы в кэш ПРЕЖНЕЕ состояние на три секунды: человек выключил
   * обслуживание, а форма рядом по-прежнему отвечает 503.
   */
  cache = { at: Date.now(), row: row! };
  return row!;
}

/** Строка истории для людей — без автора (см. ServiceAnnouncement) */
export function toAnnouncement(row: AnnouncementRow): ServiceAnnouncement {
  return {
    id: row.id,
    status: row.status as ServiceStatus,
    message: row.message,
    expectedEnd: row.expectedEnd,
    at: row.createdAt,
  };
}

/**
 * Что показать людям: объявленное плюс то, что сервер видит сам.
 *
 * Сам сервер надёжно знает одно — ответила ли ему база. Остальное
 * («медленно», «много ошибок») зависит от порога, который пришлось бы
 * выдумать, и выдуманный порог врал бы в обе стороны. Поэтому автоматом
 * ставится только «збої» при молчащей базе.
 *
 * Если база молчит во время объявленных работ, остаётся «обслуговування»:
 * базу на работах и останавливают, и «збої» поверх объявления пугало бы
 * тех, кого уже предупредили. Признак `auto` при этом виден — техпанели
 * важно знать, что база не отвечает, даже когда людям это не новость.
 */
export function composeStatus(
  latest: AnnouncementRow | null,
  dbOk: boolean,
  history: AnnouncementRow[],
  now: Date = new Date(),
): PublicServiceStatus {
  const declared = (latest?.status ?? "ok") as ServiceStatus;
  const keepDeclared = dbOk || declared === "maintenance";
  const status: ServiceStatus = dbOk ? declared : declared === "maintenance" ? "maintenance" : "degraded";
  return {
    status,
    message: keepDeclared ? (latest?.message ?? null) : null,
    expectedEnd: keepDeclared ? (latest?.expectedEnd ?? null) : null,
    since: keepDeclared ? (latest?.createdAt ?? null) : null,
    // база молчит — сохранить всё равно ничего не выйдет, и обещать это нельзя
    writable: dbOk && status !== "maintenance",
    auto: dbOk ? null : "db",
    checkedAt: now.toISOString(),
    history: history.map(toAnnouncement),
  };
}

/*
 * Две секунды на ответ базы. Страница статуса нужна как раз тогда, когда
 * что-то висит, и повиснуть вместе с базой — худшее, что она может сделать:
 * человек открыл её, чтобы узнать, что происходит, и тоже ждёт.
 */
const STATUS_DB_TIMEOUT_MS = 2_000;

/** Состояние для страницы статуса: текущее и последние объявления */
export async function publicStatus(
  historyLimit = 10,
  read: (limit: number) => Promise<AnnouncementRow[]> = readHistory,
): Promise<PublicServiceStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const history = await Promise.race([
      read(historyLimit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("db timeout")), STATUS_DB_TIMEOUT_MS);
      }),
    ]);
    const latest = history[0] ?? null;
    lastKnown = { latest, history };
    return composeStatus(latest, true, history);
  } catch {
    return composeStatus(lastKnown?.latest ?? null, false, lastKnown?.history ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/** Последние объявления — системным чтением: страница статуса открыта без входа */
export function readHistory(limit: number): Promise<AnnouncementRow[]> {
  return systemContext(baseDb, () =>
    db.select().from(serviceAnnouncements).orderBy(desc(serviceAnnouncements.createdAt)).limit(limit),
  );
}

/**
 * Сколько ждать до повтора — заголовок Retry-After.
 *
 * По ожидаемому концу работ, если он назван; иначе пять минут. Не меньше
 * тридцати секунд (чаще стучаться незачем) и не больше шести часов:
 * клиент, поверивший «приходите через сутки», перестал бы пробовать вовсе,
 * а работы заканчивают и раньше объявленного.
 */
export function retryAfterSeconds(expectedEnd: string | null, now: number): number {
  if (!expectedEnd) return 300;
  const left = Math.ceil((Date.parse(expectedEnd) - now) / 1000);
  // срок прошёл, а работы идут — значит скоро, но когда именно, не сказано
  if (!Number.isFinite(left) || left <= 0) return 60;
  return Math.min(Math.max(left, 30), 6 * 3600);
}

/**
 * Что пропускается при закрытой записи.
 *
 * Чтение — всегда: GET/HEAD/OPTIONS ничего не меняют, и смотреть карты во
 * время работ можно. Из записи — только два контура, без которых режим
 * нельзя было бы выключить:
 *
 * - техпанель (/api/ops/*): иначе выключить обслуживание некому — запрос
 *   «выключить» сам был бы записью. Туда же попадают и ручные задачи
 *   техпанели: работы для того и объявлены;
 * - вход и выход (login, logout, refresh, обмен кода Google): иначе войти,
 *   чтобы выключить, нельзя, а сессия, истёкшая посреди работ, выкинула бы
 *   человека насовсем. Регистрации и смены пароля здесь нет — это запись в
 *   учётные данные, и она подождёт.
 *
 * Список путей, а не пометка на маршрутах: исключений два, и их полнота
 * видна одним взглядом. Пометка на маршрутах разнесла бы решение по
 * двадцати файлам — и новое исключение появлялось бы незаметно.
 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT = [/^\/api\/ops(\/|$)/, /^\/api\/auth\/(login|logout|refresh|google\/exchange)$/];

export function exemptFromMaintenance(method: string, path: string): boolean {
  return READ_METHODS.has(method) || EXEMPT.some((re) => re.test(path));
}

/**
 * Заслон режима обслуживания.
 *
 * Стоит на /api/* раньше всех маршрутов и раньше входа: закрытая запись
 * закрыта для всех одинаково, и выяснять, кто пришёл, ради отказа незачем.
 *
 * 503, а не 423 или 409: это ровно «сервис временно недоступен, повторите
 * позже» — так его читают прокси, мобильная очередь сдач и веб-кабинет
 * (isTransientStatus): сдача ответов ложится ждать, а не помечается
 * отказом. Тело несёт код `maintenance` — по нему консоль сразу
 * перечитывает состояние и показывает баннер, не дожидаясь опроса.
 *
 * База не ответила на проверку — запрос идёт дальше. Сам он упадёт честно,
 * своим отказом; а придуманный здесь 503 «обслуживание» был бы неправдой.
 */
export const maintenanceGate = createMiddleware(async (c, next) => {
  if (exemptFromMaintenance(c.req.method, c.req.path)) return next();
  let row: AnnouncementRow | null;
  try {
    row = await currentAnnouncement();
  } catch {
    return next();
  }
  if (row?.status !== "maintenance") return next();
  const retryAfter = retryAfterSeconds(row.expectedEnd, Date.now());
  c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      error: renderError("err.maintenance", langOf(c)),
      code: MAINTENANCE_CODE,
      retryAfter,
      until: row.expectedEnd,
      requestId: currentRequestId(),
    },
    503,
  );
});
