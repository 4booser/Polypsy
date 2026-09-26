import { describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditLog, permissionExceptions, users as usersTable } from "../src/db/schema";
import { phoneFingerprint } from "../src/lib/phone";
import { generateTempPassword } from "../src/lib/accounts";
import { adminA, api, app, db, json, makeUser, patient, root, submitSurvey, surveyInA } from "./fixtures";

/**
 * Техпанель: учётные записи, сессии и журнал (волна 10).
 *
 * Главное здесь — не то, что кнопки работают, а три обещания, нарушение
 * которых видно только в бою:
 *
 *  1. Выключение действует сразу и везде — на входе, на обмене токена и на
 *     токене, который уже на руках. Выключают как раз тогда, когда не
 *     доверяют тому, у кого сейчас сессия.
 *  2. Удаление не уносит клинических данных: учётку со следом сервер не
 *     удаляет и говорит, что держит.
 *  3. Временный пароль виден один раз — в ответе — и никогда в журнале.
 *
 * Сценарии сквозные, через HTTP: проверять функции по отдельности значило бы
 * проверять не то место — дыры в таких местах всегда в том, что маршрут
 * функцию не позвал.
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

async function refresh(refreshToken: string) {
  const res = await app.request("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  return { status: res.status, body: await json(res) };
}

/** Учётка, заведённая штатным маршрутом, — без единой записи журнала от её имени */
async function created(tag: string, role: "admin" | "user" = "admin", extra: Record<string, unknown> = {}) {
  const email = `ops-${tag}-${crypto.randomUUID()}@test.dev`;
  const res = await api("/api/users", root.token, {
    method: "POST",
    body: JSON.stringify({ email, password: PASSWORD, firstName: "Опс", lastName: tag, role, ...extra }),
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, email };
}

/** Записи журнала по действию и субъекту — прямо из таблицы, а не через маршрут, который сам пишет в журнал */
async function journal(action: string, subjectUserId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectUserId, subjectUserId)));
}

/** Заведующий с правом users.manage — личным исключением, как его и выдают */
async function manager() {
  const person = await makeUser("admin", `ops-mgr-${crypto.randomUUID()}@test.dev`);
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: person.id,
    permission: "users.manage",
    mode: "grant",
    reason: "Ведёт учётные записи отделения",
    grantedBy: root.id,
  });
  return person;
}

describe("кто сюда допущен", () => {
  test("без users.manage реестр закрыт — и сотруднику, и пациенту", async () => {
    expect((await api("/api/ops/users", adminA.token)).status).toBe(403);
    expect((await api("/api/ops/sessions", adminA.token)).status).toBe(403);
    expect((await api("/api/ops/users", patient.token)).status).toBe(403);
  });

  test("с правом — весь реестр: и персонал, и пациенты; чтение — в журнал", async () => {
    const res = await api("/api/ops/users?per=100", root.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(2);
    expect((await api("/api/ops/users?role=user", root.token)).body.total).toBeGreaterThan(0);
    expect((await api("/api/ops/users?role=admin", root.token)).body.total).toBeGreaterThan(0);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.list"), eq(auditLog.actorId, root.id), sql`${auditLog.details}->>'ops' = 'true'`));
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.some((e) => (e.details as { matched?: number }).matched === res.body.total)).toBe(true);
  });

  test("заведующий с users.manage не трогает суперадмина и не заводит его", async () => {
    const mgr = await manager();
    expect((await api("/api/ops/users?per=5", mgr.token)).status).toBe(200);

    const reset = await api(`/api/ops/users/${root.id}/reset-password`, mgr.token, { method: "POST" });
    expect(reset.status).toBe(403);
    const disable = await api(`/api/ops/users/${root.id}/disable`, mgr.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Проверка заслона" }),
    });
    expect(disable.status).toBe(403);

    const promote = await api("/api/users", mgr.token, {
      method: "POST",
      body: JSON.stringify({
        email: `ops-super-${crypto.randomUUID()}@test.dev`,
        password: PASSWORD,
        firstName: "Ні",
        lastName: "Суперадмін",
        role: "superadmin",
      }),
    });
    expect(promote.status).toBe(403);

    // и удаление — только суперадмину, как решено политикой строк на users
    const someone = await created("mgr-del");
    expect((await api(`/api/ops/users/${someone.id}`, mgr.token, { method: "DELETE" })).status).toBe(403);
  });
});

