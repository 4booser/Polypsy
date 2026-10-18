import { describe, expect, test } from "bun:test";
import type { OpsSessionPage, OpsUserPage, OpsUserRow, OpsUsersAttention } from "@quizzy/shared";
import { auditLog, loginAttempts, permissionExceptions, userSecondFactor } from "../src/db/schema";
import { classifyAttention, IDLE_STAFF_DAYS, TEMP_PASSWORD_HOURS, type AttentionAccount } from "../src/lib/usersAttention";
import { writePolicy } from "../src/lib/secondFactor";
import { and, api, app, appApi, db, eq, makeUser, root } from "./fixtures";

/**
 * «Користувачі» техпанели в Polypsy 2.0: вкладка «Персонал», второй фактор и
 * запирание в строке реестра, «Потребує уваги».
 *
 * Обещания:
 *  1. «Персонал» — суперадмины и администраторы групп, без пациентов; выбор
 *     «всех в отборе» совпадает со списком.
 *  2. Строка говорит о втором факторе и запирании то же, что сторож входа и
 *     политика: пациенту фактор — null; обязателен — только по включённой
 *     политике; заперт — пока в окне не меньше порога неудач.
 *  3. «Потребує уваги» не включает выключенных, считает временный пароль от
 *     выдачи, а не от заведения, и видна тому же праву, что реестр.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const tag = () => crypto.randomUUID().slice(0, 8);

/** Заведующий с правом users.manage — личным исключением, как его и выдают */
async function manager() {
  const person = await makeUser("admin", `w25-mgr-${tag()}@test.dev`);
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: person.id,
    permission: "users.manage",
    mode: "grant",
    reason: "Проверка реестра техпанели",
    grantedBy: root.id,
  });
  return person;
}

/* ═══════════ разложение без базы ═══════════ */

describe("«Потребує уваги» — разложение без базы", () => {
  const NOW = Date.parse("2026-10-08T14:00:00.000Z");
  const iso = (ms: number) => new Date(NOW - ms).toISOString();
  const acc = (id: string, extra: Partial<AttentionAccount> = {}): AttentionAccount => ({
    id,
    email: `${id}@test.dev`,
    role: "admin",
    fullName: id,
    createdAt: iso(90 * DAY),
    lastSeenAt: iso(HOUR),
    disabledAt: null,
    mustChangePassword: false,
    ...extra,
  });
  const none = { now: NOW, locks: new Map(), factors: new Set<string>(), because: new Map(), issued: new Map() };

  test("заперт — по адресу без учёта регистра, с числом неудач и временем открытия; выключенный не входит", () => {
    const until = new Date(NOW + 10 * 60_000).toISOString();
    const out = classifyAttention([acc("Locked", { email: "Locked@Test.dev" }), acc("off", { disabledAt: iso(DAY) })], {
      ...none,
      locks: new Map([
        ["locked@test.dev", { failures: 6, until }],
        ["off@test.dev", { failures: 5, until }],
      ]),
    });
    expect(out.locked.count).toBe(1);
    expect(out.locked.people[0]).toMatchObject({ id: "Locked", failures: 6, at: until });
  });

  test("второй фактор: только где политика требует и фактора нет; пациентов не бывает", () => {
    const out = classifyAttention([acc("need"), acc("has"), acc("free"), acc("pt", { role: "user" })], {
      ...none,
      factors: new Set(["has"]),
      because: new Map([
        ["need", "ops"],
        ["has", "ops"],
        ["pt", "ops"],
      ]),
    });
    expect(out.mfaMissing.people.map((p) => p.id)).toEqual(["need"]);
    expect(out.mfaMissing.people[0]!.because).toBe("ops");
  });

  test("временный пароль — от выдачи по журналу, а не от заведения", () => {
    const out = classifyAttention(
      [
        acc("old", { mustChangePassword: true, createdAt: iso(10 * DAY) }),
        acc("fresh", { mustChangePassword: true, createdAt: iso(10 * DAY) }),
        acc("noMark", { mustChangePassword: true, createdAt: iso((TEMP_PASSWORD_HOURS + 2) * HOUR) }),
      ],
      { ...none, issued: new Map([["old", iso(3 * DAY)], ["fresh", iso(2 * HOUR)]]) },
    );
    expect(out.tempPassword.people.map((p) => p.id)).toEqual(["old", "noMark"]);
    expect(out.tempHours).toBe(TEMP_PASSWORD_HOURS);
  });

  test("персонал без входа: давний вход или ни разу с давнего заведения; пациенты не в счёт", () => {
    const out = classifyAttention(
      [
        acc("idle", { lastSeenAt: iso((IDLE_STAFF_DAYS + 5) * DAY) }),
        acc("never", { lastSeenAt: null, createdAt: iso((IDLE_STAFF_DAYS + 1) * DAY) }),
        acc("newbie", { lastSeenAt: null, createdAt: iso(DAY) }),
        acc("pt", { role: "user", lastSeenAt: iso(200 * DAY) }),
      ],
      none,
    );
    expect(out.idleStaff.people.map((p) => p.id)).toEqual(["idle", "never"]);
    expect(out.idleStaff.people[1]!.never).toBe(true);
  });
});

