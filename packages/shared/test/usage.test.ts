import { describe, expect, test } from "bun:test";
import { compareVersions, isRouteTemplate, ScreenBatch } from "../src/usage";

/**
 * Общая часть телеметрии и учёта сборок: то, на что опираются и клиенты, и
 * сервер. Ошибка здесь расходится сразу в три места — консоль, кабинет и
 * мобильное приложение.
 */

describe("сравнение версий", () => {
  test("числами, а не строкой: 1.10 новее 1.9", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareVersions("1.9.3", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.2.0-beta", "1.2.0")).toBe(0);
    expect(compareVersions("0.9.12", "0.10.0")).toBe(-1);
  });
});

describe("шаблон маршрута", () => {
  test("шаблоны проходят, адреса — нет", () => {
    expect(isRouteTemplate("/patients/:userId/case/dynamics")).toBe(true);
    expect(isRouteTemplate("/")).toBe(true);
    expect(isRouteTemplate("/patients/8c1f2b1e-3d4a-4f5b-9c6d-7e8f9a0b1c2d")).toBe(false);
    expect(isRouteTemplate("/visit/42")).toBe(false);
    expect(isRouteTemplate("//patients")).toBe(false);
    expect(isRouteTemplate(`/${"a".repeat(130)}`)).toBe(false);
  });

  test("пачка не копит того, что сервер отвергнет", () => {
    const b = new ScreenBatch();
    b.add("console", "/visit/42");
    b.add("console", "/visit/:id");
    expect(b.views()).toBe(1);
    expect(b.take()).toEqual([{ views: [{ app: "console", route: "/visit/:id", count: 1 }] }]);
  });
});
