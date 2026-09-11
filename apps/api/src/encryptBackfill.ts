/**
 * Бэкфилл шифрования: перешифровывает открытые значения существующих строк.
 *
 * Запуск: ENCRYPTION_KEY=... bun run db:encrypt
 * Идемпотентен: уже шифрованные значения (префикс enc1:) не трогаются,
 * прогонять можно сколько угодно раз и порциями.
 */
import { eq } from "drizzle-orm";
import { baseDb, client, db } from "./db";
import { systemContext } from "./db/context";
import { answers, conclusions, users } from "./db/schema";
import { encryptField, isEncryptionEnabled } from "./lib/crypto";

if (!isEncryptionEnabled()) {
  console.error("ENCRYPTION_KEY не задан — бэкфиллу нечем шифровать");
  process.exit(1);
}

const plain = (v: string | null) => v !== null && v !== "" && !v.startsWith("enc1:");

/*
 * Весь проход — в системном контексте.
 *
 * Иначе бэкфилл, запущенный ролью приложения (а именно она стоит в
 * DATABASE_URL боевой установки), не увидел бы ни строки: users, как и
 * клинические таблицы, лежит под политиками, а контекста у скрипта нет.
 * Отработал бы он при этом «успешно», отчитавшись о нуле перешифрованных
 * записей, — то есть оставил бы карты открытыми и сказал, что всё сделано.
 *
 * Заодно сюда попадает и app.maintenance: он ставится через SET LOCAL, то
 * есть действует до конца транзакции. Вне транзакции значение уходило в одно
 * случайное соединение пула, а работал бэкфилл через остальные.
 */
await systemContext(baseDb, async () => {
  const { sql } = await import("drizzle-orm");
  // триггер неизменяемости подписанных заключений пропускает только
  // служебную сессию — включаем режим явно, след остаётся в логах Postgres
  await db.execute(sql`select set_config('app.maintenance', '1', true)`);

  let usersDone = 0;
  for (const row of await db.select().from(users)) {
    const patch: Record<string, string | null> = {};
    if (plain(row.firstName)) patch.firstName = encryptField(row.firstName);
    if (plain(row.lastName)) patch.lastName = encryptField(row.lastName);
    if (plain(row.middleName)) patch.middleName = encryptField(row.middleName);
    if (plain(row.birthDate)) patch.birthDate = encryptField(row.birthDate);
    if (Object.keys(patch).length) {
      await db.update(users).set(patch).where(eq(users.id, row.id));
      usersDone++;
    }
  }
  console.log(`пользователи: перешифровано ${usersDone}`);

  let answersDone = 0;
  for (const row of await db.select({ id: answers.id, text: answers.text }).from(answers)) {
    if (!plain(row.text)) continue;
    await db.update(answers).set({ text: encryptField(row.text) }).where(eq(answers.id, row.id));
    answersDone++;
  }
  console.log(`тексты ответов: перешифровано ${answersDone}`);

  let conclusionsDone = 0;
  for (const row of await db.select({ id: conclusions.id, text: conclusions.text }).from(conclusions)) {
    if (!plain(row.text)) continue;
    await db.update(conclusions).set({ text: encryptField(row.text)! }).where(eq(conclusions.id, row.id));
    conclusionsDone++;
  }
  console.log(`заключения: перешифровано ${conclusionsDone}`);
});

await client.end();
