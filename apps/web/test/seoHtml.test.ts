import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appShellHtml } from "../seoHtml";

/**
 * Главная для тех, кто скрипт не выполняет, и оболочка для остальных путей.
 *
 * Поисковики и AI-ассистенты получали пустой <div id="root"> под заголовком
 * «Quizzy»: весь текст главной рисовал скрипт. Теперь он лежит в index.html, а
 * app.html — та же страница без него и с noindex (seoHtml.ts, Caddyfile).
 */

const index = readFileSync(resolve(import.meta.dir, "../index.html"), "utf8");

describe("index.html для роботов", () => {
  test("текст главной — в разметке, с заголовком продукта и описанием", () => {
    expect(index).toContain("<!-- static-landing:start -->");
    expect(index).toMatch(/<h1>Polypsy[^<]*<\/h1>/);
    expect(index).toMatch(/<meta\s+name="description"/);
    expect(index).not.toContain("Quizzy");
  });

  test("браузер со скриптом блок не показывает: атрибут ставится до <body>", () => {
    const head = index.slice(0, index.indexOf("</head>"));
    expect(head).toContain('setAttribute("data-js", "")');
    expect(head).toContain("[data-js] #static-landing { display: none }");
  });

  test("главная индексируется", () => {
    expect(index).not.toContain("noindex");
  });
});

describe("appShellHtml", () => {
  const shell = appShellHtml(index);

  test("без текста главной и с noindex", () => {
    expect(shell).not.toContain("static-landing:start");
    expect(shell).not.toContain("<h1>");
    expect(shell).toContain('<div id="root"></div>');
    expect(shell).toContain('<meta name="robots" content="noindex" />');
  });

  test("скрипты и заголовки страницы те же, что у главной", () => {
    expect(shell).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(shell).toContain("<title>Polypsy</title>");
  });

  test("без блока — ошибка сборки, а не молча пустая оболочка", () => {
    expect(() => appShellHtml("<html><body><div id=\"root\"></div></body></html>")).toThrow();
  });
});
