import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env";
import { log } from "./log";

/**
 * Прикладное шифрование чувствительных полей (AES-256-GCM).
 *
 * Зачем поверх шифрования диска: дамп базы, бэкап или доступ DBA не должны
 * раскрывать ФИО и свободнотекстовые ответы. Числовые баллы и поля когорт
 * (пол, подразделение) намеренно открыты — по ним работает SQL-аналитика.
 *
 * Формат: `enc1:<keyId>:<iv b64>:<ciphertext+tag b64>`. Значения без префикса
 * читаются как есть — старые незашифрованные строки остаются читаемыми, а
 * бэкфилл может идти постепенно. keyId в каждом значении — задел под ротацию:
 * новые записи шифруются активным ключом, старые читаются своим.
 *
 * Без ENCRYPTION_KEY модуль работает насквозь — и только вне production.
 * В production отсутствие ключа роняет процесс (см. env.ts): установка,
 * пишущая карты пациентов открытым текстом, ничем себя не выдаёт, и
 * предупреждения в логе для этого недостаточно.
 */

const PREFIX = "enc1";

interface LoadedKey {
  id: string;
  key: Buffer;
}

function loadKeys(spec: string): { active: LoadedKey | null; byId: Map<string, Buffer> } {
  const byId = new Map<string, Buffer>();
  let active: LoadedKey | null = null;
  // формат: "v1:<base64 32 байта>[,v2:<base64>]" — первый ключ активный
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = part.split(":");
    if (!id || !b64) continue;
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) {
      throw new Error(`ENCRYPTION_KEY ${id}: ожидается 32 байта в base64, получено ${key.length}`);
    }
    byId.set(id, key);
    active ??= { id, key };
  }
  return { active, byId };
}

let keys = loadKeys(env.encryptionKeys);

/**
 * Перезагрузка ключей в тестах: модуль — синглтон на процесс, а тестовые
 * файлы задают разные ключи. Продуктовый код это не вызывает никогда.
 */
export function reloadKeysForTests(spec: string): void {
  keys = loadKeys(spec);
}

/*
 * Проверка повторяет ту, что в env.ts, и это не дублирование.
 *
 * Там проверяется, что переменная не пуста, здесь — что из неё получился
 * хотя бы один ключ. Между этими условиями есть щель: «v1» без ключа,
 * «случайная строка», «ENCRYPTION_KEY=,» — всё это непустые значения, из
 * которых loadKeys не берёт ничего и молча возвращает активный ключ null.
 * Опечатка в ключе — самый вероятный способ получить установку, которая
 * считает себя шифрованной и пишет открытым текстом.
 */
if (env.isProduction && !keys.active) {
  throw new Error(
    [
      "ENCRYPTION_KEY задан, но ни одного ключа из него не получилось.",
      "",
      "Ожидается v1:<32 байта в base64>[,v2:<...>]. Проверьте формат:",
      "  echo \"v1:$(head -c 32 /dev/urandom | base64)\"",
    ].join("\n"),
  );
}

export function isEncryptionEnabled(): boolean {
  return keys.active !== null;
}

/*
 * Ключи наружу отдаются здесь, а не разбираются по второму разу.
 *
 * Записи приёма шифруются файлами, и lib/recordings разбирал ENCRYPTION_KEY
 * сам. Две реализации одного формата разошлись бы молча, а заодно вторая не
 * видела бы reloadKeysForTests и не знала бы ничего о ключах, кроме первого.
 */

/** Активный ключ: им шифруется всё новое */
export function activeKey(): { id: string; key: Buffer } | null {
  return keys.active;
}

/** Ключ по идентификатору из заголовка значения или файла */
export function keyById(id: string): Buffer | undefined {
  return keys.byId.get(id);
}

/**
 * Какие версии ключа загружены — только идентификаторы, без самих ключей.
 *
 * Нужны техпанели (раздел «Ключі й секрети»): сверить версии в данных с
 * версиями в окружении. Порядок — как в ENCRYPTION_KEY, первый — основной.
 */
export function loadedKeyIds(): string[] {
  return [...keys.byId.keys()];
}

/**
 * Строгая расшифровка: признак успеха вместо «не расшифровано».
 *
 * decryptField на отказе возвращает строку-пометку — для экрана это честно,
 * а для перешифровки смертельно: пометка, зашифрованная новым ключом,
 * навсегда заменила бы собой настоящее значение. Перешифровка и проверка
 * «открывает ли ключ свои значения» ходят только сюда.
 */
export function tryDecryptField(
  value: string,
): { ok: true; plain: string } | { ok: false; keyId: string | null } {
  if (!value.startsWith(`${PREFIX}:`)) return { ok: true, plain: value };
  const [, keyId, ivB64, payloadB64] = value.split(":");
  const key = keyId ? keys.byId.get(keyId) : undefined;
  if (!key || !ivB64 || !payloadB64) return { ok: false, keyId: keyId ?? null };
  try {
    const payload = Buffer.from(payloadB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    return { ok: true, plain: plain.toString("utf8") };
  } catch {
    return { ok: false, keyId: keyId ?? null };
  }
}
/** @deprecated снимок на момент импорта; используйте isEncryptionEnabled() */
export const encryptionEnabled = keys.active !== null;

export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined) return null;
  if (!keys.active) return plain;
  if (plain === "") return ""; // пустая строка семантически «нет значения»
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.active.key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}:${keys.active.id}:${iv.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith(`${PREFIX}:`)) return value; // легаси-открытый текст
  const [, keyId, ivB64, payloadB64] = value.split(":");
  const key = keyId ? keys.byId.get(keyId) : undefined;
  if (!key || !ivB64 || !payloadB64) {
    // ключ утрачен или значение битое: честная пометка вместо мусора или падения
    log.error("crypto.key_missing", { keyId });
    return "«не расшифровано»";
  }
  try {
    const payload = Buffer.from(payloadB64, "base64");
    const tag = payload.subarray(payload.length - 16);
    const ct = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (error) {
    log.error("crypto.decrypt_failed", { error: String(error) });
    return "«не расшифровано»";
  }
}

/** Поля учётной записи, уходящие в базу шифрованными */
export function encryptPersonFields<T extends {
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  birthDate?: string | null;
}>(values: T): T {
  return {
    ...values,
    ...(values.firstName !== undefined && { firstName: encryptField(values.firstName) }),
    ...(values.lastName !== undefined && { lastName: encryptField(values.lastName) }),
    ...(values.middleName !== undefined && { middleName: encryptField(values.middleName) }),
    ...(values.birthDate !== undefined && { birthDate: encryptField(values.birthDate) }),
  };
}
