import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Техпанель на 1280 — главной ширине консоли (13-дюймовые ноутбуки
 * отделения). Ширины здесь — из стенда: на 1280 у раздела техпанели под
 * таблицу 926 px (полоса приложения, рельса, колонка подразделов и поля
 * страницы съедают остальное), у половины строки в «Ключах» — 454 px.
 *
 * Было: «Такти процесу» в «Фонових задачах» требовали 1074 px, и колонка с
 * «Запустити зараз» на 1280 уходила под прокрутку вбок — ручной запуск не
 * был виден вовсе; таблица версий ключа в «Ключах» прятала за край
 * «Пробне розшифрування».
 */

const src = (p: string) => readFileSync(resolve(import.meta.dir, "../src/pages/ops", p), "utf8");
const CONTENT_1280 = 926;
const HALF_1280 = 454;

/** Наименьшая ширина колонок сетки: minmax(A,…) — A, фиксированная — сама, auto и fr без минимума — 0 */
function minWidth(template: string): { sum: number; cols: string[] } {
  const cols = template.split("_");
  const sum = cols.reduce((s, c) => {
    const m = /^minmax\((\d+)px,/.exec(c) ?? /^(\d+)px$/.exec(c);
    return s + (m ? Number(m[1]) : 0);
  }, 0);
  return { sum, cols };
}

describe("«Фонові задачі» на 1280", () => {
  const jobs = src("Jobs.tsx");
  const compact = /max-\[1439px\]:grid-cols-\[([^\]]+)\]/.exec(jobs)?.[1];

  test("ниже 1440 — своя сетка колонок, и она помещается в 926 px вместе с зазорами и полями", () => {
    expect(compact).toBeDefined();
    const { sum, cols } = minWidth(compact!);
    expect(cols).toHaveLength(8);
    const gaps = (cols.length - 1) * 10; // max-[1439px]:gap-x-2.5
    const padding = 2 * 16; // px-4
    expect(jobs).toContain("max-[1439px]:gap-x-2.5");
    expect(sum + gaps + padding).toBeLessThanOrEqual(CONTENT_1280);
    // и обёртка не держит таблицу шире: иначе прокрутка вбок осталась бы
    const wrap = /max-\[1439px\]:min-w-\[(\d+)px\]/.exec(jobs)?.[1];
    expect(Number(wrap)).toBeLessThanOrEqual(CONTENT_1280);
  });

  test("колонка кнопки — постоянной ширины: строки — отдельные сетки и не разъезжаются", () => {
    const { cols } = minWidth(compact!);
    expect(cols.at(-1)).toMatch(/^\d+px$/);
  });

  test("имя задачи переносится, как в макете, а не обрезается многоточием", () => {
    expect(jobs).toContain('<b className="block text-[13.5px] font-bold leading-[18px] text-text [overflow-wrap:anywhere]">{key ? ut(key) : j.name}</b>');
  });
});

describe("«Другий фактор» на 1280", () => {
  /*
   * Таблица «Кому потрібен» стоит на наименьших ширинах колонок уже без
   * кнопки; как только у кого-то фактор настроен, «Скинути» добавляла
   * колонку — 955 px в панели 926 — и кнопка уходила за край. Обрезанное
   * многоточием имя держит колонку по всей своей длине; переносом оно её
   * отпускает.
   */
  test("имя в таблице «Кому потрібен» переносится, а не обрезается", () => {
    const mfa = src("people2/MfaPolicy.tsx");
    const link = /<Link\s+to=\{personHref\(r\)\}\s+className="([^"]+)"/.exec(mfa)?.[1] ?? "";
    expect(link).toContain("[overflow-wrap:anywhere]");
    expect(link.split(/\s+/)).not.toContain("truncate");
  });
});

describe("«Ключі й секрети» на 1280", () => {
  test("таблица версий ключа помещается в половину строки: подписи колонок переносятся", () => {
    const keys = src("sec/Keys.tsx");
    const m = /<table className="w-full min-w-\[(\d+)px\] border-separate border-spacing-0 \[&_th\]:whitespace-normal">/.exec(keys);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(HALF_1280);
  });
});
