import { describe, expect, test } from "bun:test";
import { api, root } from "./fixtures";

/**
 * Отказ приходит на языке того, кто спрашивал.
 *
 * До переделки текст писался в маршруте по-русски и уезжал клиенту готовым:
 * словарь интерфейса такие строки не видит, переключатель языка на них не
 * действует. Украиноязычный пациент читал «Вы уже проходили эту методику» на
 * украинском экране.
 *
 * Проверяется именно то, что легко сломать незаметно: один и тот же отказ на
 * двух языках — разный, а без заголовка приходит украинский. Расхождение
 * ловится сравнением текстов между собой, а не сверкой с константой: так
 * тест переживает правку формулировки и падает ровно тогда, когда перевод
 * потерялся.
 */
describe("язык отказа", () => {
  const missing = "/api/surveys/00000000-0000-0000-0000-000000000000";

  test("русский и украинский тексты не совпадают", async () => {
    const ru = await api(missing, root.token, { headers: { "Accept-Language": "ru" } });
    const uk = await api(missing, root.token, { headers: { "Accept-Language": "uk" } });

    expect(ru.status).toBe(404);
    expect(uk.status).toBe(404);
    expect(typeof ru.body.error).toBe("string");
    expect(ru.body.error.length).toBeGreaterThan(0);
    expect(uk.body.error).not.toBe(ru.body.error);
  });

  test("без заголовка отвечаем по-украински", async () => {
    /*
     * Учреждение украинское, и умолчание должно быть его языком. Заголовок
     * подставляется в помощнике тестов, поэтому здесь он гасится явно.
     */
    const uk = await api(missing, root.token, { headers: { "Accept-Language": "uk" } });
    const none = await api(missing, root.token, { headers: { "Accept-Language": "" } });
    expect(none.body.error).toBe(uk.body.error);
  });

  test("ключ наружу не просачивается", async () => {
    /*
     * Ключ едет в исключении и сообщением, и причиной — сообщение видно в
     * логе. Наружу должен уходить только текст: «err.surveyNotFound» на
     * экране у специалиста хуже, чем отсутствие текста вовсе.
     */
    const res = await api(missing, root.token);
    expect(res.body.error).not.toMatch(/^err\./);
  });
});
