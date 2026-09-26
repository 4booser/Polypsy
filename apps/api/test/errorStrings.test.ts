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

  test("у каждого отказа есть все три перевода", () => {
    /*
     * Английский — наравне с двумя прежними, а не «когда переведут»: в
     * отличие от словаря оболочки, отказы переведены целиком сразу (их две
     * сотни, и именно их человек читает, когда что-то не вышло). Тип
     * ErrorEntry держит наличие поля, здесь — то, чего тип не видит:
     * пустоту и разъехавшиеся подстановки.
     */
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(ERRORS)) {
      if (!entry.uk?.trim()) bad.push(`${key}: пустой uk`);
      if (!entry.ru?.trim()) bad.push(`${key}: пустой ru`);
      if (!entry.en?.trim()) bad.push(`${key}: пустой en`);
      // подстановки должны совпадать: иначе на одном языке пропадёт число
      const marks = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
      if (marks(entry.uk) !== marks(entry.ru)) bad.push(`${key}: разные подстановки uk/ru`);
      if (marks(entry.uk) !== marks(entry.en)) bad.push(`${key}: разные подстановки uk/en`);
    }
    expect(bad).toEqual([]);
  });

  test("английский отказ написан по-английски", () => {
    // кириллица в английском поле — это скопированная, а не переведённая строка
    const leaked = Object.entries(ERRORS)
      .filter(([, entry]) => /[\u0400-\u04FF]/.test(entry.en))
      .map(([key, entry]) => `${key}: «${entry.en}»`);
    expect(leaked).toEqual([]);
  });
});
