import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SurveyAnalytics } from "@quizzy/shared";
import { appApi, createSurveySchema, createVersion, db, eq, makeUser, sql, sr45, type Person } from "./fixtures";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
import { groupAdmins, surveyGroups, surveys } from "../src/db/schema";

/**
 * Аналитика методики на объёме (#187).
 *
 * Маршрут /api/analytics/surveys/:id выбирал в память все прохождения
 * среза, все их ответы, баллы и ВСЮ ленту событий ответов (select * без
 * предела) и раскладывал это в JS; альфа и показатели пунктов считались по
 * всем прохождениям. PHQ-9 за год на синтетике — 20 с и +1,1 ГБ у
 * суперадмина, 56 с и +1,35 ГБ у врача.
 *
 * Условие закрытия — второй блок: 50 тыс. прохождений по девять пунктов с
 * лентой событий, под ролью приложения — быстрее 5 с и прирост памяти
 * процесса меньше 200 МБ.
 *
 * Первый блок — положительный контроль: на двух наборах ответ совпадает с
 * эталоном, снятым с кода main (test/golden/surveyAnalytics.json, снимается
 * WRITE_GOLDEN=1). Набор Г1 — три тысячи прохождений с лентой событий,
 * пропусками, недостоверными и брошенными: больше выборок альфы и ленты
 * событий (по 2000), поэтому надёжность и SEM, время до первого выбора и
 * доля передумавших, которые по замыслу считаются по выборке, сверяются с
 * допуском; остальное — точно. Набор Г2 — СР-45 с ключевыми пунктами
 * (person-fit, флаги качества), меньше выборок — совпадает целиком.
 */

const TAG = `w21-an-${crypto.randomUUID().slice(0, 8)}`;
const GOLDEN = new URL("./golden/surveyAnalytics.json", import.meta.url).pathname;
const WRITE = process.env.WRITE_GOLDEN === "1";

let staff: Person;
let g1: MassSurvey;
let g2: { surveyId: string; groupId: string; versionId: string };
let perf: MassSurvey;

/* ─────────── посев ─────────── */

/** Лента событий: выбор у каждого ответа, показ и «передумал» — у каждого четвёртого (полтора события на ответ, как на синтетике) */
async function massEvents(s: MassSurvey, from: number, count: number): Promise<void> {
  await db.execute(sql`
    insert into answer_events (id, response_id, question_id, sequence, kind, elapsed_ms, at)
    select ${s.tag} || '-r' || g || '-e' || q.i || '-' || k, ${s.tag} || '-r' || g, q.x ->> 'id',
           q.i * 3 + k, (array['shown', 'set', 'change'])[k + 1],
           case k when 0 then 0 when 1 then 300 + ((g * 13 + q.i * 7) % 2500) else 900 + ((g + q.i) % 1500) end,
           timestamptz '2025-01-01 00:00+00' + g * interval '7 minutes' + (q.i * 3 + k) * interval '1 second'
    from generate_series(${from}::int, ${from + count - 1}::int) g,
         jsonb_array_elements(${JSON.stringify(s.items)}::jsonb) with ordinality as q(x, i),
         generate_series(0, 2) k
    where k = 1 or (k = 2 and (g + q.i) % 4 = 0) or (k = 0 and (g + q.i) % 4 = 1)`);
}

