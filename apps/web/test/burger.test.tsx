import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { LANG_NAMES, LANG_SELF_LABEL } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { navAccess, railEntries, subNavFor } from "../src/shell/nav";
import { RailBadge } from "../src/shell/Rail";
import { SubNavGroups, subNavRow } from "../src/shell/SubNav";
import { LANG_CHOICES, LangMenu } from "../src/shell/LangMenu";
import { MenuButton } from "../src/ui/menu";

/**
 * Навигация оболочки Polypsy 2.0 и меню языка — то, что глазом не проверить.
 *
 * Колонка подразделов, меню «Ще розділи» на узком окне и рельса рисуются
 * разным кодом, а читаются как одна система: одна строка у всех пунктов,
 * текущий отмечен одинаково, красное число — только у риска. Разойтись это
 * может от любой правки одного места, а увидит разницу только тот, кто
 * откроет нужный раздел нужной учётной записью. Поэтому проверяется не
 * картинка, а то, что делает список одним.
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

const ALL = navAccess({ role: "superadmin" }, () => true);
const COUNTS = { today: 120, worklist: 5, alerts: 3, referrals: 1, messages: 2 };

/** Классы всех элементов данного тега в разметке */
const classesOf = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`, "g"))].map((m) => m[1]!);

describe("подразделы: один вид у всего списка", () => {
  test("пункты — одна строка одного вида; текущий отличается заливкой и цветом", () => {
    const at = "/ops/errors";
    const data = subNavFor("ops", at, ALL)!;
    const html = render(<SubNavGroups groups={data.groups} dense={data.dense} path={at} />, at);
    const rows = classesOf(html, "a");
    expect(rows.length).toBeGreaterThan(20);
    const idle = `group ${subNavRow(false, true)}`;
    const current = `group ${subNavRow(true, true)}`;
    expect(rows.filter((c) => c !== idle && c !== current), "строка другого вида").toEqual([]);
    expect(rows.filter((c) => c === current).length, "текущим отмечен не один пункт").toBe(1);
    expect(current).toContain("bg-violet-tint");
    expect(current).toContain("text-violet-ink");
    expect(idle).toContain("hover:bg-sunk");
    expect(html).toMatch(/<a[^>]*href="\/ops\/errors"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/ops\/errors"/);
  });

  test("подписи групп — без капители и разрядки, одним классом", () => {
    const data = subNavFor("ops", "/ops", ALL)!;
    const html = render(<SubNavGroups groups={data.groups} dense path="/ops" />, "/ops");
    const heads = [...html.matchAll(/<div id="[^"]+" class="([^"]*)"/g)].map((m) => m[1]!);
    expect(heads.length).toBe(data.groups.length);
    /* первая группа без верхнего отступа, остальные — с ним; кроме этого — одно и то же */
    expect(new Set(heads.map((h) => h.replace(/\s*mt-\[\d+px\]/, ""))).size).toBe(1);
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("tracking-");
  });
});

describe("счётчики рельсы: цвет по смыслу", () => {
  test("красным — только случаи риска, фиолетовым — письма, остальное нейтрально", () => {
    const entries = railEntries(ALL, COUNTS);
    const tone = (key: string) => entries.find((e) => e.key === key)?.badge?.tone;
    expect(tone("cases")).toBe("risk");
    expect(tone("messages")).toBe("violet");
    expect(tone("worklist")).toBe("plain");
    /* у «Сьогодні» на рельсе числа нет — так нарисовано в наборе */
    expect(entries.find((e) => e.key === "today")?.badge).toBeUndefined();
    expect(entries.filter((e) => e.badge?.tone === "risk").map((e) => e.key)).toEqual(["cases"]);
  });

  test("больше 99 — «99+», красный — заливкой риска с белым числом", () => {
    const html = render(<RailBadge n={120} tone="risk" />);
    expect(html).toContain(">99+<");
    expect(html).toContain("bg-risk");
    expect(html).toContain("text-onfill");
  });

  test("нулевых счётчиков нет вовсе: пустая метка читалась бы как «что-то есть»", () => {
    const entries = railEntries(ALL, { worklist: 0, alerts: 0, messages: 0 });
    expect(entries.filter((e) => e.badge)).toEqual([]);
  });
});

describe("меню языка", () => {
  test("языки — все ключи LANG_NAMES: третий встанет сам, как только его заведут", () => {
    expect(LANG_CHOICES).toEqual(Object.keys(LANG_NAMES) as typeof LANG_CHOICES);
    expect(LANG_CHOICES.length).toBeGreaterThanOrEqual(2);
  });

  test("на полосе — слово текущего языка; нажатие раскрывает меню, а не переключает по кругу", () => {
    const html = render(<LangMenu />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-label="Укр — ${LANG_SELF_LABEL}"`);
    expect(html).toMatch(/>Укр<\/button>/);
    /* «по кругу из двух» не осталось ни в полосе, ни в меню; в пояснениях прежний код цитируется законно */
    const src = ["shell/AppBar.tsx", "shell/LangMenu.tsx", "lang.tsx"]
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
