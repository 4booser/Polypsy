import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import {
  isPasswordChangeRequired,
  isPasswordGate,
  MIN_PASSWORD,
  PASSWORD_CHANGE_CODE,
  passwordActions,
  passwordForm,
  routeAfterSignIn,
} from "../src/auth/passwordGate";
import { enqueue, flush, pendingCount, rejectedItems } from "../src/offline/queue";

/**
 * Временный пароль: сначала смена, и с экрана смены всегда можно уйти.
 *
 * Сервер (участок auth) отвечает 403 password_change_required на всё, кроме
 * профиля, смены пароля, рабочего места и выхода. Шага смены в мобилке не
 * было — пациент с временным паролем упирался бы в отказы на каждом экране.
 */

beforeEach(() => {
  resetStore();
});

describe("как узнать, что нужна смена пароля", () => {
  test("код строго тот, что отдаёт сервер", () => {
    // TODO(w12:auth): сверить с PASSWORD_CHANGE_CODE из shared/types.ts после слияния
    expect(PASSWORD_CHANGE_CODE).toBe("password_change_required");
  });

  test("403 с кодом — да; другой 403 или другой статус — нет", () => {
    expect(isPasswordChangeRequired(403, { code: "password_change_required", error: "…" })).toBe(true);
    expect(isPasswordChangeRequired(403, { error: "err.forbidden" })).toBe(false);
    expect(isPasswordChangeRequired(401, { code: "password_change_required" })).toBe(false);
    expect(isPasswordChangeRequired(403, null)).toBe(false);
  });

  test("по брошенной ошибке клиента — так же", () => {
    expect(isPasswordGate({ status: 403, code: "password_change_required" })).toBe(true);
    expect(isPasswordGate({ status: 403 })).toBe(false);
    expect(isPasswordGate(null)).toBe(false);
  });
});

describe("куда после входа", () => {
  test("временный пароль — сначала смена, потом согласие", () => {
    expect(routeAfterSignIn({ mustChangePassword: true })).toBe("/password");
    expect(routeAfterSignIn({ mustChangePassword: false })).toBe("/consent");
    expect(routeAfterSignIn({})).toBe("/consent");
    expect(routeAfterSignIn(null)).toBe("/login");
  });
});

describe("форма смены", () => {
  test("готово, только когда новый пароль длинный, повторён и не равен временному", () => {
    const long = "x".repeat(MIN_PASSWORD);
    expect(passwordForm({ current: "temp", next: long, repeat: long }).ready).toBe(true);
    expect(passwordForm({ current: "temp", next: "short", repeat: "short" })).toMatchObject({ ready: false, tooShort: true });
    expect(passwordForm({ current: "temp", next: long, repeat: `${long}!` })).toMatchObject({ ready: false, mismatch: true });
    // тот же, что временный, сервер отвергнет — кнопка этого не обещает
    expect(passwordForm({ current: long, next: long, repeat: long })).toMatchObject({ ready: false, same: true });
    expect(passwordForm({ current: "", next: long, repeat: long }).ready).toBe(false);
  });

  test("пустые поля не ругаются раньше времени", () => {
    expect(passwordForm({ current: "", next: "", repeat: "" })).toEqual({
      tooShort: false,
      mismatch: false,
      same: false,
      ready: false,
    });
  });
});

describe("выход с экрана смены есть всегда", () => {
  test("в любом состоянии формы и во время смены", () => {
    for (const ready of [true, false]) {
      for (const busy of [true, false]) {
        expect(passwordActions({ ready, busy }).signOut).toBe(true);
      }
    }
    expect(passwordActions({ ready: true, busy: false }).change).toBe(true);
    expect(passwordActions({ ready: true, busy: true }).change).toBe(false);
    expect(passwordActions({ ready: false, busy: false }).change).toBe(false);
  });
});

describe("очередь не принимает «смените пароль» за отказ по существу", () => {
  test("прогон останавливается, сдача не помечается отвергнутой", async () => {
    enqueue("owner-a", "s1", {});
    enqueue("owner-a", "s2", {});
    let calls = 0;
    const res = await flush("owner-a", async () => {
      calls++;
      throw Object.assign(new Error("Змініть пароль"), { status: 403, code: PASSWORD_CHANGE_CODE });
    });
    expect(calls).toBe(1);
    expect(res.rejected).toBe(0);
    expect(rejectedItems("owner-a")).toEqual([]);
    expect(pendingCount("owner-a")).toBe(2);
  });
});