/** Г1: связанные пункты (альфа осмысленна), пропуски, брошенные и незавершённые, быстрые — каждое сороковое */
async function shapeG1(s: MassSurvey): Promise<void> {
  await db.execute(sql`
    update answers a set duration_ms = a.duration_ms + 1500
      from responses r
     where r.id = a.response_id and r.survey_id = ${s.surveyId} and substring(r.id from '-r([0-9]+)$')::int % 40 <> 0`);
  await db.execute(sql`
    update answers a
       set option_ids = jsonb_build_array(q.x -> 'options' ->> (case when q.i = 3 then (r.g + r.g / 5) % 4 else r.g % 4 end)::int),
           score = (case when q.i = 3 then (r.g + r.g / 5) % 4 else r.g % 4 end)
      from (select id, substring(id from '-r([0-9]+)$')::int as g from responses where survey_id = ${s.surveyId}) r,
           jsonb_array_elements(${JSON.stringify(s.items)}::jsonb) with ordinality as q(x, i)
     where a.response_id = r.id and a.question_id = q.x ->> 'id'`);
  await db.execute(sql`
    update answers set skipped = true, option_ids = null, score = null
     where response_id in (select id from responses where survey_id = ${s.surveyId} and substring(id from '-r([0-9]+)$')::int % 17 = 0)
       and id like '%-a2'`);
  await db.execute(sql`
    update responses set status = case when substring(id from '-r([0-9]+)$')::int % 29 = 0 then 'in_progress' else 'abandoned' end,
                         submitted_at = null
     where survey_id = ${s.surveyId}
       and (substring(id from '-r([0-9]+)$')::int % 29 = 0 or substring(id from '-r([0-9]+)$')::int % 31 = 0)`);
  await db.execute(sql`
    delete from response_scores where response_id in (select id from responses where survey_id = ${s.surveyId} and status <> 'completed')`);
  await db.execute(sql`
    delete from answers
     where response_id in (select id from responses where survey_id = ${s.surveyId} and status <> 'completed')
       and (id like '%-a3' or (substring(response_id from '-r([0-9]+)$')::int % 2 = 0 and id like '%-a2'))`);
}

/** Г2: СР-45 через обычный конвейер версии, прохождения — посевом: профили по уровню, перевёрнутые, быстрые */
async function seedG2(adminId: string): Promise<typeof g2> {
  const tag = `${TAG}-g2`;
  const groupId = `${tag}-group`;
  const surveyId = `${tag}-survey`;
  await db.insert(surveyGroups).values({ id: groupId, title: `Еталон ${tag}`, createdBy: adminId });
  await db.insert(groupAdmins).values({ groupId, userId: adminId, addedBy: adminId });
  const input = createSurveySchema.parse(sr45);
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: input.title,
    administration: "self",
    status: "published",
    publishedAt: "2025-01-01T00:00:00.000Z",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminId,
  } as never);
  await createVersion(surveyId, input, adminId, "v1");
  const [survey] = await db.select().from(surveys).where(eq(surveys.id, surveyId));
  const versionId = survey!.currentVersionId!;
  await db.execute(sql`
    insert into users (id, email, password_hash, first_name, last_name, role)
    select ${tag} || '-u' || n, ${tag} || '-u' || n || '@golden.test', 'посів-без-входу', 'Еталон', 'Особа' || n, 'user'
    from generate_series(1, 40) n`);
  await db.execute(sql`
    insert into responses (id, survey_id, user_id, status, version_id, started_at, submitted_at, duration_ms, reliable)
    select ${tag} || '-r' || g, ${surveyId}, ${tag} || '-u' || (1 + g % 40), 'completed', ${versionId},
           timestamptz '2025-02-01 00:00+00' + g * interval '3 hours',
           timestamptz '2025-02-01 00:00+00' + g * interval '3 hours' + interval '5 minutes',
           case when g % 25 = 0 then 20000 else 200000 end, g % 23 <> 0
    from generate_series(1, 300) g`);
  await db.execute(sql`
    with qs as (
      select q.id, q.position, row_number() over (order by q.position) - 1 as qi, count(*) over () as total,
             (select o.id from options o where o.question_id = q.id and o.key_code = 'yes' limit 1) as yes,
             (select o.id from options o where o.question_id = q.id and o.key_code = 'no' limit 1) as no
        from questions q where q.version_id = ${versionId} and q.type <> 'info')
    insert into answers (id, response_id, question_id, option_ids, score, duration_ms, change_count)
    select ${tag} || '-r' || g || '-a' || qs.qi, ${tag} || '-r' || g, qs.id,
           jsonb_build_array(case
             when g % 37 = 0 then case when qs.qi::float / qs.total > 0.6 then qs.yes else qs.no end
             else case when qs.qi::float / qs.total < (g % 10) / 10.0 then qs.yes else qs.no end end),
           0, case when g % 9 = 0 then 300 else 1200 end + (g * 17 + qs.qi * 29) % 3000, (g + qs.qi) % 3
    from generate_series(1, 300) g, qs`);
  await db.execute(sql`
    insert into response_scores (id, response_id, scale_id, raw_score, value, normalization, max_score, percent, normalized)
    select ${tag} || '-r' || g || '-s-' || sc.code, ${tag} || '-r' || g, sc.id, (g * 7 + length(sc.code)) % 20,
           (g * 7 + length(sc.code)) % 20, 'raw', 45, ((g * 7 + length(sc.code)) % 20) * 100.0 / 45, false
    from generate_series(1, 300) g, scales sc where sc.version_id = ${versionId}`);
  await db.execute(sql`analyze users, responses, answers, response_scores, answer_events`);
  return { surveyId, groupId, versionId };
}