describe("реестр", () => {
  test("поиск по ФИО, почте и целому номеру телефона; последний вход виден", async () => {
    const mark = crypto.randomUUID().slice(0, 8);
    const person = await makeUser("user", `ops-find-${mark}@test.dev`, {
      phoneIndex: phoneFingerprint("+380501234567"),
    });

    const byMail = await api(`/api/ops/users?q=ops-find-${mark}`, root.token);
    expect(byMail.body.items.map((u: { id: string }) => u.id)).toEqual([person.id]);

    // номер — в любом написании: слепой индекс считается по нормализованному
    const byPhone = await api(`/api/ops/users?q=${encodeURIComponent("050 123 45 67")}`, root.token);
    expect(byPhone.body.items.some((u: { id: string }) => u.id === person.id)).toBe(true);

    expect(byMail.body.items[0].lastSeenAt).toBeNull();
    expect((await login(`ops-find-${mark}@test.dev`)).status).toBe(200);
    const after = await api(`/api/ops/users?q=ops-find-${mark}`, root.token);
    expect(after.body.items[0].lastSeenAt).toBeTruthy();
    expect(after.body.items[0].sessions).toBe(1);
  });

  test("опечатка в фильтре — отказ, а не весь реестр", async () => {
    expect((await api("/api/ops/users?status=disabld", root.token)).status).toBe(400);
  });

  test("у прошедшего методику виден клинический след числом", async () => {
    const email = `ops-trace-${crypto.randomUUID()}@test.dev`;
    const person = await makeUser("user", email);
    const sub = await submitSurvey(surveyInA, person.token);
    expect(sub.status).toBe(201);
    const res = await api(`/api/ops/users?q=${encodeURIComponent(email)}`, root.token);
    expect(res.body.items[0].trace.responses).toBe(1);
    expect(res.body.items[0].journalEntries).toBeGreaterThan(0);
  });
});

describe("выключение", () => {
  test("действует сразу: вход, обмен токена и живой токен отказывают одним текстом", async () => {
    const { id, email } = await created("disable");
    const session = await login(email);
    expect(session.status).toBe(200);
    const access = session.body.token as string;
    expect((await api("/api/auth/me", access)).status).toBe(200);

    const off = await api(`/api/ops/users/${id}/disable`, root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Звільнився 26.09" }),
    });
    expect(off.status).toBe(200);

    const live = await api("/api/auth/me", access);
    expect(live.status).toBe(401);
    expect(live.body.error).toContain("вимкнено");

    const again = await refresh(session.body.refreshToken as string);
    expect(again.status).toBe(401);
    expect(again.body.error).toContain("вимкнено");

    const relogin = await login(email);
    expect(relogin.status).toBe(401);
    expect(relogin.body.error).toContain("вимкнено");

    // неверный пароль к выключенной учётке — обычный отказ: выключение видит только знающий пароль
    const wrong = await login(email, "не-той-пароль-1");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).not.toContain("вимкнено");

    const [entry] = await journal("user.disable", id);
    expect(entry?.actorId).toBe(root.id);
    expect(entry?.details).toMatchObject({ reason: "Звільнився 26.09" });

    // в реестре — причина и кто выключил
    const listed = await api(`/api/ops/users?q=${encodeURIComponent(email)}&status=disabled`, root.token);
    expect(listed.body.items[0].disabledReason).toBe("Звільнився 26.09");
    expect(listed.body.items[0].disabledByEmail).toBe("root@test");

    const on = await api(`/api/ops/users/${id}/enable`, root.token, { method: "POST" });
    expect(on.status).toBe(200);
    expect((await journal("user.enable", id)).length).toBe(1);
    expect((await login(email)).status).toBe(200);
  });

  test("причина обязательна", async () => {
    const { id } = await created("noreason");
    const res = await api(`/api/ops/users/${id}/disable`, root.token, {
      method: "POST",
      body: JSON.stringify({ reason: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("себя выключить нельзя", async () => {
    const mgr = await manager();
    const res = await api(`/api/ops/users/${mgr.id}/disable`, mgr.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Проверка запрета" }),
    });
    expect(res.status).toBe(403);
  });

  test("последнего действующего суперадмина не выключить и не удалить", async () => {
    /*
     * Остальные суперадмины тестовой базы на время проверки выключаются
     * прямо в таблице и возвращаются в finally: сценарий «я последний»
     * иначе не собрать — файлы сюиты заводят суперадминов сами.
     */
    const last = await makeUser("superadmin", `ops-last-${crypto.randomUUID()}@test.dev`);
    const others = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "superadmin"), isNull(usersTable.disabledAt)));
    const toRestore = others.map((o) => o.id).filter((id) => id !== last.id);
    await db
      .update(usersTable)
      .set({ disabledAt: new Date().toISOString(), disabledReason: "тест" })
      .where(inArray(usersTable.id, toRestore));
    try {
      const off = await api(`/api/ops/users/${last.id}/disable`, last.token, {
        method: "POST",
        body: JSON.stringify({ reason: "Проверка последнего" }),
      });
      expect(off.status).toBe(409);
      expect(off.body.error).toContain("останній");

      const del = await api(`/api/ops/users/${last.id}`, last.token, { method: "DELETE" });
      expect(del.status).toBe(409);
    } finally {
      await db
        .update(usersTable)
        .set({ disabledAt: null, disabledReason: null })
        .where(inArray(usersTable.id, toRestore));
    }

    // когда он не последний — отказ уже «себя нельзя»
    const self = await api(`/api/ops/users/${last.id}/disable`, last.token, {
      method: "POST",
      body: JSON.stringify({ reason: "Проверка себя" }),
    });
    expect(self.status).toBe(403);
  });
});

