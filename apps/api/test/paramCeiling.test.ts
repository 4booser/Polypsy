import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, makeUser, sql, type Person } from "./fixtures";
import { taggedAppRolePool } from "./appRole";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
// само приложение, без обёртки fixtures: запросы этого файла идут своим пулом роли приложения
import { app } from "../src/app";
import { db as appDb, runOnPool, type PoolOverride } from "../src/db";
import { answers } from "../src/db/schema";
import { inIds } from "../src/db/ids";

/**
 * Методика с прохождениями сверх потолка параметров (#183).
 *
 * Список id прохождений уходил в базу параметром на элемент (inArray), а у
 * протокола на число параметров два байта: выше 65 533 postgres.js
 * отказывает. Аналитика методики при этом зависала навсегда и уносила
 * соединение пула (как — в requestTxPipeline.test.ts). PHQ-9
 * скринингового учреждения проходит этот порог ко второму году.
 *
 * Здесь — 70 тыс. настоящих прохождений и настоящие маршруты под ролью
 * приложения, а не пониженный предел: потолок драйвера не настраивается, и
 * обойти его «понарошку» значило бы проверять не тот путь. Посев — две
 * вставки из generate_series (massSurvey.ts), пункта в методике два: объём
 * нужен по прохождениям, а не по ответам.
 *
 * Сотрудник — суперадмин, как в замерах разбора. У администратора политика
 * строк ответов и баллов зовёт rls_admin_sees_survey на каждую строку:
 * 140 тыс. ответов — четыре секунды одной только базы на запрос, и десять
 * таких запросов — минута с лишним. Это своя цена (в отчёт волны), а не
 * предмет этой проверки.
 */

const TAG = `w20pe-ceil-${crypto.randomUUID().slice(0, 8)}`;
const RESPONSES = 70_000;
let staff: Person;
let s: MassSurvey;
/*
 * Пулы — свои у каждой проверки: застрявшие соединения одной (так было до
 * правки) не должны валить соседнюю за компанию.
 */
let pools: Record<"analytics", PoolOverride & { close: () => Promise<void> }>;
let pool: PoolOverride;

const within = <T>(ms: number, work: Promise<T>): Promise<T | "timeout"> =>
  Promise.race([work, Bun.sleep(ms).then(() => "timeout" as const)]);
const onPool = <T>(fn: () => Promise<T>): Promise<T> => runOnPool(pool, fn);
const get = (path: string) => onPool(async () => app.request(path, { headers: { Authorization: `Bearer ${staff.token}` } }));
const statusOf = (r: Response | "timeout") => (r === "timeout" ? "timeout" : r.status);

beforeAll(async () => {
  staff = await makeUser("superadmin", `${TAG}@ceiling.test`);
  s = await massSurvey(TAG, 2, staff.id);
  await massResponses(s, 1, RESPONSES, 2_000);
  pools = { analytics: await taggedAppRolePool(`${TAG}-a`) };
}, 120_000);

afterAll(async () => {
  await Promise.all(Object.values(pools ?? {}).map((p) => p.close()));
  if (s) await dropMass(s);
}, 60_000);

describe("список id — одним параметром", () => {
  test("условие по 100 тыс. id собирается в один параметр, а не в сто тысяч", () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => `id-${i}`);
    const { params } = appDb.select({ id: answers.id }).from(answers).where(inIds(answers.responseId, ids)).toSQL();
    expect(params.length).toBe(1);
    expect(JSON.parse(String(params[0]))).toHaveLength(100_000);
  });

  test("отбирает ровно перечисленное", async () => {
    const wanted = [`${TAG}-r1`, `${TAG}-r2`, `${TAG}-r70000`, "нет-такого"];
    const rows = await db.select({ responseId: answers.responseId }).from(answers).where(inIds(answers.responseId, wanted));
    expect(rows.map((r) => r.responseId).sort()).toEqual([...wanted.slice(0, 3), ...wanted.slice(0, 3)].sort());
    expect(await db.select().from(answers).where(inIds(answers.responseId, []))).toEqual([]);
  });
});

describe("аналитика методики выше потолка (#183)", () => {
  beforeAll(() => {
    pool = pools.analytics;
  });

  test("десять запросов — все 200, после них /api/auth/me быстро и idle | rollback не остаётся", async () => {
    const replies = await Promise.all(
      Array.from({ length: 10 }, () => within(90_000, get(`/api/analytics/surveys/${s.surveyId}`))),
    );
    expect(replies.map(statusOf)).toEqual(Array(10).fill(200));
    const body = (await (replies[0] as Response).json()) as { completed: number };
    expect(body.completed).toBe(RESPONSES);

    const t0 = performance.now();
    const me = await within(2_000, get("/api/auth/me"));
    expect(statusOf(me)).toBe(200);
    expect(performance.now() - t0).toBeLessThan(200);

    // круг по соединениям пула — см. requestTxPipeline.test.ts: rollback последним остаётся только у застрявших
    for (let i = 0; i < 10; i++) expect(await within(1_000, onPool(() => appDb.execute(sql`select 1`)))).not.toBe("timeout");
    const left = (await db.execute(
      sql`select state, query from pg_stat_activity where application_name = ${`${TAG}-a`}`,
    )) as unknown as { state: string; query: string }[];
    expect(left.filter((c) => c.state === "idle" && /^rollback/i.test(c.query.trim()))).toEqual([]);
  }, 180_000);
});
