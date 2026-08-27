/**
 * Подготовка окружения ДО загрузки любого тестового файла.
 *
 * Раньше это делал первый же тест на своём верхнем уровне — и работало ровно
 * до появления второго файла, который тоже поднимает приложение: bun грузит
 * их в один процесс, модуль `db` запоминает адрес базы при первом импорте, а
 * `crypto` — ключ. Кто успел первым, тот и определил окружение; тесты начали
 * ходить в рабочую базу.
 *
 * Правило имени жёсткое: тестовая база — всегда `<имя>_test`.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://abooser@localhost:5432/quizzy";
const parsed = new URL(baseUrl);
const baseName = parsed.pathname.slice(1);
const testName = baseName.endsWith("_test") ? baseName : `${baseName}_test`;
parsed.pathname = `/${testName}`;

/** Адрес рабочей базы — только чтобы пересоздать тестовую */
export const ADMIN_DATABASE_URL = baseUrl;
export const TEST_DATABASE_NAME = testName;

process.env.DATABASE_URL = parsed.toString();
process.env.SCHEDULER_ENABLED = "0";
process.env.JWT_SECRET ??= "test-secret-not-for-production-0123456789";
// сюита гоняется С ШИФРОВАНИЕМ: это и есть сквозная проверка интеграции
process.env.ENCRYPTION_KEY = `v1:${Buffer.alloc(32, 9).toString("base64")}`;