describe("удаление", () => {
  test("учётку с клиническим следом не удалить: 409 со списком и подсказкой выключить", async () => {
    const person = await makeUser("user", `ops-held-${crypto.randomUUID()}@test.dev`);
    expect((await submitSurvey(surveyInA, person.token)).status).toBe(201);

    const res = await api(`/api/ops/users/${person.id}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(409);
    const keys = res.body.holds.map((h: { key: string }) => h.key);
    expect(keys).toContain("responses");
    expect(res.body.error).toContain("Вимкніть");

    // учётка на месте, а отказ — в журнале
    expect((await db.select().from(usersTable).where(eq(usersTable.id, person.id))).length).toBe(1);
    const [denied] = await journal("user.delete", person.id);
    expect(denied?.outcome).toBe("denied");
  });

  test("учётка без следа удаляется, и это строка журнала", async () => {
    const { id } = await created("delete");
    const res = await api(`/api/ops/users/${id}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await db.select().from(usersTable).where(eq(usersTable.id, id))).length).toBe(0);
    const [entry] = await journal("user.delete", id);
    expect(entry?.outcome).toBe("success");
  });

  test("вошедший хоть раз — держится журналом: он не переписывается", async () => {
    const { id, email } = await created("journal");
    expect((await login(email)).status).toBe(200);
    const res = await api(`/api/ops/users/${id}`, root.token, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.body.holds.map((h: { key: string }) => h.key)).toContain("journal");
  });

  test("себя удалить нельзя", async () => {
    const other = await makeUser("superadmin", `ops-self-${crypto.randomUUID()}@test.dev`);
    expect((await api(`/api/ops/users/${other.id}`, other.token, { method: "DELETE" })).status).toBe(403);
  });
});

describe("сброс пароля", () => {
  test("временный пароль — в ответе один раз, в журнале его нет, сессии отозваны", async () => {
    const { id, email } = await created("reset");
    const before = await login(email);
    expect(before.status).toBe(200);

    const res = await api(`/api/ops/users/${id}/reset-password`, root.token, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const temp = res.body.password as string;
    expect(temp).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    // старая сессия кончилась вся: и access, и refresh
    expect((await api("/api/auth/me", before.body.token)).status).toBe(401);
    expect((await refresh(before.body.refreshToken)).status).toBe(401);
    // старый пароль больше не подходит, новый — да, и консоль попросит сменить его
    expect((await login(email)).status).toBe(401);
    const fresh = await login(email, temp);
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.mustChangePassword).toBe(true);

    // пароль не попал в журнал ни в каком виде
    const entries = await journal("user.password_reset", id);
    expect(entries.length).toBe(1);
    const all = await db.select().from(auditLog).where(eq(auditLog.subjectUserId, id));
    expect(JSON.stringify(all)).not.toContain(temp);

    // смена пароля снимает отметку
    const changed = await api("/api/auth/password", fresh.body.token, {
      method: "POST",
      body: JSON.stringify({ currentPassword: temp, newPassword: "zminyv-parol-2026" }),
    });
    expect(changed.status).toBe(200);
    const again = await login(email, "zminyv-parol-2026");
    expect(again.body.user.mustChangePassword).toBe(false);
  });

  test("свой пароль так не сбрасывают", async () => {
    expect((await api(`/api/ops/users/${root.id}/reset-password`, root.token, { method: "POST" })).status).toBe(403);
  });

  test("заведение с временным паролем помечает учётку", async () => {
    const { email } = await created("temp", "admin", { mustChangePassword: true });
    const first = await login(email);
    expect(first.body.user.mustChangePassword).toBe(true);
  });

  test("генератор не даёт знаков, которые путают: 0/O, 1/l/I", () => {
    for (let i = 0; i < 200; i++) expect(generateTempPassword()).not.toMatch(/[0O1lI]/);
  });
});

