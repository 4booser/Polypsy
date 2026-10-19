import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { OpsOverview, OpsTraffic } from "@quizzy/shared";
import { auditLog, permissionExceptions, staffRoles } from "../src/db/schema";
import { recordError, resetOpsBuffers } from "../src/lib/opsBuffer";
import { requestSql } from "../src/lib/opsSql";
import { resetOpsAuditCoalescing } from "../src/routes/ops";
import { adminA, api, db, makeUser, root } from "./fixtures";

/**
 * «Огляд» техпанели одним запросом на такт (волна 27, perf-day).
 *
 * Экран опрашивал каждые двадцать секунд сводку, ряд окна, суточный ряд и
 * ошибки — четыре запроса, а при окне «24 год» сутки брались дважды. Теперь
 * /api/ops/overview?window= отдаёт к сводке ряд окна, сутки (null, когда окно
 * и есть сутки) и новые за час группы ошибок; без окна ответ прежний.
 *
 * Чтение групп ошибок остаётся чтением журнала: та же ops.errors.read и та
 * же склейка, что у /errors без периода.
 */

beforeEach(() => {
  resetOpsBuffers();
  resetOpsAuditCoalescing();
});

/** Разработчик: сотрудник без клинической роли с одним ops.read */
async function makeDeveloper() {
  const dev = await makeUser("admin", `ovl-dev-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, dev.id));
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: dev.id,
    permission: "ops.read",
    mode: "grant",
    reason: "Разработчик: огляд техпанели",
    grantedBy: root.id,
  });
  return dev;
}

const errorReads = (actor: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorId, actor), eq(auditLog.action, "ops.errors.read")));

describe("GET /api/ops/overview?window=", () => {
  test("без окна — прежняя сводка, без рядов и без журнала", async () => {
    const dev = await makeDeveloper();
    const res = await api<OpsOverview>("/api/ops/overview", dev.token);
    expect(res.status).toBe(200);
    expect(res.body.live).toBeUndefined();
    expect(await errorReads(dev.id)).toHaveLength(0);
  });

  test("ряд окна — тот же, что у /traffic, сутки — отдельно", async () => {
    const res = await api<OpsOverview>("/api/ops/overview?window=6h", root.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const live = res.body.live!;
    const six = await api<OpsTraffic>("/api/ops/traffic?window=6h", root.token);
    const day = await api<OpsTraffic>("/api/ops/traffic?window=24h", root.token);
    expect(live.traffic.window).toBe("6h");
    expect(live.traffic.stepSec).toBe(six.body.stepSec);
    expect(live.traffic.buckets.length).toBe(six.body.buckets.length);
    expect(live.traffic.since).toBe(six.body.since);
    expect(live.day!.window).toBe("24h");
    expect(live.day!.stepSec).toBe(day.body.stepSec);
    expect(live.day!.buckets.length).toBe(day.body.buckets.length);
  });

  test("окно «24 год» — сутки один раз: day пуст, ряд окна и есть суточный", async () => {
    const res = await api<OpsOverview>("/api/ops/overview?window=24h", root.token);
    expect(res.status).toBe(200);
    expect(res.body.live!.traffic.window).toBe("24h");
    expect(res.body.live!.day).toBeNull();
  });

  test("неизвестное окно — 400, пустое — как без него", async () => {
    expect((await api("/api/ops/overview?window=7d", root.token)).status).toBe(400);
    const blank = await api<OpsOverview>("/api/ops/overview?window=", root.token);
    expect(blank.status).toBe(200);
    expect(blank.body.live).toBeUndefined();
  });

  test("ошибки — только новые за час и без кадров стека", async () => {
    // группа двухчасовой давности: на «нова група» она уже не тянет
    setSystemTime(new Date(Date.now() - 2 * 3_600_000));
    try {
      recordError({ error: new Error("old trouble"), method: "GET", route: "/api/old", requestId: "o" });
    } finally {
      setSystemTime();
    }
    recordError({ error: new TypeError("fresh trouble olena.pchilka@example.com"), method: "POST", route: "/api/new", requestId: "n" });

    const res = await api<OpsOverview>("/api/ops/overview?window=1h", root.token);
    expect(res.status).toBe(200);
    const errors = res.body.live!.errors;
    expect(errors.map((g) => g.route)).toEqual(["/api/new"]);
    expect(errors[0]!.frames).toEqual([]);
    expect(errors[0]!.message).toBe("fresh trouble [email]");
    expect(JSON.stringify(res.body)).not.toContain("olena.pchilka");
  });

  test("чтение ошибок в журнале: одна строка на серию опросов, общая с /errors", async () => {
    const dev = await makeDeveloper();
    for (let i = 0; i < 3; i++) expect((await api("/api/ops/overview?window=1h", dev.token)).status).toBe(200);
    // вкладка «Помилки» в том же окне склейки — тот же вопрос, новой строки нет
    expect((await api("/api/ops/errors", dev.token)).status).toBe(200);
    const rows = await errorReads(dev.id);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.details as { coalesceSec: number }).coalesceSec).toBe(300);
  });

  test("тот же заслон: без ops.read — отказ", async () => {
    expect((await api("/api/ops/overview?window=1h", adminA.token)).status).toBe(403);
  });

  /* порядок величин: такт «Огляду» — один запрос, и он не дороже прежней сводки на порядок */
  test("такт одним запросом: SQL — как у одной сводки", async () => {
    const id = crypto.randomUUID();
    const res = await api("/api/ops/overview?window=1h", root.token, { headers: { "x-request-id": id } });
    expect(res.status).toBe(200);
    const plain = crypto.randomUUID();
    expect((await api("/api/ops/overview", root.token, { headers: { "x-request-id": plain } })).status).toBe(200);
    const live = requestSql(id)?.count ?? 0;
    const bare = requestSql(plain)?.count ?? 0;
    expect(bare).toBeGreaterThan(0);
    // ряды — память процесса; к сводке добавляется разве что строка журнала о чтении ошибок
    expect(live).toBeLessThanOrEqual(bare + 3);
  });
});
