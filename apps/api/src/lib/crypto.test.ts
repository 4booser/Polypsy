import { describe, expect, test } from "bun:test";

// ключ задаётся ДО импорта модуля: crypto.ts читает env при загрузке
const KEY_SPEC = `v1:${Buffer.alloc(32, 7).toString("base64")},v0:${Buffer.alloc(32, 3).toString("base64")}`;
process.env.ENCRYPTION_KEY = KEY_SPEC;
const { decryptField, encryptField, isEncryptionEnabled, reloadKeysForTests } = await import("./crypto");
// модуль — синглтон на процесс: в полном прогоне его мог загрузить другой
// тестовый файл со своими ключами, поэтому свои задаём явно
reloadKeysForTests(KEY_SPEC);

describe("шифрование полей", () => {
  test("круговой цикл, включая кириллицу и переводы строк", () => {
    expect(isEncryptionEnabled()).toBe(true);
    for (const plain of ["Іваненко Петро Іванович", "многострочный\nтекст ответа", "a"]) {
      const enc = encryptField(plain)!;
      expect(enc.startsWith("enc1:v1:")).toBe(true);
      // «не содержит исходник» проверяем только для длинных строк: одиночный
      // символ вроде «a» случайно встречается в base64 — это был флейк
      if (plain.length > 3) expect(enc).not.toContain(plain);
      expect(decryptField(enc)).toBe(plain);
    }
  });

  test("один и тот же текст шифруется в разные значения (случайный IV)", () => {
    expect(encryptField("тест")).not.toBe(encryptField("тест"));
  });

  test("легаси-открытый текст проходит насквозь", () => {
    expect(decryptField("Открытый Текст")).toBe("Открытый Текст");
    expect(decryptField(null)).toBe(null);
    expect(encryptField("")).toBe("");
  });

  test("значение под старым ключом из списка читается (ротация)", () => {
    // шифруем «старым» ключом вручную
    const { createCipheriv, randomBytes } = require("node:crypto") as typeof import("node:crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 3), iv);
    const ct = Buffer.concat([cipher.update("старая запись", "utf8"), cipher.final(), cipher.getAuthTag()]);
    const value = `enc1:v0:${iv.toString("base64")}:${ct.toString("base64")}`;
    expect(decryptField(value)).toBe("старая запись");
    // а новые записи идут активным v1
    expect(encryptField("новая")!.startsWith("enc1:v1:")).toBe(true);
  });

  test("битое или неизвестное — честная пометка, не падение", () => {
    expect(decryptField("enc1:v9:AAAA:BBBB")).toBe("«не расшифровано»");
    expect(decryptField("enc1:v1:битый:мусор")).toBe("«не расшифровано»");
  });
});
