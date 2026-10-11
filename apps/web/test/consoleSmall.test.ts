import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api } from "../src/api";
import { currentLang } from "../src/lang";
import { OPS_GROUPS } from "../src/pages/ops/sections";
import * as print from "../src/print";

/**
 * Мелкое в консоли (#180): печать плана безопасности, язык листа ключей,
 * права на разделы техпанели в маршрутизаторе. Файл грузится и на коде до
 * правки — проверки там падают по существу.
 */

const SRC = resolve(import.meta.dir, "../src");
const source = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("«Друк» плана безопасности печатает только план", () => {
  type Marked = { setAttribute(n: string, v: string): void; removeAttribute(n: string): void };
  const printOnly = (print as { printOnly?: (el: Marked | null, win: unknown) => boolean }).printOnly;

  function element() {
    const attrs = new Set<string>();
    return {
      attrs,
      setAttribute: (n: string) => void attrs.add(n),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
  }

  function fakeWindow() {
    const body = element();
    const listeners = new Set<() => void>();
    const seenWhilePrinting: string[][] = [];
    return {
      body,
      listeners,
      seenWhilePrinting,
      win: {
        document: { body },
        addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
        print: () => void seenWhilePrinting.push([...body.attrs]),
      },
      afterprint: () => {
        for (const fn of [...listeners]) fn();
      },
    };
  }

  test("на время печати блок и страница помечены; после печати пометок нет", () => {
    expect(printOnly).toBeFunction();
    const plan = element();
    const w = fakeWindow();
    expect(printOnly!(plan, w.win)).toBe(true);
    expect(w.seenWhilePrinting).toEqual([["data-printing-scope"]]);
    expect([...plan.attrs]).toEqual(["data-print-scope"]);
    w.afterprint();
    expect(plan.attrs.size).toBe(0);
    expect(w.body.attrs.size).toBe(0);
    expect(w.listeners.size).toBe(0);
  });

  test("нет блока — не печатается ничего, а не вся карта", () => {
    expect(printOnly).toBeFunction();
    const w = fakeWindow();
    expect(printOnly!(null, w.win)).toBe(false);
    expect(w.seenWhilePrinting).toEqual([]);
  });

  test("план печатает свой блок, а печатное правило убирает остальное", () => {
    const editor = source("components/SafetyPlanEditor.tsx");
    expect(editor.includes("window.print()"), "голый window.print() — на лист ложится вся карта").toBe(false);
    expect(editor.includes("printOnly(planRef.current)")).toBe(true);
    const css = source("styles/legacy.css");
    // правило — в печатном блоке, а не на экране: экран им не задевается
    const printBlock = css.slice(css.indexOf("@media print {"), css.indexOf("/* высококонтрастный режим Windows"));
    const rule = "body[data-printing-scope] *:not([data-print-scope], [data-print-scope] *, :has([data-print-scope]))";
    expect(printBlock.includes(rule), "печатного правила нет").toBe(true);
  });
});

describe("лист ключей — на языке консоли", () => {
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
  let sent: { path: string; lang: string | null }[] = [];

  function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k) => data.get(k) ?? null,
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
      setItem: (k, v) => void data.set(k, String(v)),
    };
  }

  beforeEach(() => {
    sent = [];
    g.localStorage = memoryStorage();
    g.sessionStorage = memoryStorage();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ path: String(input), lang: new Headers(init?.headers).get("Accept-Language") });
      return new Response(JSON.stringify({ title: "PHQ-9", scales: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = saved.fetch;
    g.localStorage = saved.localStorage;
    g.sessionStorage = saved.sessionStorage;
  });

  test("?lang в адресе нет — он у сервера сильнее заголовка и печатал лист по-русски", async () => {
    await api.keySheet("survey-1");
    expect(sent[0]?.path).toBe("/api/surveys/survey-1/key");
  });

  test("положительный контроль: язык уходит заголовком — языком консоли", async () => {
    await api.keySheet("survey-1");
    expect(sent[0]?.lang).toBe(currentLang);
  });
});

describe("разделы техпанели — под тем же правом, что в меню", () => {
  const app = source("App.tsx");
  const opsBlock = app.slice(app.indexOf('<Route path="/ops" element={<OpsPanel />}>'));

  /* строка маршрута раздела в блоке /ops */
  const routeLine = (path: string) => opsBlock.split("\n").find((l) => l.includes(`<Route path="${path}"`)) ?? "";

  for (const group of OPS_GROUPS) {
    for (const s of group.sections) {
      const path = s.to.replace(/^\/ops\/?/, "");
      if (!path || !s.perm) continue;
      test(`/ops/${path} — под can("${s.perm}")`, () => {
        const line = routeLine(path);
        expect(line, `маршрута /ops/${path} нет`).not.toBe("");
        expect(line.includes(`can("${s.perm}") ? <Route path="${path}"`), line.trim()).toBe(true);
      });
    }
  }
});
