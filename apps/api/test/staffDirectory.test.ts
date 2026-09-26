import { beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../src/db";
import { auditLog, departments, roles, specialistProfiles, staffRoles } from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";
import { api, makeUser, patient, root, type Person } from "./fixtures";

/**
 * Справочник сотрудников — `?directory=1` у GET /api/users и у
 * GET /api/permissions/staff.
 *
 * Решение заказчика 2026-09-26: в списке «Лікарі» — поиск по имени, телефону
 * и логину и сортировка по відділенням и посадам. Отсюда то, что сторожится
 * ниже, и каждое из этого на экране ломается молча:
 *
 *   — телефон приходит расшифрованным, а шифротекст наружу не уходит;
 *   — чтение с номерами пишется в журнал с пометкой `phones` (как список
 *     пациентов, docs/REWRITE-PLAN.md §14) — иначе «кто видел номера
 *     коллег» журнал не ответит;
 *   — відділення — из профиля приёма, на языке запроса;
 *   — реестр в этом режиме не отдаёт пациентов: прежде раздел качал их всех
 *     ради отбора в браузере;
 *   — флаг не расширяет круг людей: у заведующего — та же лестница;
 *   — без флага оба маршрута отвечают, как отвечали, и в журнал не пишут
 *     лишнего: экрану прав и экрану учётных записей номера не нужны.
 */

const phone = `+38067${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;
const departmentId = `dept-dir-${crypto.randomUUID()}`;
let doctor: Person;
let bare: Person;

/** Человек на ступени лестницы: одна роль, без встроенной — как в roleChain.test.ts */
async function onLadder(code: string): Promise<Person> {
  const who = await makeUser("admin", `dir-${code}-${crypto.randomUUID()}@test`);
  const [role] = await db.select().from(roles).where(eq(roles.code, code));
  await db.delete(staffRoles).where(eq(staffRoles.userId, who.id));
  await db.insert(staffRoles).values({ userId: who.id, roleId: role!.id, grantedBy: root.id });
  return who;
}

/** Последняя запись журнала этого человека с действием user.list */
async function lastList(actorId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorId, actorId), eq(auditLog.action, "user.list")))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  await db.insert(departments).values({ id: departmentId, title: { uk: "Психологічне відділення", ru: "Психологическое отделение" } });
  /* лікар с профилем приёма, номером и анкетой; профиль — ступенью «специалист» */
  doctor = await onLadder("specialist");
  const { users } = await import("../src/db/schema");
  await db.update(users).set({ phoneEnc: encryptField(phone), unit: "Штаб", position: "Лікар" }).where(eq(users.id, doctor.id));
  await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId, position: "Психолог" });
  /* и лікар без профиля и без номера — в справочнике пустые места, а не выдумка */
  bare = await onLadder("specialist");
});

describe("справочник у того, кому открыт реестр", () => {
  test("только сотрудники, с расшифрованным номером и відділенням на языке запроса", async () => {
    const res = await api("/api/users?directory=1", root.token, { headers: { "Accept-Language": "ru" } });
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string; role: string; phone: string | null; placement: unknown }[];

    expect(items.some((u) => u.id === patient.id), "пациент в справочнике сотрудников").toBe(false);
    expect(items.every((u) => u.role !== "user")).toBe(true);

    const d = items.find((u) => u.id === doctor.id);
    expect(d?.phone).toBe(phone);
    expect(d?.placement).toEqual({ department: "Психологическое отделение", position: "Психолог" });

    const b = items.find((u) => u.id === bare.id);
    expect(b?.phone).toBeNull();
    expect(b?.placement).toBeNull();
  });

  test("шифротекст номера наружу не уходит", async () => {
    const res = await api("/api/users?directory=1", root.token);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("phoneEnc");
    expect(text).not.toContain("phoneIndex");
    expect(text).toContain(phone);
  });

  test("чтение с номерами — в журнале с пометкой phones", async () => {
    await api("/api/users?directory=1", root.token);
    const entry = await lastList(root.id);
    expect(entry?.details).toMatchObject({ directory: true, phones: true });
  });

  test("без флага реестр прежний: с пациентами, без номеров и без пометки", async () => {
    const res = await api("/api/users", root.token);
    const items = res.body.items as { id: string; phone?: unknown }[];
    expect(items.some((u) => u.id === patient.id)).toBe(true);
    expect(items.every((u) => u.phone === undefined)).toBe(true);
    const entry = await lastList(root.id);
    expect((entry?.details as { phones?: boolean } | null)?.phones).toBeUndefined();
  });

  test("флаг не открывает реестр тому, у кого нет права на него", async () => {
    const head = await onLadder("head");
    const res = await api("/api/users?directory=1", head.token);
    expect(res.status).toBe(403);
  });
});

describe("справочник у заведующего", () => {
  test("та же лестница, с номером и відділенням", async () => {
    const head = await onLadder("head");
    const chief = await onLadder("chief");
    const res = await api("/api/permissions/staff?directory=1", head.token);
    expect(res.status).toBe(200);
    const items = res.body.items as { id: string; phone?: string | null; placement?: unknown; unit?: string | null; position?: string | null }[];

    const ids = items.map((u) => u.id);
    expect(ids, "специалиста заведующий видит").toContain(doctor.id);
    expect(ids, "главного врача — нет: флаг круг людей не расширяет").not.toContain(chief.id);
    expect(ids, "суперадмина — никогда").not.toContain(root.id);

    const d = items.find((u) => u.id === doctor.id);
    expect(d).toMatchObject({ phone, unit: "Штаб", position: "Лікар" });
    expect(d?.placement).toEqual({ department: "Психологічне відділення", position: "Психолог" });

    const entry = await lastList(head.id);
    expect(entry?.details).toMatchObject({ directory: true, assignable: true, phones: true });
  });

  test("анкеты в строке нет и в режиме справочника: пол и дата рождения заведующему не положены", async () => {
    const head = await onLadder("head");
    const res = await api("/api/permissions/staff?directory=1", head.token);
    const d = (res.body.items as Record<string, unknown>[]).find((u) => u.id === doctor.id)!;
    expect("sex" in d).toBe(false);
    expect("birthDate" in d).toBe(false);
  });

  test("без флага экран прав получает людей без номеров, и журнал молчит", async () => {
    const head = await onLadder("head");
    const res = await api("/api/permissions/staff", head.token);
    expect(res.status).toBe(200);
    const d = (res.body.items as { id: string; phone?: unknown; placement?: unknown; unit?: unknown }[]).find((u) => u.id === doctor.id);
    expect(d?.phone).toBeUndefined();
    expect(d?.placement).toBeUndefined();
    /* подразделение анкеты — рабочее сведение из той же строки, оно приходит и так */
    expect(d?.unit).toBe("Штаб");
    expect(await lastList(head.id)).toBeNull();
  });

  test("специалисту справочник закрыт, как и экран прав", async () => {
    const res = await api("/api/permissions/staff?directory=1", doctor.token);
    expect(res.status).toBe(403);
  });
});
