import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AUDIT_ACTIONS_MAX } from "@quizzy/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLog } from "../src/db/schema";
import { api, app, appApi, db, makeUser, root } from "./fixtures";

/**
 * Несколько действий одним чтением журнала — `actions` (волна 27).
 *
 * «Адміністратори» читали журнал назначений пятью запросами по одному
 * действию, доступ методики — двумя: у каждого свой счёт и своя строка
 * audit.read на каждое открытие. Одним отбором — одно чтение. Проверяется,
 * что оно отдаёт ровно то, что экран прежде сводил сам (восемь последних по
 * всем действиям вместе), что счёт — сумма по действиям, что отбор тот же у
 * выгрузки, и что чтение по-прежнему пишется в журнал — одной строкой.
 *
 * Строки посева — свои коды действий, вне цепочки (seq пуст), и уходят в
 * afterAll, как в auditSearch.test.ts.
 */

const TAG = `w27act${crypto.randomUUID().slice(0, 8)}`;
const A = `${TAG}.grant`;
const B = `${TAG}.revoke`;
const C = `${TAG}.other`;
const SURVEY = crypto.randomUUID();
const OTHER_SURVEY = crypto.randomUUID();

type Entry = { id: string; at: string; action: string; resourceId: string | null };
type Page = { entries: Entry[]; total?: number; nextCursor: string | null };

beforeAll(async () => {
  /* у каждого действия свои моменты: A — каждые 7 минут, B — каждые 11, C — шум; часть — по чужой методике */
  await db.execute(sql`
    insert into audit_log (id, at, actor_email, actor_role, action, resource_type, resource_id, outcome, details)
    select ${TAG} || '-a-' || g, now() - g * interval '7 minutes', 'w27@audit-actions.test', 'admin', ${A},
           'survey', case when g % 3 = 0 then ${OTHER_SURVEY} else ${SURVEY} end, 'success', jsonb_build_object('n', g)
    from generate_series(1, 30) g`);
  await db.execute(sql`
    insert into audit_log (id, at, actor_email, actor_role, action, resource_type, resource_id, outcome, details)
    select ${TAG} || '-b-' || g, now() - g * interval '11 minutes' - interval '1 second', 'w27@audit-actions.test', 'admin', ${B},
           'survey', ${SURVEY}, 'success', jsonb_build_object('n', g)
    from generate_series(1, 20) g`);
  await db.execute(sql`
    insert into audit_log (id, at, actor_email, actor_role, action, resource_type, resource_id, outcome, details)
    select ${TAG} || '-c-' || g, now() - g * interval '5 minutes' - interval '2 seconds', 'w27@audit-actions.test', 'admin', ${C},
           'survey', ${SURVEY}, 'success', jsonb_build_object('n', g)
    from generate_series(1, 25) g`);
});

afterAll(async () => {
  // журнал неизменяем и для владельца; посев снимается так же, как в auditSearch.test.ts
  await db.execute(sql`alter table audit_log disable trigger audit_log_immutable`);
  try {
    await db.execute(sql`delete from audit_log where id like ${`${TAG}-%`}`);
  } finally {
    await db.execute(sql`alter table audit_log enable trigger audit_log_immutable`);
  }
});

const page = (query: string) => api<Page>(`/api/audit?${query}`, root.token);

describe("отбор по нескольким действиям", () => {
  test("восемь последних по всем действиям — те же, что экран сводил из чтений по одному", async () => {
    const one = await page(`actions=${A},${B}&limit=8`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.entries.length).toBe(8);
    expect(new Set(one.body.entries.map((e) => e.action))).toEqual(new Set([A, B]));

    // прежний путь экрана: по восемь на действие, свести, по времени, первые восемь
    const parts = await Promise.all([A, B].map((action) => page(`action=${action}&limit=8`)));
    const merged = parts
      .flatMap((p) => p.body.entries)
      .sort((x, y) => y.at.localeCompare(x.at))
      .slice(0, 8);
    expect(one.body.entries.map((e) => e.id)).toEqual(merged.map((e) => e.id));

    // счёт — по всем действиям вместе
    expect(one.body.total).toBe((parts[0]!.body.total ?? 0) + (parts[1]!.body.total ?? 0));
    expect(one.body.total).toBe(50);
  });

  test("вместе с типом ресурса и текстом — как у доступа методики", async () => {
    const res = await page(`actions=${A},${B}&resourceType=survey&q=${SURVEY}&limit=100`);
    expect(res.status).toBe(200);
    // A по чужой методике — каждая третья из тридцати — в отбор не идёт
    expect(res.body.total).toBe(20 + 20);
    expect(res.body.entries.every((e) => e.resourceId === SURVEY && (e.action === A || e.action === B))).toBe(true);
  });

  test("повторы и пустые коды схлопываются; пустой список — отбора нет, как и без параметра", async () => {
    const messy = await page(`actions=${encodeURIComponent(` ${A}, ,${A},${B} `)}&limit=100`);
    expect(messy.status).toBe(200);
    expect(messy.body.total).toBe(50);

    const empty = await page(`actions=&q=${TAG}&limit=1`);
    const none = await page(`q=${TAG}&limit=1`);
    expect(empty.status).toBe(200);
    expect(empty.body.total).toBe(none.body.total!);
  });

  test("кодов не больше двадцати и каждый не длиннее 64 знаков", async () => {
    const many = Array.from({ length: AUDIT_ACTIONS_MAX + 1 }, (_, i) => `${TAG}.x${i}`).join(",");
    expect((await page(`actions=${many}`)).status).toBe(400);
    expect((await page(`actions=${"a".repeat(65)}`)).status).toBe(400);
    const enough = Array.from({ length: AUDIT_ACTIONS_MAX }, (_, i) => `${TAG}.x${i}`).join(",");
    expect((await page(`actions=${enough}`)).status).toBe(200);
  });

  test("чтение пишется в журнал одной строкой, с отбором действий", async () => {
    const reader = await makeUser("superadmin", `w27-reader-${crypto.randomUUID()}@test`);
    const res = await api<Page>(`/api/audit?actions=${A},${B}&limit=8`, reader.token);
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, reader.id), eq(auditLog.action, "audit.read")))
      .orderBy(desc(auditLog.at));
    expect(rows.length).toBe(1);
    expect((rows[0]!.details as { filters: { actions?: string[] } }).filters.actions).toEqual([A, B]);
  });

  test("выгрузка отбирает так же", async () => {
    const res = await app.request(`/api/audit/export.csv?actions=${A},${C}`, { headers: { Authorization: `Bearer ${root.token}` } });
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").slice(1);
    expect(lines.length).toBe(30 + 25);
    expect(lines.some((l) => l.includes(B))).toBe(false);
  });

  test("под боевой ролью — то же", async () => {
    const res = await appApi<Page>(`/api/audit?actions=${A},${B}&limit=8`, root.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(50);
    expect(res.body.entries.length).toBe(8);
  });
});
