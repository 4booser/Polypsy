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
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused" | "disabled"; userId?: string };

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
  /*
   * И не отозван (#138): ждавший строку обмен перечитывает её после
   * фиксации отзыва, и условие только на rotated_at пропускало его в уже
   * отозванную семью.
   */
  const taken = await tx
    .update(refreshTokens)
    .set({ rotatedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.rotatedAt), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return taken.length > 0;
}

/**
 * Замок на строку владельца — точка, в которой обмен и отзыв встают в одну
 * очередь (#138).
 *
 * Без неё они гасили и выпускали токены разными UPDATE и не видели друг
 * друга целиком. Отзыв первым: обмен ждал строку старого токена, перечитывал
 * её после фиксации отзыва и выпускал в отозванной семье живой токен. Обмен
 * первым: новый токен вставлялся, пока отзыв ждал строку старого, а отзыв,
 * перечитав одну её, нового не видел — «завершить все сессии» и смена
 * пароля оставляли держателю украденного токена живую цепочку.
 *
 * Под замком каждый следующий оператор видит всё, что зафиксировал
 * предшественник в очереди: обмен после отзыва — отозванный токен, отзыв
 * после обмена — выпущенный им новый. Строка пользователя, а не токена:
 * отзыв гасит токены, которых при его начале ещё не было. NO KEY UPDATE —
 * чтобы не мешать вставкам, ссылающимся на пользователя (их внешний ключ
 * берёт KEY SHARE).
 *
 * Держится до конца транзакции вызывающего: внутри запроса — до его
 * фиксации, вне контекста — до конца db.transaction вокруг.
 */
async function lockOwner(tx: typeof db, userId: string) {
  const [owner] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
  return owner;
}

export async function rotateRefresh(raw: string): Promise<RefreshOutcome> {
  const found = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(raw)),
  });
  if (!found) return { ok: false, reason: "unknown" };

  return db.transaction(async (t): Promise<RefreshOutcome> => {
    const tx = t as unknown as typeof db;
    /*
     * Сначала очередь за отзывами этого человека (lockOwner), потом всё
     * остальное — по строке, перечитанной уже под замком: прочитанная до
     * него могла устареть, пока мы ждали.
     */
    const owner = await lockOwner(tx, found.userId);
    const row = await tx.query.refreshTokens.findFirst({ where: eq(refreshTokens.id, found.id) });
    if (!row) return { ok: false, reason: "unknown" };

    /*
     * Выключенная учётка — раньше всех прочих причин (техпанель, 0088).
     *
     * Выключение гасит все семьи, так что без этой строки обмен всё равно
     * отказал бы — но словами «сессия истекла», и мобильное приложение
     * показывало бы человеку предложение войти заново, а вход отвечал бы уже
     * другим текстом. Причина одна, и назвать её надо одинаково везде.
     * Раскрывать тут нечего: токен предъявил тот, кто в эту учётку входил.
     */
    if (owner?.disabledAt) return { ok: false, reason: "disabled", userId: row.userId };

    if (row.revokedAt) return { ok: false, reason: "revoked", userId: row.userId };

    if (row.rotatedAt) {
      // повторное предъявление погашенного токена — гасим всю семью
      await revokeOnReuse(tx, row);
      return { ok: false, reason: "reused", userId: row.userId };
    }

    if (isPast(row.expiresAt)) {
      return { ok: false, reason: "expired", userId: row.userId };
    }

    if (!owner) return { ok: false, reason: "unknown" };

    /*
     * Гашение — условием самого UPDATE, а не по прочитанному раньше значению.
     *
     * Вся модель «семьи» держится на том, что повторное предъявление
     * погашенного токена читается как кража. Проверка `row.rotatedAt` выше
     * когда-то шла вне транзакции, а запись была безусловной — два
     * одновременных запроса с одним украденным токеном оба проходили
     * проверку и оба получали живую пару в одной семье. Вор уходил с
     * собственной действующей цепочкой, жертва ничего не замечала:
     * обнаружение кражи не срабатывало ровно там, ради чего написано.
     *
     * Ноль затронутых строк означает, что кто-то нас опередил, — то есть тот
     * же случай, что и повторное предъявление: два предъявления одного
     * одноразового токена означают, что копий у него две.
     */
    if (!(await claimRotation(tx, row.id))) {
      await revokeOnReuse(tx, row);
      return { ok: false, reason: "reused", userId: row.userId };
    }

    const nextRaw = newRawToken();
    await tx.insert(refreshTokens).values({
      id: crypto.randomUUID(),
      userId: row.userId,
      tokenHash: hashToken(nextRaw),
      familyId: row.familyId,
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000).toISOString(),
    });

    return {
      ok: true,
      userId: row.userId,
      pair: { token: await issueToken(owner), refreshToken: nextRaw },
    };
  });
}

