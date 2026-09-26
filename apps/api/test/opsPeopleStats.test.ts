import { describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AuditDaily, GrantStats, OpsSessionsSummary, OpsUsersSummary, SuspiciousStats } from "@quizzy/shared";
import { auditLog, loginAttempts, permissionExceptions, suspiciousFindings, userSecondFactor, users as usersTable } from "../src/db/schema";
import {
  accountState,
  ageBucket,
  emptyTally,
  hiddenParts,
  roleSummary,
} from "../src/lib/peopleStats";
import { SMALL_CELL_FLOOR } from "../src/lib/privacy";
import { dailyWindow } from "../src/routes/audit";
import { underAppRole } from "./appRole";
import { adminA, api, app, db, json, makeUser, patient, root } from "./fixtures";

/**
 * Графики разделов людей техпанели (волна 11, участок people): сводка
 * реестра и сессий, записи журнала по отбору во времени, обзор подозрительного
 * и временных доступов.
 *
 * Главное здесь — обещания, которые график нарушает незаметно:
 *
 *  1. Наружу — только числа: ни почты, ни имени, ни идентификатора.
 *  2. Пациенты — через порог малых чисел, и скрытое не восстанавливается
 *     вычитанием из напечатанного рядом целого.
 *  3. Числа — про всю систему: заведующий с users.manage под боевой ролью
 *     видит то же, что суперадмин, хотя попытки входа и второй фактор
 *     политики строк ему не открывают.
 *  4. График журнала рисует ровно отбор таблицы.
 *  5. Права — те же, что у раздела; чтение — в журнал там, где оно про людей.
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

/** Заведующий с правом users.manage — личным исключением, как его и выдают */
async function manager(permission = "users.manage") {
  const person = await makeUser("admin", `w11-mgr-${crypto.randomUUID()}@test.dev`);
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: person.id,
    permission,
    mode: "grant",
    reason: "Проверка графиков техпанели",
    grantedBy: root.id,
  });
  return person;
}

const usersSummary = async (token = root.token) => (await api<OpsUsersSummary>("/api/ops/users/summary", token)).body;
const roleOf = (s: OpsUsersSummary, role: "superadmin" | "admin" | "user") => s.roles.find((r) => r.role === role)!;
const stateOf = (s: OpsUsersSummary, role: "superadmin" | "admin" | "user", key: string) =>
  roleOf(s, role).states.find((x) => x.key === key)!.count;

/** Числа ячейки пациентов допустимы только такие: скрыто, ноль или не меньше порога */
const safeCell = (n: number | null) => n === null || n === 0 || n >= SMALL_CELL_FLOOR;

/* ═══════════ чистые правила ═══════════ */