/* ─────────── сверка с эталоном ─────────── */

/**
 * Ответ без случайных идентификаторов: каждый uuid и каждая строка с меткой
 * прогона — порядковым знаком по первому появлению. Порядок ответа
 * детерминирован, значит, и знаки.
 */
function canonical(body: unknown): unknown {
  const seen = new Map<string, string>();
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      if (!id.test(x) && !x.startsWith(TAG)) return x.replaceAll(TAG, "<прогон>");
      if (!seen.has(x)) seen.set(x, `#${seen.size + 1}`);
      return seen.get(x);
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(body);
}

/** Поля, которые по замыслу считаются по выборке прохождений, — отдельно от остального */
function split(body: SurveyAnalytics) {
  const sampled = body.scales.map((s) => ({ reliability: s.reliability, measurement: s.measurement }));
  const rest = { ...body, scales: body.scales.map((s) => ({ ...s, reliability: null, measurement: null })) };
  return { sampled, rest };
}

async function analytics(surveyId: string): Promise<{ body: SurveyAnalytics; ms: number; peakMb: number }> {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  const t0 = performance.now();
  const res = await appApi<SurveyAnalytics>(`/api/analytics/surveys/${surveyId}`, staff.token);
  const ms = performance.now() - t0;
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);
  expect(res.status).toBe(200);
  return { body: res.body, ms, peakMb: (peak - base) / 1048576 };
}

beforeAll(async () => {
  staff = await makeUser("superadmin", `${TAG}@analytics-scale.test`);
}, 30_000);

afterAll(async () => {
  for (const s of [g1, perf]) if (s) await dropMass(s);
  if (g2) {
    await db.execute(sql`delete from surveys where id = ${g2.surveyId}`);
    await db.execute(sql`delete from users where id like ${`${TAG}-g2-u%`}`);
    await db.execute(sql`delete from survey_groups where id = ${g2.groupId}`);
  }
}, 120_000);

describe("эталон: ответ тот же, что до правки", () => {
  beforeAll(async () => {
    g1 = await massSurvey(`${TAG}-g1`, 3, staff.id);
    await massResponses(g1, 1, 3_000, 300);
    await massEvents(g1, 1, 3_000);
    await shapeG1(g1);
    g2 = await seedG2(staff.id);
  }, 120_000);

  test("Г1 (3 тыс., события, пропуски, брошенные) и Г2 (СР-45, person-fit)", async () => {
    const one = split((await analytics(g1.surveyId)).body);
    const two = (await analytics(g2.surveyId)).body;
    const actual = { g1: canonical(one.rest), g1Sampled: canonical(one.sampled), g2: canonical(two) };
    if (WRITE) {
      await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
      return;
    }
    const golden = await Bun.file(GOLDEN).json();
    expect(withoutEvents(actual.g1)).toEqual(withoutEvents(golden.g1));
    expectEventsNear(actual.g1, golden.g1);
    expect(actual.g2).toEqual(golden.g2);
    expectNear(actual.g1Sampled, golden.g1Sampled);
  }, 60_000);
});

/** Поля пункта, которые считаются по ленте событий выборки (EVENT_SAMPLE в routes/analytics.ts) */
const EVENT_FIELDS = ["avgTimeToFirstAnswerMs", "changedShare"] as const;

type Canon = { questions: Record<string, number | null>[] } & Record<string, unknown>;

function withoutEvents(body: unknown): unknown {
  const b = body as Canon;
  return { ...b, questions: b.questions.map((q) => ({ ...q, avgTimeToFirstAnswerMs: null, changedShare: null })) };
}

/**
 * Время до первого выбора и доля передумавших Г1 — по ленте 2000 последних
 * прохождений против всех 3000 в эталоне. Доля «передумавших» в посеве —
 * каждый четвёртый ответ, время до выбора — равномерно от 300 до 2800 мс:
 * на двух тысячах прохождений (шесть тысяч ответов на пункт) ошибка доли —
 * доли процента, среднего времени — около десяти миллисекунд. Допуск — 2
 * п.п. и 5 %.
 */
