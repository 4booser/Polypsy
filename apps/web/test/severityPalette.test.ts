import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SEVERITY_FILL,
  SEVERITY_SCREEN_DARK,
  SEVERITY_SCREEN_LIGHT,
  SEVERITY_SCREEN_TEXT_DARK,
  SEVERITY_SCREEN_TEXT_LIGHT,
  SEVERITY_STEPS_SCREEN_BG_DARK,
  SEVERITY_STEPS_SCREEN_BG_LIGHT,
  SEVERITY_STEPS_SCREEN_DARK,
  SEVERITY_STEPS_SCREEN_LIGHT,
  type Severity,
} from "@quizzy/shared";

/**
 * Экранная лестница выраженности не расходится с объявленной.
 *
 * Ступени живут в packages/shared/src/palette.ts: оттуда их берут печатное
 * заключение и мобильное приложение — импортом, то есть без возможности
 * разойтись. Консоль импортировать не может: цвета нужны в CSS, а CSS не
 * знает про TypeScript. Значит, у неё зеркало — и зеркало обязано быть
 * сверено, иначе это просто ещё одна копия.
 *
 * Расхождение уже было и стоило доверия к цифре: «умеренная» на экране
 * #e0813f, та же «умеренная» в распечатке того же заключения #ec835a.
 * Специалист сверял оттенки вместо того, чтобы читать результат.
 *
 * Проверяется именно РАВЕНСТВО зеркалу, а не равенство печати. Земля разная:
 * тёмная консоль стоит на #141019, лист бумаги белый, и один набор хексов не
 * может пройти оба порога контраста. Разными им быть можно; расходиться
 * молча — нельзя.
 */

/*
 * Печатный блок (@media print) — не тема экрана: его селектор перечисляет и
 * `:root[data-theme="dark"]`, и без вырезки его бумажные значения ложились
 * бы в тёмную тему. Сверяются только экранные блоки.
 */
const CSS = withoutPrint(readFileSync(resolve(import.meta.dir, "../src/styles/tokens.css"), "utf8"));

function withoutPrint(css: string): string {
  let out = css;
  for (;;) {
    const at = out.indexOf("@media print");
    if (at < 0) return out;
    const open = out.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (let i = open; i < out.length; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
}

/** Значения всех блоков с данным селектором — файл делит :root на слои */
function block(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(selector, from);
    if (at < 0) break;
    from = at + selector.length;

    const open = CSS.indexOf("{", at);
    let depth = 0;
    let end = open;
    for (let i = open; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    for (const m of CSS.slice(open, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(m[1]!, m[2]!.trim());
    }
  }
  if (out.size === 0) throw new Error(`не найден блок ${selector}`);
  return out;
}

const PALETTE = block(":root {");
const DARK = new Map([...PALETTE, ...block(':root[data-theme="dark"]')]);
const LIGHT = new Map([...PALETTE, ...block(':root[data-theme="light"]')]);

/**
 * Токен до хекса.
 *
 * Понимает ровно то, чем пользуются переменные --sev-*: прямой хекс и ссылку
 * `var(--x)`. Тёмная тема уводит заливку через сигнальные цвета
 * (--sev-moderate → --signal-warn), и без раскрытия ссылки сверять было бы
 * нечего.
 */
function hex(name: string, theme: Map<string, string>): string {
  const raw = theme.get(name) ?? PALETTE.get(name);
  if (!raw) throw new Error(`токен ${name} не найден`);
  const value = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (value.startsWith("#")) return value.toLowerCase();
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return hex(ref[1]!, theme);
  throw new Error(`не разобрать значение токена ${name}: ${value}`);
}

const LEVELS: Severity[] = ["none", "mild", "moderate", "severe"];

describe("лестница выраженности сведена к одному источнику", () => {
  const cases: [string, Map<string, string>, string, Record<Severity, string>][] = [
    ["тёмная заливка", DARK, "", SEVERITY_SCREEN_DARK],
    ["светлая заливка", LIGHT, "", SEVERITY_SCREEN_LIGHT],
    ["тёмный текст", DARK, "-text", SEVERITY_SCREEN_TEXT_DARK],
    ["светлый текст", LIGHT, "-text", SEVERITY_SCREEN_TEXT_LIGHT],
  ];

  for (const [name, theme, suffix, declared] of cases) {
    test(`${name}: токены повторяют палитру`, () => {
      const drifted: string[] = [];
      for (const level of LEVELS) {
        const token = `--sev-${level}${suffix}`;
        const inCss = hex(token, theme);
        const inTs = declared[level].toLowerCase();
        if (inCss !== inTs) drifted.push(`${token}: в токенах ${inCss}, в палитре ${inTs}`);
      }
      expect(drifted).toEqual([]);
    });
  }

  /*
   * Пять ступеней «Виразной» (--sev-0…--sev-4) и их подложки — то же
   * зеркало: из них собраны четыре степени выше, и плашка ступени берёт
   * подложку отсюда же.
   */
  const steps: [string, Map<string, string>, string, readonly string[]][] = [
    ["тёмные ступени", DARK, "", SEVERITY_STEPS_SCREEN_DARK],
    ["светлые ступени", LIGHT, "", SEVERITY_STEPS_SCREEN_LIGHT],
    ["тёмные подложки", DARK, "-bg", SEVERITY_STEPS_SCREEN_BG_DARK],
    ["светлые подложки", LIGHT, "-bg", SEVERITY_STEPS_SCREEN_BG_LIGHT],
  ];
  for (const [name, theme, suffix, declared] of steps) {
    test(`${name}: токены повторяют палитру`, () => {
      expect(declared.length).toBe(5);
      const drifted: string[] = [];
      declared.forEach((inTs, n) => {
        const token = `--sev-${n}${suffix}`;
        const inCss = hex(token, theme);
        if (inCss !== inTs.toLowerCase()) drifted.push(`${token}: в токенах ${inCss}, в палитре ${inTs}`);
      });
      expect(drifted).toEqual([]);
    });
  }

  /*
   * Лестница одна, даже когда оттенки разные.
   *
   * Единственное, что читает человек, — это порядок: спокойнее → тревожнее.
   * Экранный набор подобран под тёмную землю, печатный под белый лист, и
   * сравнивать их хексами бессмысленно. А вот перепутанный порядок — «лёгкая»
   * краснее «умеренной» — сломал бы обе стороны сразу, и никакой контраст
   * этого не поймает.
   */
  test("порядок ступеней одинаков на всех подложках", () => {
    const redness = (h: string) => {
      const [r, g] = [1, 3].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
      return r! - g!;
    };
    for (const set of [
      SEVERITY_FILL,
      SEVERITY_SCREEN_DARK,
      SEVERITY_SCREEN_LIGHT,
      SEVERITY_SCREEN_TEXT_DARK,
      SEVERITY_SCREEN_TEXT_LIGHT,
    ]) {
      const ladder = LEVELS.map((l) => redness(set[l]));
      const sorted = [...ladder].sort((a, b) => a - b);
      expect(ladder).toEqual(sorted);
    }
    for (const steps of [SEVERITY_STEPS_SCREEN_LIGHT, SEVERITY_STEPS_SCREEN_DARK]) {
      const ladder = steps.map(redness);
      expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    }
  });
});
