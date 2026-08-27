import { defineConfig, devices } from "@playwright/test";
// порты смоука намеренно не совпадают с dev (3001/5199) — стенды не мешают друг другу
import { API_PORT, WEB_PORT, standDatabaseUrl } from "./e2e/stand";

/**
 * Смоук веб-консоли против настоящего стенда: собранная консоль + живой API +
 * своя база. Юнит- и интеграционные тесты проверяют логику; здесь проверяется
 * то, что они увидеть не могут — что страница вообще отрисовалась, кнопка
 * дошла до сервера, а сборка не рассыпалась.
 *
 * База отдельная (`quizzy_e2e`) и пересоздаётся перед прогоном: смоук должен
 * стартовать с известного состояния и никогда не трогать базу разработчика.
 */
const apiEnv = {
  DATABASE_URL: standDatabaseUrl(),
  JWT_SECRET: "e2e-secret-not-for-production-0123456789",
  PORT: API_PORT,
  NODE_ENV: "development",
};

export default defineConfig({
  testDir: "./e2e",
  // .e2e.ts, а не .spec.ts: иначе `bun test` в корне подхватит эти файлы и
  // упадёт на импорте @playwright/test
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  globalSetup: "./e2e/globalSetup.ts",

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: "ru-RU",
    timezoneId: "Europe/Kyiv",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: "bun run --cwd apps/api start",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      env: apiEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // сборка перед подъёмом: иначе смоук проверяет вчерашний dist
      command: `bun run --cwd apps/web build && bun run --cwd apps/web preview --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
