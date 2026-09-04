import { describe, expect, test } from "bun:test";
import { adminA, api, makeUser } from "./fixtures";
import { signState, verifyState } from "../src/lib/meetState";

/**
 * Подключение календаря для дистанционного приёма.
 *
 * Проверяется не работа Google — её проверить нечем, — а два места, где
 * ошибка не видна снаружи и дорого стоит: возврат должен принадлежать тому,
 * кто его начал, и ненастроенный сервер должен говорить об этом вслух, а не
 * молчать.
 */

describe("состояние возврата", () => {
  test("подписанное состояние опознаёт того, кто его начал", () => {
    const state = signState("user-42");
    expect(verifyState(state)).toBe("user-42");
  });

  test("подделанное состояние не принимается", () => {
    /*
     * Без подписи чужое состояние подключило бы календарь одного
     * специалиста к учётной записи другого: события начали бы появляться не
     * у того человека, и заметили бы это не сразу.
     */
    const state = signState("user-42");
    const [payload] = state.split(".");
    expect(verifyState(`${payload}.подделка`), "подпись не проверяется").toBeNull();

    // подменён и полезный груз, и подпись оставлена от другого
    const other = signState("user-99");
    const [, mac] = other.split(".");
    expect(verifyState(`${payload}.${mac}`), "чужая подпись подошла к чужому грузу").toBeNull();
  });

  test("мусор не роняет разбор", () => {
    for (const bad of ["", ".", "a.b.c.d", "!!!.???"]) {
      expect(verifyState(bad)).toBeNull();
    }
  });
});

describe("маршруты", () => {
  test("состояние подключения отдаётся честно, когда Google не настроен", async () => {
    /*
     * Экран приёма по этому ответу решает, предлагать ли поле для ссылки
     * руками. Сказать «встреча создастся сама» там, где она не создастся, —
     * худший вариант: специалист узнает об этом от пациента.
     */
    const res = await api("/api/meet/status", adminA.token);
    expect(res.status).toBe(200);
    expect(typeof res.body.configured).toBe("boolean");
    if (!res.body.configured) expect(res.body.connected).toBe(false);
  });

  test("пациенту календарь не подключают", async () => {
    const person = await makeUser("user", `meet-${crypto.randomUUID()}@test`);
    const res = await api("/api/meet/status", person.token);
    expect([401, 403]).toContain(res.status);
  });

  test("возврат с чужим состоянием отклоняется", async () => {
    const res = await api("/api/meet/callback", adminA.token, {
      method: "POST",
      body: JSON.stringify({ code: "какой-то-код", state: signState("кто-то-другой") }),
    });
    expect(res.status).toBe(400);
  });
});
