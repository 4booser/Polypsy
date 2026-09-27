import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { ConditionsResult, OverviewAnalytics, Severity } from "@quizzy/shared";
import { api, db, eq, makeUser, root, sql, users, type Person } from "./fixtures";
import { responseScores, responses, scales, surveyVersions, surveys } from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";
import {
  CONDITION_DOMAINS,
  allSources,
  overallSpread,
  summarizeDomain,
  type Measurement,
} from "../src/lib/conditions";
import { env } from "../src/env";
import { percent } from "../src/lib/stats";

/**
 * Сводки считаются в базе — и числа при этом не сдвинулись.
 *
 * Внешний разбор: «сводная аналитика загружала тысячи строк в память ради
 * счётчиков, которые можно вычислить в SQL». У сводки по методикам
 * (/api/analytics/overview) это исправлено давно; у «Зведення» (состояние
 * по направлениям, /api/dashboard/conditions) — в этой волне: там шла строка
 * на человека и шкалу и ещё строка на человека ради худшей ступени.
 *
 * Перенос счёта — ровно то место, где число может молча уехать: чуть другой
 * порядок при равенстве, другое правило «последнего», округление. Поэтому
 * проверка не пересказывает ожидания руками, а считает ПРЕЖНИМ способом —
 * выбирает те же строки и складывает их в приложении — и сверяет с ответом
 * маршрута на одних и тех же посевных данных.
 *
 * Данные — случайные, но с закреплённым зерном: разбросанные ступени, пустые
 * полосы, несколько методик одного направления у одного человека, равные
 * моменты сдачи. Именно на таких краях новый подсчёт и мог бы разойтись.
 */

/** Детерминированный генератор: повтор запуска — повтор данных */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Seed {
  surveyId: string;
  versionId: string;
  scaleId: string;
}
const seeds = new Map<string, Seed>();

async function seedOf(catalogKey: string, code: string): Promise<Seed> {
  const k = `${catalogKey}:${code}`;
  const hit = seeds.get(k);
  if (hit) return hit;
  const [s] = await db.select().from(surveys).where(eq(surveys.catalogKey, catalogKey));
  if (!s) throw new Error(`методика каталога «${catalogKey}» не установлена`);
  const [v] = await db
    .select()
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, s.id))
    .orderBy(sql`${surveyVersions.version} desc`)
    .limit(1);
  const [sc] = await db.select().from(scales).where(sql`${scales.versionId} = ${v!.id} and ${scales.code} = ${code}`);
  if (!sc) throw new Error(`у «${catalogKey}» нет шкалы ${code}`);
  const seed = { surveyId: s.id, versionId: v!.id, scaleId: sc.id };
  seeds.set(k, seed);
  return seed;
}

async function measure(who: Person, catalogKey: string, code: string, severity: Severity | null, percent: number, at: string) {
  const seed = await seedOf(catalogKey, code);
  const responseId = crypto.randomUUID();
  await db.insert(responses).values({
    id: responseId,
    surveyId: seed.surveyId,
    userId: who.id,
    status: "completed",
    versionId: seed.versionId,
    startedAt: at,
    submittedAt: at,
    durationMs: Math.round(percent * 1000),
  } as never);
  await db.insert(responseScores).values({
    id: crypto.randomUUID(),
    responseId,
    scaleId: seed.scaleId,
    rawScore: percent,
    value: percent,
    normalization: "raw",
    maxScore: 100,
    percent,
    normalized: true,
    bandLabel: severity,
    severity,
  } as never);
}

const SEVERITIES: (Severity | null)[] = ["none", "mild", "moderate", "severe", null];

/** Посеянные люди — чтобы увести их замеры после проверки (см. afterAll) */
const people: string[] = [];

beforeAll(async () => {
  await installCatalog();
  const rand = prng(20260926);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const pairs = allSources();

  /*
   * Сорок человек, у каждого — от одного до пяти замеров по случайным
   * источникам направлений, за последние сто дней (часть выпадает из
   * периода 30 и даже 90). Каждый пятый замер делит момент сдачи с
   * предыдущим — так проверяется правило «при равном времени — первый по
   * методике и шкале» между РАЗНЫМИ шкалами направления. Одну и ту же шкалу
   * один человек в один момент дважды не сдаёт: там «последний» решает уже
   * идентификатор прохождения, и это проверяет не посев, а сам запрос.
   */
  let lastAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  for (let i = 0; i < 40; i++) {
    const person = await makeUser("user", `agg-${i}-${crypto.randomUUID()}@summary.test`);
    people.push(person.id);
    const taken = new Set<string>();
    const n = 1 + Math.floor(rand() * 5);
    for (let j = 0; j < n; j++) {
      const src = pick(pairs);
      const at = rand() < 0.2 ? lastAt : new Date(Date.now() - Math.floor(rand() * 100 * 86_400_000)).toISOString();
      const key = `${src.catalogKey}:${src.code}:${at}`;
      if (taken.has(key)) continue;
      taken.add(key);
      lastAt = at;
      const percent = Math.round(rand() * 1000) / 10;
      await measure(person, src.catalogKey, src.code, pick(SEVERITIES), percent, at);
    }
  }
}, 180_000); // каталог и сорок учётных записей с argon2 — не пять секунд

