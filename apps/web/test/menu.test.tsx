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

/**
 * Замер одного кадра остаётся при своём меню.
 *
 * Меню структуры аналитической модели (f19) сведено с кадром: пункты 17/400
 * #666666 шагом 30, плашка с рамкой #999999. Первая редакция записала эти
 * числа в «right» — то есть разом в меню инструментов конструктора, в
 * переключатель языка «Укр» и в ActionMenu карточек людей и розсилок, кадры
 * которых в той сверке не открывались, и высота пункта у них ушла с 32 на 30
 * без всякого замера.
 *
 * Сторож держит границу: «right-out» — своё, «right» — прежнее. Свои кадры у
 * тех меню есть, и сводить их надо в их собственную сверку.
 */
describe("меню структуры модели не переписывает чужие меню", () => {
  const OUT = menuItemClass("right-out");
  const CARD = menuItemClass("right");

  test("пункт карточки остался прежним: 15/…, поля 16 и 6, цвет --text-2", () => {
    for (const cls of ["text-[15px]", "px-[16px]", "py-[6px]", "text-text-2"]) {
      expect(CARD, `у пункта карточки пропало ${cls}`).toContain(cls);
    }
  });

  test("пункт меню структуры — свой: 17/…, поля 10 и 5, цвет --muted", () => {
    for (const cls of ["text-[17px]", "px-[10px]", "py-[5px]", "text-muted"]) {
      expect(OUT, `у пункта меню структуры пропало ${cls}`).toContain(cls);
    }
  });

  test("ни одно число одного меню не перетекло в другое", () => {
    for (const cls of ["text-[17px]", "px-[10px]", "py-[5px]", "text-muted"]) {
      expect(CARD, `${cls} из меню структуры оказалось в меню карточки`).not.toContain(cls);
    }
    for (const cls of ["text-[15px]", "px-[16px]", "py-[6px]", "text-text-2"]) {
      expect(OUT, `${cls} из меню карточки оказалось в меню структуры`).not.toContain(cls);
    }
  });

  test("рамка #999999 стоит в ветке меню структуры, а не в общей", () => {
    /*
     * Плашка рисуется только у открытого меню, а открыть его в статической
     * разметке нечем, поэтому сторож читает сам plateClass: строка с рамкой
     * обязана быть привязана к "right-out" и ни к чему больше.
     */
    const src = readFileSync(new URL("../src/ui/menu.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const at = src.indexOf("function plateClass");
    expect(at, "plateClass переименован — сторож смотрит не туда").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    const lines = body.split("\n");
    const at2 = lines.findIndex((l) => l.includes("border-border-strong"));
    expect(at2, "рамки #999999 у плашки нет вовсе").toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("border-border-strong"))).toHaveLength(1);
    /* ближайшее сравнение выше по коду — то, под каким видом плашки рамка стоит */
    const guard = lines.slice(0, at2).reverse().find((l) => l.includes("align ==="));
    expect(guard, "рамка #999999 стоит вне ветки вида плашки — её увидят все меню").toContain("right-out");
  });
});
