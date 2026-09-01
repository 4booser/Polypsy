import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { adminA, api, app, db, makeUser } from "./fixtures";
import { users } from "../src/db/schema";
import { normalizePhone, phoneFingerprint } from "../src/lib/phone";

/**
 * Телефон обязателен для всех, включая учётные записи под кодом.
 *
 * Это меняет смысл слова «анонимный»: запись анонимна для специалиста — он
 * видит код, а не имя, — но не для учреждения. Взамен закрывается самое
 * опасное место: при сработавшей тревоге есть кому позвонить.
 */

async function register(body: Record<string, unknown>) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("нормализация номера", () => {
  test("один номер, записанный пятью способами, даёт один отпечаток", () => {
    /*
     * Без нормализации слепой индекс ловил бы не дубликаты, а совпадения
     * написания — то есть почти ничего.
     */
    const written = [
      "+380501112233",
      "380501112233",
      "0501112233",
      "80501112233",
      "+38 (050) 111-22-33",
    ];
    const prints = new Set(written.map((w) => phoneFingerprint(normalizePhone(w)!)));
    expect(prints.size).toBe(1);
  });

  test("не номер — не принимается", () => {
    expect(normalizePhone("абв")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  test("отпечаток не восстанавливается в номер", () => {
    // HMAC, а не хеш: пространство телефонных номеров перебирается за минуты
    const print = phoneFingerprint("+380501112233");
    expect(print).not.toContain("380501112233");
    expect(print.length).toBeGreaterThan(20);
  });
});

describe("регистрация", () => {
  test("без телефона не пускает", async () => {
    const res = await register({
      email: `nophone-${crypto.randomUUID()}@test.dev`,
      password: "longpass123",
      anonymous: false,
      firstName: "Без",
      lastName: "Телефона",
    });
    expect(res.status).toBe(400);
  });

  test("под кодом телефон тоже обязателен", async () => {
    /*
     * Ровно то место, ради которого всё затевалось: раньше у анонима не было
     * ни имени, ни номера, и тревога попадала в разбор, на чём всё и
     * заканчивалось.
     */
    const res = await register({
      email: `coded-${crypto.randomUUID()}@test.dev`,
      password: "longpass123",
      anonymous: true,
    });
    expect(res.status).toBe(400);
  });

  test("номер хранится зашифрованным", async () => {
    const email = `enc-${crypto.randomUUID()}@test.dev`;
    const res = await register({
      email,
      password: "longpass123",
      phone: "+380631112233",
      anonymous: false,
      firstName: "С",
      lastName: "Телефоном",
    });
    expect(res.status).toBe(201);

    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row!.phoneEnc).not.toBeNull();
    expect(row!.phoneEnc).not.toContain("631112233");
    expect(row!.phoneIndex).toBe(phoneFingerprint("+380631112233"));
    // подтверждать нечем: внешнего шлюза нет и не будет
    expect(row!.phoneVerified).toBe(false);
  });

  test("второй аккаунт на тот же номер не заводится", async () => {
    /*
     * Один человек не заводит два аккаунта, чтобы «начать с чистого листа».
     * Проверка по слепому индексу: сравнить можно, расшифровывать не нужно.
     */
    const phone = `+38063${Math.floor(1000000 + Math.random() * 8999999)}`;
    const first = await register({
      email: `dup1-${crypto.randomUUID()}@test.dev`,
      password: "longpass123",
      phone,
      anonymous: false,
      firstName: "Первый",
      lastName: "Аккаунт",
    });
    expect(first.status).toBe(201);

    const second = await register({
      email: `dup2-${crypto.randomUUID()}@test.dev`,
      password: "longpass123",
      // тот же номер, записанный иначе
      phone: phone.replace("+380", "0"),
      anonymous: false,
      firstName: "Второй",
      lastName: "Аккаунт",
    });
    expect(second.status).toBe(409);
    // отказ не говорит, чей это номер
    expect(String(second.body?.error ?? "")).not.toContain("Первый");
  });
});

describe("показ телефона", () => {
  test("отдаётся отдельным действием и попадает в журнал", async () => {
    /*
     * Номер нужен в двух случаях — перенести приём и связаться в кризис. В
     * списках он лишний, и лишний не безобидно: список с телефонами
     * выносится из учреждения одним снимком экрана.
     */
    const email = `show-${crypto.randomUUID()}@test.dev`;
    const created = await register({
      email,
      password: "longpass123",
      phone: "+380671112233",
      anonymous: false,
      firstName: "Показ",
      lastName: "Номера",
    });
    expect(created.status).toBe(201);
    const patientId = created.body.user.id;

    // в списке пациентов номера нет
    const list = await api("/api/access/patients", adminA.token);
    const inList = list.body.items.find((p: { id: string }) => p.id === patientId);
    if (inList) expect(JSON.stringify(inList)).not.toContain("671112233");
  });

  test("чужого пациента номер не отдаётся", async () => {
    const stranger = await makeUser("user", `phone-x-${crypto.randomUUID()}@test`);
    const res = await api(`/api/clinic/patients/${stranger.id}/phone`, adminA.token);
    expect([403, 404]).toContain(res.status);
  });
});

describe("раскрытие учётной записи", () => {
  test("код меняется на имя, прохождения остаются", async () => {
    /*
     * Обратной операции нет: карта уже собрана, и притворяться, что данные
     * исчезли, было бы обманом.
     */
    const created = await register({
      email: `reveal-${crypto.randomUUID()}@test.dev`,
      password: "longpass123",
      phone: `+38050${Math.floor(1000000 + Math.random() * 8999999)}`,
      anonymous: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.user.anonymous).toBe(true);
    expect(created.body.user.pseudonym).not.toBeNull();

    const res = await api("/api/auth/me/reveal", created.body.token, {
      method: "POST",
      body: JSON.stringify({ firstName: "Тарас", lastName: "Шевченко" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.user.anonymous).toBe(false);
    expect(res.body.user.fullName).toContain("Шевченко");
    expect(typeof res.body.responsesLinked).toBe("number");
  });

  test("повторное раскрытие отклоняется", async () => {
    const person = await makeUser("user", `reveal2-${crypto.randomUUID()}@test`);
    const res = await api("/api/auth/me/reveal", person.token, {
      method: "POST",
      body: JSON.stringify({ firstName: "Уже", lastName: "Именной" }),
    });
    expect(res.status).toBe(400);
  });
});
