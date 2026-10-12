import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { appRequest, db, json, makeUser, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { auditLog, refreshTokens } from "../src/db/schema";
import { runRetentionOnce } from "../src/lib/retention";

/**
 * Срок хранения refresh-токенов (#205).
 *
 * Каждый обмен пары — новая строка, и погашенные строки никто не убирал
 * (~1,3 млн на цели). Ретенция удаляет семьи целиком и только мёртвые —
 * каждый токен отозван или истёк раньше 90 дней назад. Живая семья
 * хранится вся, как бы стары ни были её погашенные строки: повтор любой из
 * них — кража, и семья должна гаснуть (CR-072).
 *
 * Семьи заводятся прямо в таблице, с выдачей в прошлом; сырые токены
 * известны тесту (хеш — sha256, как в lib/refresh.ts), и повтор идёт
 * настоящим обменом — POST /api/auth/refresh. Ретенция и обмены — ролью
 * приложения.
 */

const TAG = `w23rt${crypto.randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;
const hashOf = (raw: string) => new Bun.CryptoHasher("sha256").update(raw).digest("hex");
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let person: Person;

interface Seeded {
  family: string;
  /** Сырые токены по порядку выдачи */
  raws: string[];
}

/**
 * Цепочка обменов: `count` токенов с шагом в сутки от `startDaysAgo`, каждый
 * погашен следующим; последний — голова. Срок — 30 дней от выдачи, как у
 * настоящего обмена. `revokedDaysAgo` — семья отозвана целиком (выход,
 * смена пароля). `headLive` — голова выдана только что и жива.
 */
async function family(
  name: string,
  opts: { startDaysAgo: number; count: number; revokedDaysAgo?: number; headLive?: boolean },
): Promise<Seeded> {
  const family = `${TAG}-${name}`;
  const raws = Array.from({ length: opts.count }, (_, k) => `${family}-raw-${k}-${crypto.randomUUID()}`);
  const issued = raws.map((_, k) =>
    opts.headLive && k === raws.length - 1 ? Date.now() - 60_000 : Date.now() - (opts.startDaysAgo - k) * DAY,
  );
  await db.insert(refreshTokens).values(
    raws.map((raw, k) => ({
      id: `${family}-${k}`,
      userId: person.id,
      tokenHash: hashOf(raw),
      familyId: family,
      createdAt: new Date(issued[k]!).toISOString(),
      expiresAt: new Date(issued[k]! + 30 * DAY).toISOString(),
      rotatedAt: k < raws.length - 1 ? new Date(issued[k + 1]!).toISOString() : null,
      revokedAt: opts.revokedDaysAgo !== undefined ? ago(opts.revokedDaysAgo) : null,
    })),
  );
  return { family, raws };
}

const rowsOf = async (family: string) =>
  db.select().from(refreshTokens).where(eq(refreshTokens.familyId, family));

const refresh = (refreshToken: string) =>
  appRequest("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

beforeAll(async () => {
  person = await makeUser("user", `${TAG}@retention.test`);
});

// учётки остаются, как у соседних файлов: на них ссылается журнал (actor_id — RESTRICT)
afterAll(async () => {
  await db.delete(refreshTokens).where(like(refreshTokens.familyId, `${TAG}-%`));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, person.id));
}, 30_000);

describe("ретенция refresh-токенов (#205)", () => {
  let expiredLongAgo: Seeded;
  let revokedLongAgo: Seeded;
  let expiredOldRevokedNew: Seeded;
  let revokedRecently: Seeded;
  let expiredRecently: Seeded;
  let liveOld: Seeded;
  let deleted = 0;

  beforeAll(async () => {
    // голова истекла 170 дней назад
    expiredLongAgo = await family("expired-old", { startDaysAgo: 202, count: 3 });
    // отозвана 100 дней назад, хотя срок головы вышел бы позже
    revokedLongAgo = await family("revoked-old", { startDaysAgo: 115, count: 5, revokedDaysAgo: 100 });
    /*
     * Истекла 268 дней назад, а отозвана — 10: смена пароля (revokeAllFor)
     * гасит у человека все строки, в том числе давно истёкших семей. Семья
     * умерла по сроку, отзыв её не оживляет.
     */
    expiredOldRevokedNew = await family("expired-old-revoked-new", { startDaysAgo: 300, count: 3, revokedDaysAgo: 10 });
    // мертвы, но недавно: отозвана 10 дней назад; голова истекла 10 дней назад
    revokedRecently = await family("revoked-new", { startDaysAgo: 25, count: 3, revokedDaysAgo: 10 });
    expiredRecently = await family("expired-new", { startDaysAgo: 42, count: 3 });
    // живая семья с погашенными строками полугодовой давности
    liveOld = await family("live-old", { startDaysAgo: 200, count: 4, headLive: true });

    deleted = await asAppRole(() => runRetentionOnce());
  }, 30_000);

  test("мёртвые раньше 90 дней семьи удалены целиком, след в журнале", async () => {
    expect(await rowsOf(expiredLongAgo.family)).toEqual([]);
    expect(await rowsOf(revokedLongAgo.family)).toEqual([]);
    expect(await rowsOf(expiredOldRevokedNew.family)).toEqual([]);
    expect(deleted).toBeGreaterThanOrEqual(3 + 5 + 3);

    const [entry] = await db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, "retention.refresh_tokens"))
      .orderBy(sql`${auditLog.at} desc`)
      .limit(1);
    const details = entry?.details as { deleted: number; families: number; olderThanDays: number } | undefined;
    expect(details?.olderThanDays).toBe(90);
    expect(details?.deleted).toBeGreaterThanOrEqual(11);
    expect(details?.families).toBeGreaterThanOrEqual(3);
  }, 30_000);

  test("положительный контроль: недавно умершие и живая семьи на месте, все строки", async () => {
    expect(await rowsOf(revokedRecently.family)).toHaveLength(3);
    expect(await rowsOf(expiredRecently.family)).toHaveLength(3);
    // у живой семьи хранятся и погашенные строки полугодовой давности
    expect(await rowsOf(liveOld.family)).toHaveLength(4);
  });

  test("удалённый токен не открывает ничего — тот же отказ, что у мёртвой семьи", async () => {
    const res = await refresh(expiredLongAgo.raws[0]!);
    expect(res.status).toBe(401);
  }, 30_000);

  test("повтор погашенного полгода назад токена живой семьи — кража: семья гаснет", async () => {
    const res = await refresh(liveOld.raws[0]!);
    expect(res.status).toBe(401);
    const rows = await rowsOf(liveOld.family);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.revokedAt !== null), "голова живой семьи пережила повтор").toBe(true);
    // и голова больше не обменивается
    expect((await refresh(liveOld.raws[3]!)).status).toBe(401);
  }, 30_000);
});

describe("свежепогашенный токен после ретенции", () => {
  test("повтор по-прежнему гасит семью, преемник больше не обменивается", async () => {
    const owner = await makeUser("user", `${TAG}-fresh@retention.test`);
    const login = await appRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${TAG}-fresh@retention.test`, password: "secret12345" }),
    });
    expect(login.status).toBe(200);
    const first = (await json<{ refreshToken: string }>(login)).refreshToken;

    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const second = (await json<{ refreshToken: string }>(rotated)).refreshToken;

    // ретенция прошла между обменом и повтором
    await asAppRole(() => runRetentionOnce());
    const kept = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, owner.id));
    expect(kept).toHaveLength(2);

    expect((await refresh(first)).status).toBe(401);
    const after = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, owner.id), inArray(refreshTokens.familyId, kept.map((t) => t.familyId))));
    expect(after.every((t) => t.revokedAt !== null), "повтор погашенного токена не погасил семью").toBe(true);
    expect((await refresh(second)).status).toBe(401);

    await db.delete(refreshTokens).where(eq(refreshTokens.userId, owner.id));
  }, 30_000);
});
