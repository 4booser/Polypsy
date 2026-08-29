import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { noteSearch, patientNotes, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { badRequest, parseQuery } from "../lib/http";
import { accessiblePatientIds } from "../lib/scope";
import { queryFingerprints, stems } from "../lib/searchIndex";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const searchRoutes = new Hono<AppEnv>();
searchRoutes.use("*", requireAuth, requireStaff);

/**
 * Поиск по записям приёма.
 *
 * Записи зашифрованы, поэтому ищется не текст, а отпечатки основ слов
 * (`lib/searchIndex`). Найденные записи расшифровываются — но только те,
 * которые уже прошли отбор по отпечаткам и по зоне ответственности, то есть
 * единицы, а не вся база.
 *
 * Все слова запроса обязаны встретиться в записи. «Или» здесь было бы почти
 * бесполезно: запрос из двух слов выдавал бы всё, где есть хоть одно.
 */

const query = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

searchRoutes.get("/notes", async (c) => {
  const staff = c.get("user");
  const { q, limit } = parseQuery(c, query);

  const words = stems(q);
  if (!words.length) {
    /*
     * Запрос из одних предлогов. Честный отказ вместо пустого результата:
     * «ничего не найдено» здесь означало бы «в записях нет слова “на”», что
     * неправда и сбивает с толку.
     */
    badRequest("Слишком короткие слова: ищем от трёх букв");
  }

  const fps = queryFingerprints(q);
  const allowed = await accessiblePatientIds(staff);
  if (allowed && allowed.size === 0) return c.json({ items: [], words });

  /*
   * Записи, где встретились ВСЕ отпечатки. Считается группировкой в базе:
   * пересекать списки в приложении означало бы вытащить все записи по самому
   * частому слову — то есть половину индекса.
   */
  const matched = await db
    .select({ noteId: noteSearch.noteId })
    .from(noteSearch)
    .where(
      and(
        inArray(noteSearch.fp, fps),
        allowed ? inArray(noteSearch.userId, [...allowed]) : undefined,
      ),
    )
    .groupBy(noteSearch.noteId)
    .having(sql`count(distinct ${noteSearch.fp}) = ${fps.length}`)
    .limit(limit);

  const ids = matched.map((m) => m.noteId);
  if (!ids.length) return c.json({ items: [], words });

  const rows = await db
    .select({ note: patientNotes, patient: users })
    .from(patientNotes)
    .leftJoin(users, eq(users.id, patientNotes.userId))
    .where(inArray(patientNotes.id, ids))
    .orderBy(desc(patientNotes.createdAt));

  await audit(c, {
    action: "search.notes",
    // сам запрос в журнал не пишется: он и есть клинический текст
    details: { words: words.length, found: rows.length },
  });

  return c.json({
    words,
    items: rows.map((r) => {
      const text = decryptField(r.note.text) ?? "";
      return {
        id: r.note.id,
        userId: r.note.userId,
        userName: r.patient ? fullNameOf(r.patient) : "—",
        kind: r.note.kind,
        version: r.note.version,
        status: r.note.status,
        createdAt: r.note.createdAt,
        excerpt: excerpt(text, words),
      };
    }),
  });
});

/**
 * Кусок записи вокруг первого совпадения.
 *
 * Показывать запись целиком в списке результатов нельзя: поиск по одному слову
 * выложил бы на экран десяток клинических текстов сразу, а прочитан будет
 * один. Отрывок — это ответ на вопрос «та ли это запись».
 */
function excerpt(text: string, words: string[], around = 90): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const word of words) {
    const found = lower.indexOf(word);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return text.slice(0, around * 2);

  const from = Math.max(0, at - around);
  const to = Math.min(text.length, at + around);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}
