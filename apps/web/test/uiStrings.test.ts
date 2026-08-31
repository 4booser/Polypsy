import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { UI } from "@quizzy/shared";

/**
 * Строки интерфейса — только через словарь.
 *
 * Смоук на языке уже есть: он открывает страницу на двух языках и ищет буквы,
 * которых в украинском алфавите нет. Признак надёжный, но с двумя слепыми
 * зонами. Во-первых, «Создать», «Отозвать», «Снять» таких букв не содержат и
 * проходят насквозь. Во-вторых, экранов там четырнадцать из тридцати трёх, а
 * забытая строка обычно сидит не на главном.
 *
 * Здесь проверяются исходники, а не страница: на каждом экране, включая те, до
 * которых смоук не доходит, и без запущенного приложения. Ошибка ловится в
 * момент написания, а не через полгода в кабинете.
 */

const SRC = "src";

/*
 * Что разрешено оставить в разметке — с причиной для каждого случая.
 * Список короткий намеренно: длинный список исключений означает, что правило
 * не работает.
 */
const ALLOWED = new Map<string, string>([
  [
    "src/pages/UiKit.tsx",
    "витрина языка интерфейса: демонстрационные данные и пояснения к самой " +
      "системе оформления. Читает её разработчик, а не специалист в кабинете; " +
      "переводить «Петров Дмитрий» и «Рота обеспечения» не для кого",
  ],
  [
    "src/lang.tsx",
    "переключатель языка: «УКР» и «РУС» обязаны выглядеть одинаково в любом " +
      "режиме, иначе выбранный язык нельзя сменить обратно",
  ],
]);

/** Подписи, которые называют сам язык и потому не переводятся. */
const LANGUAGE_LABELS = new Set(["українською", "по-русски", "Мова / Язык", "УКР", "РУС"]);

const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;

/** Убирает комментарии: пояснения в коде по-русски — это норма проекта. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Видимый пользователю текст файла: узлы JSX и подписи в свойствах. */
function visibleStrings(source: string): string[] {
  const src = withoutComments(source);
  const found = new Set<string>();

  for (const m of src.matchAll(/>([^<>]*)</g)) {
    const text = m[1]!
      .replace(/\{[^{}]*\}/g, " ") // выражения — не литералы
      .replace(/\s+/g, " ")
      .trim();
    if (text && CYRILLIC.test(text)) found.add(text);
  }

  const PROPS = "placeholder|title|aria-label|alt|label|actionLabel|hint|caption|centerLabel";
  for (const m of src.matchAll(new RegExp(`(?:${PROPS})\\s*=\\s*"([^"]+)"`, "g"))) {
    if (CYRILLIC.test(m[1]!)) found.add(m[1]!.trim());
  }

  return [...found].filter((t) => !LANGUAGE_LABELS.has(t));
}

describe("строки интерфейса", () => {
  test("в разметке не остаётся текста мимо словаря", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      if (ALLOWED.has(file)) continue;
      for (const text of visibleStrings(readFileSync(file, "utf8"))) {
        offenders.push(`${file}: ${text.slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("у каждого ключа есть оба перевода и они не совпадают по недосмотру", () => {
    /*
     * Совпадение допустимо: «Пароль», «Email», «Дата» одинаковы на обоих
     * языках. Проверяется другое — что перевод не пустой и не остался
     * заглушкой вида «TODO».
     */
    const bad: string[] = [];
    for (const [key, pair] of Object.entries(UI)) {
      if (!pair.uk?.trim()) bad.push(`${key}: пустой uk`);
      if (!pair.ru?.trim()) bad.push(`${key}: пустой ru`);
      if (/TODO|FIXME|xxx/i.test(pair.uk + pair.ru)) bad.push(`${key}: заглушка вместо перевода`);
    }
    expect(bad).toEqual([]);
  });
});
