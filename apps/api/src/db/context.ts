import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { db as DbType } from "./index";

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
