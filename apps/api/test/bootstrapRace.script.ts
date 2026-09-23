/**
 * Два одновременных первых регистранта на пустой базе — отдельным процессом.
 *
 * Процесс отдельный не для красоты: общая тестовая база пуста ровно один раз,
 * до создания фикстур, а обвязка заводит root, двух администраторов и
 * пациента прежде, чем выполнится первый тест. Опустошать users посреди
 * прогона нельзя — по каскадам за ней уходит вся клиника, и остальные файлы
 * остались бы без данных. Поэтому здесь поднимается своя база, свои миграции
 * и то же самое приложение.
 *
 * Запускается из bootstrap.test.ts; DATABASE_URL на свежую базу передаёт он.
 */
process.env.SCHEDULER_ENABLED = "0";
process.env.JWT_SECRET ??= "test-secret-not-for-production-0123456789";
process.env.ENCRYPTION_KEY ??= `v1:${Buffer.alloc(32, 9).toString("base64")}`;

const { app } = await import("../src/app");
const { db, client } = await import("../src/db");
const { users } = await import("../src/db/schema");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");

await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

function register(tag: string) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `first-${tag}@test.dev`,
      password: "longpass123",
      phone: `+3806300000${tag === "a" ? "01" : "02"}`,
      anonymous: false,
      firstName: "Первый",
      lastName: tag === "a" ? "Регистрант" : "Второй",
    }),
  });
}

/*
 * Promise.all, а не последовательный запуск: обе транзакции должны успеть
 * сделать свой select до чужого commit — иначе гонки нет и проверять нечего.
 */
const [first, second] = await Promise.all([register("a"), register("b")]);
const rows = await db.select({ role: users.role, email: users.email }).from(users);

console.log(
  `RESULT ${JSON.stringify({
    statuses: [first.status, second.status],
    roles: rows.map((r) => r.role).sort(),
    admins: rows.filter((r) => r.role === "admin").length,
  })}`,
);

await client.end();
