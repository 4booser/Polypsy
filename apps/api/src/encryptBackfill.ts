/**
 * Бэкфилл шифрования: перешифровывает открытые значения существующих строк.
 *
 * Запуск: ENCRYPTION_KEY=... bun run db:encrypt
 * Идемпотентен: уже шифрованные значения (префикс enc1:) не трогаются,
 * прогонять можно сколько угодно раз и порциями.
 *
 * Вторым проходом — перевод на основной ключ всего, что лежит на других
 * (ротация, см. RUNBOOK): тот же проход запускает кнопка «Перешифрувати»
 * в техпанели. Он тоже идемпотентен: значение на основном ключе он не
 * выбирает вовсе.
 *
 * Сам проход живёт в lib/encryptBackfill — ради теста. Здесь остаётся то,
 * что относится к запуску процессом: проверка ключа и закрытие пула.
 */
import { client } from "./db";
import { activeKey, isEncryptionEnabled } from "./lib/crypto";
import { rewrapAll, runEncryptBackfill } from "./lib/encryptBackfill";

if (!isEncryptionEnabled()) {
  console.error("ENCRYPTION_KEY не задан — бэкфиллу нечем шифровать");
  process.exit(1);
}

const counts = await runEncryptBackfill();
console.log(`пользователи: перешифровано ${counts.users}`);
console.log(`тексты ответов: перешифровано ${counts.answers}`);
console.log(`заключения: перешифровано ${counts.conclusions}`);

const rewrap = await rewrapAll();
console.log(`на основной ключ ${activeKey()?.id} переведено значений: ${rewrap.rewrapped}, файлов записей: ${rewrap.files}`);
if (rewrap.skipped || rewrap.filesUnreadable) {
  console.log(
    `  не расшифровалось: значений ${rewrap.skipped}, файлов ${rewrap.filesUnreadable} — ключа нет в ENCRYPTION_KEY`,
  );
}

await client.end();
