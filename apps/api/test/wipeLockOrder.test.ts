import { expect, test } from "bun:test";
import { api, client, db, makeUser, root, sql } from "./fixtures";
import { issuePair } from "../src/lib/refresh";
import { AUDIT_CHAIN_LOCK } from "../src/lib/audit";

/*
 * Подтверждение стирания и вход того же человека не встают в цикл (ревью
 * PR #198, #128). Стирание гасило семью (строка users под lockOwner) и
 * потом писало журнал (замок цепочки); вход делает наоборот. Теперь
 * стирание берёт замок цепочки первым. Вторая сторона — отдельное
 * соединение ровно в порядке входа.
 */
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

test("стирание и вход того же человека: оба проходят, без взаимоблокировки", async () => {
  const person = await makeUser("admin", `rv21-wipe-${crypto.randomUUID().slice(0, 8)}@test`);
  const pair = await issuePair({ id: person.id, role: "admin" });
  const device = `inst-${crypto.randomUUID()}`;
  expect((await api("/api/devices/checkin", pair.token, post({ deviceId: device }))).status).toBe(200);
  expect((await api(`/api/devices/${device}/wipe`, root.token, post({ userId: person.id }))).status).toBe(200);

  const login = await client.reserve();
  await login`begin`;
  await login`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`; // «вход» уже записал журнал

  const wiped = api("/api/devices/wiped", pair.token, post({ deviceId: device, refreshToken: pair.refreshToken }));
  // подтверждение встаёт за замком цепочки — и строку users при этом не держит
  for (let i = 0; i < 400; i++) {
    const [w] = (await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`)) as unknown as { n: number }[];
    if ((w?.n ?? 0) > 0) break;
    await Bun.sleep(10);
  }
  let loginError: string | null = null;
  try {
    await login`update users set last_seen_at = now() where id = ${person.id}`; // touchLastSeen входа
    await login`commit`;
  } catch (e) {
    loginError = `${(e as { code?: string }).code} ${(e as Error).message}`;
    await login`rollback`.catch(() => {});
  } finally {
    login.release();
  }
  const res = await wiped;
  expect(loginError, "вход стал жертвой взаимоблокировки").toBeNull();
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.sessionRevoked).toBe(true);
}, 30_000);