describe("сессии", () => {
  test("список, завершение одной и всех — каждое в журнале", async () => {
    const { id, email } = await created("sessions");
    const one = await login(email);
    const two = await login(email);

    const list = await api(`/api/ops/sessions?userId=${id}`, root.token);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(2);
    expect(list.body.items[0].email).toBe(email);

    const target = list.body.items[0].id as string;
    const revoked = await api(`/api/ops/sessions/${target}/revoke`, root.token, { method: "POST" });
    expect(revoked.status).toBe(200);
    expect((await api(`/api/ops/sessions?userId=${id}`, root.token)).body.items.length).toBe(1);
    expect((await journal("session.revoke", id)).length).toBe(1);

    // повторно ту же — «не найдено»
    expect((await api(`/api/ops/sessions/${target}/revoke`, root.token, { method: "POST" })).status).toBe(404);

    const all = await api(`/api/ops/users/${id}/revoke-sessions`, root.token, { method: "POST" });
    expect(all.status).toBe(200);
    expect((await api(`/api/ops/sessions?userId=${id}`, root.token)).body.items.length).toBe(0);
    expect((await journal("user.sessions_revoke", id)).length).toBe(1);

    // и ни одна из двух больше не обменивается
    expect((await refresh(one.body.refreshToken)).status).toBe(401);
    expect((await refresh(two.body.refreshToken)).status).toBe(401);
  });
});

describe("журнал", () => {
  test("отбор по тому, кто, над кем, действию, типу ресурса и тексту; страницы курсором", async () => {
    const { id, email } = await created("audit");
    const reason = `Перевірка відбору ${crypto.randomUUID().slice(0, 8)}`;
    await api(`/api/ops/users/${id}/disable`, root.token, { method: "POST", body: JSON.stringify({ reason }) });
    await api(`/api/ops/users/${id}/enable`, root.token, { method: "POST" });

    const bySubject = await api(`/api/audit?subject=${id}&resourceType=user&limit=50`, root.token);
    const actions = bySubject.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.create", "user.disable", "user.enable"]));

    // над кем — и по куску почты: разбирающий помнит почту, а не uuid
    const byMail = await api(`/api/audit?subject=${encodeURIComponent(email)}&action=user.disable`, root.token);
    expect(byMail.body.entries.length).toBe(1);

    const byActor = await api(`/api/audit?actor=root@test&action=user.enable&subject=${id}`, root.token);
    expect(byActor.body.entries.length).toBe(1);

    // свободный текст ищется и в подробностях: причина стоит в выключении и в «прежней причине» включения
    const byText = await api(`/api/audit?q=${encodeURIComponent(reason)}`, root.token);
    expect(byText.body.entries.map((e: { action: string }) => e.action).sort()).toEqual(["user.disable", "user.enable"]);

    // курсор: вторая страница продолжает первую, без повторов
    const first = await api(`/api/audit?subject=${id}&limit=1`, root.token);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await api(`/api/audit?subject=${id}&limit=1&cursor=${first.body.nextCursor}`, root.token);
    expect(second.body.entries[0].id).not.toBe(first.body.entries[0].id);

    // «по» включительно: сегодняшний день не выпадает из отбора за сегодня
    const today = new Date().toISOString().slice(0, 10);
    const todays = await api(`/api/audit?subject=${id}&from=${today}&to=${today}`, root.token);
    expect(todays.body.entries.length).toBeGreaterThanOrEqual(3);
  });

  test("выгрузка CSV отдаёт текущий отбор и сама пишется в журнал", async () => {
    const { id } = await created("csv");
    const res = await app.request(`/api/audit/export.csv?subject=${id}`, {
      headers: { Authorization: `Bearer ${root.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.replace(/^﻿/, "").split("\n");
    expect(lines[0]).toStartWith("seq,at,actor_id");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("user.create");

    const [exported] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "audit.export"), eq(auditLog.actorId, root.id)));
    expect(exported).toBeTruthy();
  });

  test("проверка цепочки проходит и сама оставляет строку", async () => {
    const res = await api("/api/audit/verify", root.token);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("без audit.read журнал закрыт, и выгрузка тоже", async () => {
    expect((await api("/api/audit/export.csv", adminA.token)).status).toBe(403);
  });
});
