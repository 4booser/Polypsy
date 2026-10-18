import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("тон пункта не спорит с обычным цветом: в строке классов один цвет чернил", () => {
    const inks = (cls: string) => cls.split(/\s+/).filter((c) => /^text-(text|muted|risk-ink|danger|violet-ink)$/.test(c));
    /* разрушительное — обычными чернилами: красный в наборе только для риска для человека */
    const danger = menuItemClass("left", "danger");
    expect(inks(danger)).toEqual(["text-text"]);
    expect(danger).not.toContain("text-danger");

    const disabled = menuItemClass("right", "disabled");
    expect(inks(disabled)).toEqual(["text-muted"]);
    expect(disabled).toContain("cursor-not-allowed");
    expect(disabled).not.toContain("hover:");

    /* пункт набора — один для всех меню: 36 px, 13/600, у левого края */
    expect(menuItem).toContain("text-left");
    expect(menuItem).toContain("text-[13px]");
    expect(menuItem).toContain("h-9");
  });
});

/**
 * Один вид пункта на все меню.
 *
 * Прежний макет рисовал три меню тремя замерами (13/400 списка, 15/400
 * карточки, 17/400 структуры модели), и замер одного кадра расползался по
 * чужим меню. В наборе «Виразна» пункт один (.mi: 36 px, 13/600), а `align`
 * решает только, к какому краю глифа прижата плашка. Сторож держит это:
 * разные `align` и прежний `itemSize` дают ровно одну строку классов.
 */
describe("меню набора: пункт один, плашка одна", () => {
  test("align и прежний кегль не меняют вида пункта", () => {
    const base = menuItemClass("left");
    for (const align of ["left", "right", "right-out"] as const) {
      for (const size of [15, 17] as const) {
        expect(menuItemClass(align, "normal", size), `${align}/${size}`).toBe(base);
      }
    }
  });

  test("плашка — лист 14 с ободом и тенью слоя; сторона — в ветке align", () => {
    const src = readFileSync(new URL("../src/ui/menu.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const at = src.indexOf("function plateClass");
    expect(at, "plateClass переименован — сторож смотрит не туда").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    /* лист один на живое меню и на нарисованное (MenuPanel): константа plate */
    const plate = src.match(/const plate =\s*"([^"]+)"/)?.[1] ?? "";
    for (const cls of ["rounded-panel", "border-border", "bg-panel", "shadow-pop"]) {
      expect(plate, `у плашки пропало ${cls}`).toContain(cls);
    }
    expect(body).toContain("plate,");
    expect(body).toMatch(/align === "right-out" \? "left-0/);
  });
});
