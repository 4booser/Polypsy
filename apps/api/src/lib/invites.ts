import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { batteries, batteryAssignments, batteryItems, invites, inviteUses, surveyAccess, surveys } from "../db/schema";
import { isPast } from "./time";

/**
 * Механика приглашений.
 *
 * Токен — случайная строка в ссылке, код — короткий человекочитаемый для
 * ручного ввода. Оба ведут к одной записи; в базе токен только хешем.
 */

export function hashInviteToken(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

export function newInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** Код без похожих символов (0/O, 1/I/l): диктуется по телефону без ошибок */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export type InviteLookup =
  | { ok: true; invite: typeof invites.$inferSelect }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "exhausted" };

/** Поиск по токену ИЛИ по коду с проверкой годности */
export async function findUsableInvite(raw: string): Promise<InviteLookup> {
  const normalized = raw.trim();
  const byToken = await db.query.invites.findFirst({
    where: eq(invites.tokenHash, hashInviteToken(normalized)),
  });
  const row =
    byToken ??
    (await db.query.invites.findFirst({
      where: eq(invites.code, normalized.toUpperCase()),
    }));
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (isPast(row.expiresAt)) return { ok: false, reason: "expired" };
  if (row.usedCount >= row.maxUses) return { ok: false, reason: "exhausted" };
  return { ok: true, invite: row };
}

/**
 * Погашение приглашения новым пользователем: счётчик, след, назначение батареи.
 *
 * Счётчик инкрементируется атомарно с проверкой лимита — два одновременных
 * входа по последнему использованию не проскочат оба.
 */
export async function consumeInvite(
  invite: typeof invites.$inferSelect,
  userId: string,
): Promise<{ ok: boolean }> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(invites)
      .set({ usedCount: sql`${invites.usedCount} + 1` })
      .where(sql`${invites.id} = ${invite.id} and ${invites.usedCount} < ${invites.maxUses}`)
      .returning({ id: invites.id });
    if (!updated) return { ok: false };

    await tx.insert(inviteUses).values({ inviteId: invite.id, userId });

    if (invite.batteryId) {
      const battery = await tx.query.batteries.findFirst({ where: eq(batteries.id, invite.batteryId) });
      if (battery && !battery.archived) {
        // снятые методики по приглашению не выдаются — как и везде
        const items = await tx
          .select({ surveyId: batteryItems.surveyId })
          .from(batteryItems)
          .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
          .where(and(eq(batteryItems.batteryId, battery.id), isNull(surveys.archivedAt)));
        if (items.length) {
          await tx.insert(batteryAssignments).values({
            id: crypto.randomUUID(),
            batteryId: battery.id,
            userId,
            assignedBy: invite.createdBy,
            note: "По приглашению",
          });
          await tx
            .insert(surveyAccess)
            .values(
              items.map((item) => ({
                surveyId: item.surveyId,
                userId,
                grantedBy: invite.createdBy,
                note: "По приглашению",
              })),
            )
            .onConflictDoNothing();
        }
      }
    }
    return { ok: true };
  });
}
