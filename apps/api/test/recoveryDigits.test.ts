import { describe, expect, test } from "bun:test";
import { appApi, appRequest, db, json, makeUser } from "./fixtures";
import { userRecoveryCodes } from "../src/db/schema";
import { base32Decode, looksLikeRecovery, newRecoveryCodes, recoveryHash, totp } from "../src/lib/totp";

/**
 * Код восстановления из одних цифр (#143).
 *
 * В алфавите кодов семь цифр, и генератор иногда выдаёт код без единой
 * буквы — «2345-6789». looksLikeRecovery требовал букву, и такой код уходил
 * в ветку кода приложения: «неверный код», попытка — в счётчик блокировки.
 * Заодно ввод с пробелом посередине («k7m2 9xq4») не узнавался вовсе, хотя
 * сверка (canonicalRecovery) пробелы снимает.
 *
 * Вход — под ролью приложения, как в бою: второй шаг входа читает и гасит
 * коды через политики строк user_recovery_codes.
 */

const PASSWORD = "secret12345";

const post = (body?: unknown) => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

async function login(email: string) {
  const res = await appRequest("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { status: res.status, body: await json(res) };
}

async function mfaLogin(mfaToken: string, code: string) {
  const res = await appRequest("/api/auth/mfa/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
  return { status: res.status, body: await json(res) };
}

/** Сотрудник с включённым вторым фактором и дополнительными кодами восстановления заданного вида */
async function staffWithCodes(tag: string, extra: string[]) {
  const email = `rc-${tag}-${crypto.randomUUID()}@test.dev`;
  const person = await makeUser("admin", email);
  const setup = await appApi("/api/auth/mfa/setup", person.token, { method: "POST" });
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.secret);
  const confirm = await appApi("/api/auth/mfa/confirm", person.token, post({ code: totp(secret, Date.now()) }));
  expect(confirm.status).toBe(200);
  /*
   * Цифровой код выпадает генератору примерно раз на пять тысяч человек —
   * ждать его нечестно, поэтому он кладётся тем же хэшем, каким кладёт
   * выдача (recoveryHash), рядом с выданными.
   */
  if (extra.length) {
    await db
      .insert(userRecoveryCodes)
      .values(extra.map((code) => ({ id: crypto.randomUUID(), userId: person.id, codeHash: recoveryHash(person.id, code) })));
  }
  return { ...person, email, secret, codes: confirm.body.recoveryCodes as string[] };
}

describe("код восстановления из одних цифр (#143)", () => {
  test("распознавание: восемь знаков — код восстановления, шесть цифр — код приложения", () => {
    for (const code of ["2345-6789", "23456789", "2345 6789", " 2345-6789 ", "k7m2-9xq4", "K7M2 9XQ4", "k7m29xq4"]) {
      expect(looksLikeRecovery(code), code).toBe(true);
    }
    for (const code of ["123456", "123 456", "123-456", "1234567", "123456789", "k7m2-9xq", "k7m2_9xq4"]) {
      expect(looksLikeRecovery(code), code).toBe(false);
    }
    // всё, что выдаёт генератор, узнаётся — на большой выборке
    for (let i = 0; i < 200; i++) for (const code of newRecoveryCodes()) expect(looksLikeRecovery(code), code).toBe(true);
  });

  test(
    "цифровой код входит — в любом написании, и только один раз",
    async () => {
      const person = await staffWithCodes("digits", ["2345-6789", "9876-5432"]);

      const one = await login(person.email);
      expect(one.body.mfaRequired).toBe(true);
      const first = await mfaLogin(one.body.mfaToken, "2345-6789");
      expect(first.status, "цифровой код восстановления отвергнут").toBe(200);
      expect(first.body.token).toBeString();

      // тот же код второй раз — уже погашен
      const two = await login(person.email);
      expect((await mfaLogin(two.body.mfaToken, "23456789")).status).toBe(401);
      // другой цифровой — без дефиса, с пробелом
      const spaced = await mfaLogin(two.body.mfaToken, "9876 5432");
      expect(spaced.status, "цифровой код с пробелом отвергнут").toBe(200);

      const status = await appApi("/api/auth/mfa", person.token);
      expect(status.body.recoveryLeft, "погашены не те коды").toBe(10);
    },
    15_000,
  );

  test(
    "выданный код с буквами — с пробелом и в верхнем регистре; код приложения работает как прежде",
    async () => {
      const person = await staffWithCodes("mixed", []);
      const code = person.codes[0]!;

      const one = await login(person.email);
      const mixed = await mfaLogin(one.body.mfaToken, code.replace("-", " ").toUpperCase());
      expect(mixed.status, "код с пробелом посередине не узнан").toBe(200);

      // контроль: шесть цифр из приложения — по-прежнему ветка приложения
      // (следующий шаг: текущий погашен подтверждением настройки)
      const two = await login(person.email);
      const app = await mfaLogin(two.body.mfaToken, totp(person.secret, Date.now() + 30_000));
      expect(app.status).toBe(200);
    },
    15_000,
  );
});
