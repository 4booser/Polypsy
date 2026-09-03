import { sql } from "drizzle-orm";
import { db } from "../db";

/**
 * Проверка того, что политики строк для приложения вообще действуют.
 *
 * В PostgreSQL владелец таблицы обходит RLS — это поведение по умолчанию,
 * и `FORCE ROW LEVEL SECURITY` у нас намеренно не стоит: миграции с
 * переносом данных под FORCE не увидели бы ни одной строки и «успешно»
 * ничего не сделали.
 *
 * Отсюда единственное условие: приложение подключается ролью, которая
 * таблиц не владеет. Ровно для этого написан `scripts/create-app-role.sql`.
 *
 * Проверка нужна потому, что нарушение не видно ничем. Все сорок семь
 * политик остаются на месте, запросы отрабатывают, экраны рисуются — просто
 * каждый видит всё. Отличить это от исправной работы можно только специально
 * заглянув в pg_class, а заглядывать никто не будет: поводов нет.
 *
 * Обнаружилось это на разборе развёртывания: поставляемый docker-compose
 * подключал приложение владельцем базы. То есть самый глубокий слой защиты
 * был выключен ровно тем способом, каким систему предлагалось разворачивать.
 */
export interface RlsStatus {
  role: string;
  /** Роль обходит политики: суперпользователь, BYPASSRLS или владелец таблиц */
  bypasses: boolean;
  reason: string | null;
  /** Сколько таблиц с включённой RLS принадлежит этой роли */
  ownedWithRls: number;
}

/**
 * Как выполнять запрос. По умолчанию — общее подключение приложения;
 * параметр нужен проверке, которая спрашивает то же самое от имени другой
 * роли: иначе проверить можно было бы только ту роль, под которой идут
 * тесты, а именно её отличие от боевой и составляет весь смысл.
 */
export type Exec = <T>(query: ReturnType<typeof sql>) => Promise<T[]>;

const defaultExec: Exec = (query) => db.execute(query) as never;

export async function checkRls(exec: Exec = defaultExec): Promise<RlsStatus> {
  const [row] = await exec<{
    role: string;
    is_super: boolean;
    bypass: boolean;
    owned: number;
  }>(sql`
    select current_user as role,
           r.rolsuper as is_super,
           r.rolbypassrls as bypass,
           (select count(*)::int
              from pg_class c
              join pg_roles o on o.oid = c.relowner
             where c.relnamespace = 'public'::regnamespace
               and c.relkind = 'r'
               and c.relrowsecurity
               and o.rolname = current_user) as owned
      from pg_roles r
     where r.rolname = current_user
  `);

  const role = String(row?.role ?? "?");
  const owned = Number(row?.owned ?? 0);

  if (row?.is_super) {
    return { role, bypasses: true, reason: "суперпользователь базы", ownedWithRls: owned };
  }
  if (row?.bypass) {
    return { role, bypasses: true, reason: "роль с BYPASSRLS", ownedWithRls: owned };
  }
  if (owned > 0) {
    return {
      role,
      bypasses: true,
      reason: `владеет ${owned} табл. с включённой RLS`,
      ownedWithRls: owned,
    };
  }
  return { role, bypasses: false, reason: null, ownedWithRls: 0 };
}

/**
 * Текст отказа. Отдельно от проверки, чтобы его можно было показать и в
 * установщике, и при старте, и в тесте — одними словами.
 */
export function rlsRefusal(status: RlsStatus): string {
  return [
    `Приложение подключено к базе ролью «${status.role}» — ${status.reason}.`,
    "Для такой роли политики строк не применяются: все сорок семь остаются на месте,",
    "но каждый видит всё. Это не мешает работе и потому не будет замечено.",
    "",
    "Заведите роль приложения и переключите на неё DATABASE_URL:",
    "  psql \"$OWNER_DATABASE_URL\" -v app_password='<пароль>' -f scripts/create-app-role.sql",
    "",
    "Миграции по-прежнему выполняются владельцем — им нужны права на схему.",
  ].join("\n");
}
