import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Курсор постраничности из двух полей.
 *
 * Одного времени мало — оно повторяется. Приём идёт потоком, замеры сдают
 * одновременно, и на границе страницы условие «строго раньше курсора»
 * выбрасывало всех, кто попал в ту же метку: один показывался, второй не
 * попадал ни на одну страницу. Потеря молчаливая — список выглядит целым, и
 * заметить её можно только по несовпадению с общим числом.
 *
 * Пара кодируется одной строкой, чтобы клиенту не пришлось знать её
 * устройство: сегодня это два поля, завтра может быть три.
 *
 * Живёт отдельным модулем, потому что нужен в нескольких списках сразу.
 * Написанный по копии в каждом, он и разошёлся: в одном списке пару чинили,
 * в другом — нет, и тот терял строки ещё год спустя.
 */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): { at: string; id: string } | null {
  if (!raw) return null;
  try {
    const [at, id] = Buffer.from(raw, "base64url").toString().split("|");
    return at && id ? { at, id } : null;
  } catch {
    // испорченный курсор — это первая страница, а не пятисотка
    return null;
  }
}

/*
 * ── Курсор по времени, записанному базой ──
 *
 * Колонки времени читаются через timestampCol, и тот отдаёт их округлёнными
 * до миллисекунд (toISOString). Для времени, поставленного приложением, это
 * без потерь — оно и было миллисекундным. А `default now()` пишет
 * микросекунды, и курсор из округлённого времени на границе страницы
 * выбрасывает строки: `(12:00:00.123456, id) < (12:00:00.123, …)` ложно, и
 * всё, что попало в ту же миллисекунду, не показывается ни на этой странице,
 * ни на следующей. Строки одной вставки получают один и тот же now(), так
 * что это не редкость, а обычная пачка: сорок направлений, заведённых разом,
 * обрывались на первой же границе.
 *
 * Поэтому время для курсора берётся из базы текстом, с микросекундами, а
 * сравнивается там же — приведением обратно к timestamptz.
 */

/** Время строки для курсора — в UTC и с микросекундами, как лежит в базе */
export const exactAt = (col: AnyPgColumn) =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const EXACT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Курсор, чьё время обязано быть точным (см. exactAt).
 *
 * Строже decodeCursor: мусор вместо времени дошёл бы до `::timestamptz` и
 * уронил запрос пятисоткой, а испорченный курсор — это первая страница.
 */
export function decodeExactCursor(raw: string | undefined | null): { at: string; id: string } | null {
  const cursor = decodeCursor(raw);
  return cursor && EXACT_AT.test(cursor.at) ? cursor : null;
}

/** «Строго после курсора» для порядка (время ↓, идентификатор ↓) — одной парой, не по частям */
export function afterCursor(at: AnyPgColumn, id: AnyPgColumn, cursor: { at: string; id: string } | null): SQL | undefined {
  return cursor ? sql`(${at}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined;
}
