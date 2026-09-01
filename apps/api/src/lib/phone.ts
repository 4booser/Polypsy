import { createHmac } from "node:crypto";
import { env } from "../env";

/**
 * Нормализация номера.
 *
 * Один и тот же телефон человек записывает пятью способами: с восьмёркой, с
 * плюсом, со скобками, с пробелами. Без нормализации слепой индекс ловил бы
 * не дубликаты, а совпадения написания — то есть почти ничего.
 *
 * Приводим к международному виду с плюсом. Украинские номера, начинающиеся с
 * 0, дополняются кодом страны: это самый частый способ записи внутри страны,
 * и не учесть его значит пропускать половину дубликатов.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;

  let value = digits.startsWith("+") ? digits.slice(1) : digits;
  value = value.replace(/\D/g, "");

  if (value.length === 10 && value.startsWith("0")) value = `380${value.slice(1)}`;
  // «8 0XX...» — старая привычка набора внутри страны
  else if (value.length === 11 && value.startsWith("80")) value = `380${value.slice(2)}`;

  /*
   * Границы широкие намеренно. Строгая проверка длины по стране означала бы
   * справочник планов нумерации, который устаревает; а отказ принять
   * настоящий номер хуже, чем принять неправдоподобный: номер всё равно
   * помечен как неподтверждённый.
   */
  if (value.length < 10 || value.length > 15) return null;
  return `+${value}`;
}

/**
 * Слепой индекс номера.
 *
 * HMAC, а не хеш: без секрета отпечаток нельзя перебрать по словарю — а
 * пространство телефонных номеров перебирается за минуты, и обычный хеш
 * означал бы, что база телефонов лежит открытой.
 */
export function phoneFingerprint(normalized: string): string {
  return createHmac("sha256", env.jwtSecret).update(`phone:${normalized}`).digest("base64url");
}
