import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Адрес базы смоук-стенда.
 *
 * Порядок: явный E2E_DATABASE_URL (так задаётся в CI) → база разработчика из
 * apps/api/.env с подменённым именем БД → postgres по умолчанию. Подмена
 * только имени, а не пользователя: локальный Postgres обычно ходит под
 * учёткой разработчика, и роли `postgres` в нём просто нет.
 */
export function standDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;

  // CommonJS-совместимо: конфиг Playwright грузится нодой без type: module
  const envFile = join(process.cwd(), "apps/api/.env");
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_URL="));
    if (line) {
      const url = new URL(line.slice("DATABASE_URL=".length).trim());
      url.pathname = "/quizzy_e2e";
      return url.toString();
    }
  }
  return "postgres://postgres@localhost:5432/quizzy_e2e";
}

export const API_PORT = process.env.E2E_API_PORT ?? "3199";
export const WEB_PORT = process.env.E2E_WEB_PORT ?? "4199";
