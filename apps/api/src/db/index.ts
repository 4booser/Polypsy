import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";
import { dbContext } from "./context";
import { installDbErrorUnwrap } from "./errors";

// ошибки базы — ошибками драйвера, а не обёрткой drizzle с параметрами в тексте (см. ./errors)
installDbErrorUnwrap();

/**
 * Пул соединений к PostgreSQL.
 *
 * max держим небольшим: приложение живёт в одном процессе Bun, а каждое
 * соединение — это отдельный бэкенд-процесс на стороне сервера БД.
 *
 * Маленький пул держится на инварианте «один запрос — одна транзакция
 * запроса»: запрос, который держит своё соединение и просит второе, при
 * десяти одновременных таких же ждёт вечно — все соединения заняты первыми
 * транзакциями. Так вставал /api/ops/data с двойной авторизацией (внешний
 * разбор 2026-09-26); сторож — test/authOnce.test.ts.
 */
const client = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  // имена в схеме уже в snake_case, автопреобразование только запутает
  transform: undefined,
});

const poolDb = drizzle(client, { schema });

/* ─────────── Пул на время участка: шов для проверки под ролью приложения ─────────── */

/**
 * Другой пул — для всего, что выполняется внутри участка.
 *
 * В бою не вызывается ни разу: у процесса один пул, и он подключён ролью
 * приложения (quizzy_app). Шов нужен сюите. Она ходит в базу владельцем, а
 * владелец политики строк обходит, поэтому три боевые поломки волны 12
 * (пустые списки записи у пациента, 500 на автосохранении с критическим
 * ответом, потерянный impersonation.view) сюита не видела. Проверка под
 * ролью приложения нужна на ЦЕЛЫХ сценариях, а не на отдельных запросах,
 * и при этом фикстуры и проверки теста обязаны остаться владельцем — им
 * политики только мешают. Отсюда подмена по async-контексту: запрос,
 * запущенный внутри runOnPool, от первого до последнего обращения к базе —
 * транзакция запроса (withRequestContext), вложенные systemContext, asSystem
 * внутри транзакции, повтор записей после отката (durable), отложенный
 * журнал read-only запроса — идёт пулом роли приложения; код теста вокруг —
 * своим.
 *
 * Отвергнуто: SET ROLE на соединениях владельца. Сессия остаётся сессией
 * суперпользователя, и любой оператор (консоль SQL выполняет чужой текст)
 * снимает подмену через RESET ROLE; session_user и pg_stat_activity тоже
 * показывают не то, что в бою. Отдельная учётная запись без прав владельца
 * — ровно боевая картина. Отвергнут и дочерний процесс на весь сценарий
 * (underAppRole в test/appRole.ts): у него свои кэши прав и сессий, свои
 * модули, фикстуры туда не передать, и каждый запуск — секунды на загрузку
 * приложения; для одного-двух запросов годится, для сквозного сценария нет.
 */
export interface PoolOverride {
  db: typeof poolDb;
  /** Адрес того же подключения: консоль SQL открывает своё соединение, и оно должно быть той же ролью */
  url: string;
}

const poolOverride = new AsyncLocalStorage<PoolOverride>();

export function runOnPool<T>(pool: PoolOverride, fn: () => T): T {
  return poolOverride.run(pool, fn);
}

/** Адрес базы, которым ходит текущий участок: подменённый пул или пул процесса */
export function currentDatabaseUrl(): string {
  return poolOverride.getStore()?.url ?? env.databaseUrl;
}

/**
 * Пул участка: подменённый (см. runOnPool) или пул процесса.
 *
 * Прокси, а не переменная: baseDb импортируют напрямую (транзакция запроса,
 * systemContext фоновых задач и публичных конвейеров), и выбор обязан
 * происходить при каждом обращении, а не при импорте.
 */
const baseDb: typeof poolDb = new Proxy(poolDb, {
  get(target, prop) {
    const source = poolOverride.getStore()?.db ?? target;
    const value = Reflect.get(source as object, prop, source as object) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(source) : value;
  },
});

/**
 * Прокси над drizzle: если вызов идёт внутри контекста (см. ./context) —
 * уходит в транзакцию контекста, иначе в пул напрямую. Существующий код
 * продолжает писать db.select()… и не знает о подмене.
 */
export const db: typeof poolDb = new Proxy(poolDb, {
  get(target, prop, receiver) {
    // ленивый импорт разорвал бы цикл, но контекст не тянет index — можно прямо
    const store = dbContext.getStore();
    const source = (store ?? poolOverride.getStore()?.db ?? target) as typeof poolDb;
    const value = Reflect.get(source as object, prop, source as object) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(source) : value;
  },
});

export { baseDb, client, schema };
