import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Tabs } from "../src/ui/primitives";

/**
 * Выбранная вкладка: фиолетовые чернила на плашке, бездеятельная — text-2.
 *
 * Это место уже переворачивали: в прежнем макете активную отличал один цвет,
 * и опись кадров однажды вывела «активна» из бледного цвета, а правка — цвет
 * из описи. Полоса вкладок на шести экранах поехала наоборот, ничего не
 * ломая — ни типов, ни разметки. Поймать такое может только проверка,
 * прибитая к самому классу.
 *
 * В наборе «Виразна» (kit/page.py, .tab / .tab.on) выбранная отличается
 * тремя признаками сразу: чернилами (--vink), начертанием (800 против 600) и
 * плашкой листа с тенью плитки. Бездеятельная — text-2 без плашки. Проверка
 * держит все три: если один пропадёт, «вы здесь» снова повиснет на цвете.
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

function expectSelected(on: string, off: string, where: string) {
  for (const sign of ["text-violet-ink", "font-extrabold", "shadow-tile", "bg-panel"]) {
    expect(on, `${where}: у выбранной нет ${sign}`).toContain(sign);
    expect(off, `${where}: у бездеятельной есть ${sign}`).not.toContain(sign);
  }
  expect(off, `${where}: бездеятельная — чернилами text-2`).toContain("text-text-2");
  expect(on, `${where}: выбранная не красится в text-2`).not.toContain("text-text-2");
}

describe("вид вкладок", () => {
  test("выбранная — чернилами, начертанием и плашкой; бездеятельная — text-2", () => {
    for (const [path, active, idle] of [
      ["/tabs/one", "Конкретний тест", "Комплексний тест"],
      ["/tabs/two", "Комплексний тест", "Конкретний тест"],
    ] as const) {
      const html = markup(path);
      expectSelected(classesOf(html, active), classesOf(html, idle), path);
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
    expectSelected(on, off, "состояние");
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
  });
});

/*
 * Второй слой: имя класса должно ещё и значить то, что обещает.
 *
 * Без него переворот можно было бы повторить, не трогая ветку вовсе —
 * достаточно сделать --vink светлее --text-2, и «выбранная = violet-ink»
 * осталась бы зелёной, а выбранная вкладка читалась бы бледнее соседних.
 * Читается светлая тема.
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
  test("на листе фиолетовые чернила выбранной не бледнее text-2 бездеятельной", () => {
    const ink = hexOf("var(--vink)");
    const idle = hexOf("var(--text-2)");
    const panel = hexOf("var(--panel)");
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    expect(contrast(ink, panel), `--vink (${ink}) на листе читается хуже 4.5:1`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(idle, panel), `--text-2 (${idle}) на листе читается хуже 4.5:1`).toBeGreaterThanOrEqual(4.5);
  });
});