/* ═══════════ маршруты ═══════════ */

describe("реестр: вкладка «Персонал»", () => {
  test("role=staff — суперадмины и администраторы групп без пациентов; «всі у відборі» — те же", async () => {
    const t = tag();
    const sup = await makeUser("superadmin", `w25-staff-${t}-s@test.dev`);
    const adm = await makeUser("admin", `w25-staff-${t}-a@test.dev`);
    await makeUser("user", `w25-staff-${t}-p@test.dev`);

    const list = await api<OpsUserPage>(`/api/ops/users?role=staff&q=${t}`, root.token);
    expect(list.status).toBe(200);
    expect(list.body.items.map((r) => r.id).sort()).toEqual([sup.id, adm.id].sort());

    const ids = await api<{ ids: string[] }>(`/api/ops/people/users/ids?role=staff&q=${t}`, root.token);
    expect(ids.status).toBe(200);
    expect(ids.body.ids.sort()).toEqual([sup.id, adm.id].sort());

    expect((await api(`/api/ops/users?role=staf`, root.token)).status).toBe(400);
  });
});

describe("строка реестра: второй фактор и запирание", () => {
  test("пациенту — null; персоналу — есть ли фактор и обязателен ли по политике", async () => {
    const t = tag();
    const adm = await makeUser("admin", `w25-mfa-${t}-a@test.dev`);
    const sup = await makeUser("superadmin", `w25-mfa-${t}-s@test.dev`);
    await makeUser("user", `w25-mfa-${t}-p@test.dev`);
    await db.insert(userSecondFactor).values({ userId: sup.id, secretEnc: "x", confirmedAt: new Date().toISOString() });

    /* смотрит заведующий: суперадмину без фактора включённая политика закрыла бы техпанель */
    const mgr = await manager();
    try {
      await writePolicy({ superadmins: true, ops: false }, root.id);
      const page = await api<OpsUserPage>(`/api/ops/users?q=${t}`, mgr.token);
      expect(page.status).toBe(200);
      const byEmail = new Map(page.body.items.map((r) => [r.email.split("-").pop(), r]));
      expect(byEmail.get("p@test.dev")!.secondFactor).toBeNull();
      expect(byEmail.get("a@test.dev")!.secondFactor).toEqual({ enabled: false, required: null });
      expect(byEmail.get("s@test.dev")!.secondFactor).toEqual({ enabled: true, required: "superadmin" });
    } finally {
      await writePolicy({ superadmins: false, ops: false }, root.id);
    }
  });

  test("заперт перебором: число неудач и время, когда вход откроется сам", async () => {
    const t = tag();
    const email = `w25-lock-${t}@test.dev`;
    await makeUser("user", email);
    const first = Date.now() - 5 * 60_000;
    await db.insert(loginAttempts).values(
      Array.from({ length: 6 }, (_, i) => ({ id: crypto.randomUUID(), email, ip: "10.0.0.9", at: new Date(first + i * 1000).toISOString() })),
    );
    const page = await api<OpsUserPage>(`/api/ops/users?q=${t}`, root.token);
    const row = page.body.items[0]!;
    expect(row.lock?.failures).toBe(6);
    /* в окне шесть неудач при пороге пять: откроется, когда выйдет вторая */
    expect(new Date(row.lock!.until).getTime()).toBe(first + 1000 + 15 * 60_000);

  });
});

