import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { adminA, api, app, db, json } from "./fixtures";
import { invites, inviteUses, users } from "../src/db/schema";

/**
 * Лимит приглашения — это лимит учётных записей, а не назначений.
 *
 * Внешний разбор 2026-09-26: регистрация проверяла приглашение чтением,
 * создавала учётку и только в конце атомарно гасила использование. Две
 * одновременные регистрации по одноразовой ссылке обе проходили проверку,
 * обе создавали учётку, одна гасила приглашение, а проигравшая… всё равно
 * получала пару токенов — «аккаунт уже создан, назначения нет». Ссылка на
 * одного человека заводила сколько угодно учётных записей в клинической
 * системе с закрытой регистрацией.
 *
 * Теперь использование гасится атомарно и ДО создания учётки, в той же
 * транзакции: проигравший получает отказ и не оставляет после себя
 * ничего — ни учётки, ни токенов.
 */

/* номер — уникальный на прогон: телефон проверяется на дубликат по всей базе */
const phone = () => `+38050${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

describe("гонка за последнее использование приглашения", () => {
  test(
    "пять одновременных регистраций по одноразовой ссылке — одна учётка",
    async () => {
      const created = await api("/api/invites", adminA.token, {
        method: "POST",
        body: JSON.stringify({ maxUses: 1, ttlDays: 7 }),
      });
      expect(created.status).toBe(201);
      const inviteId = created.body.id as string;

      const emails = Array.from({ length: 5 }, () => `inv-race-${crypto.randomUUID()}@test.dev`);
      const results = await Promise.all(
        emails.map(async (email) => {
          const res = await app.request("/api/auth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email,
              password: "longpass123",
              phone: phone(),
              anonymous: false,
              firstName: "Гонка",
              lastName: "Приглашення",
              inviteCode: created.body.code,
            }),
          });
          return { status: res.status, body: await json(res) };
        }),
      );

      const won = results.filter((r) => r.status === 201);
      expect(won, "одноразовая ссылка выдала больше одной пары токенов").toHaveLength(1);
      for (const lost of results.filter((r) => r.status !== 201)) {
        expect(lost.status).toBe(400);
        expect(lost.body.token, "проигравшему выдан токен").toBeUndefined();
      }

      const accounts = await db.select({ id: users.id }).from(users).where(inArray(users.email, emails));
      expect(accounts, "одноразовая ссылка завела несколько учётных записей").toHaveLength(1);

      const [row] = await db.select().from(invites).where(eq(invites.id, inviteId));
      expect(row!.usedCount).toBe(1);
      const uses = await db.select().from(inviteUses).where(eq(inviteUses.inviteId, inviteId));
      expect(uses.map((u) => u.userId)).toEqual([won[0]!.body.user.id]);
    },
    30_000,
  );

  test("отказ по исчерпанной ссылке остаётся в журнале", async () => {
    /*
     * Отказ возвращается из транзакции регистрации, а бросается снаружи —
     * как у входа. Брошенный изнутри, он откатывал вместе с собой и строку
     * журнала «регистрация по приглашению отклонена»: попытки пройти по
     * чужой или исчерпанной ссылке не оставляли следа.
     */
    const { auditLog } = await import("../src/db/schema");
    const { and } = await import("drizzle-orm");
    const created = await api("/api/invites", adminA.token, {
      method: "POST",
      body: JSON.stringify({ maxUses: 1, ttlDays: 7 }),
    });
    const register = (email: string) =>
      app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: "longpass123",
          phone: phone(),
          anonymous: false,
          firstName: "Друга",
          lastName: "Спроба",
          inviteCode: created.body.code,
        }),
      });
    expect((await register(`inv-once-${crypto.randomUUID()}@test.dev`)).status).toBe(201);
    const late = `inv-late-${crypto.randomUUID()}@test.dev`;
    const refused = await register(late);
    expect(refused.status).toBe(400);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "auth.register"), eq(auditLog.outcome, "denied")));
    expect(
      rows.some((r) => (r.details as { email?: string } | null)?.email === late),
      "отказ по исчерпанной ссылке откатился вместе с транзакцией",
    ).toBe(true);
  });
});
