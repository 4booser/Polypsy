import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * У каждого маршрута есть дверь.
 *
 * Долг, ради которого написана проверка: два адреса были заведены, разобраны
 * экраном через useMatch, описаны в докблоках — и ни одной ссылки на них во
 * всём клиенте не было. «Зберегти чернетку» на заключении
 * (/responses/:id/conclusion/draft) и правка названия группы
 * (/patient-groups/:id/edit) стали недостижимы: попасть можно было, только
 * набрав адрес руками. Ни типы, ни сборка, ни один из 328 тестов этого не
 * заметили — потеря возможности выглядит ровно как работающий код.
 *
 * Проверка грубая и потому надёжная: берётся форма каждого маршрута из
 * App.tsx и ищется среди строк остального дерева. Она НЕ доказывает, что
 * ссылка нарисована на видном месте и что до неё можно дойти нажатиями, —
 * это работа смоука. Она ловит другое, более грубое: адрес, на который в
 * коде не ссылается вообще ничто.
 */

const WEB = resolve(import.meta.dir, "../src");
const APP = readFileSync(join(WEB, "App.tsx"), "utf8");

/**
 * Адреса, у которых двери нет намеренно. Список короткий и каждый со своим
 * доводом: длинный список исключений — это отключённая проверка.
 */
const NO_DOOR = new Set([
  /* корень: на него приводит браузер, а не ссылка */
  "/",
  /* возврат от Google: сюда браузер приводит сервер */
  "/auth/google",
  /* старая закладка на сводку — перенаправление, ссылаться на него незачем */
  "/patients/:userId/summary",
  /* инструменты того, кто пишет систему: из меню убраны намеренно (Rail.tsx) */
  "/ui",
  "/api-docs",
  /*
   * Прежние «Облікові записи» и «Журнал доступу» — перенаправления на вкладки
   * техпанели (волна 10): старые закладки должны работать, а ссылаться на
   * адрес, который сразу уводит дальше, незачем.
   */
  "/users",
  "/audit",
]);

/** Все .ts/.tsx дерева, кроме самого App.tsx: ссылки ищутся в них */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(e.name) && e.name !== "App.tsx") out.push(path);
  }
  return out;
}

/**
 * Подстановки гасятся до звёздочки, и по разу, пока меняется: они бывают
 * вложенными, и один проход оставляет от внешней огрызок.
 */
function flatten(text: string): string {
  let out = text;
  for (let before = ""; before !== out; ) {
    before = out;
    out = out.replace(/\$\{[^{}]*\}/g, "*");
  }
  return out;
}

/** Форма адреса: значение — звёздочка, хвостовая косая не в счёт */
const shape = (path: string) => path.replace(/:[A-Za-z][A-Za-z0-9]*/g, "*").replace(/\/+$/, "");

const CODE = flatten(sources(WEB).map((f) => readFileSync(f, "utf8")).join("\n"));
const TARGETS = new Set(
  [...CODE.matchAll(/["'`](\/?[A-Za-z0-9_\-*/.]*)["'`]/g)]
    .map((m) => m[1]!.replace(/\/+$/, ""))
    .filter((t) => t.includes("/")),
);

/**
 * Ссылка на маршрут — либо адрес целиком, либо собранный от базы:
 * `${base}/dynamics` после гашения выглядит как «*\/dynamics», и это
 * настоящая дверь в /patients/:id/case/dynamics.
 */
function hasDoor(route: string): boolean {
  const want = shape(route);
  if (TARGETS.has(want)) return true;
  for (const t of TARGETS) {
    if (t.startsWith("*") && t.length > 3 && want.endsWith(t.slice(1))) return true;
  }
  return false;
}

describe("двери маршрутов", () => {
  const routes = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((m) => m[1]!)
    /* относительные пути вложенных маршрутов достраиваются родителем */
    .filter((p) => p.startsWith("/") && p !== "*" && p !== "/*");

  test("маршрутов в App.tsx нашлось не меньше полусотни", () => {
    /* сторож самого сторожа: сломанный разбор App.tsx дал бы пустой список и зелень */
    expect(routes.length).toBeGreaterThan(50);
  });

  test("на каждый маршрут в коде есть ссылка", () => {
    const orphans = routes.filter((r) => !NO_DOOR.has(r) && !hasDoor(r));
    expect(orphans, `недостижимы: ${orphans.join(", ")}`).toEqual([]);
  });

  test("список исключений не оброс: каждое — действительно без двери", () => {
    /* исключение, у которого дверь появилась, обязано уйти из списка */
    const stale = [...NO_DOOR].filter((r) => hasDoor(r));
    expect(stale, `дверь есть, исключение лишнее: ${stale.join(", ")}`).toEqual([]);
  });
});