/*
 * Посев уводится за пределы любого периода сводки (больше года назад).
 * Проверки «Зведення» в соседнем файле считают людей по направлениям точно
 * и рассчитывают на свои замеры; сорок чужих человек с каталожными шкалами
 * сдвинули бы их числа — в зависимости от того, в каком порядке CI обходит
 * файлы. Удалять прохождения незачем: за пределами года их не видит ни
 * одна сводка, а счёт «всего» у сводки по методикам сверяется выше, до ухода.
 */
afterAll(async () => {
  if (!people.length) return;
  const away = new Date(Date.now() - 4 * 365 * 86_400_000).toISOString();
  await db
    .update(responses)
    .set({ submittedAt: away, startedAt: away } as never)
    .where(inArray(responses.userId, people));
});

/**
 * Прежний способ «Зведення»: строка на человека и шкалу — и счёт в приложении.
 *
 * Запрос — тот, что стоял в маршруте до переноса, с одной добавкой: `r.id`
 * последним ключом, как теперь и в маршруте. Без неё «последний» из двух
 * замеров одной шкалы с одинаковым временем база выбирает произвольно — и
 * прежний, и новый запрос, каждый по-своему, — и сверять было бы нечего.
 *
 * И с правилом «кого считаем» волны 12 (lib/population.ts): недостоверный
 * протокол и прохождение сотрудника на себя в «Зведення» не идут. Правило
 * здесь повторено руками, а не взято из маршрута: сверка с самим собой
 * ничего бы не проверяла.
 */
const COUNTED = sql`and r.reliable and not exists (select 1 from users su where su.id = r.user_id and su.role <> 'user')`;
async function conditionsTheOldWay(since: string): Promise<Pick<ConditionsResult, "domains" | "overall">> {
  const pairs = sql.join(
    allSources().map((s) => sql`(${s.catalogKey}, ${s.code})`),
    sql`, `,
  );
  const measured = await db.execute<{
    user_id: string;
    survey_id: string;
    catalog_key: string | null;
    code: string;
    severity: Severity | null;
    percent: number;
    at: string;
  } & Record<string, unknown>>(sql`
    select distinct on (r.user_id, r.survey_id, sc.code)
      r.user_id, r.survey_id, s.catalog_key, sc.code, rs.severity,
      rs.percent::float8 as percent, r.submitted_at as at
    from responses r
    join surveys s on s.id = r.survey_id
    join response_scores rs on rs.response_id = r.id
    join scales sc on sc.id = rs.scale_id
    where r.status = 'completed'
      and r.user_id is not null
      and r.submitted_at is not null
      and r.submitted_at >= ${since}
      ${COUNTED}
      and (s.catalog_key, sc.code) in (${pairs})
    order by r.user_id, r.survey_id, sc.code, r.submitted_at desc, r.id desc
  `);
  const rows: Measurement[] = [...measured].map((r) => ({
    userId: String(r.user_id),
    surveyId: String(r.survey_id),
    catalogKey: r.catalog_key ? String(r.catalog_key) : null,
    code: String(r.code),
    severity: (r.severity ?? null) as Severity | null,
    percent: Number(r.percent),
    at: new Date(String(r.at)).toISOString(),
  }));
  const weekly = () => [];
  const titleOf = () => "";
  const domains = CONDITION_DOMAINS.map((def) => summarizeDomain(def, { rows, titleOf, weekly })).filter(
    (d) => d.sources.length > 0,
  );

  const worstRows = await db.execute<{ user_id: string; worst: number | null } & Record<string, unknown>>(sql`
    with latest as (
      select distinct on (r.user_id, r.survey_id, sc.code)
        r.user_id, rs.severity
      from responses r
      join response_scores rs on rs.response_id = r.id
      join scales sc on sc.id = rs.scale_id
      where r.status = 'completed'
        and r.user_id is not null
        and r.submitted_at is not null
        and r.submitted_at >= ${since}
        and sc.kind = 'clinical'
        ${COUNTED}
      order by r.user_id, r.survey_id, sc.code, r.submitted_at desc, r.id desc
    )
    select user_id,
           max(case severity when 'severe' then 4 when 'moderate' then 3 when 'mild' then 2 when 'none' then 1 end) as worst
    from latest
    group by user_id
  `);
  const LEVEL: Record<number, Severity> = { 1: "none", 2: "mild", 3: "moderate", 4: "severe" };
  const overall = overallSpread([...worstRows].map((r) => (r.worst === null ? null : (LEVEL[Number(r.worst)] ?? null))));
  return { domains, overall };
}

/** Что сверяется: всё, кроме названий и хода по неделям — их считает прежний, нетронутый запрос */
const comparable = (d: ConditionsResult["domains"][number]) => ({
  domain: d.domain,
  higherIsWorse: d.higherIsWorse,
  people: d.people,
  spread: d.spread,
  primary: d.primary ? { surveyId: d.primary.surveyId, people: d.primary.people, meanPercent: d.primary.meanPercent } : null,
  sources: d.sources.map((s) => s.surveyId),
});

