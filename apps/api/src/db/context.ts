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
