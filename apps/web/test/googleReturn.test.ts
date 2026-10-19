import { describe, expect, test } from "bun:test";
import { GOOGLE_RETURN_CODES, renderError } from "@quizzy/shared";
import { googleRefusal } from "../src/pages/GoogleReturn";

/**
 * Отказ возврата от Google (ревью волны 26).
 *
 * Сервер отказывал JSON-ом на адресе API (GET /api/auth/google/callback): сюда
 * браузер приходит переходом от Google, и человек видел сырой текст без пути
 * назад. Теперь отказ — переходом в консоль, /auth/google?error=<ключ>, и
 * экран возврата говорит причину словами на языке страницы.
 */
describe("экран возврата от Google читает причину отказа из адреса", () => {
  test("ключ отказа — словами на языке страницы", () => {
    expect(googleRefusal("?error=err.googleNotLinked", "uk")).toBe(renderError("err.googleNotLinked", "uk"));
    expect(googleRefusal("?error=err.googleState", "en")).toBe(renderError("err.googleState", "en"));
    for (const key of GOOGLE_RETURN_CODES) expect(googleRefusal(`?error=${key}`, "ru"), key).toBe(renderError(key, "ru"));
  });

  test("чужой ключ или выдуманный текст в адресе на экран не попадают", () => {
    // адрес может набрать кто угодно: на экране входа — только причины из списка сервера
    expect(googleRefusal("?error=err.internal", "uk")).toBeNull();
    expect(googleRefusal(`?error=${encodeURIComponent("Ваш пароль: введіть його тут")}`, "uk")).toBeNull();
    expect(googleRefusal("?code=abc", "uk")).toBeNull();
    expect(googleRefusal("", "uk")).toBeNull();
  });
});
