import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { OpsErrors, OpsJobs, OpsLogVolume } from "@quizzy/shared";
import { permissionExceptions, staffRoles } from "../src/db/schema";
import { log } from "../src/lib/log";
import { recordError, resetOpsBuffers } from "../src/lib/opsBuffer";
import { LOG_VOLUME_GRAIN, levelBuckets, readErrorHours, readLogVolume } from "../src/lib/opsHistory";
import { flushOpsStore } from "../src/lib/opsStore";
import { SCHEDULE_ACTIVITY_DAYS, resetOpsAuditCoalescing } from "../src/routes/ops";
import { adminA, api, batteries, db, groupA, makeUser, root, scheduleRuns, schedules, sql } from "./fixtures";

/**
 * Графики техпанели (волна 11): агрегаты по времени для графиков —
 * объём лога по уровням (GET /api/ops/logs/volume), случаи ошибок по часам
 * (/errors?window=), срабатывания расписаний по часам (/jobs).
 *
 * Порядок тот же, что у соседей (ops.test.ts, opsObs2a.test.ts): кто видит,
 * потом что числа честные — сохранённое и ещё не записанное складываются
 * без повторов, граница периода та же, что у списка, и ни одного текста
 * наружу: график получает только счёт.
 *
 * База общая с другими файлами, и строки лога пишут все: поэтому счёт
 * проверяется приращением («было — стало»), а не абсолютным числом.
 */

beforeEach(() => {
  resetOpsBuffers();
  resetOpsAuditCoalescing();
});

async function makeDeveloper() {
  const dev = await makeUser("admin", `charts-dev-${crypto.randomUUID()}@test`);
  await db.delete(staffRoles).where(eq(staffRoles.userId, dev.id));
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: dev.id,
    permission: "ops.read",
    mode: "grant",
    reason: "Разработчик: графики панели",
    grantedBy: root.id,
  });
  return dev;
}

const sumLevel = (v: OpsLogVolume, level: "debug" | "info" | "warn" | "error") => v.buckets.reduce((s, b) => s + b[level], 0);
const sumHours = (e: OpsErrors) => (e.hours ?? []).reduce((s, h) => s + h.count, 0);

describe("кто видит", () => {
  test("объём лога — по праву ops.read, как сама лента", async () => {
    const denied = await api("/api/ops/logs/volume", adminA.token);
    expect(denied.status).toBe(403);
    expect(String(denied.body?.error ?? "")).toContain("ops.read");

    const dev = await makeDeveloper();
    const ok = await api<OpsLogVolume>("/api/ops/logs/volume?window=24h", dev.token);
    expect(ok.status).toBe(200);
    expect(ok.body.window).toBe("24h");
  });

  test("неизвестный период — 400, пустой — умолчание «година»", async () => {
    expect((await api("/api/ops/logs/volume?window=3d", root.token)).status).toBe(400);
    const blank = await api<OpsLogVolume>("/api/ops/logs/volume?window=", root.token);
    expect(blank.status).toBe(200);
    expect(blank.body.window).toBe("1h");
    expect(blank.body.grain).toBe("minute");
  });
});

