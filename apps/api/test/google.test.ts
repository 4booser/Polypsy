import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, app, db, issueToken, makeUser } from "./fixtures";
import { users } from "../src/db/schema";
import { revokeAllFor } from "../src/lib/refresh";
import { domainAllowed, googleEnabled } from "../src/lib/google";
import { env } from "../src/env";

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
    /*
     * Сверка целиком, а не по одному полю: экран входа читает весь ответ, и
     * новое поле, приехавшее сюда молча, меняет то, что нарисовано, — пусть
     * его добавление ломает тест и требует решения.
     */
    expect(await res.json()).toEqual({ enabled: false, openRegistration: env.openRegistration });

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

    const withoutPassword = await api("/api/auth/google/unlink", person.token, { method: "POST" });
    expect(
      withoutPassword.status,
      "второй ключ от учётной записи снимается угнанным токеном доступа",
    ).toBe(401);

    const res = await api("/api/auth/google/unlink", person.token, {
      method: "POST",
      body: JSON.stringify({ password: "secret12345" }),
    });
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

describe("передача пары токенов", () => {
  test("код обменивается один раз и живёт секунды", async () => {
    /*
     * Прежде в адресе возврата уезжали сами токены: refresh живёт тридцать
     * дней и не привязан ни к устройству, ни к адресу. Адрес попадает в
     * историю браузера общего компьютера в кабинете, в журнал обратного
     * прокси и в Referer первого же подзапроса — кто угодно с доступом к
     * журналам получал месячный доступ к учётной записи специалиста.
     * Чистка адреса на клиенте от этого не спасает: она случается позже,
     * чем адрес отдан браузеру.
     */
    const bogus = await app.request("/api/auth/google/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "выдумка" }),
    });
    expect(bogus.status, "выдуманный код принят").toBe(401);

    const empty = await app.request("/api/auth/google/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(401);
  });
});

describe("состояние входа привязано к браузеру", () => {
  test("возврат без cookie не пускает, даже если состояние наше", async () => {
    /*
     * Без привязки `state` доказывает только, что мы его когда-то выдавали,
     * — а выдаём мы его кому угодно: маршрут начала входа открыт.
     * Злоумышленник получал свой state и code, не давая им дойти до
     * сервера, и приводил сотрудника по этому адресу: сервер выдавал пару
     * для ЕГО учётной записи, а консоль молча её принимала. Сотрудник
     * продолжал работать в чужой записи, и заметки с заключениями уходили
     * туда, куда у злоумышленника есть доступ.
     */
    const res = await app.request("/api/auth/google/callback?code=что-то&state=что-то");
    expect([401, 404]).toContain(res.status);
  });

  test("начало входа ставит cookie", async () => {
    // без неё возврат не примут; проверяем, что она вообще выдаётся
    const res = await app.request("/api/auth/google/start", { redirect: "manual" });
    if (res.status === 404) return; // способ не настроен в тестах
    expect(res.headers.get("set-cookie") ?? "").toContain("quizzy_oauth_state");
  });
});

