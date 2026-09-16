import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  batteries,
  batteryAssignments,
  batteryItems,
  departmentPatients,
  invites,
  inviteUses,
  specialistProfiles,
  surveys,
  users,
} from "../db/schema";
import { grantAccess } from "./grantAccess";
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

    /*
     * Одна методика выдаётся напрямую.
     *
     * Через grantAccess, а не вставкой с onConflictDoNothing: приглашение
     * может быть вторым для того же человека — например взамен
     * просроченного, — и тогда «ничего не делать при совпадении» означало
     * бы, что по новой ссылке методика по-прежнему недоступна. Ровно на этом
     * уже обжигались с плановыми повторами.
     */
    if (invite.surveyId) {
      const [survey] = await tx
        .select({ id: surveys.id })
        .from(surveys)
        .where(and(eq(surveys.id, invite.surveyId), isNull(surveys.archivedAt)))
        .limit(1);
      if (survey) {
        await grantAccess(tx as never, [
          {
            surveyId: survey.id,
            userId,
            grantedBy: invite.createdBy,
            expiresAt: null,
            note: "По приглашению",
          },
        ]);
      }
    }

    /*
     * Закрепление за врачом — то самое явное действие, которого плану не
     * хватало.
     *
     * Человек, пришедший по ссылке, оказывался ничьим: его надо было потом
     * искать среди остальных и закреплять руками. Приглашение, выписанное
     * врачом, и есть явное «этот человек мой» — вывода из последнего приёма
     * здесь нет, есть прямое решение того, кто ссылку выписал.
     *
     * Ставится только если своего врача ещё нет: приглашение не должно
     * переназначать человека, которого уже ведут. Смена ведущего — отдельное
     * действие с записью в журнал, а не побочный эффект перехода по ссылке.
     */
    if (invite.specialistId) {
      await tx
        .update(users)
        .set({ leadSpecialistId: invite.specialistId })
        .where(and(eq(users.id, userId), isNull(users.leadSpecialistId)));

      /* и прикрепление к отделению врача — иначе повторный приём не записать */
      const [profile] = await tx
        .select({ departmentId: specialistProfiles.departmentId })
        .from(specialistProfiles)
        .where(eq(specialistProfiles.userId, invite.specialistId))
        .limit(1);
      if (profile) {
        await tx
          .insert(departmentPatients)
          .values({ departmentId: profile.departmentId, patientId: userId, attachedVia: "staff" })
          .onConflictDoNothing();
      }
    }

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
          await grantAccess(
            tx as never,
            items.map((item) => ({
              surveyId: item.surveyId,
              userId,
              grantedBy: invite.createdBy,
              expiresAt: null,
              note: "По приглашению",
            })),
          );
        }
      }
    }
    return { ok: true };
  });
}
