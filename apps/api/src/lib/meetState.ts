import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";

/**
 * Состояние возврата от Google, подписанное, а не хранимое.
 *
 * Соответствие «состояние → специалист» нельзя держать в памяти процесса:
 * инстансов API может быть несколько, и возврат придёт не в тот, что выдал
 * ссылку, — подключение молча не сработает у каждого второго. Подпись
 * решает это без общего хранилища: кто выдал, тот и проверит, а подделать
 * без секрета нельзя.
 *
 * Срок жизни — десять минут: столько занимает согласие у Google, а
 * бессрочное состояние можно было бы предъявить через год.
 */
const TTL_MS = 600_000;

function sign(payload: string): string {
  return createHmac("sha256", env.jwtSecret).update(payload).digest("base64url");
}

export function signState(userId: string): string {
  const payload = `${userId}.${Date.now()}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

/** Идентификатор специалиста, если подпись цела и срок не вышел */
export function verifyState(state: string): string | null {
  const [encoded, mac] = state.split(".");
  if (!encoded || !mac) return null;
  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = sign(payload);
  // сравнение постоянного времени: побайтовое подбирает подпись за сотни попыток
  if (expected.length !== mac.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;

  const [userId, at] = payload.split(".");
  if (!userId || !at) return null;
  if (Date.now() - Number(at) > TTL_MS) return null;
  return userId;
}
