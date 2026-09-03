/**
 * Подготовка базы перед запуском приложения: схема и роль приложения.
 *
 *   bun apps/api/src/provision.ts
 *
 * Выполняется владельцем базы — миграциям нужны права на схему. Приложение
 * потом подключается другой ролью, и это не придирка к чистоте: владелец
 * таблицы в PostgreSQL обходит политики строк, и с ним все сорок семь
 * политик остаются на месте, но каждый видит всё. Отличить это от исправной
 * работы нельзя ничем — запросы отрабатывают, экраны рисуются.
 *
 * Поэтому роль приложения заводится здесь же, а не отдельным шагом, который
 * кто-то выполнит по памяти: шаг, о котором надо помнить, однажды забудут, и
 * узнать об этом будет неоткуда.
 *
 * Скрипт идемпотентен: повторный прогон обновляет пароль и права, ничего не
 * ломая.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { client, db } from "./db";

const APP_ROLE = "quizzy_app";
const password = process.env.APP_DB_PASSWORD ?? "";

await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
console.log("  ✓ схема приведена к миграциям");

if (!password) {
  console.error(
    [
      "",
      "APP_DB_PASSWORD не задан — роль приложения не заведена.",
      "",
      "Без неё приложение подключится владельцем базы, а для владельца",
      "политики строк не применяются: они останутся на месте, но каждый",
      "будет видеть всё. Сервер в production такой запуск не примет.",
      "",
      "Сгенерировать пароль: head -c 24 /dev/urandom | base64",
      "",
    ].join("\n"),
  );
  await client.end();
  process.exit(1);
}

/*
 * CREATE или ALTER — по факту существования. `CREATE ROLE ... IF NOT EXISTS`
 * в PostgreSQL нет, а пароль всё равно надо уметь обновлять: он меняется
 * чаще, чем заводится роль.
 */
const [exists] = await db.execute<{ n: number }>(
  sql`select count(*)::int n from pg_roles where rolname = ${APP_ROLE}`,
);
if (Number(exists?.n ?? 0) === 0) {
  await db.execute(sql.raw(`create role ${APP_ROLE} login password '${password.replace(/'/g, "''")}'`));
  console.log(`  ✓ роль ${APP_ROLE} заведена`);
} else {
  await db.execute(sql.raw(`alter role ${APP_ROLE} with login password '${password.replace(/'/g, "''")}'`));
  console.log(`  ✓ пароль роли ${APP_ROLE} обновлён`);
}

await db.execute(sql.raw(`grant usage on schema public to ${APP_ROLE}`));
await db.execute(
  sql.raw(`grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`),
);
await db.execute(sql.raw(`grant usage, select on all sequences in schema public to ${APP_ROLE}`));
/*
 * Права на будущие таблицы — иначе следующая миграция заведёт таблицу, к
 * которой приложение не имеет доступа, и сломается не миграция, а первый же
 * запрос к новому экрану.
 */
await db.execute(
  sql.raw(`alter default privileges in schema public
           grant select, insert, update, delete on tables to ${APP_ROLE}`),
);
console.log("  ✓ права выданы, включая будущие таблицы");

/*
 * Журнал закрыт и привилегиями, а не только политикой: хеш-цепочка защищает
 * от подмены задним числом, но строку всё ещё можно было бы удалить.
 */
await db.execute(sql.raw(`revoke update, delete on audit_log from ${APP_ROLE}`));
console.log("  ✓ журнал доступен только на чтение и вставку");

await client.end();
console.log("\nГотово. DATABASE_URL приложения должен указывать на quizzy_app.");
