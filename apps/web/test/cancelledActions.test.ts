import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Отказ не должен объявляться успехом.
 *
 * `run(fn, "Сохранено")` показывает подтверждение, когда действие прошло. Но
 * пока действие могло выйти обычным `return`, подтверждение показывалось и
 * тогда, когда ничего не произошло: человек нажимал «удалить», отказывался в
 * системном окне — и читал «группа удалена». Группа оставалась на месте.
 *
 * Теперь «я ничего не сделал» выражается возвратом false. Проверка следит,
 * чтобы внутри run не осталось голых выходов после вопроса человеку: такой
 * выход — это ровно тот случай, ради которого правило и заведено.
 */

const SRC = resolve(import.meta.dir, "../src");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("отменённое действие не рапортует об успехе", () => {
  test("после вопроса человеку внутри run стоит return false, а не return", () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, "utf8");
      /*
       * Смотреть надо ВНУТРЬ run, а не рядом с вопросом.
       *
       * Первая редакция ловила «вопрос человеку, а ниже голый return» по
       * соседним строкам — и дала две ложные тревоги: там вопрос стоит ДО
       * run, выход покидает обработчик нажатия, и подтверждать нечего.
       * Сторож с ложными тревогами хуже отсутствующего: его начинают
       * заглушать, и вместе с шумом уходит сигнал.
       *
       * Поэтому берём тело каждого вызова run по балансу скобок и ищем
       * пару «вопрос + голый выход» только там.
       */
      for (const m of text.matchAll(/\brun\(/g)) {
        const open = text.indexOf("(", m.index!);
        let depth = 0;
        let end = open;
        for (let i = open; i < text.length; i++) {
          if (text[i] === "(") depth++;
          else if (text[i] === ")" && --depth === 0) {
            end = i;
            break;
          }
        }
        const body = text.slice(open, end);
        if (!/window\.(confirm|prompt|alert)\(|[^.\w]confirm\(/.test(body)) continue;
        const at = body.match(/^[ \t]*(if \(.*\) )?return;[ \t]*$/m);
        if (at) {
          const line = text.slice(0, open + body.indexOf(at[0])).split("\n").length;
          bad.push(`${file.slice(SRC.length + 1)}:${line}: ${at[0].trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
