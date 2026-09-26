import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { LangMenu } from "../src/shell/LangMenu";
import { Button, ButtonLink } from "../src/ui/primitives";

/**
 * Два правила публичной части, которые глазом не проверить.
 *
 * Оба уже нарушались, и оба раза — молча: вид правленого экрана оставался
 * верным, а ломалось то, чего на этом экране не видно. Первое — про близнецов
 * с одинаковыми именами свойств; второе — про площадку нажатия, которая
 * двигала слово на ЧУЖИХ экранах.
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
     * обеих размер и заливка приходят из одних таблиц `sizes`/`variants`, и
     * при согласных умолчаниях наборы классов расходятся ровно на то, чем
     * ссылка отличается от кнопки, — на подчёркивание и на недоступность.
     * Разойдись умолчания (было «md»/«paper» против «sm»/«primary»), в
     * разнице оказались бы h-, px-, text-[…] и заливка.
     */
    const button = classes(render(<Button>дія</Button>));
    const link = classes(render(<ButtonLink to="/куди">дія</ButtonLink>));
    expect([...button].filter((c) => !link.has(c)).sort()).toEqual([
      "disabled:opacity-45",
      "disabled:pointer-events-none",
    ]);
    expect([...link].filter((c) => !button.has(c)).sort()).toEqual(["hover:no-underline", "no-underline"]);
  });
});

describe("«Укр» в полосе", () => {
  test("площадка нажатия дорисована накладкой и места не занимает", () => {
    /*
     * Правая группа полосы прибита к правому краю колонки, поэтому ЛЮБАЯ
     * заданная ширина или высота у самой кнопки растёт влево и уводит слово
     * с замеренного места на всех экранах консоли разом. Накладке расти
     * некуда: она вне потока.
     */
    for (const node of [<LangMenu />, <LangMenu tone="token" side="start" />]) {
      const cls = buttonClasses(render(node));
      expect(cls.has("after:size-[44px]"), "площадки нажатия 44×44 не стало").toBe(true);
      const box = [...cls].filter((c) => /^-?(min-)?[wh]-\[/.test(c));
      expect(box, "коробка «Укр» получила свой размер — слово уедет влево").toEqual([]);
    }
  });
});
