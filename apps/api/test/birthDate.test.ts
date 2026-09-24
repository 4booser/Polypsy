import { describe, expect, test } from "bun:test";
import { api, app, db, eq, json, users } from "./fixtures";
import { decryptField } from "../src/lib/crypto";
import { runEncryptBackfill } from "../src/lib/encryptBackfill";

/**
 * Дата рождения хранится зашифрованной — на всех путях, а не на большинстве.
 *
 * Поле выглядит безобидно рядом с ФИО, но в психоневрологическом учреждении
 * пара «дата рождения + подразделение» опознаёт человека не хуже фамилии, а
 * дамп базы отдаёт её сразу целиком. Шифрование даты было написано и
 * работало везде, кроме единственного места, где эта дата появляется, — при
 * регистрации: строка `birthDate: input.birthDate ?? null` стояла НИЖЕ
 * вызова encryptPersonFields в том же объектном литерале и перезаписывала
 * шифртекст открытым текстом.
 */

const BORN = "1987-04-23";

async function register(body: Record<string, unknown>) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
}

async function newAccount(tag: string, birthDate: string | null) {
  const res = await register({
    email: `bd-${tag}-${crypto.randomUUID()}@test.dev`,
    password: "longpass123",
    phone: `+38063${Math.floor(1000000 + Math.random() * 8999999)}`,
    anonymous: false,
    firstName: "Дата",
    lastName: "Рождения",
    birthDate,
  });
  expect(res.status).toBe(201);
  return { id: String(res.body.user.id), token: String(res.body.accessToken ?? res.body.token) };
}

/** Значение поля так, как оно лежит в базе, — без расшифровки на чтении */
async function storedBirthDate(id: string): Promise<string | null> {
  const [row] = await db.select({ birthDate: users.birthDate }).from(users).where(eq(users.id, id));
  return row?.birthDate ?? null;
}

describe("дата рождения при регистрации", () => {
  test("в базу уходит шифртекст, а не введённая дата", async () => {
    const person = await newAccount("reg", BORN);
    const stored = await storedBirthDate(person.id);

    /*
     * Проверка именно на «не равно введённому», а не только на префикс:
     * префикс ловит подмену формата, а равенство — ту самую перезапись,
     * при которой в колонке лежала строка «1987-04-23».
     */
    expect(stored).not.toBe(BORN);
    expect(stored?.startsWith("enc1:")).toBe(true);
    expect(decryptField(stored)).toBe(BORN);
  });

  test("профиль отдаёт исходную дату", async () => {
    // шифрование не должно быть заметно тому, кто смотрит свою карточку
    const person = await newAccount("me", BORN);
    const me = await api("/api/auth/me", person.token);
    expect(me.status).toBe(200);
    expect(me.body.birthDate).toBe(BORN);
  });

  test("пустая дата остаётся пустой", async () => {
    const person = await newAccount("null", null);
    expect(await storedBirthDate(person.id)).toBeNull();
  });
});

describe("бэкфилл дат рождения", () => {
  test("открытая дата шифруется, повторный прогон её не трогает", async () => {
    /*
     * Так выглядят строки боевой базы, заведённые до исправления: дата
     * лежит открытой. Пишем её мимо приложения — нам нужно именно то
     * состояние, а не то, которое умеет создавать исправленный код.
     */
    const person = await newAccount("bf", BORN);
    await db.update(users).set({ birthDate: "1975-12-01" }).where(eq(users.id, person.id));

    const first = await runEncryptBackfill();
    expect(first.users).toBeGreaterThan(0);

    const encrypted = await storedBirthDate(person.id);
    expect(encrypted).not.toBe("1975-12-01");
    expect(encrypted?.startsWith("enc1:")).toBe(true);
    expect(decryptField(encrypted)).toBe("1975-12-01");

    /*
     * Идемпотентность проверяется по самому значению, а не по счётчику:
     * счётчик мог бы остаться нулевым и оттого, что бэкфилл ничего не
     * увидел. Байт в байт та же строка означает, что второй прогон не
     * зашифровал шифртекст ещё раз — а такое двойное шифрование дало бы
     * дату, которую уже не прочитать.
     */
    const second = await runEncryptBackfill();
    expect(second.users).toBe(0);
    expect(await storedBirthDate(person.id)).toBe(encrypted);
  });

  test("смешанные данные читаются: открытая дата соседа не ломает карточку", async () => {
    const legacy = await newAccount("mix-a", BORN);
    const fresh = await newAccount("mix-b", BORN);
    await db.update(users).set({ birthDate: "1969-07-04" }).where(eq(users.id, legacy.id));

    // до бэкфилла: одна строка открытая, другая шифрованная — обе читаются
    expect((await api("/api/auth/me", legacy.token)).body.birthDate).toBe("1969-07-04");
    expect((await api("/api/auth/me", fresh.token)).body.birthDate).toBe(BORN);

    await runEncryptBackfill();

    expect((await api("/api/auth/me", legacy.token)).body.birthDate).toBe("1969-07-04");
    expect((await api("/api/auth/me", fresh.token)).body.birthDate).toBe(BORN);
  });
});