/**
 * Сдвиг границы действительности access-токенов.
 *
 * Живёт здесь, рядом с отзывом refresh, а не в маршрутах, — и это главное
 * в этом изменении. Отзыв сессии, забывший погасить access-токены, ничем
 * себя не выдаёт: человек нажал «выйти», экран очистился, всё выглядит
 * правильно, и только следующие полчаса чужой токен открывает карты. Пока
 * обязанность лежала на маршруте, её и забыли — POST /logout гасил семью
 * refresh и на этом заканчивал.
 *
 * Теперь погасить refresh, не сдвинув границу, нельзя: это одна функция.
 */
async function invalidateAccessTokens(tx: typeof db, userId: string): Promise<void> {
  /*
   * Граница — на миллисекунду позже текущей (#138): обмен, опередивший отзыв
   * в очереди за строкой владельца, выдаёт свой access до фиксации, и он
   * может прийтись на ту же миллисекунду, что и граница, — а сравнение
   * «выдан не раньше границы» такой токен пропустило бы. Всё, что выдано
   * до отзыва или одновременно с ним, должно умереть вместе с ним.
   */
  await tx
    .update(users)
    .set({ tokensValidFrom: new Date(Date.now() + 1).toISOString() })
    .where(eq(users.id, userId));
}

/**
 * Повторное предъявление — кража: гасится семья И граница access-токенов.
 *
 * Внешний разбор 2026-09-26: семья гасилась, а граница оставалась, хотя
 * выход, смена пароля и завершение сессии её сдвигают. Вор, успевший
 * обменять украденный токен первым, уходил с живым access ещё на полчаса:
 * обнаружение кражи закрывало ему будущее и не трогало настоящее. Одна
 * функция на оба пути обнаружения (обычный повтор и проигранная гонка) —
 * чтобы второй не забыл то, что помнит первый.
 *
 * Сдвиг задевает все устройства человека, как и при выходе: остальным это
 * стоит одной 401 и обмена их (живых) семей. Для жертвы это правильно
 * вдвойне — её консоль тоже держит копию украденной цепочки и выходит на
 * вход, где ей и надо быть.
 */
async function revokeOnReuse(tx: typeof db, row: { familyId: string; userId: string }): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
  await invalidateAccessTokens(tx, row.userId);
}

/** Отзыв по сырому токену (logout) */
export async function revokeByToken(raw: string): Promise<void> {
  const row = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(raw)),
  });
  if (!row) return;
  await db.transaction(async (t) => {
    const tx = t as unknown as typeof db;
    // в очередь за обменами этого человека: выпущенный ими токен семьи гасится тоже (lockOwner)
    await lockOwner(tx, row.userId);
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    /*
     * Выход гасит access-токены целиком, а не только те, что выданы этой
     * семьёй: в самом токене семьи не записано, и выбирать не из чего. Для
     * сеанса на другом устройстве это одна 401 и незаметный обмен refresh —
     * его семья не отозвана. Для того, кто вышел, — ровно то, что он просил.
     */
    await invalidateAccessTokens(tx, row.userId);
  });
}

/**
 * Отзыв одной сессии — семьи — по её идентификатору (техпанель, «Сесії»).
 *
 * Та же пара действий, что у выхода: семья гасится, граница access-токенов
 * сдвигается. Сдвиг задевает и остальные сессии человека, но им это стоит
 * одной 401 и незаметного обмена refresh — их семьи живы. Без сдвига
 * «завершённая» сессия ещё до получаса открывала бы карты тем, что у неё уже
 * на руках, а завершают сессию обычно ровно тогда, когда подозревают чужие
 * руки.
 *
 * Возвращает владельца семьи или null, если живой семьи с таким
 * идентификатором нет.
 */
export async function revokeFamily(familyId: string): Promise<string | null> {
  const [member] = await db
    .select({ userId: refreshTokens.userId })
    .from(refreshTokens)
    .where(eq(refreshTokens.familyId, familyId))
    .limit(1);
  if (!member) return null;
  return db.transaction(async (t) => {
    const tx = t as unknown as typeof db;
    await lockOwner(tx, member.userId);
    const rows = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ userId: refreshTokens.userId });
    const userId = rows[0]?.userId ?? null;
    if (userId) await invalidateAccessTokens(tx, userId);
    return userId;
  });
}

/** Отзыв всех сессий пользователя: смена пароля, смена роли, блокировка */
export async function revokeAllFor(userId: string): Promise<number> {
  return db.transaction(async (t) => {
    const tx = t as unknown as typeof db;
    // в очередь за обменами: токен, выпущенный опередившим нас обменом, гасится тоже (lockOwner)
    await lockOwner(tx, userId);
    const rows = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    await invalidateAccessTokens(tx, userId);
    return rows.length;
  });
}
