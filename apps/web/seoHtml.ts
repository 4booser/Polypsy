import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Две оболочки приложения из одного index.html.
 *
 * В index.html лежит текст главной — для тех, кто скрипт не выполняет:
 * поисковиков, AI-ассистентов, текстовых браузеров (комментарий там же). Но
 * сервер отдаёт оболочку и на любой путь приложения: /patients, /login,
 * /join/… — и робот, пришедший по такой ссылке, получил бы тот же рассказ о
 * продукте под чужим адресом. Сотня адресов с одинаковым текстом — это дубли
 * в выдаче, а не описание продукта.
 *
 * Поэтому сборка кладёт рядом app.html: та же страница без блока главной и с
 * noindex. Caddy отдаёт index.html только на корень, а на остальные пути —
 * app.html (apps/web/Caddyfile). Скрипты, стили и предзагрузка словаря в обеих
 * одинаковые: app.html получается из уже собранного index.html.
 */

const START = "<!-- static-landing:start -->";
const END = "<!-- static-landing:end -->";

export function appShellHtml(index: string): string {
  const from = index.indexOf(START);
  const to = index.indexOf(END);
  if (from < 0 || to < from) throw new Error("index.html: нет блока static-landing — app.html не из чего собрать");
  const shell = index.slice(0, from) + index.slice(to + END.length);
  // noindex сразу после charset: правило читают и те, кто разбирает только начало <head>
  return shell.replace(/(<meta charset="utf-8" \/>)/, '$1\n    <meta name="robots" content="noindex" />');
}

export function appShell(): Plugin {
  let outDir = "dist";
  return {
    name: "polypsy-app-shell",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const index = readFileSync(resolve(outDir, "index.html"), "utf8");
      writeFileSync(resolve(outDir, "app.html"), appShellHtml(index));
    },
  };
}
