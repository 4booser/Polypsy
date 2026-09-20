import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { ActionMenu, MenuButton, menuItem, menuItemClass } from "../src/ui/menu";

/**
 * Одно меню на каталог, карточки людей, конструктор моделей и группы —
 * после слияния волны 4 три копии свелись в ui/menu.tsx. Проверяется то, что
 * у копий расходилось первым и глазом не видно: обещания диктору в закрытом
 * состоянии и классы пунктов, где цвет задаётся тоном, а не наложением.
 */

const render = (node: ReactElement) =>
  renderToStaticMarkup(
    <LangProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </LangProvider>,
  );

describe("ui/menu", () => {
  test("закрытое меню: aria-expanded=false и ни aria-controls, ни role=menu в разметке", () => {
    /* aria-controls обязан указывать на существующий id; закрытое меню в разметке отсутствует */
    for (const html of [
      render(<MenuButton label="Дії" glyph={<span>+</span>}>{() => null}</MenuButton>),
      render(<ActionMenu label="Дії" glyph={<span>⚙</span>} entries={[{ label: "Редагувати", to: "/x" }]} />),
    ]) {
      expect(html).toContain('aria-haspopup="menu"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain("aria-controls");
      expect(html).not.toContain('role="menu"');
    }
  });

  test("тон пункта не спорит с обычным цветом: в строке классов один text-*", () => {
    const danger = menuItemClass("left", "danger");
    expect(danger).toContain("text-danger");
    expect(danger).not.toMatch(/\btext-text\b/);
    expect(danger).not.toContain("hover:bg-primary-soft");

    const disabled = menuItemClass("right", "disabled");
    expect(disabled).toContain("cursor-not-allowed");
    expect(disabled).not.toContain("hover:");

    /* пункт списка — левый, 13-й кегль; пункт карточки — правый, 15-й */
    expect(menuItem).toContain("text-left");
    expect(menuItem).toContain("text-[13px]");
    expect(menuItemClass("right")).toContain("justify-end");
    expect(menuItemClass("right")).toContain("text-[15px]");
  });
});