describe("состояние учётки и порог — без базы", () => {
  test("состояние одно, по старшинству: выключена → заперта → ни разу → действует", () => {
    const locked = new Set(["x@test.dev"]);
    const at = "2026-09-01T10:00:00.000Z";
    expect(accountState({ email: "X@test.dev", disabledAt: at, lastSeenAt: null }, locked)).toBe("disabled");
    expect(accountState({ email: "X@test.dev", disabledAt: null, lastSeenAt: null }, locked)).toBe("locked");
    expect(accountState({ email: "y@test.dev", disabledAt: null, lastSeenAt: null }, locked)).toBe("never");
    expect(accountState({ email: "y@test.dev", disabledAt: null, lastSeenAt: at }, locked)).toBe("active");
  });

  test("скрыто целое — скрыты все части: иначе они сложились бы в него обратно", () => {
    const cut = hiddenParts(3, [
      { key: "a", n: 2 },
      { key: "b", n: 1 },
    ]);
    expect(cut.total).toBeNull();
    expect(cut.parts.every((p) => p.count === null)).toBe(true);
  });

  test("одна малая часть при показанном целом тянет за собой вторую — вычитанием её не назвать", () => {
    const cut = hiddenParts(40, [
      { key: "active", n: 30 },
      { key: "never", n: 7 },
      { key: "locked", n: 0 },
      { key: "disabled", n: 3 },
    ]);
    expect(cut.total).toBe(40);
    const hidden = cut.parts.filter((p) => p.count === null).map((p) => p.key);
    expect(hidden).toContain("disabled");
    expect(hidden.length).toBeGreaterThanOrEqual(2);
    // ноль показывается: «никого» не выдаёт никого
    expect(cut.parts.find((p) => p.key === "locked")!.count).toBe(0);
  });

  test("персонал — числом всегда, пациенты — через порог и без второго фактора", () => {
    const t = emptyTally();
    t.total = 3;
    t.states.active = 2;
    t.states.disabled = 1;
    t.mfaTotal = 2;
    t.mfaEnabled = 1;
    const staff = roleSummary("superadmin", t);
    expect(staff.total).toBe(3);
    expect(staff.states.find((s) => s.key === "disabled")!.count).toBe(1);
    expect(staff.mfa).toEqual({ enabled: 1, total: 2 });

    const patients = roleSummary("user", t);
    expect(patients.total).toBeNull();
    expect(patients.states.every((s) => s.count === null)).toBe(true);
    expect(patients.mfa).toBeNull();
  });

  test("возраст сессии: границы — сутки, неделя, тридцать дней", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    expect(ageBucket(ago(23), now)).toBe("day");
    expect(ageBucket(ago(24), now)).toBe("week");
    expect(ageBucket(ago(24 * 7), now)).toBe("month");
    expect(ageBucket(ago(24 * 30), now)).toBe("older");
  });

  test("окно графика журнала: по умолчанию тридцать дней, шаг — по длине, перевёрнутое — пустое", () => {
    expect(dailyWindow(undefined, undefined, "2026-09-26")).toEqual({ from: "2026-08-28", to: "2026-09-26", step: "day", empty: false });
    expect(dailyWindow(undefined, "2026-03-31", "2026-09-26")).toMatchObject({ from: "2026-03-02", to: "2026-03-31", step: "day" });
    expect(dailyWindow("2026-06-01", "2026-08-31", "2026-09-26").step).toBe("day");
    expect(dailyWindow("2025-01-01", "2026-09-26", "2026-09-26").step).toBe("week");
    expect(dailyWindow("2020-01-01", undefined, "2026-09-26").step).toBe("month");
    // дата со временем — днём: журнал отбирает по дням
    expect(dailyWindow("2026-09-20T08:00:00.000Z", "2026-09-26T23:00:00.000Z", "2026-09-26")).toMatchObject({ from: "2026-09-20", to: "2026-09-26" });
    expect(dailyWindow("2026-09-26", "2026-09-01", "2026-09-26").empty).toBe(true);
    // десять лет назад и дальше — обрезается: месяцев не больше ста двадцати с небольшим
    expect(dailyWindow("1990-01-01", "2026-09-26", "2026-09-26").from > "2016-01-01").toBe(true);
  });
});

/* ═══════════ права ═══════════ */

describe("кто видит графики", () => {
  test("сводки реестра и сессий — под users.manage, как сами разделы", async () => {
    expect((await api("/api/ops/users/summary", adminA.token)).status).toBe(403);
    expect((await api("/api/ops/sessions/summary", adminA.token)).status).toBe(403);
    expect((await api("/api/ops/users/summary", patient.token)).status).toBe(403);
    const mgr = await manager();
    expect((await api("/api/ops/users/summary", mgr.token)).status).toBe(200);
    expect((await api("/api/ops/sessions/summary", mgr.token)).status).toBe(200);
  });

  test("журнал во времени — под audit.read: ни сотруднику без права, ни ведущему учётки", async () => {
    expect((await api("/api/audit/daily", adminA.token)).status).toBe(403);
    expect((await api("/api/audit/daily", (await manager()).token)).status).toBe(403);
    expect((await api("/api/audit/daily", patient.token)).status).toBe(403);
    expect((await api("/api/audit/daily", (await manager("audit.read")).token)).status).toBe(200);
  });
});

/* ═══════════ сводка реестра ═══════════ */

