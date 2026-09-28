import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Permission } from "@quizzy/shared";
import { db } from "../src/db";
import { auditLog, permissionExceptions, roles, staffRoles, users } from "../src/db/schema";
import { api, client, makeUser, root, type Person } from "./fixtures";

/**
 * Смена класса учётной записи (superadmin · admin · user) — одним правилом
 * для всех входов (внешний разбор 2026-09-27, п. 1, P1).
 *
 * Было: команда консоли `user role` меняла класс без единой проверки сверх
 * права users.manage. Сотрудник с console.use и делегированным users.manage
 * набирал `user role <своя почта> superadmin`, получал 200, и тот же
 * access-токен со следующего запроса видел суперадмина: роль читается из
 * базы на каждый запрос (middleware/auth.ts), а консоль, в отличие от HTTP,
 * сессий не обрывала. HTTP-двойник (PATCH /api/users/:id/role) проверял
 * «не себе» и «суперадмина — только суперадмин», но лестницу должностей не
 * знал: заведующий разжаловал главного врача в пациенты.
 *
 * Стало: lib/accountClass.ts — одна функция, которую зовут оба входа, и
 * заведение учётки (POST /api/users) тем же правилом «не выше и не вровень
 * со своим положением».
 *
 * Все проверки — запросами, а не вызовом функции: функцию можно позвать
 * правильно и мимо маршрута, а дыра была именно во входе.
 */

const uid = () => crypto.randomUUID().slice(0, 8);

async function ladderRoleId(code: string): Promise<string> {
  const [row] = await db.select().from(roles).where(eq(roles.code, code));
  return row!.id;
}

/**
 * Сотрудник с личными исключениями — так users.manage и console.use и выдают
 * (ни в одну роль лестницы они не входят, миграция 0071). `ladder` — ступень
 * должности: без неё человек стоит на встроенной роли «психолог», вне лестницы.
 */
async function staff(perms: Permission[], ladder?: "specialist" | "head" | "chief"): Promise<Person & { email: string }> {
  const email = `cls-${ladder ?? "plain"}-${uid()}@test`;
  const person = await makeUser("admin", email);
  for (const permission of perms) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission,
      mode: "grant",
      reason: "Ведёт учётные записи отделения",
      grantedBy: root.id,
    });
  }
  if (ladder) await db.insert(staffRoles).values({ userId: person.id, roleId: await ladderRoleId(ladder), grantedBy: root.id });
  return { ...person, email };
}

async function patientAcct(extra?: { ladder?: "chief" }): Promise<Person & { email: string }> {
  const email = `cls-p-${uid()}@test`;
  const person = await makeUser("user", email);
  // пациент, у которого с прежней службы осталась должность: класс её гасит, но не стирает
  if (extra?.ladder) {
    await db.insert(staffRoles).values({ userId: person.id, roleId: await ladderRoleId(extra.ladder), grantedBy: root.id });
  }
  return { ...person, email };
}

const MANAGER: Permission[] = ["users.manage", "console.use"];

const consoleRun = (actor: Person, line: string) =>
  api<{ ok: boolean; lines: string[]; error?: string }>("/api/console/run", actor.token, {
    method: "POST",
    body: JSON.stringify({ line }),
    headers: { "Accept-Language": "ru" },
  });

const httpRole = (actor: Person, targetId: string, role: string) =>
  api(`/api/users/${targetId}/role`, actor.token, {
    method: "PATCH",
    body: JSON.stringify({ role }),
    headers: { "Accept-Language": "ru" },
  });

async function classOf(id: string) {
  const [row] = await db.select({ role: users.role, readOnly: users.readOnly }).from(users).where(eq(users.id, id));
  return row!;
}

