import { describe, expect, test } from "bun:test";
import { api, app, db, json, makeUser } from "./fixtures";

/**
 * Отзыв access-токена.
 *
 * Проверяется одно обещание, которого раньше не было: после «выйти» и после
 * смены пароля выданный токен перестаёт работать СРАЗУ, а не через тридцать
 * минут. Цена невыполненного обещания известна поимённо: токен живёт в
 * localStorage, компьютер в кабинете общий, и «выйти» означало бы, что
 * следующий за клавиатурой полчаса работает от имени ушедшего — открывает
 * карты, читает заключения, пишет заметки его именем.
 *
 * Сценарии здесь сквозные, через HTTP: проверять функцию сравнения меток
 * значило бы проверять не то место. Дыра была ровно в том, что маршрут её
 * не спрашивал.
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

async function logout(refreshToken: string) {
  const res = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return res.status;
}

async function refresh(refreshToken: string) {
  const res = await app.request("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return { status: res.status, body: await json(res) };
}

describe("выход", () => {
  test("после logout прежний access-токен не открывает карту", async () => {
    const email = `revoke-logout-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);

    const session = await login(email);
    expect(session.status).toBe(200);
    const access = session.body.token as string;

    // до выхода токен рабочий — иначе проверка ниже ничего не доказывает
    expect((await api("/api/auth/me", access)).status).toBe(200);

    expect(await logout(session.body.refreshToken as string)).toBe(200);

    const after = await api("/api/auth/me", access);
    expect(after.status).toBe(401);
  });

  test("выход тут же после входа тоже отзывает", async () => {
    /*
     * Вход не в ту учётную запись и немедленный выход укладываются в одну
     * секунду целиком. Пока метка выдачи считалась в секундах стандартного
     * `iat`, ровно этот случай — самый частый повод выйти — не отзывал
     * ничего: токен выдан «в ту же секунду», что и граница.
     */
    const email = `revoke-fast-${crypto.randomUUID()}@test.dev`;
    await makeUser("user", email);

    const session = await login(email);
    await logout(session.body.refreshToken as string);

    const after = await api("/api/auth/me", session.body.token as string);
    expect(after.status).toBe(401);
  });

  test("сеанс на другом устройстве продолжается через обмен refresh", async () => {
    /*
     * Плата за отзыв одной меткой: выход гасит access-токены всех устройств
     * человека. Плата должна быть именно такой — одна 401 и незаметный
     * обмен, — а не «выход на планшете разлогинил врача за рабочим столом».
     * Семья refresh второго устройства при выходе первого не трогается.
     */
    const email = `revoke-two-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);

    const deskTop = await login(email);
    const tablet = await login(email);

    await logout(tablet.body.refreshToken as string);

    // старый access первого устройства отозван вместе со всеми
    expect((await api("/api/auth/me", deskTop.body.token as string)).status).toBe(401);

    // но его refresh жив, и обмен возвращает рабочую пару
    const renewed = await refresh(deskTop.body.refreshToken as string);
    expect(renewed.status).toBe(200);
    expect((await api("/api/auth/me", renewed.body.token as string)).status).toBe(200);
  });

  test("вышедший не восстанавливается обменом: его семья погашена", async () => {
    const email = `revoke-fam-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);

    const session = await login(email);
    await logout(session.body.refreshToken as string);

    expect((await refresh(session.body.refreshToken as string)).status).toBe(401);
  });
});

