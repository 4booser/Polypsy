import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { exitFrom, fallbackOf, segmentsOfRouteFile } from "../src/nav/exits";

/**
 * С каждого экрана есть выход.
 *
 * Внешний разбор нашёл две ловушки — аналитику без выхода и согласие без
 * отказа; повторная проверка — ещё три того же рода: карту пациента в
 * обходе без шапки, прохождение скрининга, открытое заменой всего
 * приложения, и любой экран вне вкладок, открытый по ссылке первым. Общее у
 * всех одно: позади нет экрана, и «назад» ведёт в никуда.
 */

const APP = resolve(import.meta.dir, "../app");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...routeFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(relative(APP, path));
  }
  return out;
}

describe("решение: назад или на запасное место", () => {
  test("есть куда вернуться — назад, что бы ни было запасным", () => {
    expect(exitFrom(["analytics"], true)).toEqual({ kind: "back" });
    expect(exitFrom(["survey", "[id]"], true)).toEqual({ kind: "back" });
    expect(exitFrom(["login"], true)).toEqual({ kind: "back" });
  });

  test("аналитика, открытая первой: корень — к вкладкам, вложенный — к корню раздела", () => {
    // именно так выглядела ловушка: раздел вместо вкладок и позади ничего
    expect(exitFrom(["analytics"], false)).toEqual({ kind: "replace", href: "/(app)/surveys" });
    expect(exitFrom(["analytics", "[id]"], false)).toEqual({ kind: "replace", href: "/analytics" });
    expect(exitFrom(["analytics", "patients", "[userId]"], false)).toEqual({ kind: "replace", href: "/analytics" });
  });

  test("прохождение, карта обхода и регистрация, открытые первыми, уходят на своё место", () => {
    expect(exitFrom(["survey", "[id]"], false)).toEqual({ kind: "replace", href: "/(app)/surveys" });
    expect(exitFrom(["rounds", "[userId]"], false)).toEqual({ kind: "replace", href: "/(app)/rounds" });
    expect(exitFrom(["register"], false)).toEqual({ kind: "replace", href: "/login" });
  });

  test("корень потока — выход из приложения, а не подмена", () => {
    // вход, согласие и вкладки: «назад» с них закрывает приложение, как и положено
    expect(exitFrom([], false)).toBeNull();
    expect(exitFrom(["login"], false)).toBeNull();
    expect(exitFrom(["consent"], false)).toBeNull();
    expect(exitFrom(["(app)", "home"], false)).toBeNull();
  });

  test("запасное место никогда не совпадает с самим экраном", () => {
    // иначе «выход» заменял бы экран им же — та же ловушка, только с анимацией
    for (const segments of [["analytics"], ["analytics", "alerts"], ["survey", "[id]"], ["rounds", "[userId]"], ["register"]]) {
      const href = fallbackOf(segments)!;
      expect(href).not.toBe(`/${segments.join("/")}`);
    }
  });
});

describe("сегменты из пути файла — как их отдаёт useSegments", () => {
  test("index опускается, раскладки экранами не считаются", () => {
    expect(segmentsOfRouteFile("analytics/index.tsx")).toEqual(["analytics"]);
    expect(segmentsOfRouteFile("analytics/[id]/index.tsx")).toEqual(["analytics", "[id]"]);
    expect(segmentsOfRouteFile("survey/[id].tsx")).toEqual(["survey", "[id]"]);
    expect(segmentsOfRouteFile("index.tsx")).toEqual([]);
    expect(segmentsOfRouteFile("analytics/_layout.tsx")).toBeNull();
  });
});

describe("каждый экран вне вкладок имеет запасной выход", () => {
  /*
   * Вкладки выход имеют всегда — панель вкладок; корни потоков (точка
   * входа, вход, согласие) выходят из приложения, и там отказ и выход — это
   * кнопки на самом экране (consent/model.ts). Всё остальное обязано знать,
   * куда уйти, если позади пусто. Новый экран без запасного выхода уронит
   * этот тест в тот же день, когда появится.
   */
  const FLOW_ROOTS = new Set(["", "login", "consent"]);

  test("обход каталога app/", () => {
    const files = routeFiles(APP);
    expect(files.length).toBeGreaterThan(15);

    const trapped: string[] = [];
    for (const file of files) {
      const segments = segmentsOfRouteFile(file);
      if (!segments) continue; // раскладка
      if (segments[0] === "(app)") continue; // вкладка
      if (FLOW_ROOTS.has(segments.join("/"))) continue;
      if (!fallbackOf(segments)) trapped.push(file);
    }
    expect(trapped).toEqual([]);
  });
});