describe("объём лога по уровням", () => {
  test("только счёт: ни текста, ни номеров запросов", async () => {
    log.warn("charts-secret-marker taras@example.com", { requestId: "r-1" });
    const res = await api<OpsLogVolume>("/api/ops/logs/volume?window=1h", root.token);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("charts-secret-marker");
    expect(text).not.toContain("taras");
    for (const b of res.body.buckets) expect(Object.keys(b).sort()).toEqual(["at", "debug", "error", "info", "warn"]);
  });

  test("записанное и ещё не записанное складываются без повторов", async () => {
    await flushOpsStore();
    const before = (await api<OpsLogVolume>("/api/ops/logs/volume?window=1h", root.token)).body;

    log.warn("charts.volume", { i: 1 });
    log.warn("charts.volume", { i: 2 });
    log.error("charts.volume.error", { i: 3 });
    await flushOpsStore(); // эти три — уже в базе
    log.warn("charts.volume", { i: 4 }); // эта — ещё в очереди

    const mid = (await api<OpsLogVolume>("/api/ops/logs/volume?window=1h", root.token)).body;
    expect(sumLevel(mid, "warn") - sumLevel(before, "warn")).toBe(3);
    expect(sumLevel(mid, "error") - sumLevel(before, "error")).toBe(1);
    expect(mid.historyUnavailable).toBe(false);

    // после записи очереди счёт тот же: строка не посчитана дважды
    await flushOpsStore();
    const after = (await api<OpsLogVolume>("/api/ops/logs/volume?window=1h", root.token)).body;
    expect(sumLevel(after, "warn") - sumLevel(before, "warn")).toBe(3);

    // после «перезапуска» память пуста — счёт отдаёт база
    resetOpsBuffers();
    const restarted = (await api<OpsLogVolume>("/api/ops/logs/volume?window=1h", root.token)).body;
    expect(sumLevel(restarted, "warn") - sumLevel(before, "warn")).toBe(3);
  });

  test("корзины ровные: минута для часа, час для остального; начало периода — на месте", async () => {
    const now = Date.now();
    for (const [window, grain] of Object.entries(LOG_VOLUME_GRAIN)) {
      const v = await readLogVolume(window as keyof typeof LOG_VOLUME_GRAIN, undefined, now);
      expect(v.grain).toBe(grain);
      const step = grain === "minute" ? 60_000 : 3_600_000;
      for (const b of v.buckets) expect(Date.parse(b.at) % step).toBe(0);
      expect(Date.parse(v.from)).toBeLessThanOrEqual(now);
    }
  });

  test("сложение корзин — чистая функция: уровень мимо перечня и строки до периода не считаются", () => {
    const H = 3_600_000;
    const from = Date.UTC(2026, 8, 26, 10, 30);
    const out = levelBuckets(
      [
        { at: Date.UTC(2026, 8, 26, 10), level: "warn", n: 2 },
        { at: Date.UTC(2026, 8, 26, 11), level: "info", n: 5 },
        { at: Date.UTC(2026, 8, 26, 8), level: "warn", n: 9 },
        { at: Date.UTC(2026, 8, 26, 11), level: "trace", n: 7 },
      ],
      [
        { at: new Date(Date.UTC(2026, 8, 26, 11, 20)).toISOString(), level: "error" },
        { at: new Date(Date.UTC(2026, 8, 26, 10, 10)).toISOString(), level: "error" },
      ],
      from,
      H,
    );
    expect(out).toEqual([
      { at: new Date(Date.UTC(2026, 8, 26, 10)).toISOString(), debug: 0, info: 0, warn: 2, error: 0 },
      { at: new Date(Date.UTC(2026, 8, 26, 11)).toISOString(), debug: 0, info: 5, warn: 0, error: 1 },
    ]);
  });

  test("база не ответила — очередь и пометка, а не пятисотка", async () => {
    log.warn("charts.volume.down", {});
    const v = await readLogVolume("1h", async () => {
      throw new Error("connection refused");
    });
    expect(v.failed).toBe(true);
    expect(v.buckets.reduce((s, b) => s + b.warn, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("случаи ошибок по часам", () => {
  test("часы — только в режиме истории; сохранённое и очередь без повторов", async () => {
    const live = await api<OpsErrors>("/api/ops/errors", root.token);
    expect(live.body.hours).toBeUndefined();

    await flushOpsStore();
    const before = (await api<OpsErrors>("/api/ops/errors?window=24h", root.token)).body;
    const boom = () => recordError({ error: new Error("charts hours boom"), method: "GET", route: "/api/charts/hours", requestId: "h" });
    boom();
    boom();
    await flushOpsStore();
    boom(); // ещё в очереди

    const mid = (await api<OpsErrors>("/api/ops/errors?window=24h", root.token)).body;
    expect(sumHours(mid) - sumHours(before)).toBe(3);
    // часы и группы считают одно и то же: счёт группы за период — те же три
    expect(mid.items.find((g) => g.message === "charts hours boom")?.count).toBe(3);

    await flushOpsStore();
    const after = (await api<OpsErrors>("/api/ops/errors?window=24h", root.token)).body;
    expect(sumHours(after) - sumHours(before)).toBe(3);
    for (const h of after.hours ?? []) expect(Date.parse(h.at) % 3_600_000).toBe(0);
  });

  test("давний час в сутки не входит, в 90 дней — входит", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const hour = new Date(Math.floor((Date.now() - 20 * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
    await db.execute(sql`
      insert into ops_error_groups (fingerprint, origin, name, message, count, first_at, last_at)
      values (${`charts-${tag}`}, 'log', 'charts.period', ${`charts ${tag}`}, 4, ${hour}, ${hour})`);
    await db.execute(sql`insert into ops_error_hours (fingerprint, hour, count) values (${`charts-${tag}`}, ${hour}, 4)`);
    const day = await readErrorHours("24h");
    expect(day.hours.some((h) => h.at === hour)).toBe(false);
    const quarter = await readErrorHours("90d");
    expect(quarter.hours.find((h) => h.at === hour)?.count).toBeGreaterThanOrEqual(4);
  });
});

describe("срабатывания расписаний по часам", () => {
  test("месяц суммой по часам; старше — не входит; ни расписания, ни людей", async () => {
    const batteryId = crypto.randomUUID();
    const scheduleId = crypto.randomUUID();
    await db.insert(batteries).values({ id: batteryId, title: "Графики", groupId: groupA, strictOrder: false, createdBy: adminA.id });
    await db.insert(schedules).values({
      id: scheduleId,
      title: "Графики: расписание",
      batteryId,
      scope: "unit",
      unit: "Рота А",
      intervalDays: 30,
      /* не срабатывает само: срок — далеко впереди */
      nextRunAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      active: false,
      createdBy: adminA.id,
    });
    const hour = Math.floor((Date.now() - 2 * 86_400_000) / 3_600_000) * 3_600_000;
    await db.insert(scheduleRuns).values([
      { id: crypto.randomUUID(), scheduleId, ranAt: new Date(hour + 10 * 60_000).toISOString(), assigned: 3, skipped: 1 },
      { id: crypto.randomUUID(), scheduleId, ranAt: new Date(hour + 40 * 60_000).toISOString(), assigned: 2, skipped: 0 },
      { id: crypto.randomUUID(), scheduleId, ranAt: new Date(Date.now() - (SCHEDULE_ACTIVITY_DAYS + 5) * 86_400_000).toISOString(), assigned: 9, skipped: 9 },
    ]);

    const res = await api<OpsJobs>("/api/ops/jobs", root.token);
    expect(res.status).toBe(200);
    const a = res.body.scheduleActivity!;
    expect(Date.parse(a.from)).toBeLessThan(Date.now() - (SCHEDULE_ACTIVITY_DAYS - 1) * 86_400_000);
    expect(a.hours.find((h) => h.at === new Date(hour).toISOString())).toEqual({
      at: new Date(hour).toISOString(),
      runs: 2,
      assigned: 5,
      skipped: 1,
    });
    // срабатывание старше месяца в часы не попало
    expect(a.hours.every((h) => Date.parse(h.at) >= Date.parse(a.from) - 3_600_000)).toBe(true);
    expect(JSON.stringify(a)).not.toContain("Графики");
  });
});
