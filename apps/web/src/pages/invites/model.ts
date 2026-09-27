import type { Invite } from "@quizzy/shared";

/**
 * Приглашения (Invites.tsx): состояние строки. Проверяется без браузера
 * (apps/web/test/referralsInvites.test.ts).
 */

/** Жива ли ссылка-приглашение */
export type InviteState = "live" | "revoked" | "used" | "expired";

/**
 * Состояние приглашения — от него зависит, есть ли у строки «відкликати».
 *
 * Отозванное — прежде всего: отзыв — решение человека, и строка говорит о
 * нём датой отзыва. Израсходованное и просроченное мертвы сами по себе;
 * отзывать их незачем, и кнопка там была бы действием, которое ничего не
 * меняет. Время сравнивается моментами, а не строками: сервер отдаёт ISO с
 * «Z», но строка со смещением («+03:00») сравнивалась бы по буквам.
 */
export function inviteState(
  inv: Pick<Invite, "revokedAt" | "usedCount" | "maxUses" | "expiresAt">,
  now: number,
): InviteState {
  if (inv.revokedAt) return "revoked";
  if (inv.usedCount >= inv.maxUses) return "used";
  const expires = Date.parse(inv.expiresAt);
  if (Number.isFinite(expires) && expires < now) return "expired";
  return "live";
}
