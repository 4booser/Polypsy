import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { MfaPolicyView, OpsUserPage, OpsUsersAttention, Permission } from "@quizzy/shared";
import { permissionExceptions, roles, staffRoles } from "../src/db/schema";
import { permissionsOf, permissionsOfMany } from "../src/lib/permissions";
import { requestSql } from "../src/lib/opsSql";
import { invalidatePolicy, writePolicy } from "../src/lib/secondFactor";
import { api, db, makeUser, root, type Person } from "./fixtures";

/**
 * Права списком (волна 27, perf-day).
 *
 * Реестр учёток техпанели, «Потребує уваги» и покрытие второго фактора
 * спрашивали права каждого сотрудника отдельно — permissionsOf на строку,
 * два запроса на человека. Теперь — permissionsOfMany, два запроса на весь
 * список. Правило обязано остаться тем же: сверка с permissionsOf на одних и
 * тех же людях, со всеми видами исключений.
 *
 * Счёт SQL сравнивается не с числом, а сам с собой: страница с втрое
 * бо́льшим числом сотрудников обязана стоить столько же запросов.
 */

const TAG = `pmany${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;

/** Сотрудник с исключениями: [право, вид, срок (часы от сейчас; < 0 — истёк), отозвано] */
async function staff(
  exceptions: [Permission, "grant" | "revoke", number?, boolean?][] = [],
  opts: { noRoles?: boolean } = {},
): Promise<Person & { email: string }> {
  const email = `${TAG}-${++seq}@test`;
  const person = await makeUser("admin", email);
  if (opts.noRoles) await db.delete(staffRoles).where(eq(staffRoles.userId, person.id));
  for (const [permission, mode, hours, revoked] of exceptions) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: person.id,
      permission,
      mode,
      reason: "Проверка прав списком",
      grantedBy: root.id,
      expiresAt: hours === undefined ? null : new Date(Date.now() + hours * 3_600_000).toISOString(),
      revokedAt: revoked ? new Date().toISOString() : null,
    });
  }
  return { ...person, email };
}

/* политика — общее состояние процесса и базы: оставленное включённым заперло бы суперадминов следующих файлов */
afterAll(async () => {
  await writePolicy({ superadmins: false, ops: false }, root.id);
  invalidatePolicy();
});

describe("permissionsOfMany", () => {
  test("то же, что permissionsOf по каждому: роли, выдачи, отъёмы, сроки, отзыв, класс учётки", async () => {
    const [head] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "head"));
    const people = [
      { id: root.id, role: "superadmin" as const },
      await staff(),
      await staff([["ops.read", "grant"]]),
      await staff([["patients.read", "revoke"]]),
      // и выдано, и отнято одно право — отнятое побеждает
      await staff([
        ["ops.manage", "grant"],
        ["ops.manage", "revoke"],
      ]),
      await staff([["ops.manage", "grant", -2]]),
      await staff([["ops.read", "grant", 24]]),
      await staff([["ops.read", "grant", undefined, true]]),
      await staff([["audit.read", "grant"]], { noRoles: true }),
    ];
    // вторая роль у одного: права ролей складываются
    await db.insert(staffRoles).values({ userId: people[1]!.id, roleId: head!.id, grantedBy: root.id });
    // пациент со следами прав сотрудника — прав нет (#142)
    const patient = await makeUser("user", `${TAG}-patient@test`);
    await db.insert(staffRoles).values({ userId: patient.id, roleId: head!.id, grantedBy: root.id });
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: patient.id,
      permission: "ops.read",
      mode: "grant",
      reason: "Следы прав у пациента",
      grantedBy: root.id,
    });

    const list = [
      ...people.map((p) => ({ id: p.id, role: "role" in p ? p.role : ("admin" as const) })),
      { id: patient.id, role: "user" as const },
    ];
    const many = await permissionsOfMany(list);
    expect(many.size).toBe(list.length);
    for (const p of list) {
      const one = await permissionsOf({ id: p.id, role: p.role } as never);
      expect([...many.get(p.id)!].sort(), `${p.role} ${p.id}`).toEqual([...one].sort());
    }
    // и смысл, а не только совпадение: проверяемые случаи действительно разные
    expect(many.get(people[2]!.id)!.has("ops.read")).toBe(true);
    expect(many.get(people[3]!.id)!.has("patients.read")).toBe(false);
    expect(many.get(people[4]!.id)!.has("ops.manage")).toBe(false);
    expect(many.get(people[5]!.id)!.has("ops.manage")).toBe(false);
    expect(many.get(people[6]!.id)!.has("ops.read")).toBe(true);
    expect(many.get(people[7]!.id)!.has("ops.read")).toBe(false);
    expect([...many.get(people[8]!.id)!]).toEqual(["audit.read"]);
    expect(many.get(patient.id)!.size).toBe(0);
  });

  test("пустой список — без запросов к базе", async () => {
    expect((await permissionsOfMany([])).size).toBe(0);
  });
});

/** Ответ и счёт SQL запроса */
async function counted<T>(path: string, who: Person): Promise<{ status: number; body: T; sql: number }> {
  const requestId = crypto.randomUUID();
  const res = await api<T>(path, who.token, { headers: { "x-request-id": requestId } });
  return { status: res.status, body: res.body, sql: requestSql(requestId)?.count ?? 0 };
}

describe("реестр, «Потребує уваги» и покрытие: права одним заходом", () => {
  test("при политике для ops.* счёт SQL не растёт со строками, а «потрібен» — как прежде", async () => {
    // ведёт учётки, но сам ops.* не держит — требование политики его не задевает
    const manager = await staff([["users.manage", "grant"]]);
    const holders = [await staff([["ops.read", "grant"]]), await staff([["ops.manage", "grant"]])];
    const plain = [await staff(), await staff([["ops.read", "grant", -1]])];

    await writePolicy({ superadmins: false, ops: true }, root.id);
    try {
      const page = `/api/ops/users?role=staff&per=100&q=${TAG}`;
      // разогрев: первый запрос после смены политики читает её из базы (кэш на десять секунд)
      await counted<OpsUserPage>(page, manager);
      const small = await counted<OpsUserPage>(page, manager);
      expect(small.status, JSON.stringify(small.body)).toBe(200);
      const required = new Map(small.body.items.map((r) => [r.id, r.secondFactor?.required ?? null]));
      for (const h of holders) expect(required.get(h.id), "держатель ops.* — «потрібен»").toBe("ops");
      for (const p of plain) expect(required.get(p.id), "без ops.* — не нужен").toBeNull();
      expect(required.get(manager.id)).toBeNull();
      const attentionBefore = await counted<OpsUsersAttention>("/api/ops/users/attention", manager);
      expect(attentionBefore.status).toBe(200);

      // втрое больше сотрудников той же выборки, половина — держатели ops.*
      const more: Person[] = [];
      for (let i = 0; i < 12; i++) more.push(await staff(i % 2 ? [["ops.read", "grant"]] : []));

      const large = await counted<OpsUserPage>(page, manager);
      expect(large.status).toBe(200);
      expect(large.body.items.length).toBe(small.body.items.length + 12);
      expect(large.sql, "страница с бо́льшим числом сотрудников — те же запросы").toBe(small.sql);
      const mfaOf = new Map(large.body.items.map((r) => [r.id, r.secondFactor?.required ?? null]));
      more.forEach((p, i) => expect(mfaOf.get(p.id)).toBe(i % 2 ? "ops" : null));

      const attentionAfter = await counted<OpsUsersAttention>("/api/ops/users/attention", manager);
      expect(attentionAfter.status).toBe(200);
      expect(attentionAfter.sql, "«Потребує уваги» — те же запросы").toBe(attentionBefore.sql);
      expect(attentionAfter.body.mfaMissing.count).toBe(attentionBefore.body.mfaMissing.count + 6);
    } finally {
      await writePolicy({ superadmins: false, ops: false }, root.id);
    }
  }, 60_000);

  test("покрытие второго фактора: держатели ops.* — все, счёт SQL от числа сотрудников не зависит", async () => {
    await counted<MfaPolicyView>("/api/ops/people/mfa", root);
    const before = await counted<MfaPolicyView>("/api/ops/people/mfa", root);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const fresh = [await staff([["ops.read", "grant"]]), await staff(), await staff([["ops.manage", "grant"]])];
    const after = await counted<MfaPolicyView>("/api/ops/people/mfa", root);
    expect(after.status).toBe(200);
    expect(after.sql).toBe(before.sql);
    const covered = new Set(after.body.coverage.map((r) => r.id));
    expect(covered.has(fresh[0]!.id)).toBe(true);
    expect(covered.has(fresh[1]!.id)).toBe(false);
    expect(covered.has(fresh[2]!.id)).toBe(true);
    expect(after.body.coverage.find((r) => r.id === fresh[0]!.id)?.because).toBe("ops");
  }, 60_000);
});
