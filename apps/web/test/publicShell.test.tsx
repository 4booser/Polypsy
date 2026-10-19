import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { PublicFrame } from "../src/pages/public/PublicFrame";
import { LangMenu } from "../src/shell/LangMenu";
import { Button, ButtonLink } from "../src/ui/primitives";

/**
 * Два правила публичной части, которые глазом не проверить.
 *
 * Оба уже нарушались, и оба раза — молча: вид правленого экрана оставался
 * верным, а ломалось то, чего на этом экране не видно. Первое — про близнецов
 * с одинаковыми именами свойств; второе — про кнопку языка, у которой цвет
 * был прибит числом и не следовал за темой.
 */

const render = (node: ReactElement) =>
  renderToStaticMarkup(
    <LangProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </LangProvider>,
  );

const classes = (html: string) => new Set(html.match(/class="([^"]*)"/)![1].split(/\s+/));
/* классы самой кнопки: у меню языка первой в разметке стоит обёртка MenuButton */
const buttonClasses = (html: string) => new Set(html.match(/<button[^>]*class="([^"]*)"/)![1].split(/\s+/));

describe("ButtonLink — близнец Button", () => {
  test("без свойств обе рисуют одну кнопку", () => {
    /*
     * Сравниваются не «умолчания в исходнике», а то, что из них вышло: у
     * обеих размер и заливка приходят из одной функции buttonClass, и при
     * согласных умолчаниях наборы классов совпадают целиком. Разойдись
     * умолчания (было «md»/«paper» против «sm»/«primary»), в разнице
     * оказались бы h-, px-, text-[…] и заливка.
     */
    const button = classes(render(<Button>дія</Button>));
    const link = classes(render(<ButtonLink to="/куди">дія</ButtonLink>));
    /* одна таблица классов (buttonClass): ссылка и кнопка не расходятся ни в чём */
    expect([...button].filter((c) => !link.has(c)).sort()).toEqual([]);
    expect([...link].filter((c) => !button.has(c)).sort()).toEqual([]);
  });
});

describe("язык на полосе приложения и в шапке кабинета", () => {
  test("кнопка — настоящая мишень, а не слово с накладкой, и без чисел цвета", () => {
    /*
     * Polypsy 2.0: язык — кнопка 40 (полоса приложения) или 44 (шапка
     * кабинета и гостевых страниц) со значком и словом. Прежде слово стояло
     * голым в 20-м кегле с площадкой нажатия накладкой — из-за того, что
     * правая группа верхней полосы была прибита к замеренному краю; полосы
     * больше нет, и мишень теперь своя.
     *
     * Цвет — токенами: полоса приложения тёмная в обеих темах и несёт свои
     * (appbar-*), шапка следует за темой. Число цвета в классе означало бы
     * полосу, которая не меняется вместе с темой, — так было с «#663399».
     */
    for (const [node, height] of [
      [<LangMenu key="a" />, "h-10"],
      [<LangMenu key="b" tone="band" />, "h-11"],
    ] as const) {
      const cls = buttonClasses(render(node));
      expect(cls.has(height), `высота мишени не ${height}`).toBe(true);
      expect([...cls].filter((c) => /#[0-9a-f]{3,6}/i.test(c)), "число цвета в классе кнопки языка").toEqual([]);
    }
  });
});

describe("рамка гостевых страниц", () => {
  const frame = () =>
    render(
      <PublicFrame>
        <p>лист</p>
      </PublicFrame>,
    );

  test("«Увійти» в шапке — тонированная кнопка набора, а не вторая залитая рядом с основной кнопкой страницы", () => {
    const tag = frame().match(/<a[^>]*href="\/login"[^>]*>/)?.[0] ?? "";
    const cls = new Set(/class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? []);
    expect(cls.has("bg-violet-tint")).toBe(true);
    expect(cls.has("text-violet-ink")).toBe(true);
    expect(cls.has("bg-violet")).toBe(false);
    expect(cls.has("h-10")).toBe(true);
  });

  test("подвал — текущий год и имя системы; «©2023» и «Про кампанію» прежнего кадра кампании ушли", () => {
    const html = frame();
    expect(html).toContain(`© ${new Date().getFullYear()} Polypsy`);
    expect(html).not.toContain("©2023");
    expect(html).not.toMatch(/Про кампанію|О кампании|About the campaign/);
  });
});
