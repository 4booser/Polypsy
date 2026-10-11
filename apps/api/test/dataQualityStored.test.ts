import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DataCheck } from "@quizzy/shared";
import { appApi, db, makeUser, sql, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
import { DATA_QUALITY_EVERY_MS, refreshDataQuality, scheduledDataQuality } from "../src/lib/dataChecks";
import { isRunning } from "../src/lib/opsJobs";
import { requestSql } from "../src/lib/opsSql";

/**
 * «Якість даних» техпанели — сохранённый итог, а не прогон на каждое
 * открытие (#189).
 *
 * Маршрут /api/ops/data/quality прогонял все проверки целостности записей
 * по очереди, по всем таблицам, под политиками строк: на синтетике в 1,44×
 * цели — 71 с, и ответ не доходил вовсе. Теперь проверки — фоновая задача
 * (планировщик раз в шесть часов, «Запустити зараз» в техпанели), маршрут
 * отдаёт последний итог с его датой.
 *
 * Объём — 100 тыс. прохождений по три пункта (generate_series, test/
 * massSurvey.ts); всё под ролью приложения, как в бою. Пример несостыковки
 * — прохождение без версии, сданное «завтра»: проверки показывают пять
 * самых свежих, и оно встаёт первым, сколько бы чужих ни оставили соседи.
 */

const TAG = `w21-dq-${crypto.randomUUID().slice(0, 8)}`;
const RESPONSES = 100_000;
let root: Person;
let mass: MassSurvey;

interface Report {
  checkedAt: string;
  checks: DataCheck[];
}

const orphans = (r: Report) => r.checks.find((c) => c.key === "orphans.responseNoVersion")!;

/** Прохождение без версии на нашей методике — «сдано завтра», чтобы стоять первым среди примеров */
async function orphan(n: number): Promise<string> {
  const id = `${TAG}-orphan-${n}`;
  await db.execute(sql`
    insert into responses (id, survey_id, status, version_id, started_at, submitted_at)
    values (${id}, ${mass.surveyId}, 'completed', null, now() + interval '1 day', now() + interval '1 day' + interval '${sql.raw(String(n))} minutes')`);
  return id;
}

async function quality(): Promise<{ status: number; body: Report; ms: number; sql: number }> {
  const requestId = crypto.randomUUID();
  const t0 = performance.now();
  const res = await appApi<Report>("/api/ops/data/quality", root.token, { headers: { "x-request-id": requestId } });
  return { status: res.status, body: res.body, ms: performance.now() - t0, sql: requestSql(requestId)?.count ?? 0 };
}

const storedRuns = async () =>
  Number(
    ((await db.execute(sql`select count(*)::int as n from integrity_checks where kind = 'data_quality'`)) as unknown as {
      n: number;
    }[])[0]?.n ?? 0,
  );

beforeAll(async () => {
  root = await makeUser("superadmin", `${TAG}@dq.test`);
  mass = await massSurvey(TAG, 3, root.id);
  await db.execute(sql`delete from integrity_checks where kind = 'data_quality'`);
}, 60_000);

afterAll(async () => {
  await db.execute(sql`delete from integrity_checks where kind = 'data_quality'`);
  if (mass) await dropMass(mass);
}, 60_000);

describe("малый объём: первое открытие, такт планировщика, «перепроверить»", () => {
  test("первое открытие прогоняет проверки здесь же и сохраняет итог; второе отдаёт его же", async () => {
    expect(await storedRuns()).toBe(0);
    const first = await quality();
    expect(first.status).toBe(200);
    expect(first.body.checks.length).toBeGreaterThan(5);
    expect(await storedRuns()).toBe(1);
    const second = await quality();
    expect(second.body.checkedAt).toBe(first.body.checkedAt);
  }, 60_000);

  test("такт планировщика: свежий итог не пересчитывает, старше шести часов — пересчитывает", async () => {
    expect(await asAppRole(() => scheduledDataQuality())).toBeNull();
    const later = new Date(Date.now() + DATA_QUALITY_EVERY_MS + 60_000);
    const run = await asAppRole(() => scheduledDataQuality(later));
    expect(run?.checks.length).toBeGreaterThan(5);
    expect(await storedRuns()).toBe(2);
  }, 60_000);

  test("новая несостыковка видна после «перепроверить», а не при каждом открытии", async () => {
    const before = await quality();
    const added = await orphan(1);
    const stale = await quality();
    expect(stale.body.checkedAt).toBe(before.body.checkedAt);
    expect(orphans(stale.body).count).toBe(orphans(before.body).count);

    // «Запустити зараз» у задачи на экране фоновых задач техпанели
    const started = await appApi("/api/ops/jobs/data.quality/run", root.token, { method: "POST", body: "{}" });
    expect(started.status).toBe(202);
    for (let i = 0; i < 600 && isRunning("data.quality"); i++) await Bun.sleep(100);
    expect(isRunning("data.quality")).toBe(false);

    const fresh = await quality();
    expect(fresh.body.checkedAt > before.body.checkedAt).toBe(true);
    expect(orphans(fresh.body).count).toBe(orphans(before.body).count + 1);
    expect(orphans(fresh.body).examples[0]?.id).toBe(added);
  }, 90_000);
});

/*
 * Условие закрытия: 100 тыс. прохождений — маршрут быстрее 3 с. Итог
 * сохраняется фоновой проверкой ДО заливки: сама проверка по объёму —
 * работа задачи, а не маршрута, и её длительность от машины и от того, что
 * оставили в базе соседние файлы, тут не проверяется. Маршрут обязан отдать
 * сохранённое и не начать проверки заново, сколько бы прохождений ни
 * добавилось.
 */
describe("100 тыс. прохождений: маршрут отдаёт сохранённый итог", () => {
  let stored: string;
  let added: string;

  beforeAll(async () => {
    stored = (await asAppRole(() => refreshDataQuality("manual"))).at;
    await massResponses(mass, 1, RESPONSES, 2_000);
    added = await orphan(2);
  }, 180_000);

  test("быстрее 3 с, без прогона проверок, итог — сохранённый", async () => {
    const res = await quality();
    expect(res.status).toBe(200);
    expect(res.body.checkedAt).toBe(stored);
    // несостыковка, появившаяся после проверки, в итоге не видна: проверки не гонялись
    expect(orphans(res.body).examples.map((e) => e.id)).not.toContain(added);
    /*
     * Итог читается одним запросом, названия методик — вторым; остальное —
     * вход, права и журнал (около десятка). Прогон проверок — ещё тридцать.
     */
    expect(res.sql).toBeLessThan(20);
    expect(res.ms).toBeLessThan(3_000);
  }, 60_000);
});
