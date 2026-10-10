import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * «Колонка входит в список» — одним параметром, а не параметром на элемент.
 *
 * inArray кладёт каждый id отдельным $n, а у протокола PostgreSQL на число
 * параметров два байта: выше 65 533 postgres.js запрос не отправляет. Списки
 * id прохождений методики туда дорастают — PHQ-9 скринингового учреждения ко
 * второму году, — и аналитика, «Якість», SPSS- и CSV-выгрузки на таком
 * объёме отказывали (#183, #184). Список уходит одной строкой JSON и
 * разворачивается в базе; так уже делает возрастное условие когорт
 * (routes/cohorts.ts). Пустой список — пустой отбор.
 *
 * Только для текстовых ключей: id у нас — text, сравнение с элементами
 * jsonb_array_elements_text идёт без приведения.
 */
export function inIds(column: SQLWrapper, ids: readonly string[]): SQL {
  return sql`${column} in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}
