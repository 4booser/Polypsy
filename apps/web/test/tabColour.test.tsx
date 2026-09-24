import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Tabs } from "../src/ui/primitives";

/**
 * Цвет активной вкладки: полный, а не бледный.
 *
 * Это место уже переворачивали. Довод был круговой: опись кадров вывела
 * «активна» из бледного цвета, а правка вывела цвет из описи, — и полоса
 * вкладок на ШЕСТИ экранах (каталог тестов, конструктор, список пациентов,
 * группы) поехала наоборот, ничего при этом не ломая: ни типов, ни разметки,
 * ни доступности — только картинку. Поймать такое может только проверка,
 * прибитая к самому классу.
 *
 * Числа сняты по СОДЕРЖИМОМУ кадра, а не по цвету:
 *
 *   f22 — под вкладками блок «Шкала 1», то есть открыт «Конкретний тест»;
 *         первая вкладка (x 451…634) полная (102,51,153), вторая бледная;
 *   f21 — тех же шкал нет, зато есть «Питання #1/#2» комплексного;
 *         полная — вторая (x 697…898), первая бледная;
 *   f07 — папки неопубликованных; полная — вторая, «Неопубліковані».
 *
 * Три кадра из трёх: активная = полный #663399, остальные = бледный #b299cc.
 *
 * Проверяется не только имя класса, но и СМЫСЛ имени: что `--primary` на
 * листе действительно темнее `--primary-dim`. Иначе переворот прошёл бы
 * переименованием токена, а не правкой ветки.
 */

const markup = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Tabs
        label="вид"
        items={[
          { to: "/tabs/one", label: "Конкретний тест" },
          { to: "/tabs/two", label: "Комплексний тест" },
        ]}
      />
    </MemoryRouter>,
  );

/** Класс той вкладки, чья подпись названа */
function classesOf(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  expect(at, `вкладка «${label}» не нарисована`).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<a", at);
  const cls = html.slice(open, at).match(/class="([^"]*)"/);
  expect(cls, `у вкладки «${label}» нет класса`).not.toBeNull();
  return cls![1]!;
}

describe("цвет вкладок", () => {
  test("активная — полным цветом, неактивная — бледной", () => {
    for (const [path, active, idle] of [
      ["/tabs/one", "Конкретний тест", "Комплексний тест"],
      ["/tabs/two", "Комплексний тест", "Конкретний тест"],
    ] as const) {
      const html = markup(path);
      const on = classesOf(html, active);
      const off = classesOf(html, idle);
      expect(on, `${path}: активная обязана быть полной`).toContain("text-primary");
      expect(on, `${path}: активная не бледнится`).not.toContain("text-primary-dim");
      expect(off, `${path}: неактивная обязана быть бледной`).toContain("text-primary-dim");
    }
  });

  test("вкладка состояния красится по тому же правилу", () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="вид"
        items={[
          { label: "Конкретний тест", onSelect: () => {}, active: true },
          { label: "Комплексний тест", onSelect: () => {} },
        ]}
      />,
    );
    const on = html.slice(0, html.indexOf(">Конкретний тест<"));
    const off = html.slice(html.indexOf(">Конкретний тест<"));
    expect(on).toContain("text-primary");
    expect(on).not.toContain("text-primary-dim");
    expect(off).toContain("text-primary-dim");
  });
});

/*
 * Второй слой: имя класса должно ещё и значить то, что обещает.
 *
 * Без него переворот можно было бы повторить, не трогая ветку вовсе —
 * достаточно поменять местами значения двух токенов, и «активная =
 * text-primary» осталась бы зелёной, а экран стал бы бледным. Читается
 * светлая тема: кадры сняты с неё.
 */
/* пояснения выброшены: в них те же имена токенов, и разбор цеплялся за них */
const CSS = readFileSync(resolve(import.meta.dir, "../src/styles/tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function hexOf(name: string): string {
  const seen = new Set<string>();
  let value = name;
  for (;;) {
    if (value.startsWith("#")) return value;
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    const token = ref ? ref[1]! : value;
    if (seen.has(token)) throw new Error(`токен ${token} ссылается сам на себя`);
    seen.add(token);
    const all = [...CSS.matchAll(new RegExp(`${token}\\s*:\\s*([^;]+);`, "g"))];
    /* последнее объявление до тёмной темы — то есть значение светлой */
    /* по НАЧАЛУ строки: то же сочетание трижды встречается выше в пояснениях */
    const darkAt = CSS.indexOf('\n:root[data-theme="dark"]');
    const hit = all.filter((m) => m.index! < darkAt).pop();
    if (!hit) throw new Error(`токен ${token} не найден в светлой теме`);
    value = hit[1]!.trim();
  }
}

const lum = (hex: string) => {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
};

describe("токены вкладок", () => {
  test("на листе --primary темнее --primary-dim", () => {
    const full = hexOf("var(--primary)");
    const dim = hexOf("var(--primary-dim)");
    expect(full, "полный цвет вкладки — кадровый #663399").toBe("#663399");
    expect(
      lum(full),
      `--primary (${full}) обязан быть темнее --primary-dim (${dim})`,
    ).toBeLessThan(lum(dim));
  });
});
