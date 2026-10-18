import { beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  auditLog,
  consents,
  permissionExceptions,
  roles,
  staffRoles,
  userSecondFactor,
  users,
} from "../src/db/schema";
import { api, makeUser, root, type Person } from "./fixtures";

/**
 * Раздел «Адміністрування» Polypsy 2.0 (участок v2-admin): что сервер
 * добавил реестру людей, карточке фахівця, экрану согласия и описанию API.
 *
 *   — справочник сотрудников отдаёт учётную запись каждого: вход, второй
 *     фактор, роли, исключения и сколько пациентов человек ведёт — числом,
 *     без самих пациентов;
 *   — список пациентов сужается до тех, кого ведёт названный сотрудник,
 *     не выходя из зоны смотрящего;
 *   — передача пациентов другому лікарю: переходит закрепление, причина —
 *     в журнал по каждому, чужое закрепление не перетирается, передать можно
 *     только действующему лікарю;
 *   — версии согласия — только числа, только суперадмину;
 *   — описание API говорит машинно, кому маршрут открыт.
 *
 * Данные уникальны на прогон: общая база у всех файлов процесса.
 */

const tag = crypto.randomUUID().slice(0, 8);
let from: Person;
let to: Person;
let other: Person;
const led: Person[] = [];

/** Сотрудник на ступени лестницы: одна роль-шаблон поверх встроенной */
async function staffOn(code: string, name: string): Promise<Person> {
  const who = await makeUser("admin", `adm-${name}-${tag}@test`);
  const [role] = await db.select().from(roles).where(eq(roles.code, code));
  await db.insert(staffRoles).values({ userId: who.id, roleId: role!.id, grantedBy: root.id }).onConflictDoNothing();
  return who;
}

beforeAll(async () => {
  from = await staffOn("specialist", "from");
  to = await staffOn("specialist", "to");
  other = await staffOn("specialist", "other");
  for (let i = 0; i < 3; i++) {
    led.push(await makeUser("user", `adm-pt${i}-${tag}@test`, { leadSpecialistId: from.id }));
  }
  /* второй фактор и личное исключение у «from» — реестр обязан их показать */
  await db.insert(userSecondFactor).values({ userId: from.id, secretEnc: "x", confirmedAt: new Date().toISOString() });
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: from.id,
    permission: "alerts.review",
    mode: "grant",
    reason: "чергування на вихідних",
    grantedBy: root.id,
  });
});

describe("справочник сотрудников: учётная запись каждого", () => {
  test("реестр суперадмина: пациенты числом, второй фактор, роли, ступень, исключения", async () => {
    const res = await api("/api/users?directory=1", root.token);
    expect(res.status).toBe(200);
    const row = (res.body.items as { id: string; account?: Record<string, unknown> }[]).find((u) => u.id === from.id);
    expect(row?.account).toMatchObject({ mfa: true, patients: 3, exceptions: 1, ladderRank: 1, disabledAt: null });
    const codes = (row?.account?.roles as { code: string }[]).map((r) => r.code);
    expect(codes).toContain("specialist");
    /* о пациентах — только число: ни имён, ни идентификаторов */
    expect(JSON.stringify(row)).not.toContain(led[0]!.id);
    const sup = (res.body.items as { id: string; account?: { ladderRank: number } }[]).find((u) => u.id === root.id);
    expect(sup?.account?.ladderRank).toBeGreaterThan(3);
  });

  test("справочник заведующего отдаёт ту же учётную запись", async () => {
    const head = await staffOn("head", "head");
    const res = await api("/api/permissions/staff?directory=1", head.token);
    expect(res.status).toBe(200);
    const row = (res.body.items as { id: string; account?: { patients: number; mfa: boolean } }[]).find((u) => u.id === from.id);
    expect(row?.account).toMatchObject({ patients: 3, mfa: true });
  });

  test("без флага справочника учётной записи нет", async () => {
    const head = await staffOn("head", "head2");
    const res = await api("/api/permissions/staff", head.token);
    const row = (res.body.items as { id: string; account?: unknown }[]).find((u) => u.id === from.id);
    expect(row).toBeDefined();
    expect(row?.account).toBeUndefined();
  });
});

describe("пациенты сотрудника", () => {
  test("?lead= — только те, кого он ведёт", async () => {
    const res = await api(`/api/patients?lead=${from.id}&limit=200`, root.token);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: string; leadSpecialistId: string | null }[]).map((p) => p.id);
    expect(ids.sort()).toEqual(led.map((p) => p.id).sort());
    expect(res.body.total).toBe(3);
  });
});

