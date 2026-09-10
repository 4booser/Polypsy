import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Контраст проверяется по токенам, а не по экрану.
 *
 * Проверка доступности в смоуке смотрит на то, что нарисовано, и потому
 * молчит о том, чего на стенде нет. Полоса случаев на сводке рисуется, только
 * когда открытые случаи есть: на машине разработчика их не было, и заливка,
 * уводившая текст на ней ниже порога, прошла проверку двадцать два раза
 * подряд. Нашлась она случайно — на другом стенде, где случаи были.
 *
 * Здесь экран не нужен вовсе. Пары «что на чём» перечислены явно, значения
 * читаются из самого файла токенов, и ответ не зависит ни от данных, ни от
 * того, открыл ли кто-нибудь этот экран.
 */

/*
 * Читается только экранная часть файла.
 *
 * В конце файла лежит блок печати: там земля белая, текст чёрный, и
 * перекрывает он ОБЕ темы. Разбирая файл целиком, проверка брала последние
 * значения — то есть мерила контраст бумаги и проходила при любой экранной
 * палитре. Обнаружилось снятием защиты: приглушённый цвет светлой темы
 * заменён на заведомо непроходной, а проверка осталась зелёной.
 */
const RAW = readFileSync(resolve(import.meta.dir, "../src/styles/tokens.css"), "utf8");
const PRINT_AT = RAW.indexOf("@media print");
const CSS = PRINT_AT < 0 ? RAW : RAW.slice(0, PRINT_AT);

/**
 * Значения из блоков с этим селектором — из ВСЕХ, а не из первого.
 *
 * Файл токенов делит `:root` на слои: сырая палитра, семантика, типографика.
 * Читая только первый блок, проверка не находила бы `--bg` вовсе и падала бы
 * с «токен не найден» — то есть выглядела бы сломанной, а не строгой.
 */
function block(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(selector, from);
    if (at < 0) break;
    from = at + selector.length;
    collect(at, out);
  }
  if (out.size === 0) throw new Error(`не найден блок ${selector}`);
  return out;
}

function collect(at: number, out: Map<string, string>): void {
  {
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
}

/*
 * Сырая палитра общая на обе темы, поверх неё — значения темы.
 *
 * Тёмная семантика объявлена селектором через запятую — `:root,
 * :root[data-theme="dark"]`, — чтобы быть и умолчанием, и явным выбором.
 * Искать её по `:root {` бесполезно: разбор находил только палитру и падал
 * на `--bg`. Поэтому темы читаются по своему имени, а общая палитра — по
 * блокам без темы.
 */
const PALETTE = block(":root {");
const DARK = new Map([...PALETTE, ...block(':root[data-theme="dark"]')]);
const LIGHT = new Map([...PALETTE, ...block(':root[data-theme="light"]')]);

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function mix(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha)) as Rgb;
}

/**
 * Разрешение токена до цвета.
 *
 * Понимает ровно то, чем пользуется файл токенов: шестнадцатеричный цвет,
 * ссылку `var(--x)` и `color-mix(in srgb, X N%, transparent)` — последний
 * поверх той земли, на которой цвет окажется. Больше ничего понимать не
 * нужно, а понимать «на всякий случай» — значит принять за верное то, что не
 * проверено.
 */
function resolve_(name: string, theme: Map<string, string>, over: Rgb): Rgb {
  const raw = theme.get(name) ?? PALETTE.get(name);
  if (!raw) throw new Error(`токен ${name} не найден`);
  const value = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  if (value.startsWith("#")) return parseHex(value);

  const varRef = value.match(/^var\((--[\w-]+)\)$/);
  if (varRef) return resolve_(varRef[1]!, theme, over);

  const softVar = value.match(/color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+)%,\s*transparent\)/);
  if (softVar) return mix(resolve_(softVar[1]!, theme, over), Number(softVar[2]) / 100, over);

  const softHex = value.match(/color-mix\(in srgb,\s*(#[0-9a-fA-F]{6})\s+(\d+)%,\s*transparent\)/);
  if (softHex) return mix(parseHex(softHex[1]!), Number(softHex[2]) / 100, over);

  throw new Error(`не разобрать значение токена ${name}: ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Поверхности, на которых вообще бывает текст */
const GROUNDS = ["--bg", "--surface", "--surface-2", "--surface-3"] as const;

/**
 * Пороги — из правил самого проекта, а не из WCAG вообще.
 *
 * Основной текст 4.5 — минимум стандарта. Приглушённый 5.0 — своё правило,
 * записанное в шапке файла токенов: приглушённый читают дольше, потому что
 * он мельче.
 */
const TEXT_TOKENS: [string, number][] = [
  ["--text", 4.5],
  ["--text-2", 4.5],
  ["--muted", 5.0],
  ["--accent", 4.5],
  ["--primary", 4.5],
];

describe("контраст токенов", () => {
  for (const [themeName, theme] of [
    ["тёмная", DARK],
    ["светлая", LIGHT],
  ] as const) {
    test(`${themeName} тема: текст читается на каждой поверхности`, () => {
      const bad: string[] = [];
      for (const groundName of GROUNDS) {
        const ground = resolve_(groundName, theme, [0, 0, 0]);
        for (const [token, floor] of TEXT_TOKENS) {
          const ratio = contrast(resolve_(token, theme, ground), ground);
          if (ratio < floor) {
            bad.push(`${token} на ${groundName}: ${ratio.toFixed(2)}:1 при пороге ${floor}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });

    /*
     * Полупрозрачные заливки — отдельный случай и та самая ловушка.
     *
     * Они сдвигают землю под текстом, а цвета подбирались к земле без них.
     * Заливка «требует внимания» на светлой теме уводила и приглушённый
     * текст, и действие ниже порога — при том, что на чистой земле оба
     * проходили с запасом.
     */
    test(`${themeName} тема: текст читается и на цветных заливках`, () => {
      const bad: string[] = [];
      for (const groundName of GROUNDS) {
        const ground = resolve_(groundName, theme, [0, 0, 0]);
        for (const fill of ["--accent-soft", "--primary-soft", "--danger-soft"]) {
          const tinted = resolve_(fill, theme, ground);
          for (const [token, floor] of TEXT_TOKENS) {
            const ratio = contrast(resolve_(token, theme, tinted), tinted);
            if (ratio < floor) {
              bad.push(`${token} на ${fill} поверх ${groundName}: ${ratio.toFixed(2)}:1 при пороге ${floor}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});
