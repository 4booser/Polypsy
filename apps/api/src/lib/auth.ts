import { sign, verify } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";
import { env } from "../env";
import type { UserRow } from "../db/schema";
import type { User } from "@quizzy/shared";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 дней
const ALG = "HS256" as const;

export interface TokenClaims extends JWTPayload {
  sub: string;
  role: "superadmin" | "admin" | "user";
  exp: number;
}

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function issueToken(user: Pick<UserRow, "id" | "role">): Promise<string> {
  const claims: TokenClaims = {
    sub: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  return sign(claims, env.jwtSecret, ALG);
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
  return [row.lastName, row.firstName, row.middleName].filter(Boolean).join(" ");
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
    firstName: row.anonymous ? "" : row.firstName,
    lastName: row.anonymous ? "" : row.lastName,
    middleName: row.anonymous ? null : row.middleName,
    fullName: fullNameOf(row),
    anonymous: row.anonymous,
    pseudonym: row.pseudonym,
    sex: row.sex,
    birthDate: row.birthDate,
    unit: row.unit,
    position: row.position,
    specialty: row.specialty,
    rank: row.rank,
    role: row.role,
    createdAt: row.createdAt,
  };
}
