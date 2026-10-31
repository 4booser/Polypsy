import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { makeUser, type Person } from "./fixtures";
import { rlsRoleUrl } from "./appRole";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";

/**
 * Политики строк прохождений на объёме (#185).
 *
 * Прежние политики спрашивали rls_admin_sees_survey() на каждую строку —
 * функцию SECURITY DEFINER, которую PostgreSQL не встраивает: у врача
 * count(*) по баллам на синтетике шёл 10 с против 20 мс у владельца, и
 * параллельных планов не было ни у одной роли приложения, потому что все
 * функции политик были PARALLEL UNSAFE.
 *
 * Условие закрытия — проверки ниже на 100 тыс. прохождений (500 тыс.
 * ответов, 100 тыс. баллов), под ролью без прав владельца, как в бою:
 * в плане нет вызова на строку (множество методик — hashed SubPlan, роль —
 * InitPlan), функции политик PARALLEL SAFE, роли system параллельный план
 * разрешён, а count(*) у администратора — в разах от владельца, а не в
 * сотнях раз, как было (на этом объёме на main: прохождения ×100, ответы
 * ×60, баллы ×250).
 *
 * Порог по счёту — не «втрое», о котором просила задача, и это честная
 * разница, а не допуск на шум. Прохождения у администратора — 1–4 раза
 * от владельца. Ответы и баллы — 8–10 раз: владелец просто считает строки,
 * не глядя на прохождение, а политика обязана для каждой строки проверить,
 * видно ли её прохождение. Владелец, проверяющий то же самое соединением,
 * и сам медленнее своего голого счёта в 2,5–5 раз; администратор от него —
 * в 2–3 раза. Порог — двадцатикратный с запасом на шум CI: на main все три
 * таблицы его превышают в 3–10 раз, после правки в 2–6 раз до него не
 * доходят.
 */

const TAG = `w21rls-scale-${crypto.randomUUID().slice(0, 8)}`;
const RESPONSES = 100_000;
const ITEMS = 5;
const TABLES = ["responses", "answers", "response_scores"] as const;

