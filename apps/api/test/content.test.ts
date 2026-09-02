import { beforeAll, describe, expect, test } from "bun:test";
import { adminA, api, db, patient, surveyInA } from "./fixtures";
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

describe("язык содержимого следует за читателем", () => {
  /*
   * `t()` без второго аргумента отдаёт украинский всегда. Так и жила
   * очередь работы — первый экран рабочего дня: названия методик
   * по-украински тому, кто выбрал русский интерфейс. «СР-45. Схильність до
   * суїцидальних реакцій · Срочно» — это не двуязычие, это две половины от
   * разных языков в одной строке.
   *
   * В направлениях было зеркально и хуже: язык был прибит к «ru» прямо в
   * коде, и украиноязычный специалист читал русские названия.
   *
   * Проверяется поведением через настоящий заголовок Accept-Language:
   * одна и та же выдача на двух языках обязана отличаться.
   */
  const ask = (path: string, token: string, lang: string) =>
    api(path, token, { headers: { "Accept-Language": lang } });

  beforeAll(async () => {
    /*
     * Свой случай, а не одолженный у соседей: занятый в общей базе случай
     * делает проверку зависимой от порядка файлов, и падать она начинает
     * не там, где сломано.
     */
    const { alertCases } = await import("../src/db/schema");
    await db.insert(alertCases).values({
      id: crypto.randomUUID(),
      userId: patient.id,
      surveyId: surveyInA,
      severity: "severe",
    });
  });

  test("очередь работы отдаёт названия на языке запроса", async () => {
    const uk = await ask("/api/worklist", adminA.token, "uk");
    const ru = await ask("/api/worklist", adminA.token, "ru");
    expect(uk.status).toBe(200);
    expect(ru.status).toBe(200);

    const titles = (r: typeof uk) =>
      (r.body.items as { kind: string; title: string }[])
        .filter((i) => i.kind === "case" || i.kind === "alert")
        .map((i) => i.title);

    const inUk = titles(uk);
    const inRu = titles(ru);
    expect(inUk.length, "в очереди нет ни одной строки — проверять нечего").toBeGreaterThan(0);
    expect(inRu).not.toEqual(inUk);
  });

  test("случаи риска отдают названия на языке запроса", async () => {
    const uk = await ask("/api/alert-cases", adminA.token, "uk");
    const ru = await ask("/api/alert-cases", adminA.token, "ru");
    const titles = (r: typeof uk) =>
      (r.body.items as { surveyTitle: string }[]).map((i) => i.surveyTitle);

    expect(titles(uk).length, "случаев нет — проверять нечего").toBeGreaterThan(0);
    expect(titles(ru)).not.toEqual(titles(uk));
  });
});
