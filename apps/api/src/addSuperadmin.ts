/**
 * Новый суперадминистратор — с сервера, одной командой.
 *
 *   docker compose --env-file .env.docker exec api \
 *     bun apps/api/src/addSuperadmin.ts --email you@example.com [--first Имя] [--last Фамилия]
 *
 * Решение заказчика 2026-09-26: «сделай мне новый акк на проде, чтобы ты его
 * не видел». Поэтому учётка заводится не через консоль и не через выкатку, а
 * командой на самом сервере: пароль рождается там, печатается один раз в
 * терминале того, кто её запустил, и не попадает ни в журнал выкатки, ни в
 * базу открытым текстом, ни в историю чата. Установщик (install.ts) заводит
 * суперадминистратора только на пустом экземпляре — второго им не завести.
 *
 * Адрес занят — отказ, а не сброс пароля чужой записи: сброс — это другое
 * действие с другим следом в журнале, и тихо превращать в него «создание»
 * значило бы дать команде отнять вход у живого человека.
 *
 * Создание пишется в журнал (user.create, via: "cli") — без пароля, как и
 * любое создание учётки.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    first: { type: "string" },
    last: { type: "string" },
  },
});

const email = values.email?.trim().toLowerCase() ?? "";
/* та же проверка формы, что на входе: адрес, с которым не войти, заводить незачем */
if (!z.string().email().safeParse(email).success) {
  console.error("Нужен адрес: --email you@example.com");
  process.exit(1);
}

/* модуль базы читает DATABASE_URL при загрузке — импорт только после проверок */
const { baseDb, client, db } = await import("./db");
const { systemContext } = await import("./db/context");
const { users } = await import("./db/schema");
const { hashPassword } = await import("./lib/auth");
const { encryptPersonFields } = await import("./lib/crypto");
const { auditSystem } = await import("./lib/audit");

/* 20 знаков base64url — 120 бит; тот же способ, что у установщика */
const password = randomBytes(15).toString("base64url");

try {
  const outcome = await systemContext(baseDb, async () => {
    const taken = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
    if (taken) return "taken" as const;
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email,
      ...encryptPersonFields({
        firstName: values.first?.trim() || "Администратор",
        lastName: values.last?.trim() || "Системы",
        middleName: null,
        birthDate: null,
      }),
      passwordHash: await hashPassword(password),
      role: "superadmin",
    });
    await auditSystem({
      action: "user.create",
      resourceType: "user",
      resourceId: id,
      subjectUserId: id,
      details: { role: "superadmin", via: "cli" },
    });
    return "created" as const;
  });

  if (outcome === "taken") {
    console.error(`Адрес ${email} уже занят — новая запись не заведена, пароль прежней не тронут.`);
    process.exitCode = 1;
  } else {
    console.log(`\n  создан суперадминистратор\n    вход:   ${email}\n    пароль: ${password}\n`);
    console.log("  Пароль показан один раз и нигде не сохранён. Смените его после входа («Учётная запись»).\n");
  }
} finally {
  await client.end();
}
