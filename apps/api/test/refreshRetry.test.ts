import { describe, expect, test } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { appRequest, db, json, makeUser } from "./fixtures";
import { refreshTokens } from "../src/db/schema";
import { issuePair, RETRY_WINDOW_MS, rotateRefresh } from "../src/lib/refresh";

/**
 * Потерянный ответ обмена refresh (#144).
 *
 * Было: `refresh(R1)` → 200, ответ (R2) потерян; повтор `refresh(R1)` → 401 и
 * гашение семьи, `refresh(R2)` → 401. Мобилку выкидывало на вход, сдачи из
 * очереди уходили в отклонённые — на плохой сети (502/504 после записи) это
 * обычный случай.
 *
 * Стало: повтор того же обмена — тот же refresh и тот же ключ попытки
 * (requestId) — в коротком окне после поворота отдаёт ту же новую пару, пока
 * она не предъявлена. Повтор вне окна, после предъявления новой пары, с чужим
 * ключом или без ключа — по-прежнему кража: семья гаснет (CR-072).
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const requestId = () => crypto.randomUUID().replaceAll("-", "");

async function person() {
  const p = await makeUser("user", `rr-${tag()}@test`);
  return { ...p, pair: await issuePair({ id: p.id, role: "user" }) };
}

const familyAlive = async (userId: string) =>
  (await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId))).some((t) => !t.revokedAt);

describe("повтор обмена с тем же ключом попытки", () => {
  test("в окне и до предъявления новой пары — та же пара, семья жива", async () => {
    const p = await person();
    const rid = requestId();

    const first = await rotateRefresh(p.pair.refreshToken, rid);
    expect(first.ok).toBe(true);
    const again = await rotateRefresh(p.pair.refreshToken, rid);
    expect(again.ok, "повтор потерянного обмена погасил семью").toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.pair.refreshToken).toBe(first.pair.refreshToken);
    expect(typeof again.pair.token).toBe("string");

    // новая пара работает как обычно — цепочка одна
    const next = await rotateRefresh(first.pair.refreshToken);
    expect(next.ok).toBe(true);
    expect(await familyAlive(p.id)).toBe(true);
  }, 30_000);

  test("после предъявления новой пары повтор старого — кража: семья гаснет", async () => {
    const p = await person();
    const rid = requestId();
    const first = await rotateRefresh(p.pair.refreshToken, rid);
    if (!first.ok) throw new Error("обмен не прошёл");
    const second = await rotateRefresh(first.pair.refreshToken, requestId());
    expect(second.ok).toBe(true);

    const replay = await rotateRefresh(p.pair.refreshToken, rid);
    expect(replay).toMatchObject({ ok: false, reason: "reused" });
    expect(await familyAlive(p.id)).toBe(false);
  }, 30_000);

  test("вне окна — кража: семья гаснет", async () => {
    const p = await person();
    const rid = requestId();
    const first = await rotateRefresh(p.pair.refreshToken, rid);
    expect(first.ok).toBe(true);
    // поворот — давно: окно прошло
    await db
      .update(refreshTokens)
      .set({ rotatedAt: new Date(Date.now() - RETRY_WINDOW_MS - 60_000).toISOString() })
      .where(and(eq(refreshTokens.userId, p.id), isNotNull(refreshTokens.rotatedAt)));

    const replay = await rotateRefresh(p.pair.refreshToken, rid);
    expect(replay).toMatchObject({ ok: false, reason: "reused" });
    expect(await familyAlive(p.id)).toBe(false);
  }, 30_000);

  test("чужой ключ (вор с копией refresh) — кража: семья гаснет, новая пара жертвы тоже", async () => {
    const p = await person();
    const first = await rotateRefresh(p.pair.refreshToken, requestId());
    if (!first.ok) throw new Error("обмен не прошёл");

    const thief = await rotateRefresh(p.pair.refreshToken, requestId());
    expect(thief).toMatchObject({ ok: false, reason: "reused" });
    expect(await rotateRefresh(first.pair.refreshToken)).toMatchObject({ ok: false });
  }, 30_000);

  test("без ключа — как раньше: повтор погашенного гасит семью", async () => {
    const p = await person();
    expect((await rotateRefresh(p.pair.refreshToken)).ok).toBe(true);
    expect(await rotateRefresh(p.pair.refreshToken)).toMatchObject({ ok: false, reason: "reused" });
    expect(await familyAlive(p.id)).toBe(false);
  }, 30_000);
});

describe("маршрут обмена под ролью приложения", () => {
  const exchange = (refreshToken: string, rid?: string) =>
    appRequest("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rid ? { refreshToken, requestId: rid } : { refreshToken }),
    });

  test("ответ потерян — повтор тем же ключом получает ту же пару, и она продлевается", async () => {
    const p = await person();
    const rid = requestId();
    const lost = await exchange(p.pair.refreshToken, rid);
    expect(lost.status).toBe(200);
    const lostPair = await json<{ token: string; refreshToken: string }>(lost);

    const retry = await exchange(p.pair.refreshToken, rid);
    expect(retry.status).toBe(200);
    expect((await json<{ refreshToken: string }>(retry)).refreshToken).toBe(lostPair.refreshToken);

    expect((await exchange(lostPair.refreshToken, requestId())).status).toBe(200);
  }, 30_000);

  test("повтор без ключа — 401, как раньше", async () => {
    const p = await person();
    expect((await exchange(p.pair.refreshToken)).status).toBe(200);
    expect((await exchange(p.pair.refreshToken)).status).toBe(401);
  }, 30_000);
});
