import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
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
  plugins: [react(), tailwind()],
  build: {
    /* карта исходников — по запросу: по ней разбирается состав кусков (см. bundle.test.ts) */
    sourcemap: !!process.env.BUILD_SOURCEMAP,
    rollupOptions: {
      /*
       * Общий пакет — без побочных эффектов при загрузке.
       *
       * Консоль берёт его одной точкой входа (index.ts → export * from …), и
       * сборщик, не зная, чисты ли модули, тащил каждый целиком: схемы zod
       * сервера (schemas.ts) ехали в начальный кусок консоли, которая их не
       * вызывает ни разу. Модули пакета — объявления и чистые функции, а
       * «чистоту» здесь проверяет сборка: модуль с настоящим побочным
       * эффектом выпадет, и экран, которому он нужен, сломается в первом же
       * смоук-прогоне, а не тихо.
       */
      treeshake: { moduleSideEffects: (id: string) => !id.includes("/packages/shared/src/") },
      output: {
        /*
         * Решение заказчика 2026-09-26 (волна 12, разбор кода: «весь бандл
         * консоли загружался одним файлом»): начальный кусок делится на три.
         *
         *  react   — React, React DOM, маршрутизатор и слой загрузки
         *            (TanStack Query, волна 13): меняются раз в полгода, а
         *            не с каждой выкаткой, и браузер держит их в кэше между
         *            версиями консоли;
         *  strings — словарь интерфейса на трёх языках, почти половина
         *            начального куска по весу: меняется почти с каждой
         *            выкаткой, и отдельным файлом не тянет за собой
         *            перекачку всего остального;
         *  index   — сама консоль: оболочка, вход, общие компоненты.
         *
         * Экраны и тяжёлые библиотеки (графики, cmdk, виртуализация) сюда не
         * входят вовсе — они в своих кусках по требованию (App.tsx).
         */
        manualChunks(id: string) {
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@tanstack\/(react-query|query-core))\//.test(id)) return "react";
          if (id.includes("/packages/shared/src/uiStrings.ts")) return "strings";
          return undefined;
        },
      },
    },
  },
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
      // то же правило, что и в preview: префикс "/api" ловил бы "/api-docs";
      // и тот же адрес снаружи — второй стенд рядом с рабочим (своя база,
      // свой API) не должен драться с ним за 3001
      "^/api/": { target: process.env.API_PROXY_TARGET ?? "http://localhost:3001", changeOrigin: true },
    },
  },
});
