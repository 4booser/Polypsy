import { describe, expect, test } from "bun:test";
import type { RouteObject } from "react-router-dom";
import { isRouteTemplate, screenViewsSchema } from "@quizzy/shared";
import { ScreenBatch, templateOf } from "../src/telemetry/model";

/**
 * Телеметрия экранов: наружу уходит шаблон маршрута, а не адрес.
 *
 * Главное, что здесь сторожится, — что идентификатор из адреса не
 * просочится в счётчик ни при каком виде маршрута: вложенном, с индексом,
 * с абсолютным путём ребёнка, с перехватом. Счётчик с адресом был бы вторым
 * журналом чтений карт — без хэш-цепочки и без права audit.read.
 */

/* Дерево той же формы, что в App.tsx: верхние пути, вложенные, индексы, перехват */
const ROUTES: RouteObject[] = [
  { path: "/", children: [{ index: true }] },
  { path: "/surveys" },
  { path: "/surveys/drafts" },
  { path: "/surveys/:id" },
  { path: "/surveys/:id/responses/:rid/charts" },
  { path: "/patients" },
  { path: "/patients/:userId" },
  {
    path: "/patients/:userId/case",
    children: [{ index: true }, { path: "dynamics" }, { path: "timeline" }],
  },
  { path: "/staff/:id", children: [{ index: true }, { path: "patients" }] },
  { path: "/ops", children: [{ index: true }, { path: "quality" }, { path: "usage" }] },
  { path: "/my-schedule" },
  { path: "*" },
];

const UUID = "8c1f2b1e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

describe("шаблон маршрута", () => {
  test("идентификатор заменён именем параметра", () => {
    expect(templateOf(ROUTES, `/patients/${UUID}`)).toBe("/patients/:userId");
    expect(templateOf(ROUTES, `/surveys/${UUID}/responses/${UUID}/charts`)).toBe(
      "/surveys/:id/responses/:rid/charts",
    );
  });

  test("вложенные пути достраиваются родителем, индекс ничего не добавляет", () => {
    expect(templateOf(ROUTES, `/patients/${UUID}/case`)).toBe("/patients/:userId/case");
    expect(templateOf(ROUTES, `/patients/${UUID}/case/dynamics`)).toBe("/patients/:userId/case/dynamics");
    expect(templateOf(ROUTES, "/ops/quality")).toBe("/ops/quality");
    expect(templateOf(ROUTES, "/ops")).toBe("/ops");
    expect(templateOf(ROUTES, "/")).toBe("/");
  });

  test("точный сегмент выигрывает у параметра — как при отрисовке", () => {
    expect(templateOf(ROUTES, "/surveys/drafts")).toBe("/surveys/drafts");
  });

  test("перехват «*» — не экран, а перенаправление: не считается", () => {
    expect(templateOf(ROUTES, "/no/such/place")).toBeNull();
    expect(templateOf(ROUTES, `/join/${UUID}`)).toBeNull();
  });

  test("ни один шаблон не содержит куска адреса", () => {
    const addresses = [
      `/patients/${UUID}`,
      `/patients/${UUID}/case/timeline`,
      `/staff/${UUID}/patients`,
      `/surveys/${UUID}`,
      "/patients/12345",
    ];
    for (const a of addresses) {
      const t = templateOf(ROUTES, a);
      expect(t, a).not.toBeNull();
      expect(t!).not.toContain(UUID);
      expect(t!).not.toMatch(/[0-9]/);
      expect(isRouteTemplate(t!)).toBe(true);
    }
  });
});

describe("проверка шаблона (общая с сервером)", () => {
  test("адрес с идентификатором отвергается", () => {
    expect(isRouteTemplate(`/patients/${UUID}`)).toBe(false);
    expect(isRouteTemplate("/patients/12345")).toBe(false);
    // шестнадцатеричная строка без единой цифры — всё равно идентификатор
    expect(isRouteTemplate("/patients/abcdefab-cdef-abcd-efab-cdefabcdefab")).toBe(false);
    expect(isRouteTemplate("/patients/deadbeef")).toBe(false);
    // запрос и якорь — тоже кусок адреса
    expect(isRouteTemplate("/patients?q=Петренко")).toBe(false);
    expect(isRouteTemplate("/patients#x")).toBe(false);
    expect(isRouteTemplate("/patients/")).toBe(false);
    expect(isRouteTemplate("patients")).toBe(false);
  });

  test("настоящие шаблоны проходят", () => {
    for (const t of ["/", "/patients/:userId", "/my-schedule", "/patient-groups/:id/edit", "/survey/:id", "/ops/*"]) {
      expect(isRouteTemplate(t), t).toBe(true);
    }
  });

  test("лишнее поле в пачке отвергается", () => {
    const ok = { views: [{ app: "console", route: "/patients/:userId", count: 3 }] };
    expect(screenViewsSchema.safeParse(ok).success).toBe(true);
    expect(
      screenViewsSchema.safeParse({ views: [{ ...ok.views[0], title: "Петренко І. П." }] }).success,
    ).toBe(false);
    expect(screenViewsSchema.safeParse({ ...ok, userId: UUID }).success).toBe(false);
  });
});

describe("пачка", () => {
  test("одинаковые открытия складываются, пачка забирается целиком", () => {
    const b = new ScreenBatch();
    b.add("console", "/patients/:userId");
    b.add("console", "/patients/:userId");
    b.add("patient", "/me");
    expect(b.views()).toBe(3);
    const packs = b.take();
    expect(packs).toHaveLength(1);
    expect(packs[0]!.views).toContainEqual({ app: "console", route: "/patients/:userId", count: 2 });
    expect(b.views()).toBe(0);
    expect(b.take()).toEqual([]);
  });

  test("больше полусотни шаблонов — несколько пачек, каждую сервер примет", () => {
    const b = new ScreenBatch();
    for (let i = 0; i < 120; i++) b.add("console", `/r${"x".repeat(i % 20)}/${String.fromCharCode(97 + (i % 26))}${"q".repeat(Math.floor(i / 26))}`);
    const packs = b.take();
    expect(packs.length).toBeGreaterThan(1);
    for (const p of packs) expect(p.views.length).toBeLessThanOrEqual(50);
  });
});
