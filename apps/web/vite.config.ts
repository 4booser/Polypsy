import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Короткий sha сборки: при разборе инцидента сверяем «что задеплоено» */
function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(gitSha()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // общий пакет подключается по исходникам: отдельная сборка ему не нужна
      "@quizzy/shared": fileURLToPath(new URL("../../packages/shared/src", import.meta.url)),
    },
  },
  // Смоук-тесты гоняются против собранной консоли, а не dev-сервера:
  // в проде отдаётся именно сборка, и ломается обычно она.
  preview: {
    port: 4199,
    strictPort: true,
    proxy: {
      // порт задаётся снаружи: смоук-стенд не должен драться за 3001 с
      // запущенным dev-сервером разработчика
      /*
       * Регулярное выражение, а не префикс. Простое "/api" совпадает и с
       * "/api-docs" — маршрутом самой консоли, — и экран описания API
       * уходил на сервер, где его нет. В production Caddy уже настроен на
       * "/api/*", то есть разработка вела себя иначе, чем бой.
       */
      "^/api/": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  server: {
    // 5173 часто занят другими проектами — берём отдельный порт
    port: 5199,
    strictPort: true,
    proxy: {
      // то же правило, что и в preview: префикс "/api" ловил бы "/api-docs"
      "^/api/": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
