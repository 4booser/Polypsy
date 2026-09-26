import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LANG_NAMES, LANG_SELF_LABEL } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { railGroups } from "../src/shell/Rail";
import { BurgerFooter, BurgerSections, GROUP_HEAD, barItems, burgerRow, type BurgerAccount } from "../src/shell/Topbar";
import { LANG_CHOICES, LangMenu } from "../src/shell/LangMenu";
import { MenuButton } from "../src/ui/menu";

/**
 * Бургер и меню языка — решения заказчика 2026-09-26.
 *
 * Бургер переделан «по стилистике»: прежде в одном списке жили три вида
 * заголовков групп, янтарные счётчики у всех пунктов подряд и подвал из
 * жирных кнопок вперемешку с мелкой ссылкой. Глазом это видно, но только
 * тому, кто откроет бургер нужной учётной записью на нужном экране, — а
 * разойтись снова оно может от любой правки одной группы. Поэтому здесь
 * проверяется не картинка, а то, что делает список одним: один класс у всех
 * заголовков, один класс у всех строк, янтарь только у тревожного числа.
 *
 * Меню языка — выбор из всех языков, а не «по кругу из двух»: третий язык
 * заводит другой участок, и здесь проверяется, что встанет он сам.
 */

const render = (node: ReactElement, at = "/") =>
  renderToStaticMarkup(
    <LangProvider>
      <MemoryRouter initialEntries={[at]}>{node}</MemoryRouter>
    </LangProvider>,
  );

const COUNTS = { today: 120, worklist: 5, alerts: 3, referrals: 1 };

function sections(at: string) {
  return render(
    <BurgerSections
      items={barItems("admin")}
      caseLinks={null}
      tools={null}
      groups={railGroups(COUNTS, true, true)}
    />,
    at,
  );
}

/** Классы всех элементов данного тега в разметке */
const classesOf = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`, "g"))].map((m) => m[1]!);

describe("бургер: один вид у всего списка", () => {
  test("заголовки групп — один класс у всех, без капители и разрядки", () => {
    const html = sections("/");
    const heads = [...html.matchAll(/<div id="[^"]+" class="([^"]*)"/g)].map((m) => m[1]!);
    /* четыре группы разделов и повтор пунктов полосы для узкого экрана */
    expect(heads.length).toBe(railGroups(COUNTS, true, true).length + 1);
    expect(new Set(heads)).toEqual(new Set([GROUP_HEAD]));
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-");
  });

  test("пункты — одна строка одного вида; текущий отличается заливкой и цветом", () => {
    const html = sections("/alerts");
    const rows = classesOf(html, "a");
    expect(rows.length).toBeGreaterThan(15);
    const idle = burgerRow(false);
    const current = burgerRow(true);
    expect(rows.filter((c) => c !== idle && c !== current), "строка другого вида").toEqual([]);
    expect(rows.filter((c) => c === current).length, "текущим отмечен не один пункт").toBe(1);
    expect(current).toContain("bg-primary-soft");
    expect(current).toContain("text-primary");
    expect(idle).toContain("hover:bg-primary-tint");
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/alerts"|<a[^>]*href="\/alerts"[^>]*aria-current="page"/);
  });

  test("янтарём — только случаи риска; остальные числа — нейтральной меткой", () => {
    const html = sections("/");
    const amber = [...html.matchAll(/<span class="[^"]*bg-accent-soft[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(amber, "янтарь стоит не у одного числа случаев риска").toEqual([String(COUNTS.alerts)]);
    /* 120 людей на сегодня — «99+», и серым: это объём работы, а не тревога */
    const plain = [...html.matchAll(/<span class="[^"]*border-border text-muted[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(plain).toContain("99+");
    expect(plain).toContain(String(COUNTS.worklist));
    expect(plain).toContain(String(COUNTS.referrals));
    /* заливка янтарём (bg-accent) прежних счётчиков не вернулась */
    expect(html).not.toMatch(/\bbg-accent\b(?!-)/);
  });
});

describe("бургер: подвал учётной записи", () => {
  const account: BurgerAccount = {
    name: "Іваненко Олена",
    roleLabel: "Адміністратор групи",
    build: { sha: "dev", date: "2026-09-26" },
    warning: "Режим перегляду",
    actions: [
      { id: "google", label: "Прив’язати Google", onSelect: () => {} },
      { id: "account", label: "Обліковий запис", to: "/account" },
      { id: "logout", label: "Вийти", onSelect: () => {}, ruled: true },
    ],
  };

  test("действия — те же строки, что разделы, выход отделён чертой", () => {
    const html = render(<BurgerFooter account={account} />);
    const rows = [...classesOf(html, "a"), ...classesOf(html, "button")];
    expect(rows.length).toBe(3);
    expect(new Set(rows)).toEqual(new Set([burgerRow(false)]));
    /* «Вийти» — кнопка (сценарии ищут его ролью button), и черта стоит прямо перед ним */
    expect(html).toMatch(/<hr[^>]*>\s*<button[^>]*>Вийти<\/button>/);
    /* ни жирных кнопок, ни мелкой ссылки: у действий нет своего кегля */
    for (const cls of ["font-bold", "text-caption", "text-micro"]) {
      expect(rows.join(" "), `у действия подвала свой ${cls}`).not.toContain(cls);
    }
  });

  test("имя 16/700, роль 13 серым, метка сборки 11 моноширинным, предупреждение янтарём", () => {
    const html = render(<BurgerFooter account={account} />);
    expect(html).toMatch(/class="[^"]*text-\[16px\] font-bold[^"]*">Іваненко Олена</);
    expect(html).toMatch(/class="[^"]*text-\[13px\][^"]*text-muted[^"]*">.*Адміністратор групи/);
    expect(html).toMatch(/class="[^"]*font-mono text-\[11px\][^"]*"[^>]*>dev</);
    expect(html).toMatch(/class="[^"]*bg-accent-soft[^"]*">Режим перегляду</);
  });
});

describe("меню языка", () => {
  test("языки — все ключи LANG_NAMES: третий встанет сам, как только его заведут", () => {
    expect(LANG_CHOICES).toEqual(Object.keys(LANG_NAMES) as typeof LANG_CHOICES);
    expect(LANG_CHOICES.length).toBeGreaterThanOrEqual(2);
  });

  test("на полосе — прежнее слово; нажатие раскрывает меню, а не переключает по кругу", () => {
    const html = render(<LangMenu />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-label="Укр — ${LANG_SELF_LABEL}"`);
    expect(html).toMatch(/>Укр<\/button>/);
    /* «по кругу из двух» не осталось ни в полосе, ни в меню; в пояснениях прежний код цитируется законно */
    const src = ["shell/Topbar.tsx", "shell/LangMenu.tsx", "lang.tsx"]
      .map((f) => readFileSync(resolve(import.meta.dir, "../src", f), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/===\s*"uk"\s*\?\s*"ru"/);
    /* и двух литералов вместо перечня тоже: сегментный переключатель учётной записи берёт те же ключи */
    expect(src).not.toMatch(/\[\s*"uk"\s*,\s*"ru"\s*\]/);
  });

  test("MenuButton отдаёт свою кнопку экрану, не теряя обещаний диктору", () => {
    const html = render(
      <MenuButton label="Мова" trigger={(p) => <button type="button" {...p} className="mine">Укр</button>}>
        {() => null}
      </MenuButton>,
    );
    expect(html).toContain('class="mine"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    /* закрытое меню не ссылается на несуществующий id */
    expect(html).not.toContain("aria-controls");
  });
});