describe("«Зведення»: счёт в базе совпадает с прежним счётом в приложении", () => {
  for (const days of [30, 90, 365]) {
    test(`период ${days} дней`, async () => {
      const res = await api<ConditionsResult>(`/api/dashboard/conditions?days=${days}`, root.token);
      expect(res.status).toBe(200);
      const old = await conditionsTheOldWay(res.body.since);

      // посев обязан до чего-то дотянуться — иначе совпадение пустоты с пустотой
      expect(old.domains.length).toBeGreaterThan(0);
      expect(res.body.domains.map(comparable)).toEqual(old.domains.map(comparable));
      expect(res.body.overall).toEqual(old.overall);
    });
  }
});

/**
 * Прежний способ сводки по методикам — все прохождения и все баллы в память.
 * Так маршрут и работал до переноса в базу (волна 1); здесь — эталон.
 *
 * С правилами волны 12, повторёнными руками: прохождение сотрудника на себя —
 * не прохождение пациента; выраженность — только содержательные шкалы
 * достоверных протоколов, недостоверные — отдельным числом.
 */
async function overviewTheOldWay() {
  const staff = new Set(
    (await db.select({ id: users.id }).from(users).where(sql`${users.role} <> 'user'`)).map((u) => u.id),
  );
  const clinical = new Set(
    (await db.select({ id: scales.id }).from(scales).where(eq(scales.kind, "clinical"))).map((s) => s.id),
  );
  const all = (await db.select().from(responses)).filter((r) => !r.userId || !staff.has(r.userId));
  const trusted = new Set(all.filter((r) => r.status === "completed" && r.reliable).map((r) => r.id));
  const scores = (
    await db
      .select({ severity: responseScores.severity, responseId: responseScores.responseId, scaleId: responseScores.scaleId })
      .from(responseScores)
  ).filter((s) => trusted.has(s.responseId) && clinical.has(s.scaleId));
  const completed = all.filter((r) => r.status === "completed");
  const timed = completed.filter((r) => (r.durationMs ?? 0) > 0);
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.institutionTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const timeline = new Map<string, number>();
  for (const r of completed) {
    if (!r.submittedAt) continue;
    const d = day.format(new Date(r.submittedAt));
    timeline.set(d, (timeline.get(d) ?? 0) + 1);
  }
  const bySurvey = new Map<string, number>();
  for (const r of completed) bySurvey.set(r.surveyId, (bySurvey.get(r.surveyId) ?? 0) + 1);

  const severities = new Map<string, number>();
  for (const s of scores) if (s.severity) severities.set(s.severity, (severities.get(s.severity) ?? 0) + 1);

  return {
    responseCount: completed.length,
    started: all.length,
    respondentCount: new Set(completed.map((r) => r.userId).filter((x) => x !== null)).size,
    avgDurationMs: timed.length ? Math.round(timed.reduce((s, r) => s + (r.durationMs ?? 0), 0) / timed.length) : 0,
    timeline: [...timeline.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count })),
    bySurvey,
    severities,
    unreliable: completed.filter((r) => !r.reliable).length,
  };
}

describe("сводка по методикам: счёт в базе совпадает с подсчётом по строкам", () => {
  test("суперадмин — все методики", async () => {
    const res = await api<OverviewAnalytics>("/api/analytics/overview", root.token);
    expect(res.status).toBe(200);
    const old = await overviewTheOldWay();

    expect(old.responseCount).toBeGreaterThan(0);
    expect(res.body.responseCount).toBe(old.responseCount);
    expect(res.body.respondentCount).toBe(old.respondentCount);
    expect(res.body.avgDurationMs).toBe(old.avgDurationMs);
    expect(res.body.completionRate).toBe(percent(old.responseCount, old.started));
    expect(res.body.timeline).toEqual(old.timeline);
    expect(res.body.unreliableCount).toBe(old.unreliable);

    for (const s of res.body.severityBreakdown) expect(s.count).toBe(old.severities.get(s.severity) ?? 0);
    expect(res.body.severityBreakdown.reduce((sum, s) => sum + s.count, 0)).toBe(
      [...old.severities.values()].reduce((a, b) => a + b, 0),
    );

    /*
     * Первая десятка: у каждой показанной методики число — её настоящее, и ни
     * одна непоказанная не обгоняет последнюю показанную. Порядок внутри
     * ничьей база не обещает, поэтому он и не сверяется.
     */
    const shown = new Set(res.body.topSurveys.map((s) => s.surveyId));
    for (const s of res.body.topSurveys) expect(s.responseCount).toBe(old.bySurvey.get(s.surveyId) ?? 0);
    const floor = Math.min(...res.body.topSurveys.map((s) => s.responseCount));
    for (const [id, n] of old.bySurvey) if (!shown.has(id)) expect(n).toBeLessThanOrEqual(floor);
  });
});
