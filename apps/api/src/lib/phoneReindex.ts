import { and, asc, eq, ne } from "drizzle-orm";
import type { OpsPhoneReindexReport } from "@quizzy/shared";
import { db } from "../db";
import { users } from "../db/schema";
import { tryDecryptField } from "./crypto";
import { normalizePhone, phoneFingerprint } from "./phone";

/**
 * Пересчёт слепого индекса телефонов под текущий PHONE_INDEX_SECRET.
 *
 * Тело вынесено из скрипта src/phoneReindex.ts, как у бэкфилла шифрования:
 * пересчёт теперь запускается и кнопкой в техпанели (после ротации секрета),
 * а скрипт заканчивается client.end() — из маршрута его не вызвать.
 *
 * Контекст задаёт вызывающий: скрипт — системный, маршрут — asSystem внутри
 * запроса. Строки users под политиками, и без системной роли пересчёт
 * «успешно» обработал бы ноль учётных записей.
 */
export async function runPhoneReindex(): Promise<OpsPhoneReindexReport> {
  let updated = 0;
  let cleared = 0;
  let unreadable = 0;
  let conflicts = 0;

  /*
   * Старшие учётные записи — первыми: если один номер оказался у двух
   * (заведены до дедупликации), индекс достаётся той, что появилась
   * раньше, — её человек и знает как «свою».
   */
  const rows = await db
    .select({ id: users.id, phoneEnc: users.phoneEnc, phoneIndex: users.phoneIndex })
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id));

  for (const row of rows) {
    /*
     * Строгая расшифровка, а не decryptField: тот на отказе отдаёт пометку
     * «не расшифровано», и она ушла бы в normalizePhone как номер. Сейчас
     * пометка номером не нормализуется, но держаться на этом совпадении
     * незачем.
     */
    const opened = row.phoneEnc ? tryDecryptField(row.phoneEnc) : null;
    const normalized = opened?.ok ? normalizePhone(opened.plain) : null;

    if (!normalized) {
      /*
       * Номера нет или он не читается (утрачен ключ шифрования). Оставлять
       * старый отпечаток нельзя: он посчитан другим секретом и означает
       * «такой номер уже есть» для номера, которого система не знает.
       */
      if (row.phoneEnc) unreadable++;
      if (row.phoneIndex !== null) {
        await db.update(users).set({ phoneIndex: null }).where(eq(users.id, row.id));
        cleared++;
      }
      continue;
    }

    const next = phoneFingerprint(normalized);
    if (next === row.phoneIndex) continue;

    /*
     * Индекс уникален, и один номер у двух учётных записей — не выдумка:
     * так бывает с записями, заведёнными до дедупликации. Скрипт на этом
     * падал целиком посреди прохода (unique violation), а маршрут техпанели
     * отвечал бы пятисоткой. Младшей записи индекс не ставится — снимается,
     * — и дубль считается: разбирать его человеку, а не проходу.
     */
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phoneIndex, next), ne(users.id, row.id)))
      .limit(1);
    if (taken) {
      conflicts++;
      if (row.phoneIndex !== null) {
        await db.update(users).set({ phoneIndex: null }).where(eq(users.id, row.id));
        cleared++;
      }
      continue;
    }

    await db.update(users).set({ phoneIndex: next }).where(eq(users.id, row.id));
    updated++;
  }

  return { total: rows.length, updated, cleared, unreadable, conflicts };
}
