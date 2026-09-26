import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { serviceAnnouncements, userSecondFactor } from "../src/db/schema";
import { revokeAllFor } from "../src/lib/refresh";
import { beginSetup, factorOf } from "../src/lib/secondFactor";
import { exemptFromMaintenance, resetStatusCache } from "../src/lib/serviceStatus";
import { base32Decode, hotp, stepAt, totp } from "../src/lib/totp";
import { api, app, client, db, json, makeUser, root, type Person } from "./fixtures";

/**
 * Второй фактор: три дыры из третьего внешнего разбора (2026-09-26).
 *
 *  1. Начало настройки могло стереть только что включённый фактор: чтение
 *     «включён ли» и запись нового секрета шли порознь, и подтверждение,
 *     попавшее между ними, затиралось — confirmedAt = null, секрет новый,
 *     коды восстановления на руках от старого.
 *  2. Знак «пароль верный» переживал отзыв сессий: второй шаг входа не
 *     сверял время выдачи с границей токенов, а время при чтении знака
 *     терялось вовсе. Сброс пароля администратором не останавливал уже
 *     начатый вход со старым паролем.
 *  3. Режим обслуживания пропускал первый шаг входа и отказывал второму:
 *     администратор со вторым фактором не мог войти, чтобы обслуживание
 *     выключить.
 */

const PASSWORD = "secret12345";

async function login(email: string, password = PASSWORD) {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await json(res) };
}

async function mfaLogin(mfaToken: string, code: string) {
  const res = await app.request("/api/auth/mfa/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mfaToken, code }),
  });
  return { status: res.status, body: await json(res) };
}

async function staff(tag: string): Promise<Person & { email: string }> {
  const email = `mfa-h-${tag}-${crypto.randomUUID()}@test.dev`;
  return { ...(await makeUser("admin", email)), email };
}

async function enableFactor(person: Person): Promise<Buffer> {
  const setup = await api("/api/auth/mfa/setup", person.token, { method: "POST" });
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.secret);
  const confirm = await api("/api/auth/mfa/confirm", person.token, {
    method: "POST",
    body: JSON.stringify({ code: totp(secret, Date.now()) }),
  });
  expect(confirm.status).toBe(200);
  return secret;
}

/* режим обслуживания — общее состояние базы и кэша процесса: уборка безусловная */
async function declare(status: "ok" | "maintenance") {
  await db.insert(serviceAnnouncements).values({ id: crypto.randomUUID(), status, createdBy: root.id });
  resetStatusCache();
}

afterAll(async () => {
  await declare("ok");
});

describe("начало настройки не затирает включённый фактор", () => {
  test(
    "подтверждение, попавшее между проверкой и записью, переживает повторное начало",
    async () => {
      /*
       * Гонка воспроизводится детерминированно: подтверждение держим
       * открытой транзакцией. Повторное начало читает «не подтверждён»
       * (чужая запись ещё не видна), доходит до записи и ждёт блокировки
       * строки; подтверждение коммитится — и запись обязана увидеть
       * включённый фактор, а не затереть его.
       */
      const person = await staff("race");
      const pending = await beginSetup(person.id, person.email);
      expect(pending.ok).toBe(true);
      const [before] = await db.select().from(userSecondFactor).where(eq(userSecondFactor.userId, person.id));

      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const confirming = client.begin(async (tx) => {
        await tx`update user_second_factor set confirmed_at = now(), last_step = 1 where user_id = ${person.id}`;
        locked();
        await gate;
      });
      await lockedP;

      const restart = beginSetup(person.id, person.email);
      await Bun.sleep(150);
      release();
      await confirming;
      const result = await restart;

      expect(result.ok, "повторное начало настройки затёрло только что включённый фактор").toBe(false);
      const after = await factorOf(person.id);
      expect(after?.confirmedAt).toBeTruthy();
      expect(after?.secretEnc).toBe(before!.secretEnc);
    },
    15_000,
  );

  test("неподтверждённый — перезаписывается, как и прежде", async () => {
    const person = await staff("restart");
    const one = await beginSetup(person.id, person.email);
    const two = await beginSetup(person.id, person.email);
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) expect(two.secret).not.toBe(one.secret);
  });
});

describe("знак «пароль верный» и отзыв сессий", () => {
  test("отзыв между шагами — начатый вход не завершается", async () => {
    const person = await staff("revoked");
    const secret = await enableFactor(person);

    const first = await login(person.email);
    expect(first.body.mfaRequired).toBe(true);

    await Bun.sleep(5);
    // так отзывает сессии сброс пароля, выключение, «завершить все сессии»
    await revokeAllFor(person.id);

    const res = await mfaLogin(first.body.mfaToken, hotp(secret, stepAt(Date.now()) + 1));
    expect(res.status, "знак, выданный до отзыва, завершил вход").toBe(401);
    expect(res.body.token).toBeUndefined();

    // новый вход после отзыва — как обычно
    const again = await login(person.email);
    // тот же шаг: отказ выше до кода не дошёл и его не израсходовал
    const ok = await mfaLogin(again.body.mfaToken, hotp(secret, stepAt(Date.now()) + 1));
    expect(ok.status).toBe(200);
  });
});

describe("режим обслуживания и второй шаг входа", () => {
  test("второй шаг входит в исключения вместе с первым", () => {
    expect(exemptFromMaintenance("POST", "/api/auth/mfa/login")).toBe(true);
    // настройка и выключение фактора — запись в учётные данные, она подождёт
    expect(exemptFromMaintenance("POST", "/api/auth/mfa/setup")).toBe(false);
    expect(exemptFromMaintenance("POST", "/api/auth/mfa/disable")).toBe(false);
  });

  test("администратор со вторым фактором входит во время обслуживания", async () => {
    const person = await staff("maint");
    const secret = await enableFactor(person);
    await declare("maintenance");
    try {
      const first = await login(person.email);
      expect(first.status).toBe(200);
      const done = await mfaLogin(first.body.mfaToken, hotp(secret, stepAt(Date.now()) + 1));
      expect(done.status, "второй шаг входа закрыт обслуживанием — выключить его некому").toBe(200);
      expect(done.body.token).toBeTruthy();
    } finally {
      await declare("ok");
    }
  });
});