describe("смена пароля", () => {
  test("прежний access-токен перестаёт работать сразу", async () => {
    /*
     * Смена пароля — единственное, что человек делает, заподозрив чужой
     * доступ. Оставлять после неё живой токен ещё на полчаса значит не
     * сделать ровно того, ради чего пароль меняли.
     */
    const email = `revoke-pass-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);

    const session = await login(email);
    const access = session.body.token as string;

    const changed = await api("/api/auth/password", access, {
      method: "POST",
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "anotherpass9876" }),
    });
    expect(changed.status).toBe(200);

    const after = await api("/api/auth/me", access);
    expect(after.status).toBe(401);

    // а новый вход по новому паролю работает
    const again = await login(email, "anotherpass9876");
    expect(again.status).toBe(200);
    expect((await api("/api/auth/me", again.body.token as string)).status).toBe(200);
  });
});

describe("обнаружение кражи refresh-токена", () => {
  test("повторное предъявление гасит семью — и это переживает отказ", async () => {
    /*
     * Модель «семьи» держится на том, что повторное предъявление
     * одноразового токена читается как кража и гасит всю цепочку. Гашение —
     * это ЗАПИСЬ, а ответ на такой запрос — отказ. Пока отказ бросался
     * изнутри системной транзакции, он откатывал её вместе с гашением:
     * обнаружение кражи срабатывало и тут же отменяло само себя, оставляя
     * вору живую цепочку, а жертве — ничего не заметившую консоль.
     */
    const email = `revoke-theft-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);

    const session = await login(email);
    const rotated = await refresh(session.body.refreshToken as string);
    expect(rotated.status).toBe(200);

    // предъявляем погашенный токен второй раз — это и есть кража
    expect((await refresh(session.body.refreshToken as string)).status).toBe(401);

    // и цепочка, выданная первым обменом, мертва тоже
    expect((await refresh(rotated.body.refreshToken as string)).status).toBe(401);
  });
});

describe("неудачный вход", () => {
  test("остаётся записанным, несмотря на отказ", async () => {
    /*
     * Вход идёт одной транзакцией (системный контекст нужен политикам строк
     * на users), а отказ — это исключение. Если бросить его ИЗНУТРИ
     * транзакции, вместе с ответом откатится и всё, что вход успел записать:
     * счётчик неудачных попыток и запись журнала. Защита от перебора
     * перестала бы работать совсем — молча, потому что снаружи ответ тот же
     * самый «неверные учётные данные».
     */
    const { loginAttempts, auditLog } = await import("../src/db/schema");
    const { and, eq: eqOp } = await import("drizzle-orm");

    const email = `revoke-bad-${crypto.randomUUID()}@test.dev`;
    await makeUser("user", email);

    const bad = await login(email, "совершенно-неверный-пароль");
    expect(bad.status).toBe(401);

    const attempts = await db.select().from(loginAttempts).where(eqOp(loginAttempts.email, email));
    expect(attempts).toHaveLength(1);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eqOp(auditLog.action, "auth.login_failed"), eqOp(auditLog.actorEmail, email)));
    expect(entries.length).toBeGreaterThan(0);
  });

  test("после череды неудач учётная запись запирается", async () => {
    // сам порог живёт в loginGuard; здесь проверяется, что счётчик вообще
    // копится между запросами — то есть что записи переживают отказ
    const email = `revoke-lock-${crypto.randomUUID()}@test.dev`;
    await makeUser("user", email);

    for (let i = 0; i < 6; i++) await login(email, "неверный");
    const locked = await login(email);
    expect(locked.status).toBe(401);

    const { loginAttempts } = await import("../src/db/schema");
    const { eq: eqOp } = await import("drizzle-orm");
    const attempts = await db.select().from(loginAttempts).where(eqOp(loginAttempts.email, email));
    expect(attempts.length).toBeGreaterThanOrEqual(5);
  });
});

describe("отзыв не бьёт по живым сеансам", () => {
  test("чужой выход не гасит токен другого человека", async () => {
    /*
     * Метка на строке пользователя, а не общая: сдвиг у одного не должен
     * означать разлогин всего отделения.
     */
    const mine = `revoke-mine-${crypto.randomUUID()}@test.dev`;
    const theirs = `revoke-theirs-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", mine);
    await makeUser("admin", theirs);

    const my = await login(mine);
    const their = await login(theirs);

    await logout(their.body.refreshToken as string);

    expect((await api("/api/auth/me", my.body.token as string)).status).toBe(200);
  });
});
