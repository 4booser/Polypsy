import { describe, expect, test } from "bun:test";
import { templateOfSegments } from "../src/telemetry/template";

/**
 * Шаблон экрана приложения — из имён файлов маршрута, а не из адреса.
 *
 * Сторожится одно: в счётчик не попадает значение из адреса. Сегменты
 * expo-router — это `[id]`, а не идентификатор методики, и шаблон обязан
 * остаться именем параметра.
 */
describe("шаблон экрана мобильного приложения", () => {
  test("группа раскладки выбрасывается, параметр становится :именем", () => {
    expect(templateOfSegments(["(app)", "surveys"])).toBe("/surveys");
    expect(templateOfSegments(["survey", "[id]"])).toBe("/survey/:id");
    expect(templateOfSegments(["analytics", "patients", "[userId]"])).toBe("/analytics/patients/:userId");
    expect(templateOfSegments(["rounds", "[userId]"])).toBe("/rounds/:userId");
  });

  test("корень — «/», хвост — «*»", () => {
    expect(templateOfSegments([])).toBe("/");
    expect(templateOfSegments(["docs", "[...rest]"])).toBe("/docs/*");
  });

  test("сегмент, похожий на значение, не уходит вовсе", () => {
    // так выглядел бы адрес вместо шаблона — такое не отправляется
    expect(templateOfSegments(["survey", "8c1f2b1e-3d4a-4f5b-9c6d-7e8f9a0b1c2d"])).toBeNull();
    expect(templateOfSegments(["survey", "42"])).toBeNull();
  });
});
