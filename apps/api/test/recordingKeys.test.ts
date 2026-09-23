import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { reloadKeysForTests } from "../src/lib/crypto";
import { readAudio, storeAudio } from "../src/lib/recordings";
import { env } from "../src/env";

/**
 * Ротация ключей не должна делать прежние записи приёмов нечитаемыми.
 *
 * Поля называют свой ключ в самом значении (enc1:<id>:…), а файлы записей
 * — нет: они шифровались первым ключом из списка и читались тоже первым.
 * После ротации первым становится новый ключ, и весь архив разговоров
 * превращается в шум. Заметно это не в день ротации, а когда специалист
 * откроет прошлогодний приём, — и восстановить будет нечего.
 */

const KEY_A = `vA:${Buffer.alloc(32, 11).toString("base64")}`;
const KEY_B = `vB:${Buffer.alloc(32, 22).toString("base64")}`;
const AUDIO = new Uint8Array(512).map((_, i) => (i * 7) % 251);

/*
 * Ключи модуля общие на процесс, поэтому в конце возвращаем те, с которыми
 * работает остальная сюита: их задаёт preload (и переопределяет тест самого
 * crypto) через ENCRYPTION_KEY.
 */
afterAll(() => reloadKeysForTests(process.env.ENCRYPTION_KEY ?? ""));

const head = (blob: Buffer) => blob.subarray(0, 8).toString("latin1");

describe("ключ записи приёма", () => {
  test("запись, сделанная до ротации, читается после неё", async () => {
    reloadKeysForTests(KEY_A);
    const path = await storeAudio(`rot-${crypto.randomUUID()}`, AUDIO);
    // ключ назван в самом файле — иначе после ротации спросить не у кого
    expect(head(await readFile(path))).toBe("enc1:vA:");

    // ротация: новый ключ встаёт первым, прежний остаётся в списке вторым
    reloadKeysForTests(`${KEY_B},${KEY_A}`);
    expect(Buffer.from(await readAudio(path))).toEqual(Buffer.from(AUDIO));

    // а новые записи идут уже новым ключом
    const fresh = await storeAudio(`rot-${crypto.randomUUID()}`, AUDIO);
    expect(head(await readFile(fresh))).toBe("enc1:vB:");
    expect(Buffer.from(await readAudio(fresh))).toEqual(Buffer.from(AUDIO));
  });

  test("файл без заголовка читается первым ключом", async () => {
    /*
     * Так лежат записи, сделанные до этой правки. Пишем их прежним
     * способом — iv, тег, тело и ни слова о ключе: читать их всё равно
     * придётся, и другого способа, кроме «первым ключом», нет.
     */
    reloadKeysForTests(KEY_A);
    const path = resolve(join(env.recordingsDir, `legacy-${crypto.randomUUID()}.enc`));
    await mkdir(dirname(path), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 11), iv);
    const body = Buffer.concat([cipher.update(AUDIO), cipher.final()]);
    await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), body]));

    expect(Buffer.from(await readAudio(path))).toEqual(Buffer.from(AUDIO));
  });

  test("утраченный ключ — понятный отказ, а не мусор под видом разговора", async () => {
    reloadKeysForTests(KEY_A);
    const path = await storeAudio(`lost-${crypto.randomUUID()}`, AUDIO);
    // ключ vA выведен из обращения целиком — такого не должно быть, но если
    // случилось, отказ обязан назвать причину
    reloadKeysForTests(KEY_B);
    expect(readAudio(path)).rejects.toThrow(/vA/);
  });
});
