import { describe, expect, test } from "bun:test";
import { db } from "./fixtures";
import { sql } from "drizzle-orm";

/**
 * Содержимое на двух языках.
 *
 * Приложение в украинском режиме выглядело русским, и это была не ошибка
 * перевода интерфейса — интерфейс переведён. Русское приходило из
 * содержимого: локализованное поле, заполненное одним языком, — это то же
 * самое, что незаполненное, потому что в другом режиме оно всё равно
 * покажет чужой язык.
 *
 * Проверка держит это состояние. Без неё одноязычная методика заводится
 * молча и обнаруживается через полгода на экране у пациента.
 */

/** Сколько строк локализованного поля заполнены не на обоих языках */
async function monolingual(table: string, column: string): Promise<string[]> {
  const rows = await db.execute<{ sample: string }>(
    sql.raw(`
      select left(coalesce(${column}->>'ru', ${column}->>'uk', '?'), 60) as sample
      from ${table}
      where ${column} is not null
        and not (${column} ? 'uk' and ${column} ? 'ru')
      limit 20
    `),
  );
  return rows.map((r) => r.sample);
}

describe("двуязычность содержимого", () => {
  const fields: [string, string][] = [
    ["surveys", "title"],
    ["questions", "title"],
    ["options", "text"],
    ["scales", "title"],
    ["scale_bands", "label"],
    ["departments", "title"],
  ];

  for (const [table, column] of fields) {
    test(`${table}.${column} заполнено на обоих языках`, async () => {
      expect(await monolingual(table, column)).toEqual([]);
    });
  }

  test("подписи концов шкалы тоже локализованы", async () => {
    /*
     * Их видит пациент во время прохождения: «0 — Не мешала … 10 — Мешала
     * критически». Хранились простой строкой, то есть на одном языке, — и в
     * украинском режиме человек читал русские подписи под украинским
     * вопросом.
     */
    expect(await monolingual("questions", "min_label")).toEqual([]);
    expect(await monolingual("questions", "max_label")).toEqual([]);
  });

  test("проверка не проходит вхолостую", async () => {
    /*
     * Пустая база дала бы зелёный результат, ничего не проверив. Тестовая
     * база засеяна фикстурами, но не демо-данными, поэтому счёт берём с
     * методик, которые заводят сами фикстуры.
     */
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from surveys where title is not null`,
    );
    expect(Number(row?.n ?? 0)).toBeGreaterThan(0);
  });
});
