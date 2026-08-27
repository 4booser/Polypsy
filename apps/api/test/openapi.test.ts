import { describe, expect, test } from "bun:test";

/**
 * Спека не должна расходиться с кодом.
 *
 * Здесь проверяется не то, что документ красивый, а то, что он полон: каждый
 * маршрут приложения описан, и в описании нет строк про маршруты, которых уже
 * нет. Добавили эндпоинт без описания — сборка встала. Именно это и делает
 * документацию живой: помнить о ней не нужно, о ней напоминают.
 */
const { app } = await import("../src/app");
const { buildOpenApi, dedupe, ROUTE_DOCS, UNDOCUMENTED } = await import("../src/lib/openapi");

const routes = dedupe(app.routes);
const realKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));

describe("описание API", () => {
  test("описан каждый маршрут приложения", () => {
    const missing = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !ROUTE_DOCS[k] && !UNDOCUMENTED.has(k));
    expect(missing).toEqual([]);
  });

  test("нет описаний на исчезнувшие маршруты", () => {
    const stale = Object.keys(ROUTE_DOCS).filter((k) => !realKeys.has(k));
    expect(stale).toEqual([]);
  });

  test("документ собирается и содержит схемы тел", () => {
    const doc = buildOpenApi(app.routes, "0.0.0-test");
    expect(doc.openapi).toBe("3.1.0");

    // путь Hono переведён в формат OpenAPI
    expect(doc.paths["/api/surveys/{id}"]).toBeDefined();
    expect(doc.paths["/api/surveys/:id"]).toBeUndefined();

    // параметр пути объявлен
    const get = doc.paths["/api/surveys/{id}"]!.get as { parameters: { name: string }[] };
    expect(get.parameters.map((p) => p.name)).toContain("id");

    // тело входа взято из zod-схемы, а не написано руками
    const login = doc.paths["/api/auth/login"]!.post as {
      requestBody: { content: { "application/json": { schema: { properties: object } } } };
    };
    expect(Object.keys(login.requestBody.content["application/json"].schema.properties)).toEqual(
      expect.arrayContaining(["email", "password"]),
    );
  });

  test("публичные маршруты не требуют токена, остальные требуют", () => {
    const doc = buildOpenApi(app.routes, "0.0.0-test");
    const login = doc.paths["/api/auth/login"]!.post as { security: unknown[] };
    const users = doc.paths["/api/users"]!.get as { security: unknown[] };
    expect(login.security).toEqual([]);
    expect(users.security).toEqual([{ bearerAuth: [] }]);
  });
});