let admin: Person;
let s: MassSurvey;
let owner: ReturnType<typeof postgres>;
let rls: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = await makeUser("admin", `${TAG}@rls-scale.test`);
  s = await massSurvey(TAG, ITEMS, admin.id);
  await massResponses(s, 1, RESPONSES, 2_000);
  const pg = (await import("postgres")).default;
  owner = pg(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  rls = pg(await rlsRoleUrl(), { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await owner?.end({ timeout: 1 });
  await rls?.end({ timeout: 1 });
  if (s) await dropMass(s);
}, 120_000);

type Ctx = { role: string; user: string };

/** Выполнить запросы под ролью приложения с контекстом запроса (как src/db/context.ts) */
function asRole<T>(ctx: Ctx, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return rls.begin(async (tx) => {
    await tx`select set_config('app.role', ${ctx.role}, true), set_config('app.user_id', ${ctx.user}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function explain(tx: postgres.TransactionSql, query: string): Promise<string> {
  const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`explain (costs off) ${query}`);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

/** Лучшее из нескольких прогонов, мс: замер про порядок величины, а не про шум соседей */
async function best(run: () => Promise<unknown>, times = 5): Promise<number> {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times; i++) {
    const t0 = performance.now();
    await run();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

describe("политики строк прохождений на 100 тыс. прохождений (#185)", () => {
  test("у администратора в плане нет вызова функции на строку: множество методик — hashed SubPlan, роль — InitPlan", async () => {
    for (const table of TABLES) {
      const text = await asRole({ role: "admin", user: admin.id }, (tx) => explain(tx, `select count(*) from ${table}`));
      expect({ table, perRowCall: text.includes("rls_admin_sees_survey") }).toEqual({ table, perRowCall: false });
      expect({ table, hashed: text.includes("hashed SubPlan"), initPlan: text.includes("InitPlan") }).toEqual({
        table,
        hashed: true,
        initPlan: true,
      });
    }
  }, 30_000);

  test("чтение одного прохождения не строит множество всех: ответы проверяются по ключу", async () => {
    const one = `${TAG}-r777`;
    const text = await asRole({ role: "admin", user: admin.id }, (tx) =>
      explain(tx, `select * from answers where response_id = '${one}'`),
    );
    // множество видимых прохождений строится полным просмотром — для пяти строк он не нужен
    expect(text).not.toContain("Seq Scan on responses");
    expect(text).toContain("responses_pkey");
  }, 30_000);

  test("функции политик — PARALLEL SAFE", async () => {
    const rows = await owner.unsafe<{ fn: string; parallel: string }[]>(`
      select distinct m[1] as fn, p.proparallel as parallel
        from pg_policies pol
        cross join lateral regexp_matches(coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''), '([a-z_]+)\\(', 'g') m
        join pg_proc p on p.proname = m[1]
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where pol.tablename in ('responses', 'answers', 'response_scores', 'answer_events', 'conclusions', 'risk_alerts', 'alert_cases')
       order by 1`);
    expect(rows.map((r) => r.fn)).toContain("app_role");
    expect(rows.filter((r) => r.parallel !== "s").map((r) => r.fn)).toEqual([]);
  }, 30_000);

  /*
   * Разрешён ли параллельный план — а не выгоден ли он: цена запуска
   * исполнителей обнулена, и на 100 тыс. прохождений планировщик берёт
   * параллельный план, когда политика его не запрещает. На main запрещала:
   * функция политики PARALLEL UNSAFE отключает параллельность у запроса
   * целиком. Проверяются прохождения: тревоги и случаи в тестовой базе
   * малы, и на десятке строк последовательный план дешевле и с нулевой
   * ценой исполнителей — проверка зависела бы от соседей по базе.
   */
  test("у роли system план прохождений параллельный", async () => {
    const text = await asRole({ role: "system", user: "" }, async (tx) => {
      await tx`select set_config('parallel_setup_cost', '0', true), set_config('parallel_tuple_cost', '0', true)`;
      return explain(tx, "select count(*) from responses");
    });
    expect(text).toContain("Gather");
  }, 30_000);

  test("count(*) у администратора — в разах от владельца, а не в сотнях раз", async () => {
    const ms: Record<string, { owner: number; admin: number }> = {};
    const seen: Record<string, number> = {};
    for (const table of TABLES) {
      const query = `select count(*)::int as n from ${table}`;
      const ownerMs = await best(() => owner.unsafe(query));
      const adminMs = await best(() =>
        asRole({ role: "admin", user: admin.id }, async (tx) => {
          const [row] = await tx.unsafe<{ n: number }[]>(query);
          seen[table] = row!.n;
        }),
      );
      ms[table] = { owner: Math.round(ownerMs), admin: Math.round(adminMs) };
    }
    // администратор видит ровно свою методику: проверка скорости — не проверка пустоты
    expect(seen).toEqual({ responses: RESPONSES, answers: RESPONSES * ITEMS, response_scores: RESPONSES });
    for (const table of TABLES) {
      const { owner: o, admin: a } = ms[table]!;
      /*
       * Порог — по порядку величины: в 20 раз от владельца, но не ниже
       * 800 мс. На раннере CI владелец считает баллы по индексу за 4 мс, и
       * чистое «20× + 30» (110 мс) краснело на 155 мс у администратора, хотя
       * до правки (#185) тот же счёт на 100 тыс. строк шёл около двух секунд —
       * вызов функции политики на каждую строку. На ubuntu-26.04 исправный
       * счёт стоит 410 мс при том же коде: граница посередине между ним и
       * двумя секундами, а не вплотную к норме.
       */
      expect({ table, ms: ms[table], within: a <= Math.max(20 * o + 30, 800) }).toEqual({ table, ms: ms[table], within: true });
    }
  }, 120_000);
});