describe("п. 1 разбора: повышение себя через консоль", () => {
  test("сотрудник с console.use и users.manage не делает себя суперадмином, и его токен прав не получает", async () => {
    const head = await staff(MANAGER);

    const res = await consoleRun(head, `user role ${head.email} superadmin`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    expect((await classOf(head.id)).role).toBe("admin");
    // тот же токен — тот же человек: ни суперадмина, ни обрыва сессии
    const me = await api("/api/auth/me", head.token);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe("admin");
  });

  test("…и через HTTP тоже: себе класс не меняют", async () => {
    const head = await staff(MANAGER);
    const res = await httpRole(head, head.id, "superadmin");
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("собственную роль");
    expect((await classOf(head.id)).role).toBe("admin");
  });
});

describe("одно правило на оба входа", () => {
  /*
   * Каждая строка — одна и та же попытка через консоль и через HTTP. Ответ
   * обязан совпасть: 403 и тот же текст отказа. Текст проверяется, чтобы тест
   * не устроил любой чужой 403 — от проверки персонала или «только чтения».
   */
  const both = async (actor: Person, target: { id: string; email: string }, role: string) => {
    const viaConsole = await consoleRun(actor, `user role ${target.email} ${role}`);
    const viaHttp = await httpRole(actor, target.id, role);
    return { viaConsole, viaHttp };
  };

  test("суперадмина не выдаёт никто, кроме суперадмина", async () => {
    const head = await staff(MANAGER, "chief");
    const colleague = await staff([]);
    const { viaConsole, viaHttp } = await both(head, colleague, "superadmin");
    expect([viaConsole.status, viaHttp.status]).toEqual([403, 403]);
    expect(viaConsole.body.error).toBe(viaHttp.body.error);
    expect(viaHttp.body.error).toContain("суперадминистратору");
    expect((await classOf(colleague.id)).role).toBe("admin");
  });

  test("защищённая учётка: суперадмина не трогает никто, кроме суперадмина", async () => {
    const head = await staff(MANAGER, "chief");
    const [rootRow] = await db.select().from(users).where(eq(users.id, root.id));
    try {
      const { viaConsole, viaHttp } = await both(head, { id: root.id, email: rootRow!.email }, "user");
      expect([viaConsole.status, viaHttp.status]).toEqual([403, 403]);
      expect(viaConsole.body.error).toBe(viaHttp.body.error);
      expect((await classOf(root.id)).role).toBe("superadmin");
    } finally {
      // общий суперадмин фикстур нужен всем файлам: провал проверки не должен их ронять
      await restoreRoot();
    }
  });

  test("равного и старшего по лестнице не трогают: заведующий не разжалует заведующего и главного врача", async () => {
    const head = await staff(MANAGER, "head");
    for (const ladder of ["head", "chief"] as const) {
      const senior = await staff([], ladder);
      const { viaConsole, viaHttp } = await both(head, senior, "user");
      expect([viaConsole.status, viaHttp.status], ladder).toEqual([403, 403]);
      expect(viaConsole.body.error).toBe(viaHttp.body.error);
      expect(viaHttp.body.error).toContain("вашей ступени или выше");
      expect((await classOf(senior.id)).role).toBe("admin");
    }
  });

  test("роль вровень со своей не выдаётся: сотрудник вне лестницы не делает сотрудников", async () => {
    // делегированный users.manage у «психолога» (ступень 0): сотрудник — его ровня
    const plain = await staff(MANAGER);
    const person = await patientAcct();
    const { viaConsole, viaHttp } = await both(plain, person, "admin");
    expect([viaConsole.status, viaHttp.status]).toEqual([403, 403]);
    expect(viaHttp.body.error).toContain("ниже собственной");
    expect((await classOf(person.id)).role).toBe("user");

    // и заведением учётки тоже: создать сотрудника — выдать тот же класс
    const made = await api("/api/users", plain.token, {
      method: "POST",
      body: JSON.stringify({ email: `cls-new-${uid()}@test.dev`, password: "secret12345", firstName: "Новий", lastName: "Співробітник", role: "admin" }),
      headers: { "Accept-Language": "ru" },
    });
    expect(made.status).toBe(403);
    expect(made.body.error).toContain("ниже собственной");
  });

  test("должность, оставшаяся у пациента, не возвращается руками младшего", async () => {
    const head = await staff(MANAGER, "head");
    const former = await patientAcct({ ladder: "chief" });
    const { viaConsole, viaHttp } = await both(head, former, "admin");
    expect([viaConsole.status, viaHttp.status]).toEqual([403, 403]);
    expect((await classOf(former.id)).role).toBe("user");
  });

  test("ниже себя — можно: заведующий принимает человека в сотрудники и разжалует специалиста", async () => {
    const head = await staff(MANAGER, "head");

    const a = await patientAcct();
    expect((await consoleRun(head, `user role ${a.email} admin`)).body.ok).toBe(true);
    expect((await classOf(a.id)).role).toBe("admin");

    const b = await patientAcct();
    expect((await httpRole(head, b.id, "admin")).status).toBe(200);
    expect((await classOf(b.id)).role).toBe("admin");

    const specialist = await staff([], "specialist");
    expect((await consoleRun(head, `user role ${specialist.email} user`)).body.ok).toBe(true);
    expect((await classOf(specialist.id)).role).toBe("user");
  });
});

describe("прежний токен не получает новых прав молча", () => {
  /*
   * Как сейчас: requireAuth читает строку пользователя на каждый запрос, то
   * есть роль и права из токена не берутся вовсе — токен с любой ролью
   * «догоняет» базу на следующем же запросе. Поэтому смена класса обрывает
   * сессии человека (граница tokensValidFrom + отзыв refresh), и новый класс
   * он получает только новым входом — не посреди открытой вкладки.
   * Консоль прежде сессий не обрывала: повышенный через неё человек
   * продолжал работать тем же токеном уже с новыми правами.
   */
  test("после смены класса консолью старый токен человека больше не принимается", async () => {
    const person = await patientAcct();
    expect((await api("/api/auth/me", person.token)).status).toBe(200);

    const res = await consoleRun(root, `user role ${person.email} admin`);
    expect(res.body.ok, res.body.lines?.join(" ")).toBe(true);

    const after = await api("/api/auth/me", person.token);
    expect(after.status, "повышенный консолью человек продолжил работать прежним токеном").toBe(401);
  });

  test("…и после смены через HTTP — так же", async () => {
    const person = await patientAcct();
    expect((await httpRole(root, person.id, "admin")).status).toBe(200);
    expect((await api("/api/auth/me", person.token)).status).toBe(401);
  });
});

describe("«только чтение» консолью — те же границы, что у действий над чужой учёткой", () => {
  test("суперадмина в «только чтение» не переводит никто, кроме суперадмина; себя — никто", async () => {
    const head = await staff(MANAGER, "chief");
    const [rootRow] = await db.select().from(users).where(eq(users.id, root.id));

    try {
      const onRoot = await consoleRun(head, `user readonly ${rootRow!.email} on`);
      expect(onRoot.status).toBe(403);
      expect((await classOf(root.id)).readOnly).toBe(false);
    } finally {
      await restoreRoot();
    }

    const onSelf = await consoleRun(head, `user readonly ${head.email} on`);
    expect(onSelf.status).toBe(403);
    expect((await classOf(head.id)).readOnly).toBe(false);

    const senior = await staff([], "chief");
    expect((await consoleRun(head, `user readonly ${senior.email} on`)).status).toBe(403);
    expect((await classOf(senior.id)).readOnly).toBe(false);

    const junior = await staff([], "specialist");
    expect((await consoleRun(head, `user readonly ${junior.email} on`)).body.ok).toBe(true);
    expect((await classOf(junior.id)).readOnly).toBe(true);
  });
});

describe("журнал", () => {
  test("отказ пишется в журнал действием смены класса — каким бы входом ни пробовали", async () => {
    const head = await staff(MANAGER);
    await consoleRun(head, `user role ${head.email} superadmin`);
    const target = await staff([]);
    await httpRole(head, target.id, "superadmin");

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.role_change"), eq(auditLog.actorId, head.id)));
    const denied = rows.filter((r) => r.outcome === "denied");
    expect(denied.map((r) => r.subjectUserId).sort()).toEqual([head.id, target.id].sort());

    // и консольная попытка видна как попытка консоли, а не только как её итог
    const consoleRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "console.run"), eq(auditLog.actorId, head.id)));
    expect(consoleRows.some((r) => r.outcome === "denied")).toBe(true);
  });
});

