import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";

/**
 * Сторож: символы интерфейса покрыты локальными шрифтами.
 *
 * CSP закрыт, шрифты — свои подмножества с unicode-range. Символ вне
 * диапазонов рисует системный запасной шрифт, а он у каждого свой: смена
 * образа раннера GitHub перерисовала «←», «→» и «▸», и эталоны экранов
 * покраснели без единой правки кода. Это не только про эталоны: читатель
 * на Linux видит другую стрелку, чем на macOS, — то есть не тот интерфейс,
 * что нарисован.
 *
 * Проверяется исходник, а не страница: так видны все экраны сразу, а не
 * те, что открыл сценарий. Комментарии вырезаются — в них символы стоят
 * законно. Список известного долга пуст и обязан таким оставаться: новый
 * символ — новый значок в ui/glyphs.tsx, а не строка в списке.
 */

const WEB = resolve(import.meta.dir, "../src");
const STRINGS = resolve(import.meta.dir, "../../../packages/shared/src/uiStrings.ts");
/*
 * Тексты отказов тоже рисует консоль — сервер отдаёт их готовыми, и они
 * встают в ту же разметку, что и словарь. С английским в них появились
 * типографские кавычки и апостроф (“ ” ’): проверяется, что и они в
 * подмножестве, а не у системного запасного шрифта.
 */
const ERROR_STRINGS = resolve(import.meta.dir, "../../../packages/shared/src/errorStrings.ts");

/** Диапазоны из fonts.css: «U+0400-045F, U+2116» → [[0x400, 0x45f], [0x2116, 0x2116]] */
function coveredRanges(): Array<[number, number]> {
  const css = readFileSync(join(WEB, "styles/fonts.css"), "utf8");
  const out: Array<[number, number]> = [];
  for (const m of css.matchAll(/unicode-range:\s*([^;]+);/g)) {
    for (const part of m[1]!.split(",")) {
      const r = part.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
      if (!r) throw new Error(`fonts.css: непонятный диапазон «${part.trim()}»`);
      const from = Number.parseInt(r[1]!, 16);
      out.push([from, r[2] ? Number.parseInt(r[2], 16) : from]);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx?|css)$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * Комментарии вон: блочные целиком, строчные — до конца строки.
 *
 * Блочный заменяется не пустотой, а своими переводами строк: иначе номера
 * строк в отчёте съезжают на высоту всех комментариев выше, и «index.tsx:327»
 * указывает не туда, где стоит символ.
 */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/*
 * Известный долг — символы, которые ещё рисует запасной шрифт. Был списком
 * из двенадцати (✕ ⚠ ✖ ★ ↶ ↷ ↵ ⌘ ⧉ └ ─ α): значки ушли в ui/glyphs.tsx,
 * уголок цепочки назначения — в CSS-рамку, «α» Кронбаха — словом в словаре
 * (греческое подмножество не подключено). Пуст и обязан оставаться
 * пустым: новый символ — новый значок, а не строка здесь.
 */
const KNOWN_DEBT = new Set<string>([]);

/** Каждый символ, который рисует консоль, с первым местом, где он стоит */
function uiCharacters(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of [...sourceFiles(WEB), STRINGS, ERROR_STRINGS]) {
    const src = stripComments(readFileSync(file, "utf8"));
    src.split("\n").forEach((line, i) => {
      for (const ch of line) {
        if (!out.has(ch)) out.set(ch, `${file.replace(`${WEB}/`, "")}:${i + 1}`);
      }
    });
  }
  return out;
}

/** Гарнитура текста — её подмножества и должны рисовать интерфейс */
const TEXT_FAMILY = "Manrope";

/** Грани @font-face гарнитуры: файл и его диапазоны */
function faces(family: string): Array<{ file: string; ranges: Array<[number, number]> }> {
  const css = readFileSync(join(WEB, "styles/fonts.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ file: string; ranges: Array<[number, number]> }> = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1]!;
    if (!body.includes(`font-family: "${family}"`)) continue;
    const file = body.match(/url\("\/fonts\/([^"]+)"\)/)![1]!;
    const ranges: Array<[number, number]> = [];
    for (const part of body.match(/unicode-range:\s*([^;]+);/)![1]!.split(",")) {
      const r = part.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/)!;
      const from = Number.parseInt(r[1]!, 16);
      ranges.push([from, r[2] ? Number.parseInt(r[2], 16) : from]);
    }
    out.push({ file, ranges });
  }
  return out;
}

/**
 * Кодовые точки, у которых в файле woff2 есть глиф.
 *
 * Диапазон в fonts.css — только обещание браузеру. Если глифа в файле нет,
 * браузер всё равно уходит к запасному шрифту, а первая проверка молчит:
 * диапазон-то объявлен. Поэтому файл читается сам — заголовок WOFF2,
 * каталог таблиц, распакованный Brotli поток и таблица cmap (её WOFF2 не
 * преобразует, она лежит в потоке как есть).
 */
function glyphCodepoints(path: string): Set<number> {
  const buf = readFileSync(path);
  expect(buf.toString("latin1", 0, 4), `${path}: не WOFF2`).toBe("wOF2");
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[at++]!;
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error(`${path}: испорченное число UIntBase128`);
  };
  let offset = 0;
  let cmap: { offset: number; length: number } | null = null;
  for (let t = 0; t < numTables; t++) {
    const flags = buf[at++]!;
    const known = flags & 0x3f;
    if (known === 63) at += 4; // тег записан явно
    const version = flags >> 6;
    const origLength = base128();
    // glyf и loca (10, 11) преобразованы при версии 0, прочие таблицы — при ненулевой
    const transformed = known === 10 || known === 11 ? version === 0 : version !== 0;
    const length = transformed ? base128() : origLength;
    if (known === 0) cmap = { offset, length };
    offset += length;
  }
  expect(cmap, `${path}: нет таблицы cmap`).not.toBeNull();
  const data = brotliDecompressSync(buf.subarray(at, at + compressedSize));
  const c = data.subarray(cmap!.offset, cmap!.offset + cmap!.length);

  const out = new Set<number>();
  const count = c.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const sub = c.readUInt32BE(4 + i * 8 + 4);
    const format = c.readUInt16BE(sub);
    if (format === 4) {
      const segs = c.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const rangeOffsets = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const start = c.readUInt16BE(starts + s * 2);
        const end = c.readUInt16BE(ends + s * 2);
        const delta = c.readUInt16BE(deltas + s * 2);
        const ro = c.readUInt16BE(rangeOffsets + s * 2);
        for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
          const glyph = ro === 0 ? (cp + delta) & 0xffff : c.readUInt16BE(rangeOffsets + s * 2 + ro + (cp - start) * 2);
          if (glyph !== 0) out.add(cp);
        }
      }
    } else if (format === 12) {
      const groups = c.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const start = c.readUInt32BE(sub + 16 + g * 12);
        const end = c.readUInt32BE(sub + 20 + g * 12);
        const first = c.readUInt32BE(sub + 24 + g * 12);
        for (let cp = start; cp <= end; cp++) if (first + (cp - start) !== 0) out.add(cp);
      }
    }
  }
  return out;
}

