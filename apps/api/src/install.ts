/**
 * Установка экземпляра одной командой.
 *
 * Каждое учреждение получает свою базу — колонок арендатора в таблицах нет.
 * Это решение волны 8, и цена у него эксплуатационная: установка, обновление
 * и резервное копирование умножаются на число учреждений. Заплатить эту цену
 * надо явно, а не оставить её в виде десятка шагов, которые кто-то выполнит
 * по памяти и в третьем учреждении забудет один.
 *
 *   bun run install:instance
 *
 * Скрипт идемпотентен: повторный запуск на готовом экземпляре ничего не
 * ломает и говорит, что уже сделано. Установку запускают дважды чаще, чем
 * кажется, — например когда первая прервалась на середине.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

const steps: string[] = [];
const warnings: string[] = [];

function step(text: string): void {
  steps.push(text);
  console.log(`  ✓ ${text}`);
}

function warn(text: string): void {
  warnings.push(text);
  console.log(`  ! ${text}`);
}

/**
 * Проверка настроек до всякой работы.
 *
 * Установка, прерванная на середине из-за незаданного ключа шифрования,
 * оставляет базу с таблицами и без данных — и разбираться в этом хуже, чем
 * не начинать. Поэтому сначала смотрим на всё, что понадобится.
 */
function checkEnv(): { url: string; dbName: string } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан. Без него ставить некуда.");
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET не задан. На нём держатся сессии и слепые индексы.");
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_KEY) {
    /*
     * Без ключа система работает, но поля лежат открытыми. Для клинической
     * системы это не «режим по умолчанию», а авария — поэтому отказ, а не
     * предупреждение.
     */
    console.error(
      "ENCRYPTION_KEY не задан. Без него ФИО, записи приёма и расшифровки лягут открытыми.\n" +
        `Сгенерировать: ENCRYPTION_KEY=k1:${randomBytes(32).toString("base64")}`,
    );
    process.exit(1);
  }
  const name = new URL(url).pathname.slice(1);
  if (!name) {
    console.error("В DATABASE_URL не указано имя базы.");
    process.exit(1);
  }
  return { url, dbName: name };
}

async function ensureDatabase(url: string, dbName: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (exists) {
      step(`база ${dbName} уже есть`);
    } else {
      await admin.unsafe(`create database "${dbName}"`);
      step(`база ${dbName} создана`);
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  console.log("Установка экземпляра\n");
  const { url, dbName } = checkEnv();
  step("настройки на месте");

  await ensureDatabase(url, dbName);

  /* модуль базы читает DATABASE_URL при загрузке — импорт только после проверок */
  const { db, client } = await import("./db");
  const { users } = await import("./db/schema");
  const { syncBuiltinRole } = await import("./lib/permissions");

  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  step("миграции применены");

  /*
   * Встроенная роль и её выдача — тем же кодом, что при старте приложения.
   * Второй реализации здесь быть не должно: она разъедется с первой, и
   * разойдутся они молча.
   */
  await syncBuiltinRole();
  step("права персонала выданы");

  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "superadmin"));
  const supers = Number(rows[0]?.n ?? 0);

  if (supers > 0) {
    step(`суперадминистратор уже есть (${supers})`);
  } else {
    /*
     * Пароль печатается один раз и не сохраняется никуда. Записать его в файл
     * значило бы оставить в экземпляре учётку с паролем на диске; а придумать
     * «admin/admin» — оставить её навсегда.
     */
    const { hashPassword } = await import("./lib/auth");
    const { encryptPersonFields } = await import("./lib/crypto");
    /*
     * Адрес обязан проходить проверку формы — той самой, что стоит на входе.
     *
     * По умолчанию было «admin@local», и вход с ним невозможен: домен без
     * точки zod за адрес не считает. То есть установщик заводил единственную
     * учётную запись свежего экземпляра и делал её непригодной — молча, с
     * бодрым «создан первый суперадминистратор» и напечатанным паролем.
     * Обнаруживается это в первую же попытку войти, когда установщик уже
     * отработал и пароль показан один раз.
     */
    const email = process.env.ADMIN_EMAIL ?? "admin@quizzy.local";
    const password = randomBytes(12).toString("base64url");
    await db.insert(users).values({
      id: crypto.randomUUID(),
      email,
      ...encryptPersonFields({
        firstName: "Администратор",
        lastName: "Системы",
        middleName: null,
        birthDate: null,
      }),
      passwordHash: await hashPassword(password),
      role: "superadmin",
    });
    step("создан первый суперадминистратор");
    console.log(`\n    вход: ${email}\n    пароль: ${password}\n`);
    console.log("    Пароль показан один раз и нигде не сохранён. Смените его после входа.\n");
  }

  /* ── то, о чём легко забыть и что не видно, пока не понадобится ── */

  if (!process.env.RECORDINGS_DIR) {
    warn("RECORDINGS_DIR не задан: записи приёмов лягут в ./data/recordings");
  }
  if (!process.env.WHISPER_BIN || !process.env.WHISPER_MODEL) {
    warn("whisper не настроен: записи приёмов будут храниться как аудио, без расшифровки");
  }
  if (!process.env.INSTITUTION_NAME) {
    warn("INSTITUTION_NAME не задан: справки и отчёты выйдут без шапки учреждения");
  }
  if (url.includes("@localhost") && process.env.NODE_ENV === "production") {
    warn("приложение ходит в базу под учёткой с localhost — проверьте, что это не владелец таблиц");
  }

  console.log(`\nГотово: шагов ${steps.length}, предупреждений ${warnings.length}.`);
  if (warnings.length) {
    console.log("Предупреждения не мешают работе, но каждое однажды о себе напомнит.");
  }
  await client.end();
}

await main();
