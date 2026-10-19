import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { consentTexts, consents } from "../src/db/schema";
import { api, appApi, db, makeUser, root, type Person } from "./fixtures";

/**
 * «Відмовилися» на экране версий согласия (GET /api/consents/versions) —
 * волна 27.
 *
 * Число — пациенты с отказом по действующей редакции, которые её так и не
 * приняли. Прежде запрос сводил к людям каждую строку отказа: проверял
 * согласие отдельно для каждой строки журнала и сортировал их по правилам
 * языка. Теперь сначала люди, потом проверка — один раз на человека. Здесь
 * проверяется, что число осталось тем же: повторный отказ не считается
 * дважды, принявший после отказа не считается, отказ по прежней редакции —
 * тоже, а строка отказа без человека — не человек.
 *
 * Текст согласия общий на всю базу: после файла его не остаётся (как в
 * consentRequiredCode.test.ts). Строка посева без человека — вне цепочки и
 * уходит в afterAll.
 */

const TAG = `w27dec${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
  try {
    await db.execute(sql`delete from audit_log where id like ${`${TAG}-%`}`);
  } finally {
    await db.execute(sql`alter table audit_log enable trigger audit_log_immutable`);
  }
  await db.delete(consents);
  await db.delete(consentTexts);
});

async function publish(): Promise<void> {
  const res = await api("/api/consents/text", root.token, {
    method: "PUT",
    body: JSON.stringify({ body: { uk: `Згода, редакція ${TAG} ${crypto.randomUUID()}`, ru: `Согласие ${TAG}` } }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const decline = (p: Person) => api("/api/consents/me/decline", p.token, { method: "POST" });

async function accept(p: Person): Promise<void> {
  const status = await api("/api/consents/me", p.token);
  const res = await api("/api/consents/me/accept", p.token, { method: "POST", body: JSON.stringify({ textId: status.body.textId }) });
  expect(res.status).toBe(200);
}

/** Прежний запрос маршрута — эталон, с которым сверяется новый */
async function referenceDeclined(textId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(distinct a.subject_user_id)::int as n
      from audit_log a
     where a.action = 'consent.decline' and a.resource_id = ${textId}
       and not exists (select 1 from consents k where k.user_id = a.subject_user_id and k.consent_text_id = ${textId})`);
  return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
}

describe("«відмовилися» по действующей редакции", () => {
  test("люди, а не строки отказа: повторный не дважды, принявший и отказ по прежней — мимо", async () => {
    const person = (n: string) => makeUser("user", `${TAG}-${n}@test.dev`);
    const old = await person("old");
    await publish();
    expect((await decline(old)).status).toBe(200);

    await publish();
    const twice = await person("twice");
    const changedMind = await person("changed");
    const agreed = await person("agreed");
    const once = await person("once");
    await decline(twice);
    await decline(twice);
    await decline(changedMind);
    await accept(changedMind);
    await accept(agreed);
    await decline(once);

    const [current] = await db.select().from(consentTexts).orderBy(sql`${consentTexts.version} desc`).limit(1);
    // строка отказа без человека (журнал старше поля subject) — не человек
    await db.execute(sql`
      insert into audit_log (id, at, actor_role, action, resource_type, resource_id, outcome, details)
      values (${`${TAG}-nobody`}, now(), 'user', 'consent.decline', 'consent_text', ${current!.id}, 'success', '{}'::jsonb)`);

    const res = await api<{ declined: number; patients: number }>("/api/consents/versions", root.token);
    expect(res.status).toBe(200);
    expect(res.body.declined).toBe(2);
    expect(res.body.declined).toBe(await referenceDeclined(current!.id));

    // под боевой ролью — то же число
    const asApp = await appApi<{ declined: number }>("/api/consents/versions", root.token);
    expect(asApp.status).toBe(200);
    expect(asApp.body.declined).toBe(2);
  }, 30_000);
});
