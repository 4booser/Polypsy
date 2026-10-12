import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OpsSessionPage, OpsSessionsSummary } from "@quizzy/shared";
import { appApi, db, root, sql } from "./fixtures";

/**
 * Сессии на миллионе refresh-токенов (#202).
 *
 * Живая сессия — семья с неотозванным, непогашенным и неистёкшим токеном
 * (liveTokenCondition, lib/accounts.ts). Индекса под это условие не было:
 * сводка и список «Сесій» перебирали токены целиком (на цели ~1,3 млн
 * строк), а начало сессии — самый ранний токен семьи — читали по всей
 * семье, по строке на каждую ротацию. Миграция 0130: частичный индекс
 * живых токенов и индекс семьи со временем выдачи.
 *
 * Посев: 5 000 семей по 200 токенов (ротация каждые 15 минут), каждая
 * третья отозвана выходом, начала разнесены на 60 дней, срок — 30 дней от
 * выдачи. Живых семей — около 1 800, как и бывает: почти все строки —
 * погашенные ротацией. Уходит в afterAll.
 */

const TAG = `w22ses${crypto.randomUUID().slice(0, 8)}`;
const USERS = 100;
const FAMILIES = 5_000;
const PER_FAMILY = 200;
let userIds: string[] = [];
/** Живых семей посева: всего, у сотрудников и у одного человека */
let live = { total: 0, staff: 0, ofOne: 0 };

beforeAll(async () => {
  /* сто учёток: каждая десятая — сотрудник */
  const made = await db.execute<{ id: string }>(sql`
    insert into users (id, email, password_hash, first_name, last_name, role)
    select gen_random_uuid()::text, ${TAG} || '-' || g || '@sessions-scale.test', 'x', 'Т', 'Т',
           case when g % 10 = 0 then 'admin' else 'user' end
    from generate_series(0, ${USERS - 1}::int) g
    returning id`);
  const ordered = await db.execute<{ id: string }>(sql`
    select id from users where email like ${`${TAG}-%`} order by split_part(split_part(email, '@', 1), '-', 2)::int`);
  userIds = [...ordered].map((r) => r.id);
  expect([...made]).toHaveLength(USERS);

  await db.execute(sql`
    insert into refresh_tokens (id, user_id, token_hash, family_id, created_at, expires_at, rotated_at, revoked_at)
    select ${TAG} || '-' || f || '-' || k,
           (${sql.raw(`array[${userIds.map((id) => `'${id}'`).join(",")}]`)})[1 + f % ${USERS}],
           md5(${TAG} || f || '-' || k) || md5(k || '-' || f || ${TAG}),
           ${TAG} || '-fam-' || f,
           now() - (f % 60) * interval '1 day' + k * interval '15 minutes',
           now() - (f % 60) * interval '1 day' + k * interval '15 minutes' + interval '30 days',
           case when k < ${PER_FAMILY - 1} then now() - (f % 60) * interval '1 day' + (k + 1) * interval '15 minutes' end,
           case when f % 3 = 0 then now() - (f % 60) * interval '1 day' + ${PER_FAMILY} * interval '15 minutes' end
    from generate_series(1, ${FAMILIES}::int) f, generate_series(0, ${PER_FAMILY - 1}::int) k`);
  await db.execute(sql`vacuum analyze refresh_tokens`);

  const [counts] = await db.execute<{ total: number; staff: number; one: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where u.role = 'admin')::int as staff,
           count(*) filter (where u.id = ${userIds[1]!})::int as one
      from refresh_tokens t join users u on u.id = t.user_id
     where t.family_id like ${`${TAG}-fam-%`}
       and t.revoked_at is null and t.rotated_at is null and t.expires_at > now()`);
  live = { total: Number(counts!.total), staff: Number(counts!.staff), ofOne: Number(counts!.one) };
  expect(live.total).toBeGreaterThan(1000);
  expect(live.staff).toBeGreaterThan(0);
  expect(live.ofOne).toBeGreaterThan(0);

  /* первое чтение после посева — с диска; замеряется второе, как у техпанели, открытой не впервые */
  await appApi("/api/ops/sessions/summary", root.token);
  await appApi("/api/ops/sessions?per=100", root.token);
}, 300_000);

afterAll(async () => {
  await db.execute(sql`delete from refresh_tokens where family_id like ${`${TAG}-fam-%`}`);
  await db.execute(sql`delete from users where email like ${`${TAG}-%`}`);
  // миллион мёртвых строк не должен доставаться соседям полным просмотром
  await db.execute(sql`vacuum analyze refresh_tokens`);
}, 300_000);

async function timed<T>(path: string) {
  const t0 = performance.now();
  const res = await appApi<T>(path, root.token);
  return { ...res, ms: performance.now() - t0 };
}

/*
 * Порог — 300 мс, строже секунды из условия задачи: перебор миллиона
 * токенов идёт здесь около секунды (на прежнем коде — 1,0 с у сводки и у
 * списка), по индексу — десятки миллисекунд. Секундный порог прежний код
 * проходил бы впритык.
 */
const FAST_MS = 300;

describe("сессии на миллионе refresh-токенов (#202)", () => {
  test("сводка живых сессий — быстро, посев в ней весь", async () => {
    const res = await timed<OpsSessionsSummary>("/api/ops/sessions/summary");
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(FAST_MS);
    const admins = res.body.byRole.find((r) => r.role === "admin")!.sessions!;
    const staff = res.body.byAge.find((g) => g.group === "staff")!.total!;
    // в базе бывают и чужие сессии (соседние файлы входят), но посев — весь
    expect(admins).toBeGreaterThanOrEqual(live.staff);
    expect(staff).toBeGreaterThanOrEqual(live.staff);
  }, 30_000);

  test("список «Сесій» целиком — быстро", async () => {
    const res = await timed<OpsSessionPage>("/api/ops/sessions?per=100");
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(FAST_MS);
    expect(res.body.total).toBeGreaterThanOrEqual(live.total);
    expect(res.body.items).toHaveLength(100);
  }, 30_000);

  test("положительный контроль: сессии одного человека — ровно его живые семьи, начало — первый токен семьи", async () => {
    const res = await timed<OpsSessionPage>(`/api/ops/sessions?userId=${userIds[1]}&per=100`);
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(FAST_MS);
    expect(res.body.total).toBe(live.ofOne);
    for (const s of res.body.items) {
      // семья — двести токенов по 15 минут: от начала до последней выдачи 199 × 15 минут
      const span = Date.parse(s.lastUsedAt) - Date.parse(s.startedAt);
      expect(span).toBe((PER_FAMILY - 1) * 15 * 60_000);
    }
  }, 30_000);
});
