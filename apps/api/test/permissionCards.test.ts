import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { auditLog, permissionExceptions, roles, staffRoles } from "../src/db/schema";
import { ladderRankOf, ladderRanksOf, permissionsOf, permissionsOfMany } from "../src/lib/permissions";
import { requestSql } from "../src/lib/opsSql";
import { CARDS_MAX } from "../src/routes/permissions";
import { api, appApi, db, makeUser, root, type Person } from "./fixtures";

/**
 * Карточки прав пачкой — GET /api/permissions/cards (волна 27).
 *
 * «Що може кожен» на экране «Адміністратори» спрашивал карточку каждого
 * администратора отдельным запросом. Пачка обязана быть ровно теми же
 * карточками по тому же правилу видимости: кого одиночный маршрут отдаёт,
 * того пачка кладёт в ответ, кому отказывает — того в ответе нет. Иначе
 * матрица показала бы права того, чью карточку смотрящему не открывают, —
 * подсказку, что именно у старшего отнять.
 */

const ladder = new Map<string, string>();
beforeAll(async () => {
  for (const r of await db.select().from(roles).where(inArray(roles.code, ["specialist", "head", "chief", "psychologist"]))) {
    ladder.set(r.code, r.id);
  }
});

/** Администратор на ступени: встроенная роль снята, стоит ровно одна должность */
async function on(code: "specialist" | "head" | "chief"): Promise<Person> {
  const who = await makeUser("admin", `pc-${code}-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, who.id));
  await db.insert(staffRoles).values({ userId: who.id, roleId: ladder.get(code)!, grantedBy: root.id });
  return who;
}

type Card = { userId: string; role: string; roles: { code: string }[]; exceptions: { id: string }[]; effective: string[] };

/** Карточка в сравнимом виде: роли и итог — множествами, порядок строк базы не договор */
const comparable = (c: Card) => ({
  ...c,
  roles: [...c.roles].sort((a, b) => a.code.localeCompare(b.code)),
  effective: [...c.effective].sort(),
});

const cards = (ids: string[], token: string) => api<{ items: Card[] }>(`/api/permissions/cards?ids=${ids.join(",")}`, token);

describe("пачка — те же карточки, что поодиночке", () => {
  test("суперадмину: каждая карточка пачки равна одиночной", async () => {
    const head = await on("head");
    const specialist = await on("specialist");
    const plain = await makeUser("admin", `pc-plain-${crypto.randomUUID()}@test`);
    // исключения: выданное, отнятое, истёкшее и отозванное — итог считает только действующие
    const now = Date.now();
    await db.insert(permissionExceptions).values([
      { id: crypto.randomUUID(), userId: head.id, permission: "audit.read", mode: "grant", reason: "разбор обходов правил", grantedBy: root.id },
      { id: crypto.randomUUID(), userId: head.id, permission: "console.use", mode: "revoke", reason: "консоль не нужна", grantedBy: root.id },
      {
        id: crypto.randomUUID(),
        userId: specialist.id,
        permission: "users.manage",
        mode: "grant",
        reason: "срок вышел вчера",
        grantedBy: root.id,
        expiresAt: new Date(now - 86_400_000).toISOString(),
      },
      {
        id: crypto.randomUUID(),
        userId: specialist.id,
        permission: "ops.read",
        mode: "grant",
        reason: "уже отозвано",
        grantedBy: root.id,
        revokedAt: new Date(now - 1000).toISOString(),
      },
    ]);

    const ids = [head.id, specialist.id, plain.id, root.id];
    const batch = await cards(ids, root.token);
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect(batch.body.items.map((c) => c.userId), "порядок — порядок вопроса").toEqual(ids);
    for (const id of ids) {
      const single = await api<Card>(`/api/permissions/users/${id}`, root.token);
      expect(single.status).toBe(200);
      expect(comparable(batch.body.items.find((c) => c.userId === id)!)).toEqual(comparable(single.body));
    }
    const headCard = batch.body.items[0]!;
    expect(headCard.effective).toContain("audit.read");
    expect(headCard.effective).not.toContain("console.use");
    expect(headCard.exceptions.length).toBe(2);
  });

  test("видимость — ровно как у одиночной: свою и ниже своей ступени; старших, равных, суперадмина и несуществующих — нет", async () => {
    const chief = await on("chief");
    const otherChief = await on("chief");
    const head = await on("head");
    const specialist = await on("specialist");
    const plain = await makeUser("admin", `pc-plain-${crypto.randomUUID()}@test`);
    const patient = await makeUser("user", `pc-pt-${crypto.randomUUID()}@test`);
    const ghost = crypto.randomUUID();
    const everyone = [chief.id, otherChief.id, head.id, specialist.id, plain.id, patient.id, root.id, ghost];

    for (const viewer of [chief, head, specialist, plain]) {
      const batch = await cards(everyone, viewer.token);
      expect(batch.status).toBe(200);
      const got = new Set(batch.body.items.map((c) => c.userId));
      for (const id of everyone) {
        const single = await api(`/api/permissions/users/${id}`, viewer.token);
        expect(got.has(id), `смотрящий ${viewer.id}, карточка ${id}: одиночная ответила ${single.status}`).toBe(single.status === 200);
      }
    }
    // и само правило — на деле, а не только «совпадает»
    const byChief = new Set((await cards(everyone, chief.token)).body.items.map((c) => c.userId));
    expect(byChief).toEqual(new Set([chief.id, head.id, specialist.id, plain.id, patient.id]));
    const byPlain = new Set((await cards(everyone, plain.token)).body.items.map((c) => c.userId));
    expect(byPlain).toEqual(new Set([plain.id]));
  });

  test("пациенту пачка закрыта, как и одиночная", async () => {
    const patient = await makeUser("user", `pc-pt-${crypto.randomUUID()}@test`);
    expect((await cards([patient.id], patient.token)).status).toBe(403);
    expect((await api(`/api/permissions/users/${patient.id}`, patient.token)).status).toBe(403);
  });

  test("пустой, слишком длинный и кривой список — отказ разбора", async () => {
    expect((await api("/api/permissions/cards", root.token)).status).toBe(400);
    expect((await api("/api/permissions/cards?ids=", root.token)).status).toBe(400);
    expect((await api("/api/permissions/cards?ids=a%20b", root.token)).status).toBe(400);
    const tooMany = Array.from({ length: CARDS_MAX + 1 }, () => crypto.randomUUID());
    expect((await cards(tooMany, root.token)).status).toBe(400);
    // повторы схлопываются: сто одинаковых — одна карточка
    const same = await cards(Array.from({ length: CARDS_MAX + 1 }, () => root.id), root.token);
    expect(same.status).toBe(200);
    expect(same.body.items.length).toBe(1);
  });
});

describe("пачка дешевле поштучного", () => {
  test("число запросов к базе не растёт с числом карточек", async () => {
    const few = [await on("head"), await on("specialist")];
    const many = [...few];
    for (let i = 0; i < 10; i++) many.push(await on(i % 2 ? "head" : "specialist"));
    const sqlOf = async (ids: string[]) => {
      const requestId = `pc-${crypto.randomUUID()}`;
      const res = await api(`/api/permissions/cards?ids=${ids.join(",")}`, root.token, { headers: { "x-request-id": requestId } });
      expect(res.status).toBe(200);
      return requestSql(requestId)?.count ?? 0;
    };
    await sqlOf(few.map((p) => p.id));
    const a = await sqlOf(few.map((p) => p.id));
    const b = await sqlOf(many.map((p) => p.id));
    expect(a).toBeGreaterThan(0);
    // поштучно двенадцать карточек — двенадцать запросов по нескольку обращений; пачкой — те же несколько
    expect(b - a, `запросов: ${a} на 2 карточки, ${b} на 12`).toBeLessThan(3);
  });

  test("в журнал не пишет — как и одиночная карточка", async () => {
    const viewer = await on("chief");
    const target = await on("specialist");
    const rows = async () =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.actorId, viewer.id)))[0]!.n;
    const before = await rows();
    await api(`/api/permissions/users/${target.id}`, viewer.token);
    const afterSingle = await rows();
    await cards([target.id, viewer.id], viewer.token);
    expect(afterSingle - before, "одиночная карточка писала в журнал").toBe(0);
    expect((await rows()) - afterSingle, "пачка пишет в журнал").toBe(0);
  });
});

describe("правила пачкой — те же, что поодиночке", () => {
  test("permissionsOfMany и ladderRanksOf совпадают с permissionsOf и ladderRankOf", async () => {
    const head = await on("head");
    const chief = await on("chief");
    const plain = await makeUser("admin", `pc-plain-${crypto.randomUUID()}@test`);
    const bare = await makeUser("admin", `pc-bare-${crypto.randomUUID()}@test`);
    await db.delete(staffRoles).where(eq(staffRoles.userId, bare.id));
    // пациент с ролью сотрудника — прав у него нет всё равно (#142)
    const patient = await makeUser("user", `pc-pt-${crypto.randomUUID()}@test`);
    await db.insert(staffRoles).values({ userId: patient.id, roleId: ladder.get("head")!, grantedBy: root.id });
    await db.insert(permissionExceptions).values([
      { id: crypto.randomUUID(), userId: plain.id, permission: "audit.read", mode: "grant", reason: "разбор обходов правил", grantedBy: root.id },
      { id: crypto.randomUUID(), userId: chief.id, permission: "users.manage", mode: "revoke", reason: "учётки ведёт техслужба", grantedBy: root.id },
      { id: crypto.randomUUID(), userId: patient.id, permission: "ops.read", mode: "grant", reason: "не должно сработать", grantedBy: root.id },
    ]);
    const people = [
      { id: root.id, role: "superadmin" as const },
      { id: head.id, role: "admin" as const },
      { id: chief.id, role: "admin" as const },
      { id: plain.id, role: "admin" as const },
      { id: bare.id, role: "admin" as const },
      { id: patient.id, role: "user" as const },
    ];
    const perms = await permissionsOfMany(people);
    const ranks = await ladderRanksOf(people);
    for (const p of people) {
      expect([...perms.get(p.id)!].sort(), `права ${p.role} ${p.id}`).toEqual([...(await permissionsOf(p as never))].sort());
      expect(ranks.get(p.id), `ступень ${p.role} ${p.id}`).toBe(await ladderRankOf(p as never));
    }
    expect(perms.get(patient.id)!.size).toBe(0);
    expect(perms.get(plain.id)!.has("audit.read")).toBe(true);
    expect(perms.get(chief.id)!.has("users.manage")).toBe(false);
  });
});

describe("под боевой ролью", () => {
  test("пачка отдаёт те же карточки, что владельцу базы", async () => {
    const chief = await on("chief");
    const head = await on("head");
    const specialist = await on("specialist");
    const ids = [head.id, specialist.id, chief.id, root.id];
    const owner = await cards(ids, chief.token);
    const appRole = await appApi<{ items: Card[] }>(`/api/permissions/cards?ids=${ids.join(",")}`, chief.token);
    expect(appRole.status, JSON.stringify(appRole.body)).toBe(200);
    expect(appRole.body.items.map(comparable)).toEqual(owner.body.items.map(comparable));
    expect(appRole.body.items.map((c) => c.userId)).toEqual([head.id, specialist.id, chief.id]);
    expect(appRole.body.items[0]!.effective.length).toBeGreaterThan(0);
  });
});
