import { afterAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import { db, makeUser, sql } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { systemContext } from "../src/db/context";
import { refreshTokens } from "../src/db/schema";
import { env } from "../src/env";

/**
 * Токены за период — индексом (#205, миграция 0131).
 *
 * Отчёт «Використання» (lib/opsData.ts, usageReport) берёт refresh-токены,
 * выданные за окно отчёта, — «активні люди» по обменам. Индекса по
 * created_at не было, и отбор перебирал таблицу целиком (1,3 млн строк на
 * цели; замер на таком посеве — 0,2–0,26 с полного просмотра против 15–26 мс
 * по индексу).
 *
 * Как в listIndexes.test.ts, спрашивается план, а не секундомер: обходной
 * путь запрещён, и если индекса под условие нет, в плане останется полный
 * просмотр — «дорогой», но тот же. План — ролью приложения в системном
 * контексте, как идёт отчёт: условие по времени выдачи должно доходить до
 * индекса и под политикой строк.
 */

const TAG = `w23rp${crypto.randomUUID().slice(0, 8)}`;

/** Начало окна отчёта — то же выражение, что windowStart в lib/opsData.ts */
const windowStart = (days: number) =>
  sql`((((now() at time zone ${env.institutionTz})::date - ${days - 1}::int)::timestamp) at time zone ${env.institutionTz})`;

/** Отбор ветки «обновление токена» из usageReport */
const tokensSince = (days: number) =>
  sql`select t.user_id, t.created_at from refresh_tokens t where t.created_at >= ${windowStart(days)}`;

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };
const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

afterAll(async () => {
  await db.delete(refreshTokens).where(like(refreshTokens.familyId, `${TAG}-%`));
});

describe("refresh-токены за период отчёта (#205)", () => {
  for (const days of [30, 90]) {
    test(`окно ${days} дней — индексом по времени выдачи`, async () => {
      const plan = await asAppRole(() =>
        systemContext(baseDb, async () => {
          await db.execute(sql`set local enable_seqscan = off`);
          const [row] = await db.execute<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
            sql`explain (format json) ${tokensSince(days)}`,
          );
          return nodes(row!["QUERY PLAN"][0]!.Plan);
        }),
      );
      expect(
        plan.some((n) => n["Index Name"] === "refresh_tokens_created_idx"),
        `план: ${plan.map((n) => `${n["Node Type"]}${n["Index Name"] ? ` (${n["Index Name"]})` : ""}`).join(" → ")}`,
      ).toBe(true);
    }, 30_000);
  }

  test("положительный контроль: отбор тот же — выданный в окне есть, выданный раньше нет", async () => {
    const person = await makeUser("user", `${TAG}@period.test`);
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    await db.insert(refreshTokens).values(
      [1, 45].map((daysAgo) => ({
        id: `${TAG}-${daysAgo}`,
        userId: person.id,
        tokenHash: `${TAG}-${daysAgo}-${crypto.randomUUID()}`,
        familyId: `${TAG}-${daysAgo}`,
        createdAt: at(daysAgo),
        expiresAt: at(daysAgo - 30),
      })),
    );
    const seen = await asAppRole(() =>
      systemContext(baseDb, async () => {
        const rows = await db.execute<{ user_id: string; created_at: string }>(
          sql`select * from (${tokensSince(30)}) s where s.user_id = ${person.id}`,
        );
        return [...rows].map((r) => new Date(r.created_at).getTime());
      }),
    );
    expect(seen).toHaveLength(1);
    expect(Math.abs(seen[0]! - Date.parse(at(1)))).toBeLessThan(1000);
  }, 30_000);
});