describe("передача пациентов другому лікарю", () => {
  const url = () => `/api/users/${from.id}/patients/transfer`;
  const reason = "Перерозподіл: лікар іде у відпустку";

  test("без права на реестр — отказ", async () => {
    const res = await api(url(), from.token, {
      method: "POST",
      body: JSON.stringify({ patientIds: [led[0]!.id], to: to.id, reason }),
    });
    expect(res.status).toBe(403);
  });

  test("причина короче 10 знаков — отказ, ничего не перешло", async () => {
    const res = await api(url(), root.token, {
      method: "POST",
      body: JSON.stringify({ patientIds: [led[0]!.id], to: to.id, reason: "коротко" }),
    });
    expect(res.status).toBe(400);
    const [p] = await db.select({ lead: users.leadSpecialistId }).from(users).where(eq(users.id, led[0]!.id));
    expect(p?.lead).toBe(from.id);
  });

  test("себе, суперадмину и выключенному — нельзя", async () => {
    const off = await staffOn("specialist", "off");
    await db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, off.id));
    for (const target of [from.id, root.id, off.id]) {
      const res = await api(url(), root.token, {
        method: "POST",
        body: JSON.stringify({ patientIds: [led[0]!.id], to: target, reason }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("чужого пациента не перетирает: отказ целиком", async () => {
    const foreign = await makeUser("user", `adm-foreign-${tag}@test`, { leadSpecialistId: other.id });
    const res = await api(url(), root.token, {
      method: "POST",
      body: JSON.stringify({ patientIds: [led[0]!.id, foreign.id], to: to.id, reason }),
    });
    expect(res.status).toBe(409);
    const rows = await db.select({ id: users.id, lead: users.leadSpecialistId }).from(users).where(
      sql`${users.id} in ${[led[0]!.id, foreign.id]}`,
    );
    expect(rows.find((r) => r.id === led[0]!.id)?.lead).toBe(from.id);
    expect(rows.find((r) => r.id === foreign.id)?.lead).toBe(other.id);
  });

  test("переходит закрепление, причина — в журнал по каждому", async () => {
    const moving = [led[0]!.id, led[1]!.id];
    const res = await api(url(), root.token, {
      method: "POST",
      body: JSON.stringify({ patientIds: moving, to: to.id, reason }),
    });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(2);
    for (const id of moving) {
      const [p] = await db.select({ lead: users.leadSpecialistId }).from(users).where(eq(users.id, id));
      expect(p?.lead).toBe(to.id);
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "clinic.lead_transfer"), eq(auditLog.subjectUserId, id)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(entry?.actorId).toBe(root.id);
      expect(entry?.details).toMatchObject({ from: from.id, to: to.id, reason });
    }
    /* оставшийся — у прежнего лікаря, и реестр считает заново */
    const dir = await api("/api/users?directory=1", root.token);
    const count = (id: string) =>
      (dir.body.items as { id: string; account?: { patients: number } }[]).find((u) => u.id === id)?.account?.patients;
    expect(count(from.id)).toBe(1);
    expect(count(to.id)).toBe(2);
  });
});

describe("заведение сотрудника с анкетой", () => {
  test("пол, дата рождения, подразделение, должность, специализация и населённый пункт сохраняются; дата — шифром", async () => {
    const email = `adm-new-${tag}@test.dev`;
    const res = await api("/api/users", root.token, {
      method: "POST",
      body: JSON.stringify({
        email,
        password: "temp-pass-1234",
        firstName: "Ольга",
        lastName: "Харченко",
        middleName: null,
        role: "admin",
        mustChangePassword: true,
        sex: "female",
        birthDate: "1991-11-22",
        unit: "Психологічне відділення",
        position: "дитяча психологиня",
        specialty: "Ігрова терапія",
        locality: "Житомир",
      }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ sex: "female", birthDate: "1991-11-22", specialty: "Ігрова терапія", mustChangePassword: true });
    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row?.locality).toBe("Житомир");
    expect(row?.unit).toBe("Психологічне відділення");
    /* дата рождения в базе — не открытым текстом */
    expect(row?.birthDate).not.toBe("1991-11-22");
  });

  test("кривая дата рождения — отказ, записи нет", async () => {
    const email = `adm-bad-${tag}@test.dev`;
    const res = await api("/api/users", root.token, {
      method: "POST",
      body: JSON.stringify({ email, password: "temp-pass-1234", firstName: "А", lastName: "Б", role: "admin", birthDate: "22.11.1991" }),
    });
    expect(res.status).toBe(400);
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(0);
  });
});

describe("версии текста согласия", () => {
  test("только суперадмину", async () => {
    const res = await api("/api/consents/versions", from.token);
    expect(res.status).toBe(403);
  });

  test("числа сходятся с базой; свежая версия первой", async () => {
    const res = await api("/api/consents/versions", root.token);
    expect(res.status).toBe(200);
    const body = res.body as { patients: number; declined: number; versions: { id: string; version: number; accepted: number; languages: string[] }[] };
    expect(body.patients).toBeGreaterThan(0);
    expect(body.declined).toBeGreaterThanOrEqual(0);
    const versions = body.versions.map((v) => v.version);
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
    for (const v of body.versions) {
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(consents)
        .innerJoin(users, eq(users.id, consents.userId))
        .where(and(eq(consents.consentTextId, v.id), eq(users.role, "user")));
      expect(v.accepted).toBe(Number(n));
      expect(v.languages).toContain("uk");
    }
    /* ни одного имени пациента в ответе */
    expect(JSON.stringify(body)).not.toContain("@test");
  });
});

describe("описание API говорит, кому маршрут открыт", () => {
  test("x-access и x-permission у операций", async () => {
    const res = await api("/api/openapi.json", root.token);
    expect(res.status).toBe(200);
    const users = res.body.paths["/api/users"].get;
    expect(users["x-access"]).toBe("superadmin");
    expect(users["x-permission"]).toBe("users.manage");
    const login = res.body.paths["/api/auth/login"].post;
    expect(login["x-access"]).toBe("public");
    expect(login["x-permission"]).toBeNull();
  });
});