describe("гонка двух смен класса", () => {
  /**
   * Проверка «из какого класса можно» и запись — под одним замком строки.
   *
   * Было: обработчик читал класс цели простым SELECT и писал UPDATE по id.
   * Заведующий видел цель администратором, а суперадмин тем временем делал
   * её суперадмином; UPDATE заведующего, дождавшись замка, разжаловал
   * суперадмина в пациенты — хотя над суперадмином действует только
   * суперадмин. Гонка ставится строчным замком, как в recordingRace.test.ts.
   */
  test("заведующий, опоздавший за суперадмином, получает отказ, а не разжалует суперадмина", async () => {
    const head = await staff(MANAGER, "head");
    const target = await staff([]);

    let demoting!: Promise<{ status: number }>;
    await client.begin(async (tx) => {
      await tx`select id from users where id = ${target.id} for update`;
      demoting = httpRole(head, target.id, "user");
      await untilBlocked();
      // пока запрос заведующего ждёт, суперадмин успевает первым
      await tx`update users set role = 'superadmin' where id = ${target.id}`;
    });

    const res = await demoting;
    expect(res.status).toBe(403);
    expect((await classOf(target.id)).role).toBe("superadmin");
    // вернуть как было: живой суперадмин из теста не нужен соседним файлам
    await db.update(users).set({ role: "admin" }).where(eq(users.id, target.id));
  });
});