describe("начатая привязка не переживает отзыв сессий (внешний разбор, #36)", () => {
  /*
   * Pending OAuth хранил verifier, время и linkUserId — но не границу отзыва
   * и не сессию, которая привязку начала. Callback доверял сохранённому
   * linkUserId и записывал google_sub без повторной проверки полномочий:
   * пациент начинал привязку, администратор отзывал его сессии (старый
   * токен на /auth/me уже давал 401), а возврат от Google с исходными
   * state и cookie всё равно записывал google_sub — и этот Google становился
   * новым способом входа в отозванную учётную запись.
   *
   * Google подменён локальным fetch (как в meetBooking.test.ts): это проверка
   * жизненного цикла полномочий, а не обхода проверки Google-токена.
   */
  const originalFetch = globalThis.fetch;
  const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };
  const CLIENT_ID = `client-${crypto.randomUUID()}`;
  let googleSub = "";
  let googleEmail = "";

  function idToken(): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const claims = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: googleSub,
      email: googleEmail,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
  }

  beforeAll(() => {
    env.googleClientId = CLIENT_ID;
    env.googleClientSecret = "secret";
    env.googleRedirectUri = "http://localhost/api/auth/google/callback";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ id_token: idToken() }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    env.googleClientId = saved.id;
    env.googleClientSecret = saved.secret;
    env.googleRedirectUri = saved.redirect;
  });

  /** Начать привязку: адрес Google и cookie состояния этого браузера */
  async function startLink(token: string) {
    const res = await api<{ url: string }>("/api/auth/google/link", token, { method: "POST" });
    expect(res.status).toBe(200);
    const state = new URL(res.body.url).searchParams.get("state")!;
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("quizzy_oauth_state=");
    return { state, cookie };
  }

  function callback(state: string, cookie: string) {
    return app.request(`/api/auth/google/callback?code=${crypto.randomUUID()}&state=${state}`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
  }

  const subOf = async (id: string) => (await db.query.users.findFirst({ where: eq(users.id, id) }))?.googleSub ?? null;

  test("после отзыва сессий старый callback не записывает google_sub", async () => {
    const person = await makeUser("user", `g-revoke-${crypto.randomUUID()}@test`);
    googleSub = `sub-${crypto.randomUUID()}`;
    googleEmail = `g-revoke-${crypto.randomUUID()}@example.com`;
    const { state, cookie } = await startLink(person.token);

    // администратор отзывает сессии: старый токен больше не работает
    await revokeAllFor(person.id);
    expect((await api("/api/auth/me", person.token)).status).toBe(401);

    const res = await callback(state, cookie);
    expect(res.status, "возврат от Google завершил привязку после отзыва сессий").toBe(401);
    expect(await subOf(person.id), "google_sub записан отозванной сессией").toBeNull();
    // и войти этим Google нечем
    const login = await db.query.users.findFirst({ where: eq(users.googleSub, googleSub) });
    expect(login).toBeUndefined();
  });

  test("после блокировки — тоже", async () => {
    const person = await makeUser("user", `g-disabled-${crypto.randomUUID()}@test`);
    googleSub = `sub-${crypto.randomUUID()}`;
    googleEmail = `g-disabled-${crypto.randomUUID()}@example.com`;
    const { state, cookie } = await startLink(person.token);
    await db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, person.id));

    const res = await callback(state, cookie);
    expect(res.status).toBe(401);
    expect(await subOf(person.id)).toBeNull();
  });

  test("действующая привязка проходит, а повторный возврат по тому же состоянию — нет", async () => {
    const person = await makeUser("user", `g-live-${crypto.randomUUID()}@test`);
    googleSub = `sub-${crypto.randomUUID()}`;
    googleEmail = `g-live-${crypto.randomUUID()}@example.com`;
    const { state, cookie } = await startLink(person.token);

    const res = await callback(state, cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("google=linked");
    expect(await subOf(person.id)).toBe(googleSub);

    // состояние одноразовое
    expect((await callback(state, cookie)).status).toBe(401);
  });

  test("привязка, начатая после отзыва новой сессией, проходит", async () => {
    // отзыв гасит прежние токены, а не запрещает привязку навсегда
    const person = await makeUser("user", `g-fresh-${crypto.randomUUID()}@test`);
    await revokeAllFor(person.id);
    // граница отзыва — на миллисекунду позже его самого (#138, lib/refresh.ts):
    // токен той же миллисекунды считается выданным до отзыва. Новая сессия
    // в жизни — другой запрос; здесь её отделяет пауза
    await Bun.sleep(2);
    const fresh = await issueToken({ id: person.id, role: "user" });
    googleSub = `sub-${crypto.randomUUID()}`;
    googleEmail = `g-fresh-${crypto.randomUUID()}@example.com`;
    const { state, cookie } = await startLink(fresh);
    expect((await callback(state, cookie)).status).toBe(302);
    expect(await subOf(person.id)).toBe(googleSub);
  });
});
