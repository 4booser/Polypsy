import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ERRORS } from "@quizzy/shared";

/**
 * Отказы — только через словарь.
 *
 * Тип ErrorKey закрывает главный путь: помощники badRequest, notFound и
 * прочие принимают ключ, и русская фраза до боя не доживёт — её найдёт
 * компилятор. Но мимо помощников можно ответить и напрямую, через
 * c.json({ error: … }), и вот это компилятор пропустит: тип у поля обычная
 * строка.
 *
 * Здесь проверяется именно обход. Плюс — что в словаре нет ключей, которых
 * никто не зовёт: они накапливаются молча и заставляют переводить текст,
 * который никто не увидит.
 */

const SRC = resolve(import.meta.dir, "../src");

/** Комментарии по-русски — норма проекта, их из проверки убираем. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

const CYRILLIC = /[А-Яа-яЁё]/;

describe("тексты отказов", () => {
  const files = sources(SRC);

  test("исходники вообще нашлись", () => {
    /*
     * Первой строкой, а не в уме: проверка, которая обошла пустой список и
     * объявила победу, отвечает «всё в порядке» на вопрос, который не
     * задавала. Так уже случалось в соседнем пакете.
     */
    expect(files.length).toBeGreaterThan(40);
  });

  test("ответ с ошибкой не собирается в обход словаря", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // seed.ts — демоданные, а не интерфейс
      if (file.endsWith("/seed.ts")) continue;
      const src = withoutComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(/error:\s*"([^"]+)"/g)) {
        if (CYRILLIC.test(m[1]!)) offenders.push(`${file.slice(SRC.length + 1)}: ${m[1]!.slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("в словаре отказов нет ключей, которых никто не зовёт", () => {
    const code = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const unused = Object.keys(ERRORS).filter((key) => !code.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });

  test("у каждого отказа есть оба перевода", () => {
    const bad: string[] = [];
    for (const [key, pair] of Object.entries(ERRORS)) {
      if (!pair.uk?.trim()) bad.push(`${key}: пустой uk`);
      if (!pair.ru?.trim()) bad.push(`${key}: пустой ru`);
      // подстановки должны совпадать: иначе на одном языке пропадёт число
      const marks = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
      if (marks(pair.uk) !== marks(pair.ru)) bad.push(`${key}: разные подстановки в переводах`);
    }
    expect(bad).toEqual([]);
  });
});
