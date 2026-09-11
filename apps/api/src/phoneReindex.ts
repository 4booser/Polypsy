/**
 * Пересчёт слепого индекса телефонов под текущий PHONE_INDEX_SECRET.
 *
 *   bun run --cwd apps/api db:reindex-phones
 *
 * Зачем. Индекс — это HMAC от нормализованного номера, и сравнивать между
 * собой можно только отпечатки, посчитанные одним секретом. Пока индекс
 * считался на JWT_SECRET, смена секрета подписи (штатная реакция на утечку)
 * молча ломала дедупликацию: «номер уже используется» переставало
 * срабатывать, и один человек заводил второй аккаунт, чтобы начать с
 * чистого листа, — а лонгитюд по нему уже не склеивался.
 *
 * Теперь у индекса свой секрет, и переезд на него — разовая операция,
 * которую выполняет этот скрипт. Пересчёт возможен ровно потому, что номер
 * лежит рядом шифрованным: расшифровали, нормализовали, посчитали заново.
 * У аккаунтов без сохранённого номера пересчитывать нечего — индекс
 * обнуляется, иначе в базе осталась бы строка, которая не совпадёт ни с
 * чем и при этом занимает уникальность.
 *
 * Идемпотентен: повторный прогон переписывает те же значения теми же.
 */
import { eq } from "drizzle-orm";
import { baseDb, client, db } from "./db";
import { systemContext } from "./db/context";
import { users } from "./db/schema";
import { decryptField } from "./lib/crypto";
import { normalizePhone, phoneFingerprint } from "./lib/phone";

const report = await systemContext(baseDb, async () => {
  let updated = 0;
  let cleared = 0;
  let unreadable = 0;

  const rows = await db
    .select({ id: users.id, phoneEnc: users.phoneEnc, phoneIndex: users.phoneIndex })
    .from(users);

  for (const row of rows) {
    const plain = decryptField(row.phoneEnc);
    const normalized = plain ? normalizePhone(plain) : null;

    if (!normalized) {
      /*
       * Номера нет или он не читается (утрачен ключ шифрования). Оставлять
       * старый отпечаток нельзя: он посчитан другим секретом и означает
       * «такой номер уже есть» для номера, которого система не знает.
       */
      if (row.phoneEnc && !normalized) unreadable++;
      if (row.phoneIndex !== null) {
        await db.update(users).set({ phoneIndex: null }).where(eq(users.id, row.id));
        cleared++;
      }
      continue;
    }

    const next = phoneFingerprint(normalized);
    if (next === row.phoneIndex) continue;
    await db.update(users).set({ phoneIndex: next }).where(eq(users.id, row.id));
    updated++;
  }

  return { total: rows.length, updated, cleared, unreadable };
});

console.log(`учётных записей просмотрено: ${report.total}`);
console.log(`  индекс пересчитан: ${report.updated}`);
console.log(`  индекс снят (номера нет): ${report.cleared}`);
if (report.unreadable) {
  console.log(`  номер не расшифровался: ${report.unreadable} — проверьте ENCRYPTION_KEY`);
}

await client.end();
