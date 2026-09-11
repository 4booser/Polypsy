import { sign, verify } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import { env } from "../env";
import { decryptField } from "./crypto";
import type { UserRow } from "../db/schema";
import type { User } from "@quizzy/shared";

// Короткий access: угнанный токен живёт минуты, продление — через refresh
const TOKEN_TTL_SECONDS = 60 * 30;
const ALG = "HS256" as const;

export interface TokenClaims extends JWTPayload {
  sub: string;
  role: "superadmin" | "admin" | "user";
  exp: number;
  /** Когда выдан, секунды эпохи — стандартное поле JWT */
  iat: number;
  /**
   * Когда выдан, миллисекунды эпохи. По нему работает отзыв.
   *
   * Отдельным полем, а не вместо `iat`, потому что `iat` по стандарту
   * считается в секундах: положить туда миллисекунды значит отдать токен,
   * который любая сторонняя проверка прочитает как выданный в 2445 году.
   * А секунды для отзыва грубы: «вошёл не в ту учётную запись и сразу
   * вышел» укладывается в одну секунду целиком, и при сравнении по `iat`
   * такой выход не отозвал бы ничего.
   */
  ims: number;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/**
 * Выдача access-токена.
 *
 * Отметка о времени выдачи — не украшение: на ней держится отзыв. У
 * пользователя есть метка users.tokens_valid_from, и токен, выданный раньше
 * неё, не принимается (см. middleware/auth.ts). Без отметки отличить «выдан
 * до выхода» от «выдан после» было бы нечем.
 *
 * Почему не jti со списком отозванных. Список означает отдельный запрос в
 * базу на КАЖДЫЙ запрос к API — включая те, что и так укладываются в один
 * поход, — и таблицу, которую надо чистить. Метка времени отвечает на тот
 * же вопрос одной колонкой в строке, которая в requireAuth всё равно
 * читается, и закрывает разом и выход, и смену пароля, и любой отзыв
 * сессий: «всё, что выдано раньше, недействительно» — это ровно то, что
 * нужно сказать в каждом из этих случаев.
 *
 * Плата — отзыв не бывает точечным: он гасит все access-токены человека,
 * а не только тот, с которого нажали «выйти». Для сеанса на другом
 * устройстве это одна 401, после которой консоль молча меняет refresh на
 * новую пару (его семья при выходе не трогается) и продолжает работу.
 */
export function issueToken(user: Pick<UserRow, "id" | "role">): Promise<string> {
  const nowMs = Date.now();
  const claims: TokenClaims = {
    sub: user.id,
    role: user.role,
    iat: Math.floor(nowMs / 1000),
    ims: nowMs,
    exp: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS,
  };
  return sign(claims, env.jwtSecret, ALG);
}

/**
 * Действителен ли токен на фоне метки отзыва.
 *
 * Токен без `ims` — выданный до появления отзыва — считается отозванным.
 * Иначе достаточно было бы предъявить старый токен, чтобы проверки не
 * было вовсе; а обновление системы и так сдвигает метку всем сразу (см.
 * миграцию 0074), то есть эти токены недействительны по любому счёту.
 */
export function issuedAfterRevocation(claims: TokenClaims, tokensValidFrom: string): boolean {
  if (!Number.isFinite(claims.ims)) return false;
  return claims.ims >= new Date(tokensValidFrom).getTime();
}

export async function readToken(token: string): Promise<TokenClaims | null> {
  try {
    return (await verify(token, env.jwtSecret, ALG)) as TokenClaims;
  } catch {
    return null;
  }
}

/**
 * Отображаемое имя. У псевдонимизированного аккаунта ФИО не хранится вовсе,
 * поэтому показывается код — и подменять его именем нечем даже случайно.
 */
export function fullNameOf(
  row: Partial<Pick<UserRow, "firstName" | "lastName" | "middleName" | "anonymous" | "pseudonym">>,
): string {
  if (row.anonymous) return row.pseudonym ?? "Респондент";
  // поля в базе шифрованы; decryptField пропускает легаси-открытый текст
  return [decryptField(row.lastName), decryptField(row.firstName), decryptField(row.middleName)]
    .filter(Boolean)
    .join(" ");
}

/** Код псевдонима: буква и четыре цифры, читаемо и достаточно различимо */
export function makePseudonym(): string {
  const letters = "АБВГДЕЖЗИКЛМНПРСТУФХЦЧШЭЮЯ";
  const letter = letters[Math.floor(Math.random() * letters.length)]!;
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `Респондент ${letter}-${digits}`;
}

/** Публичное представление пользователя — без хеша пароля */
export function toPublicUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    firstName: row.anonymous ? "" : (decryptField(row.firstName) ?? ""),
    lastName: row.anonymous ? "" : (decryptField(row.lastName) ?? ""),
    middleName: row.anonymous ? null : decryptField(row.middleName),
    fullName: fullNameOf(row),
    anonymous: row.anonymous,
    pseudonym: row.pseudonym,
    leadSpecialistId: row.leadSpecialistId ?? null,
    /*
     * Только факт связи, без идентификатора Google. Экрану нужно решить,
     * показывать «привязать» или «отвязать»; сам идентификатор ему для
     * этого не нужен, а отдавать наружу то, что не нужно, незачем.
     */
    googleLinked: Boolean(row.googleSub),
    sex: row.sex,
    birthDate: decryptField(row.birthDate),
    unit: row.unit,
    position: row.position,
    specialty: row.specialty,
    rank: row.rank,
    role: row.role,
    readOnly: row.readOnly,
    workspace: (row.workspace as never) ?? null,
    createdAt: row.createdAt,
  };
}
