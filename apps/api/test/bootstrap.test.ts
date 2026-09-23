import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME } from "./preload";

/**
 * Первый пользователь свежей установки становится администратором — ровно один.
 *
 * Исключение нужно: иначе новую установку некому настроить. Но решение
 * принималось по свободному `count(users) = 0`, а на уровне READ COMMITTED
 * две регистрации, начатые в одну секунду, обе видят пустую таблицу. На
 * свежем экземпляре это не теоретическая гонка: ссылку на регистрацию дают
 * сразу нескольким сотрудникам, и второй администратор, которого никто не
 * заводил, останется администратором навсегда.
 *
 * Проверка идёт в отдельном процессе со своей базой: общая тестовая база
 * пуста только до создания фикстур, а опустошать users посреди прогона
 * нельзя — по каскадам за ней уходит вся клиника.
 */

const RACE_DB = `${TEST_DATABASE_NAME}_boot`;

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(ADMIN_DATABASE_URL, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

afterAll(async () => {
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${RACE_DB}`));
});

describe("первый пользователь", () => {
  test(
    "два одновременных регистранта на пустой базе дают ровно одного администратора",
    async () => {
      await admin(async (sql) => {
        await sql.unsafe(`DROP DATABASE IF EXISTS ${RACE_DB}`);
        await sql.unsafe(`CREATE DATABASE ${RACE_DB}`);
      });

      const url = new URL(ADMIN_DATABASE_URL);
      url.pathname = `/${RACE_DB}`;
      const script = new URL("./bootstrapRace.script.ts", import.meta.url).pathname;
      const proc = Bun.spawn(["bun", script], {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`гонка не отработала (код ${code}):\n${await new Response(proc.stderr).text()}`);
      }

      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice("RESULT ".length)) as {
        statuses: number[];
        roles: string[];
        admins: number;
      };

      // оба аккаунта заводятся: отказывать второму не за что
      expect(result.statuses.sort()).toEqual([201, 201]);
      /*
       * Главное утверждение. Без замка здесь два «admin»: обе транзакции
       * успевали сосчитать пустую таблицу до чужого коммита.
       */
      expect(result.admins).toBe(1);
      expect(result.roles).toEqual(["admin", "user"]);
    },
    120_000,
  );
});