function expectEventsNear(actual: unknown, golden: unknown): void {
  const a = (actual as Canon).questions;
  const g = (golden as Canon).questions;
  for (const [i, q] of a.entries()) {
    for (const field of EVENT_FIELDS) {
      const x = q[field];
      const y = g[i]![field];
      expect(x === null).toBe(y === null);
      if (x === null || y === null || x === undefined || y === undefined) continue;
      const limit = field === "changedShare" ? 2 : 0.05 * Math.abs(y);
      expect(Math.abs(x - y)).toBeLessThanOrEqual(limit);
    }
  }
}

/**
 * Надёжность и SEM Г1 — по выборке из 2000 последних прохождений против
 * всех 3000 в эталоне. Альфа и ω — до 0,03: стандартная ошибка альфы на двух
 * тысячах прохождений ≈ 0,01. Корреляции пунктов и «альфа без пункта» — до
 * 0,05, дисперсия пункта и доля срабатывания — до 10 % от значения, SEM и
 * MDC — до 5 %. Число наблюдений выборки — ровно столько, сколько полных
 * строк среди 2000 последних.
 */
function expectNear(actual: unknown, golden: unknown): void {
  const a = actual as { reliability: Record<string, unknown> | null; measurement: Record<string, unknown> | null }[];
  const g = golden as typeof a;
  expect(a).toHaveLength(g.length);
  for (const [i, ra] of a.entries()) {
    const rg = g[i]!;
    expect(ra.reliability === null).toBe(rg.reliability === null);
    if (ra.reliability && rg.reliability) {
      expect(ra.reliability.itemCount).toBe(rg.reliability.itemCount);
      expect(Number(ra.reliability.sampleN)).toBeLessThanOrEqual(2000);
      expect(Math.abs(Number(ra.reliability.alpha) - Number(rg.reliability.alpha))).toBeLessThan(0.03);
      expect(Math.abs(Number(ra.reliability.omega ?? 0) - Number(rg.reliability.omega ?? 0))).toBeLessThan(0.03);
      const ia = ra.reliability.items as Record<string, number>[];
      const ig = rg.reliability.items as Record<string, number>[];
      for (const [j, item] of ia.entries()) {
        expect(Math.abs(item.itemTotalCorrelation! - ig[j]!.itemTotalCorrelation!)).toBeLessThan(0.05);
        expect(Math.abs((item.alphaIfDeleted ?? 0) - (ig[j]!.alphaIfDeleted ?? 0))).toBeLessThan(0.05);
        expect(Math.abs(item.variance! - ig[j]!.variance!)).toBeLessThanOrEqual(0.1 * Math.abs(ig[j]!.variance!) + 0.01);
        expect(Math.abs((item.endorsement ?? 0) - (ig[j]!.endorsement ?? 0))).toBeLessThanOrEqual(
          0.1 * Math.abs(ig[j]!.endorsement ?? 0) + 0.5,
        );
      }
    }
    expect(ra.measurement === null).toBe(rg.measurement === null);
    if (ra.measurement && rg.measurement) {
      for (const key of ["sem", "mdc95"]) {
        const x = Number(ra.measurement[key]);
        const y = Number(rg.measurement[key]);
        expect(Math.abs(x - y)).toBeLessThanOrEqual(0.05 * Math.abs(y) + 0.01);
      }
    }
  }
}

describe("50 тыс. прохождений по девять пунктов с лентой событий", () => {
  beforeAll(async () => {
    perf = await massSurvey(`${TAG}-p`, 9, staff.id);
    // время на пункте — от полутора секунд, как на синтетике: флаги качества — редкость, а не каждый четвёртый
    await massResponses(perf, 1, 50_000, 5_000, 1_500);
    await massEvents(perf, 1, 50_000);
    await db.execute(sql`analyze answer_events`);
  }, 180_000);

  test("быстрее 5 с, память процесса растёт меньше чем на 200 МБ", async () => {
    const { body, ms, peakMb } = await analytics(perf.surveyId);
    expect(body.completed).toBe(50_000);
    expect(body.questions).toHaveLength(9);
    // лента событий учтена: время до первого выбора и доля передумавших — из неё
    expect(body.questions[0]!.avgTimeToFirstAnswerMs).not.toBeNull();
    expect(body.questions[0]!.changedShare).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5_000);
    expect(peakMb).toBeLessThan(200);
  }, 120_000);
});
