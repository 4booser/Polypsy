/**
 * Бэкфилл шифрования: перешифровывает открытые значения существующих строк.
 *
 * Идемпотентен: уже шифрованные значения (префикс enc1:) не трогаются,
 * прогонять можно сколько угодно раз и порциями.
 *
 * Тело вынесено из скрипта src/encryptBackfill.ts в библиотеку, чтобы у
 * бэкфилла был тест. Скрипт заканчивается client.end() и process.exit — из
 * теста его можно было бы только запустить отдельным процессом, а тогда
 * проверялся бы не бэкфилл, а умение подготовить ему окружение.
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { answers, conclusions, users } from "../db/schema";
import { encryptField } from "./crypto";

export interface BackfillCounts {
  users: number;
  answers: number;
  conclusions: number;
}

/*
 * Открытое значение отличается от шифртекста отсутствием заголовка enc1:,
 * а не видом самого значения.
 *
 * Проверять дату рождения по маске ГГГГ-ММ-ДД заманчиво, но маска отвечает
 * на другой вопрос: она говорит, похоже ли значение на дату, а не
 * зашифровано ли оно. Для ФИО и текстов ответов маски нет вовсе, и тогда у
 * одной таблицы было бы два разных правила «что считать открытым». Формат
 * шифртекста задан в lib/crypto одним местом — по нему и различаем.
 */
const plain = (v: string | null) => v !== null && v !== "" && !v.startsWith("enc1:");

/** Перешифровать всё, что лежит открытым. Возвращает, сколько строк тронуто */
export async function runEncryptBackfill(): Promise<BackfillCounts> {
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
  return systemContext(baseDb, async () => {
    // триггер неизменяемости подписанных заключений пропускает только
    // служебную сессию — включаем режим явно, след остаётся в логах Postgres
    await db.execute(sql`select set_config('app.maintenance', '1', true)`);

    const counts: BackfillCounts = { users: 0, answers: 0, conclusions: 0 };

    for (const row of await db.select().from(users)) {
      const patch: Record<string, string | null> = {};
      if (plain(row.firstName)) patch.firstName = encryptField(row.firstName);
      if (plain(row.lastName)) patch.lastName = encryptField(row.lastName);
      if (plain(row.middleName)) patch.middleName = encryptField(row.middleName);
      /*
       * Дата рождения — то самое поле, ради которого бэкфилл придётся
       * прогнать ещё раз: до исправления регистрации она уходила в базу
       * открытой (см. routes/auth.ts). Здесь она обрабатывалась и раньше,
       * так что отдельной дозаписи не нужно — нужен повторный прогон.
       */
      if (plain(row.birthDate)) patch.birthDate = encryptField(row.birthDate);
      if (Object.keys(patch).length) {
        await db.update(users).set(patch).where(eq(users.id, row.id));
        counts.users++;
      }
    }

    for (const row of await db.select({ id: answers.id, text: answers.text }).from(answers)) {
      if (!plain(row.text)) continue;
      await db.update(answers).set({ text: encryptField(row.text) }).where(eq(answers.id, row.id));
      counts.answers++;
    }

    for (const row of await db.select({ id: conclusions.id, text: conclusions.text }).from(conclusions)) {
      if (!plain(row.text)) continue;
      await db.update(conclusions).set({ text: encryptField(row.text)! }).where(eq(conclusions.id, row.id));
      counts.conclusions++;
    }

    return counts;
  });
}