describe("одна запись реестра", () => {
  test("та же строка, что в списке; чужому праву — отказ; нет такой — 404; чтение — в журнал", async () => {
    const t = tag();
    const person = await makeUser("admin", `w25-one-${t}@test.dev`);
    const list = await api<OpsUserPage>(`/api/ops/users?q=${t}`, root.token);
    const one = await api<OpsUserRow>(`/api/ops/users/${person.id}`, root.token);
    expect(one.status).toBe(200);
    expect(one.body).toEqual(list.body.items[0]!);

    const plain = await makeUser("admin", `w25-one-plain-${t}@test.dev`);
    expect((await api(`/api/ops/users/${person.id}`, plain.token)).status).toBe(403);
    expect((await api(`/api/ops/users/${crypto.randomUUID()}`, root.token)).status).toBe(404);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.list"), eq(auditLog.subjectUserId, person.id)))
      .limit(1);
    expect((row!.details as { view?: string }).view).toBe("account");
  });
});

describe("«Потребує уваги» — маршрут", () => {
  test("тому же праву, что реестр; под ролью приложения видит запертых; чтение — в журнал", async () => {
    const plain = await makeUser("admin", `w25-att-plain-${tag()}@test.dev`);
    expect((await api("/api/ops/users/attention", plain.token)).status).toBe(403);

    const mgr = await manager();
    const before = await appApi<OpsUsersAttention>("/api/ops/users/attention", mgr.token);
    expect(before.status).toBe(200);

    const email = `w25-att-${tag()}@test.dev`;
    await makeUser("user", email);
    await db.insert(loginAttempts).values(Array.from({ length: 5 }, () => ({ id: crypto.randomUUID(), email, ip: "10.0.0.8" })));

    const after = await appApi<OpsUsersAttention>("/api/ops/users/attention", mgr.token);
    expect(after.body.locked.count).toBe(before.body.locked.count + 1);
    expect(after.body.idleDays).toBe(IDLE_STAFF_DAYS);

    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.list"), eq(auditLog.actorId, mgr.id)))
      .limit(1);
    expect((row!.details as { view?: string }).view).toBe("attention");
  }, 20_000);
});

describe("«Сесії»: отбор по роли и возрасту", () => {
  test("staff — только персонал, user — только пациенты; возраст — от входа, корзинами сводки", async () => {
    const t = tag();
    const staffEmail = `w25-sess-${t}-a@test.dev`;
    const patientEmail = `w25-sess-${t}-p@test.dev`;
    await makeUser("admin", staffEmail);
    await makeUser("user", patientEmail);
    for (const email of [staffEmail, patientEmail]) {
      const res = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "secret12345" }),
      });
      expect(res.status).toBe(200);
    }
    const emails = async (query: string) =>
      (await api<OpsSessionPage>(`/api/ops/sessions?q=${t}${query}`, root.token)).body.items.map((s) => s.email).sort();

    expect(await emails("")).toEqual([staffEmail, patientEmail].sort());
    expect(await emails("&role=staff")).toEqual([staffEmail]);
    expect(await emails("&role=user")).toEqual([patientEmail]);
    expect(await emails("&age=day")).toEqual([staffEmail, patientEmail].sort());
    expect(await emails("&age=older")).toEqual([]);
    expect((await api(`/api/ops/sessions?age=year`, root.token)).status).toBe(400);
  });
});
