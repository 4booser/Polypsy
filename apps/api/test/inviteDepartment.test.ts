import { beforeAll, describe, expect, test } from "bun:test";
import { appApi, db, makeUser, root, type Person } from "./fixtures";
import { departments, specialistProfiles } from "../src/db/schema";

/**
 * Приглашение без набора и без методики — отделения выписавшего (#51).
 *
 * Прежде у такого приглашения не было области: его видел и гасил любой
 * сотрудник с invites.manage, включая выписанное суперадмином. Под ролью
 * приложения, как в бою.
 */
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

let issuer: Person;
let colleague: Person;
let stranger: Person;

beforeAll(async () => {
  const [d1, d2] = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(departments).values([
    { id: d1, title: { uk: "Відділення А", ru: "Отделение А" }, timezone: "Europe/Kyiv" },
    { id: d2, title: { uk: "Відділення Б", ru: "Отделение Б" }, timezone: "Europe/Kyiv" },
  ]);
  const tag = crypto.randomUUID().slice(0, 8);
  issuer = await makeUser("admin", `inv-dep-issuer-${tag}@test`);
  colleague = await makeUser("admin", `inv-dep-colleague-${tag}@test`);
  stranger = await makeUser("admin", `inv-dep-stranger-${tag}@test`);
  await db.insert(specialistProfiles).values([
    { userId: issuer.id, departmentId: d1 },
    { userId: colleague.id, departmentId: d1 },
    { userId: stranger.id, departmentId: d2 },
  ]);
});

async function listed(person: Person, id: string): Promise<boolean> {
  const res = await appApi("/api/invites?limit=100", person.token);
  expect(res.status).toBe(200);
  return (res.body.items as { id: string }[]).some((i) => i.id === id);
}

async function unscopedInvite(by: Person): Promise<string> {
  const res = await appApi("/api/invites", by.token, post({}));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe("приглашение без набора и методики", () => {
  test("видят выписавший, его отделение и суперадмин; чужое отделение — нет", async () => {
    const id = await unscopedInvite(issuer);
    expect(await listed(issuer, id)).toBe(true);
    expect(await listed(colleague, id)).toBe(true);
    expect(await listed(root, id)).toBe(true);
    expect(await listed(stranger, id)).toBe(false);
  });

  test("отозвать его из чужого отделения нельзя, из своего — можно", async () => {
    const id = await unscopedInvite(issuer);
    const denied = await appApi(`/api/invites/${id}/revoke`, stranger.token, post({}));
    expect(denied.status).toBe(403);
    const ok = await appApi(`/api/invites/${id}/revoke`, colleague.token, post({}));
    expect(ok.status).toBe(200);
  });

  test("выписанное суперадмином без отделения — только суперадмину", async () => {
    const id = await unscopedInvite(root);
    expect(await listed(issuer, id)).toBe(false);
    expect((await appApi(`/api/invites/${id}/revoke`, issuer.token, post({}))).status).toBe(403);
    expect(await listed(root, id)).toBe(true);
  });
});
