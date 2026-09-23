/**
 * Бэкфилл шифрования: перешифровывает открытые значения существующих строк.
 *
 * Запуск: ENCRYPTION_KEY=... bun run db:encrypt
 * Идемпотентен: уже шифрованные значения (префикс enc1:) не трогаются,
 * прогонять можно сколько угодно раз и порциями.
 *
 * Сам проход живёт в lib/encryptBackfill — ради теста. Здесь остаётся то,
 * что относится к запуску процессом: проверка ключа и закрытие пула.
 */
import { client } from "./db";
import { isEncryptionEnabled } from "./lib/crypto";
import { runEncryptBackfill } from "./lib/encryptBackfill";

if (!isEncryptionEnabled()) {
  console.error("ENCRYPTION_KEY не задан — бэкфиллу нечем шифровать");
  process.exit(1);
}

const counts = await runEncryptBackfill();
console.log(`пользователи: перешифровано ${counts.users}`);
console.log(`тексты ответов: перешифровано ${counts.answers}`);
console.log(`заключения: перешифровано ${counts.conclusions}`);

await client.end();
