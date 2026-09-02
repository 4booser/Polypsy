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

/*
 * Локализованные поля перечислены поимённо, и рядом — поимённый список
 * тех, что локализованными не являются. Вместе они обязаны покрывать все
 * jsonb-колонки базы: проверка ниже это и требует.
 *
 * Так сделано потому, что первый список был набран руками и покрывал
 * восемь колонок из тридцати пяти. Инструкция к методике и план
 * безопасности в него не входили — а их читает пациент, и одноязычная
 * инструкция означает украинца, читающего русский текст под украинским
 * вопросом. Ровно та жалоба, ради которой всё это писалось.
 *
 * Новая jsonb-колонка теперь заставляет сделать выбор, а не молча
 * оказывается непроверенной.
 */
const LOCALIZED: [string, string][] = [
  ["surveys", "title"],
  ["surveys", "description"],
  ["surveys", "instructions"],
  ["surveys", "safety_plan"],
  ["sections", "title"],
  ["sections", "description"],
  ["questions", "title"],
  ["questions", "help"],
  ["questions", "risk_label"],
  /*
   * Подписи концов шкалы: их видит пациент во время прохождения — «0 — Не
   * мешала … 10 — Мешала критически». Хранились простой строкой, то есть
   * на одном языке, и в украинском режиме человек читал русские подписи
   * под украинским вопросом.
   */
  ["questions", "min_label"],
  ["questions", "max_label"],
  ["options", "text"],
  ["options", "risk_label"],
  ["scales", "title"],
  ["scales", "description"],
  ["scales", "validity_message"],
  ["scale_bands", "label"],
  ["scale_bands", "description"],
  ["scale_bands", "recommendation"],
  ["departments", "title"],
  ["pathways", "title"],
  ["pathways", "description"],
  ["pathway_steps", "title"],
  ["roles", "title"],
  ["consent_texts", "body"],
];

/** jsonb, который хранит данные, а не текст для человека */
const NOT_TEXT: [string, string][] = [
  ["answers", "matrix"],
  ["answers", "option_ids"],
  ["answers", "ranking"],
  ["answer_events", "value"],
  ["audit_log", "details"],
  ["cohorts", "spec"],
  ["decision_rules", "actions"],
  ["decision_rules", "conditions"],
  ["question_logic", "value"],
  ["users", "workspace"],
  /*
   * Объяснение срабатывания правила складывается из имён шкал и чисел в
   * момент срабатывания. Локализовать его как хранимое поле нельзя —
   * язык читателя в этот момент неизвестен; это отдельная задача, и
   * помечать её локализованной значило бы соврать проверке.
   */
  ["rule_hits", "explanation"],
];

describe("двуязычность содержимого", () => {
  const fields = LOCALIZED;

  for (const [table, column] of fields) {
    test(`${table}.${column} заполнено на обоих языках`, async () => {
      expect(await monolingual(table, column)).toEqual([]);
    });
  }

  test("ни одна jsonb-колонка не осталась неразобранной", async () => {
    /*
     * Полнота, а не выборка. Первый список покрывал восемь колонок из
     * тридцати пяти, и узнать об этом можно было только пересчитав их
     * вручную — то есть никогда.
     */
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public' and data_type = 'jsonb'
    `);
    const known = new Set(
      [...LOCALIZED, ...NOT_TEXT].map(([t, c]) => `${t}.${c}`),
    );
    const unclassified = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((k) => !known.has(k))
      .sort();

    expect(unclassified).toEqual([]);
    // и наоборот: список не должен ссылаться на колонки, которых уже нет
    const actual = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    expect([...known].filter((k) => !actual.has(k)).sort()).toEqual([]);
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