describe("последний заслон — база (миграция 0110)", () => {
  /*
   * Сервис держит правило для всех нынешних входов; триггер — для входа,
   * который однажды напишут мимо сервиса, как консоль была написана мимо
   * маршрута. Политика строк users здесь не помогает: UPDATE разрешён всему
   * персоналу.
   */
  const asRole = (role: string, id: string, next: string) =>
    client.begin(async (tx) => {
      await tx`select set_config('app.role', ${role}, true)`;
      await tx`update users set role = ${next} where id = ${id}`;
    });
  const codeOf = async (work: Promise<unknown>) => {
    try {
      await work;
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "?";
    }
  };

  test("в контексте сотрудника класс суперадмина не выдаётся и не снимается даже голым UPDATE", async () => {
    const target = await staff([]);
    expect(await codeOf(asRole("admin", target.id, "superadmin"))).toBe("42501");
    expect((await classOf(target.id)).role).toBe("admin");

    // суперадмин и система — проходят
    expect(await codeOf(asRole("superadmin", target.id, "superadmin"))).toBeNull();
    expect((await classOf(target.id)).role).toBe("superadmin");
    expect(await codeOf(asRole("admin", target.id, "user"))).toBe("42501");
    expect(await codeOf(asRole("system", target.id, "admin"))).toBeNull();
    expect((await classOf(target.id)).role).toBe("admin");

    // остальные смены класса триггер не трогает: их правило — в сервисе
    expect(await codeOf(asRole("admin", target.id, "user"))).toBeNull();
  });
});

async function restoreRoot(): Promise<void> {
  await db.update(users).set({ role: "superadmin", readOnly: false }).where(eq(users.id, root.id));
}

async function untilBlocked(waiting = 1): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await client`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and state = 'active'`;
    if ((row?.n ?? 0) >= waiting) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("никто не ждёт на замке: гонка не состоялась");
}
