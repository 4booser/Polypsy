import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Одноразовые коды по времени — TOTP (RFC 6238) поверх HOTP (RFC 4226).
 *
 * Своими руками, а не пакетом: вся схема — HMAC-SHA1 от номера шага и
 * «динамическое усечение» до шести цифр, это двадцать строк поверх
 * node:crypto, и тянуть ради них зависимость в сервер, который держит
 * клинические данные, незачем (решение заказчика 2026-09-26: без новых
 * зависимостей). Правильность держат векторы из приложения B RFC 6238 —
 * они в тестах (opsPeople.test.ts).
 *
 * Параметры — те, что понимает любое приложение-аутентификатор без
 * подсказок: SHA-1, шаг 30 секунд, шесть цифр. SHA-256 и восемь цифр RFC
 * допускает, но половина приложений молча игнорирует их в otpauth-адресе и
 * показывает не те коды — человек видел бы «неверный код» при верном
 * телефоне.
 *
 * Модуль чистый: ни базы, ни часов по умолчанию, кроме явного `now`. Хранение,
 * повтор кода и лимит попыток — в lib/secondFactor.ts.
 */

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
/**
 * Окно ±1 шаг. Часы телефона уходят на десятки секунд, а человек набирает
 * код, пока тот меняется: без окна каждый третий верный код отвергался бы.
 * Шире — нет: окно ±2 это две с половиной минуты жизни подсмотренного кода.
 */
export const TOTP_WINDOW = 1;

/* ─────────── Base32 (RFC 4648) — так секрет живёт в otpauth-адресе ─────────── */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Декодирование терпит то, что делает человек, переписывая ключ руками:
 * строчные буквы, пробелы и дефисы между группами, знаки «=» в хвосте.
 * Любой другой знак — ошибка, а не молча выброшенный символ: секрет с
 * выброшенной буквой дал бы другие коды, и искать причину было бы нечем.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32: недопустимый знак");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ─────────── HOTP / TOTP ─────────── */

/** HOTP (RFC 4226): HMAC от восьмибайтового счётчика и динамическое усечение */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  /* счётчик шире 32 бит (T = 20000000000 из векторов) — старшая и младшая половины отдельно */
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Номер 30-секундного шага для момента времени (миллисекунды эпохи) */
export function stepAt(nowMs: number, period = TOTP_PERIOD_SEC): number {
  return Math.floor(nowMs / 1000 / period);
}

export function totp(secret: Uint8Array, nowMs: number, digits = TOTP_DIGITS, period = TOTP_PERIOD_SEC): string {
  return hotp(secret, stepAt(nowMs, period), digits);
}

/** Сравнение без утечки по времени: коды одной длины, и перебор не читает префикс по задержке */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Какому шагу из окна отвечает код; null — ни одному.
 *
 * Возвращается шаг, а не «да/нет»: по нему защищаются от повтора (принятый
 * шаг записывается, и код того же или более раннего шага второй раз не
 * проходит). Если код совпал с несколькими шагами окна — берётся последний:
 * так повтор в соседнем шаге тоже упрётся в записанное.
 */
export function matchStep(secret: Uint8Array, code: string, nowMs: number, window = TOTP_WINDOW): number | null {
  const digits = normalizeCode(code);
  if (digits.length !== TOTP_DIGITS) return null;
  const now = stepAt(nowMs);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    if (s >= 0 && sameCode(hotp(secret, s), digits)) matched = s;
  }
  return matched;
}

/** Код, как его набирает человек: «123 456», «123-456» — это шесть цифр */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/* ─────────── секрет и адрес для QR ─────────── */

/** 160 бит — длина, которую RFC 4226 называет рекомендуемой для SHA-1 */
export function newSecret(): Buffer {
  return randomBytes(20);
}

/**
 * Адрес otpauth:// — его рисует QR и понимает любое приложение.
 *
 * Метка «Polypsy:почта» — чтобы в приложении с десятком записей человек
 * узнал свою; issuer повторён параметром, как просит спецификация Key Uri
 * Format, — старые приложения читают его только оттуда.
 */
export function otpauthUrl(account: string, secretB32: string, issuer = "Polypsy"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ─────────── коды восстановления ─────────── */

/*
 * Алфавит кодов восстановления — без 0/o и 1/l/i: их переписывают с листка,
 * и «это ноль или буква?» не должно стоить единственного запасного входа.
 * Строчные — код набирают на телефоне, где верхний регистр лишнее нажатие.
 */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECOVERY_COUNT = 10;

/**
 * Десять кодов вида «k7m2-9xq4»: восемь знаков из 31 — около сорока бит.
 *
 * Сорок бит для одноразового кода, который проверяется сервером с лимитом
 * попыток (пять за пятнадцать минут, lib/loginGuard.ts), — это миллиарды
 * лет перебора вслепую. Отбор с отбраковкой: 256 на 31 не делится.
 */
export function newRecoveryCodes(count = RECOVERY_COUNT): string[] {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  const codes: string[] = [];
  while (codes.length < count) {
    const chars: string[] = [];
    while (chars.length < 8) {
      for (const b of randomBytes(16)) {
        if (b >= limit) continue;
        chars.push(RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]!);
        if (chars.length === 8) break;
      }
    }
    const code = `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Похоже ли введённое на код восстановления, а не на шесть цифр из приложения */
export function looksLikeRecovery(input: string): boolean {
  return /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(input.trim()) && /[a-z]/i.test(input);
}

/**
 * Хэш кода восстановления: sha256 с идентификатором учётки.
 *
 * Не argon2, как пароль, и это не экономия на безопасности. Пароль придумывает
 * человек, и медленный хэш защищает слабое слово от перебора по словарю.
 * Код восстановления — сорок случайных бит, словаря для него нет; argon2 здесь
 * стоил бы десяти медленных сверок на каждый ввод (проверяется каждый из
 * десяти кодов) и ничего не добавил бы. Идентификатор учётки в хэше — чтобы
 * одинаковые коды у двух людей (случайность, но возможная) не давали
 * одинаковых строк в таблице.
 */
export function recoveryHash(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${canonicalRecovery(code)}`).digest("hex");
}

/** Код восстановления в каноническом виде «xxxx-xxxx» — как его выдали */
export function canonicalRecovery(input: string): string {
  const raw = input.trim().toLowerCase().replace(/[\s-]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
