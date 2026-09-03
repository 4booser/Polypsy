import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { refreshTokens, users } from "../db/schema";
import { issueToken } from "./auth";
import { isPast } from "./time";

/**
 * Жизненный цикл refresh-токенов.
 *
 * Модель: access — короткий JWT, refresh — непрозрачная случайная строка,
 * хранится хешем, одноразова. Ротация связывает перевыпуски в «семью»:
 * повторное предъявление уже погашенного токена читается как кража (у вора и
 * жертвы оказались копии одного токена, одна из них уже была обменена) — и
 * отзывается вся семья, разлогинивая обоих.
 */

export const REFRESH_TTL_DAYS = 30;

function hashToken(raw: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  return digest;
}

function newRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export interface IssuedPair {
  token: string;
  refreshToken: string;
}

/** Выдача новой пары при логине/регистрации: новая семья */
export async function issuePair(user: { id: string; role: "superadmin" | "admin" | "user" }): Promise<IssuedPair> {
  const raw = newRawToken();
  await db.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: hashToken(raw),
    familyId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000).toISOString(),
  });
  return { token: await issueToken(user), refreshToken: raw };
}

export type RefreshOutcome =
  | { ok: true; pair: IssuedPair; userId: string }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused"; userId?: string };

/** Обмен refresh-токена на новую пару с ротацией */
/**
 * Притязание на обмен токена: помечает его погашенным, если он ещё не погашен.
 *
 * Отдельной функцией, потому что в ней вся суть: гашение выражено условием
 * самого UPDATE, а не проверкой прочитанного раньше значения. Проверка
 * чтением неустранимо гоночная — два запроса с одним украденным токеном оба
 * её проходили и оба получали живую пару в одной семье, а обнаружение кражи
 * не срабатывало ровно там, ради чего написано.
 *
 * Возвращает ложь, если токен уже погашен кем-то другим. Для вызывающего это
 * то же самое, что повторное предъявление.
 */
export async function claimRotation(tx: typeof db, id: string): Promise<boolean> {
  const taken = await tx
    .update(refreshTokens)
    .set({ rotatedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.rotatedAt)))
    .returning({ id: refreshTokens.id });
  return taken.length > 0;
}

export async function rotateRefresh(raw: string): Promise<RefreshOutcome> {
  const row = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(raw)),
  });
  if (!row) return { ok: false, reason: "unknown" };

  if (row.revokedAt) return { ok: false, reason: "revoked", userId: row.userId };

  if (row.rotatedAt) {
    // повторное предъявление погашенного токена — гасим всю семью
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    return { ok: false, reason: "reused", userId: row.userId };
  }

  if (isPast(row.expiresAt)) {
    return { ok: false, reason: "expired", userId: row.userId };
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) return { ok: false, reason: "unknown" };

  const nextRaw = newRawToken();
  /*
   * Гашение — условием самого UPDATE, а не по прочитанному раньше значению.
   *
   * Вся модель «семьи» держится на том, что повторное предъявление
   * погашенного токена читается как кража. Проверка `row.rotatedAt` выше
   * идёт вне транзакции, а запись была безусловной — два одновременных
   * запроса с одним украденным токеном оба проходили проверку и оба
   * получали живую пару в одной семье. Вор уходил с собственной действующей
   * цепочкой, жертва ничего не замечала: обнаружение кражи не срабатывало
   * ровно там, ради чего написано.
   *
   * Ноль затронутых строк означает, что кто-то нас опередил, — то есть тот
   * же случай, что и повторное предъявление.
   */
  let raced = false;
  await db.transaction(async (tx) => {
    if (!(await claimRotation(tx as never, row.id))) {
      raced = true;
      return;
    }
    await tx.insert(refreshTokens).values({
      id: crypto.randomUUID(),
      userId: row.userId,
      tokenHash: hashToken(nextRaw),
      familyId: row.familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000).toISOString(),
    });
  });

  if (raced) {
    /*
     * Нас опередили тем же токеном — это и есть повторное предъявление.
     * Гасим семью, как при обычном повторе: два предъявления одного
     * одноразового токена означают, что копий у него две.
     */
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    return { ok: false, reason: "reused", userId: row.userId };
  }

  return {
    ok: true,
    userId: row.userId,
    pair: { token: await issueToken(user), refreshToken: nextRaw },
  };
}

/** Отзыв по сырому токену (logout) */
export async function revokeByToken(raw: string): Promise<void> {
  const row = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(raw)),
  });
  if (!row) return;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
}

/** Отзыв всех сессий пользователя: смена пароля, смена роли, блокировка */
export async function revokeAllFor(userId: string): Promise<number> {
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}
