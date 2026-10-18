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

/** Вид списка: по состоянию строки или всё сразу */
export type InviteView = InviteState | "all";

export const INVITE_VIEWS: readonly InviteView[] = ["live", "used", "expired", "revoked", "all"];

export function isInviteView(v: string): v is InviteView {
  return (INVITE_VIEWS as readonly string[]).includes(v);
}

/** Сколько строк в каждом виде — по загруженному */
export function inviteCounts(rows: readonly Invite[], now: number): Record<InviteView, number> {
  const out: Record<InviteView, number> = { live: 0, used: 0, expired: 0, revoked: 0, all: rows.length };
  for (const r of rows) out[inviteState(r, now)]++;
  return out;
}

/**
 * Строки вида и поиска. Поиск — по коду, подразделу, привязке и заметке: код
 * диктуют по телефону, подразделение — то, по чему ссылку вспоминают.
 */
export function shownInvites(rows: readonly Invite[], view: InviteView, q: string, now: number): Invite[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (view !== "all" && inviteState(r, now) !== view) return false;
    if (!needle) return true;
    return [r.code, r.unit ?? "", r.batteryTitle ?? "", r.surveyTitle ?? "", r.note ?? ""].some((s) => s.toLowerCase().includes(needle));
  });
}

/**
 * Сколько мест осталось у живой ссылки, когда об этом стоит сказать: у
 * групповой ссылки (больше одного входа) и только когда осталось три и
 * меньше. У одноразовой «лишилось 1 місце» — шум: это и так её смысл.
 */
export function placesLeft(inv: Pick<Invite, "usedCount" | "maxUses">): number | null {
  const left = inv.maxUses - inv.usedCount;
  return inv.maxUses > 1 && left > 0 && left <= 3 ? left : null;
}

/** Сколько людей вошло по ссылкам за последние `days` дней — по загруженным строкам */
export function joinedSince(rows: readonly Invite[], now: number, days = 30): number {
  const from = now - days * 86_400_000;
  return rows.reduce((n, r) => n + r.uses.filter((u) => Date.parse(u.usedAt) >= from).length, 0);
}