describe("символы интерфейса покрыты локальными шрифтами", () => {
  const ranges = coveredRanges();
  const covered = (cp: number) => cp < 0x80 || ranges.some(([a, b]) => cp >= a && cp <= b);

  test("вне диапазонов fonts.css — только известный долг", () => {
    const offenders = new Map<string, string[]>();
    for (const file of [...sourceFiles(WEB), STRINGS, ERROR_STRINGS]) {
      const src = stripComments(readFileSync(file, "utf8"));
      src.split("\n").forEach((line, i) => {
        for (const ch of line) {
          const cp = ch.codePointAt(0)!;
          if (covered(cp) || KNOWN_DEBT.has(ch)) continue;
          const list = offenders.get(ch) ?? [];
          if (list.length < 3) list.push(`${file.replace(`${WEB}/`, "")}:${i + 1}`);
          offenders.set(ch, list);
        }
      });
    }
    const report = [...offenders].map(([ch, where]) => `«${ch}» U+${ch.codePointAt(0)!.toString(16)} — ${where.join(", ")}`);
    expect(report, "символ вне локальных шрифтов: замени на значок из ui/glyphs.tsx или добавь в подмножество").toEqual([]);
  });

  /*
   * Стрелки и знаки сравнения теперь лежат в латинском подмножестве
   * Manrope, а не отдельным файлом (см. fonts.css): в «Виразной» они почти
   * в каждой строке. Проверяется, что грань с ними подключена и файл на месте.
   */
  test("стрелки и знаки сравнения — в подключённом подмножестве Manrope", () => {
    const text = faces(TEXT_FAMILY);
    expect(text.length, `в fonts.css нет граней ${TEXT_FAMILY}`).toBeGreaterThan(0);
    for (const cp of [0x2190, 0x2191, 0x2192, 0x2193, 0x2248, 0x2264, 0x2265]) {
      const face = text.find((f) => f.ranges.some(([a, b]) => cp >= a && cp <= b));
      expect(face, `U+${cp.toString(16)} не покрыт гранью ${TEXT_FAMILY}`).toBeDefined();
      expect(statSync(resolve(WEB, "../public/fonts", face!.file)).size).toBeGreaterThan(500);
    }
  });

  /*
   * Второй слой: глиф действительно лежит в файле, а не только обещан
   * диапазоном. Каждый символ словаря, текстов отказов и разметки — кроме
   * управляющих — обязан найтись в cmap той грани гарнитуры текста, чей
   * диапазон его забирает.
   */
  test("каждый символ интерфейса есть в файле своей грани, а не только в диапазоне", () => {
    const text = faces(TEXT_FAMILY).map((f) => ({
      ...f,
      glyphs: glyphCodepoints(resolve(WEB, "../public/fonts", f.file)),
    }));
    const missing: string[] = [];
    for (const [ch, where] of uiCharacters()) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 || KNOWN_DEBT.has(ch)) continue;
      const face = text.find((f) => f.ranges.some(([a, b]) => cp >= a && cp <= b));
      if (!face?.glyphs.has(cp)) {
        missing.push(`«${ch}» U+${cp.toString(16)} (${face ? `нет в ${face.file}` : "вне диапазонов"}) — ${where}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("положительный контроль: чтение cmap видит то, что в файле есть, и не видит того, чего нет", () => {
    const latin = faces(TEXT_FAMILY).find((f) => f.file.includes("latin"))!;
    const glyphs = glyphCodepoints(resolve(WEB, "../public/fonts", latin.file));
    for (const cp of [0x41, 0x30, 0x2014, 0x2192]) expect(glyphs.has(cp), `U+${cp.toString(16)}`).toBe(true);
    // кириллица — в своей грани, «▸» нет в Manrope вовсе
    for (const cp of [0x416, 0x25b8]) expect(glyphs.has(cp), `U+${cp.toString(16)}`).toBe(false);
  });
});
