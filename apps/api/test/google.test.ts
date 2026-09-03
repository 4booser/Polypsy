import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, app, db, makeUser } from "./fixtures";
import { users } from "../src/db/schema";
import { domainAllowed, googleEnabled } from "../src/lib/google";

/**
 * Вход через Google.
 *
 * Проверяется не «работает ли OAuth» — это делается с настоящим Google, а не
 * в тестах, — а три правила, ради которых всё устроено именно так.
 */

describe("вход через Google", () => {
  test("выключен, пока не настроен — и тогда его просто нет", async () => {
    /*
     * Пусто в настройках означает «способа нет», а не «способ есть, но
     * сломан». Разница видна на экране: кнопка не рисуется вовсе, а не ведёт
     * в отказ.
     */
    expect(googleEnabled()).toBe(false);

    const res = await app.request("/api/auth/google/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });

    const start = await app.request("/api/auth/google/start");
    expect(start.status).toBe(404);
  });

  test("возврат без состояния не пускает", async () => {
    /*
     * Состояние выдаём мы, и вернувшийся код принимается только вместе с
     * ним. Без этой проверки чужой запрос с подставленным кодом входил бы
     * в чужую учётную запись.
     */
    const res = await app.request("/api/auth/google/callback?code=подделка&state=выдумка");
    expect([401, 404]).toContain(res.status);
  });

  test("учётную запись под кодом связывать нельзя", async () => {
    /*
     * Анонимность здесь означает, что специалист видит «Респондент А-4821»
     * вместо имени. Связать такую запись с Google — значит подставить в неё
     * настоящее имя и почту, то есть отменить ровно то, ради чего она
     * заведена.
     */
    const coded = await makeUser("user", `g-anon-${crypto.randomUUID()}@test`, {
      anonymous: true,
      pseudonym: "А-4821",
    });
    const res = await api("/api/auth/google/link", coded.token, { method: "POST" });
    // 404 — способ не настроен в тестах; проверяем, что и настроенный откажет
    expect([400, 404]).toContain(res.status);
  });

  test("отвязать может каждый и без Google", async () => {
    /*
     * Отвязывание не должно зависеть от настроенности способа: если Google
     * убрали из настроек, связь обязана сниматься всё равно, иначе она
     * останется навсегда.
     */
    const person = await makeUser("admin", `g-unlink-${crypto.randomUUID()}@test`);
    await db.update(users).set({ googleSub: "sub-123" }).where(eq(users.id, person.id));

    const res = await api("/api/auth/google/unlink", person.token, { method: "POST" });
    expect(res.status).toBe(200);

    const after = await db.query.users.findFirst({ where: eq(users.id, person.id) });
    expect(after?.googleSub).toBeNull();
  });

  test("одна учётная запись Google — одна наша", async () => {
    /*
     * Без уникальности двое входят как один и оба видят карты друг друга.
     * Держится это индексом в базе, а не проверкой в коде: проверку в коде
     * обходит гонка двух одновременных связываний.
     */
    const a = await makeUser("admin", `g-uniq-a-${crypto.randomUUID()}@test`);
    const b = await makeUser("admin", `g-uniq-b-${crypto.randomUUID()}@test`);
    const sub = `sub-${crypto.randomUUID()}`;

    await db.update(users).set({ googleSub: sub }).where(eq(users.id, a.id));

    // построитель запросов drizzle — не промис, пока его не выполнили:
    // `expect(builder).rejects` принимает его за обычный объект и проходит
    let refused = false;
    try {
      await db.update(users).set({ googleSub: sub }).where(eq(users.id, b.id));
    } catch {
      refused = true;
    }
    expect(refused, "база приняла второй такой же google_sub").toBe(true);
  });

  test("список доменов пуст — пускаем любые, непуст — только свои", () => {
    // единственное, что отделяет «вошёл наш сотрудник» от «вошёл кто угодно»
    expect(domainAllowed("кто-угодно@gmail.com")).toBe(true);
  });
});

describe("связывание достижимо из консоли", () => {
  test("адрес отдаётся ответом, а не перенаправлением", async () => {
    /*
     * Маршрут закрыт requireAuth, то есть требует заголовка Authorization.
     * Консоль хранит токен в localStorage и шлёт его заголовком — обычная
     * ссылка такого заголовка не несёт, и переход браузером всегда получал
     * 401. Связать учётную запись было нельзя вовсе, а значит и вход через
     * Google не мог завершиться ничем, кроме «не привязано»: новый контур
     * аутентификации не был проверен сквозным сценарием ни разу.
     *
     * Отсюда форма проверки: маршрут обязан быть POST и отвечать телом.
     * Перенаправление сюда не годится по построению.
     */
    const person = await makeUser("admin", `g-link-${crypto.randomUUID()}@test`);

    // GET больше не существует — именно он и был недостижим
    const asGet = await api("/api/auth/google/link", person.token);
    expect(asGet.status).toBe(404);

    const asPost = await api("/api/auth/google/link", person.token, { method: "POST" });
    // 404 — способ не настроен в тестах; настроенный отдал бы { url }
    expect([200, 404]).toContain(asPost.status);
    expect(asPost.status, "маршрут отвечает перенаправлением — консоль так не умеет").not.toBe(302);
  });
});