describe("сводка реестра", () => {
  test("только числа: ни почты, ни имени, ни идентификатора", async () => {
    const who = await makeUser("admin", `w11-pii-${crypto.randomUUID()}@test.dev`);
    const text = JSON.stringify(await usersSummary());
    expect(text).not.toContain("@test");
    expect(text).not.toContain(who.id);
    expect(text).not.toContain(root.id);
    expect(text).not.toContain("Тест");
  });

  test("персонал сходится с базой строка в строку, части складываются в целое", async () => {
    const s = await usersSummary();
    for (const role of ["superadmin", "admin"] as const) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.role, role));
      const r = roleOf(s, role);
      expect(r.total).toBe(Number(row?.n ?? 0));
      expect(r.states.reduce((sum, x) => sum + (x.count ?? 0), 0)).toBe(r.total!);
      expect(r.mfa!.total).toBeLessThanOrEqual(r.total!);
    }
  });

  test("новая учётка — «жодного входу», выключенная — «вимкнено», запертая перебором — «заблоковано»", async () => {
    const before = await usersSummary();
    const fresh = await makeUser("admin", `w11-fresh-${crypto.randomUUID()}@test.dev`);
    const off = await makeUser("admin", `w11-off-${crypto.randomUUID()}@test.dev`);
    await db.update(usersTable).set({ disabledAt: new Date().toISOString(), disabledReason: "проверка" }).where(eq(usersTable.id, off.id));
    const lockedEmail = `w11-locked-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", lockedEmail);
    await db.insert(loginAttempts).values(Array.from({ length: 5 }, () => ({ id: crypto.randomUUID(), email: lockedEmail, ip: "10.0.0.1" })));

    const after = await usersSummary();
    expect(roleOf(after, "admin").total).toBe(roleOf(before, "admin").total! + 3);
    expect(stateOf(after, "admin", "never")).toBe(stateOf(before, "admin", "never")! + 1);
    expect(stateOf(after, "admin", "disabled")).toBe(stateOf(before, "admin", "disabled")! + 1);
    expect(stateOf(after, "admin", "locked")).toBe(stateOf(before, "admin", "locked")! + 1);
    // выключенная не считается в охвате второго фактора: ей он ни к чему
    expect(roleOf(after, "admin").mfa!.total).toBe(roleOf(before, "admin").mfa!.total + 2);
    expect(fresh.id).toBeTruthy();
  });

  test("второй фактор считается только подтверждённый", async () => {
    const before = await usersSummary();
    const on = await makeUser("admin", `w11-mfa-${crypto.randomUUID()}@test.dev`);
    const half = await makeUser("admin", `w11-mfa-half-${crypto.randomUUID()}@test.dev`);
    await db.insert(userSecondFactor).values([
      { userId: on.id, secretEnc: "x", confirmedAt: new Date().toISOString() },
      { userId: half.id, secretEnc: "x", confirmedAt: null },
    ]);
    const after = await usersSummary();
    expect(roleOf(after, "admin").mfa!.enabled).toBe(roleOf(before, "admin").mfa!.enabled + 1);
    expect(roleOf(after, "admin").mfa!.total).toBe(roleOf(before, "admin").mfa!.total + 2);
  });

  test("пациенты — через порог: ни одна ячейка не меньше порога, и скрытая не одна при показанном целом", async () => {
    const s = await usersSummary();
    const p = roleOf(s, "user");
    expect(p.mfa).toBeNull();
    expect(safeCell(p.total)).toBe(true);
    for (const x of p.states) expect(safeCell(x.count)).toBe(true);
    if (p.total !== null) expect(p.states.filter((x) => x.count === null).length).not.toBe(1);
    for (const w of s.newByWeek) expect(safeCell(w.patients)).toBe(true);
    expect(s.smallCellFloor).toBe(SMALL_CELL_FLOOR);
  });

  test("новые по неделям — двенадцать понедельников подряд, эта неделя последней", async () => {
    const before = await usersSummary();
    await makeUser("admin", `w11-week-${crypto.randomUUID()}@test.dev`);
    const after = await usersSummary();
    expect(after.newByWeek).toHaveLength(12);
    for (const w of after.newByWeek) expect(new Date(`${w.week}T12:00:00Z`).getUTCDay()).toBe(1);
    const weeks = after.newByWeek.map((w) => w.week);
    expect([...weeks].sort()).toEqual(weeks);
    expect(after.newByWeek.at(-1)!.staff).toBe(before.newByWeek.at(-1)!.staff + 1);
  });

  test("входы по дням: удачный и неудачный — в последнем дне ряда, по своим частям", async () => {
    const email = `w11-login-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);
    const before = await usersSummary();
    expect((await login(email)).status).toBe(200);
    expect((await login(email, "wrong-password")).status).toBe(401);
    const after = await usersSummary();
    expect(after.loginsByDay).toHaveLength(30);
    expect(after.loginsByDay.at(-1)!.success).toBe(before.loginsByDay.at(-1)!.success + 1);
    expect(after.loginsByDay.at(-1)!.failed).toBe(before.loginsByDay.at(-1)!.failed + 1);
  });

  test("чтение сводки — в журнал тем же user.list, с пометкой вида", async () => {
    const mgr = await manager();
    await usersSummary(mgr.token);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.list"), eq(auditLog.actorId, mgr.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((row?.details as { view?: string } | null)?.view).toBe("summary");
  });

  test("под боевой ролью заведующий видит то же, что суперадмин: запертых и второй фактор — всей системы", async () => {
    const mgr = await manager();
    const owner = await usersSummary();
    // предыдущие проверки оставили и запертого, и включённый фактор — иначе сравнивать было бы нечего
    expect(stateOf(owner, "admin", "locked")!).toBeGreaterThan(0);
    expect(roleOf(owner, "admin").mfa!.enabled).toBeGreaterThan(0);
    const out = await underAppRole<{ status: number; body: OpsUsersSummary }>(`
      const r = await app.request("/api/ops/users/summary", { headers: { Authorization: "Bearer ${mgr.token}" } });
      out.status = r.status;
      out.body = await r.json();
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.status).toBe(200);
    expect(out.body!.roles).toEqual(owner.roles);
  });
});

/* ═══════════ сводка сессий ═══════════ */

describe("сводка сессий", () => {
  test("вход — новая сессия персонала младше суток; всего не печатается", async () => {
    const email = `w11-sess-${crypto.randomUUID()}@test.dev`;
    await makeUser("admin", email);
    const before = (await api<OpsSessionsSummary>("/api/ops/sessions/summary", root.token)).body;
    expect((await login(email)).status).toBe(200);
    const res = await api<OpsSessionsSummary>("/api/ops/sessions/summary", root.token);
    expect(res.status).toBe(200);
    const after = res.body;
    const admins = (s: OpsSessionsSummary) => s.byRole.find((r) => r.role === "admin")!.sessions!;
    const staffDay = (s: OpsSessionsSummary) => s.byAge.find((g) => g.group === "staff")!.buckets.find((b) => b.key === "day")!.count!;
    expect(admins(after)).toBe(admins(before) + 1);
    expect(staffDay(after)).toBe(staffDay(before) + 1);
    // персонал: части складываются в своё целое
    const staff = after.byAge.find((g) => g.group === "staff")!;
    expect(staff.buckets.reduce((s, b) => s + (b.count ?? 0), 0)).toBe(staff.total!);
    expect(Object.keys(after)).not.toContain("total");
    expect(JSON.stringify(after)).not.toContain("@test");
  });

  test("сессии пациентов — через порог, и их скрытое не вычитается из общего", async () => {
    const s = (await api<OpsSessionsSummary>("/api/ops/sessions/summary", root.token)).body;
    const patients = s.byAge.find((g) => g.group === "patients")!;
    expect(s.byRole.find((r) => r.role === "user")!.sessions).toBe(patients.total);
    expect(safeCell(patients.total)).toBe(true);
    for (const b of patients.buckets) expect(safeCell(b.count)).toBe(true);
    if (patients.total !== null) expect(patients.buckets.filter((b) => b.count === null).length).not.toBe(1);
  });

  test("чтение сводки сессий — в журнал (session.list)", async () => {
    const mgr = await manager();
    await api("/api/ops/sessions/summary", mgr.token);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "session.list"), eq(auditLog.actorId, mgr.id)))
      .limit(1);
    expect((row?.details as { view?: string } | null)?.view).toBe("summary");
  });
});

/* ═══════════ журнал во времени ═══════════ */

describe("журнал по отбору во времени", () => {
  test("по умолчанию — тридцать дней днями, сегодня последним", async () => {
    const res = await api<AuditDaily>("/api/audit/daily", root.token);
    expect(res.status).toBe(200);
    expect(res.body.step).toBe("day");
    expect(res.body.buckets).toHaveLength(30);
    expect(res.body.buckets.at(-1)!.start).toBe(res.body.to);
  });

  test("отбор тот же, что у таблицы: неудачные входы одного человека — ровно его две строки", async () => {
    const email = `w11-daily-${crypto.randomUUID()}@test.dev`;
    const who = await makeUser("admin", email);
    await login(email, "wrong-1");
    await login(email, "wrong-2");
    await login(email);

    const failed = await api<AuditDaily>(`/api/audit/daily?action=auth.login_failed&actor=${who.id}`, root.token);
    expect(failed.body.buckets.reduce((s, b) => s + b.refused, 0)).toBe(2);
    expect(failed.body.buckets.reduce((s, b) => s + b.ok, 0)).toBe(0);

    const all = await api<AuditDaily>(`/api/audit/daily?actor=${who.id}`, root.token);
    const ok = all.body.buckets.reduce((s, b) => s + b.ok, 0);
    const refused = all.body.buckets.reduce((s, b) => s + b.refused, 0);
    const page = await api(`/api/audit?actor=${who.id}&limit=500`, root.token);
    expect(ok + refused).toBe(page.body.total);
    expect(refused).toBe(2);
  });

  test("шаг — по длине периода; перевёрнутый период пуст, а не вывернут", async () => {
    expect((await api<AuditDaily>("/api/audit/daily?from=2025-01-01&to=2026-09-26", root.token)).body.step).toBe("week");
    expect((await api<AuditDaily>("/api/audit/daily?from=2019-01-01&to=2026-09-26", root.token)).body.step).toBe("month");
    const reversed = await api<AuditDaily>("/api/audit/daily?from=2026-09-26&to=2026-09-01", root.token);
    expect(reversed.status).toBe(200);
    expect(reversed.body.buckets).toEqual([]);
  });

  test("чтение — в журнал (audit.read, view: daily), текст поиска — только фактом", async () => {
    const reader = await manager("audit.read");
    await api("/api/audit/daily?q=olena.teliha@example.com", reader.token);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "audit.read"), eq(auditLog.actorId, reader.id)))
      .limit(1);
    const details = row?.details as { view?: string; filters?: { text?: boolean } } | null;
    expect(details?.view).toBe("daily");
    expect(details?.filters?.text).toBe(true);
    expect(JSON.stringify(details)).not.toContain("olena.teliha");
  });
});

/* ═══════════ подозрительное и доступы ═══════════ */

describe("обзор подозрительного", () => {
  test("новое срабатывание — в своём правиле и в последнем дне; разбор переносит его в «розібрані»", async () => {
    const reader = await manager("audit.read");
    const statsOf = async () => (await api<{ stats: SuspiciousStats }>("/api/ops/people/suspicious?status=all", reader.token)).body.stats;
    const before = await statsOf();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(suspiciousFindings).values({
      id,
      rule: "failedLoginsIp",
      fingerprint: `w11-${id}`,
      ip: "10.1.2.3",
      windowFrom: now,
      windowTo: now,
      hits: 12,
    });
    const mid = await statsOf();
    const rule = (s: SuspiciousStats) => s.byRule.find((r) => r.rule === "failedLoginsIp") ?? { total: 0, open: 0 };
    expect(rule(mid).total).toBe(rule(before).total + 1);
    expect(rule(mid).open).toBe(rule(before).open + 1);
    expect(mid.byDay).toHaveLength(mid.days);
    expect(mid.byDay.at(-1)!.open).toBe(before.byDay.at(-1)!.open + 1);

    expect((await api(`/api/ops/people/suspicious/${id}/resolve`, reader.token, { method: "POST", body: JSON.stringify({ comment: "Проверено" }) })).status).toBe(200);
    const after = await statsOf();
    expect(rule(after).open).toBe(rule(before).open);
    expect(after.byDay.at(-1)!.resolved).toBe(before.byDay.at(-1)!.resolved + 1);
  });
});

describe("обзор временных доступов", () => {
  test("каждое исключение — в одном состоянии; выдачи этой недели — в последнем столбце", async () => {
    const mgr = await manager();
    const statsOf = async () => (await api<{ stats: GrantStats }>("/api/ops/people/grants", mgr.token)).body.stats;
    const before = await statsOf();
    const person = await makeUser("admin", `w11-grant-${crypto.randomUUID()}@test.dev`);
    const day = 86_400_000;
    const base = { userId: person.id, permission: "analytics.export", mode: "grant" as const, reason: "Проверка графиков", grantedBy: root.id };
    await db.insert(permissionExceptions).values([
      { ...base, id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3 * day).toISOString() },
      { ...base, id: crypto.randomUUID(), expiresAt: new Date(Date.now() - day).toISOString() },
      // отозванное с прошедшим сроком — отозванное, а не истёкшее
      { ...base, id: crypto.randomUUID(), expiresAt: new Date(Date.now() - day).toISOString(), revokedAt: new Date().toISOString() },
      { ...base, id: crypto.randomUUID() },
    ]);
    const after = await statsOf();
    expect(after.active).toBe(before.active + 1);
    expect(after.expired).toBe(before.expired + 1);
    expect(after.revoked).toBe(before.revoked + 1);
    // бессрочное — одно наше: исключение самого заведующего заведено раньше замера «до»
    expect(after.permanent).toBe(before.permanent + 1);
    expect(after.byWeek).toHaveLength(12);
    expect(after.byWeek.at(-1)!.count).toBe(before.byWeek.at(-1)!.count + 4);
  });
});
