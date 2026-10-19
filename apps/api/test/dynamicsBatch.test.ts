import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { RespondentDynamics } from "@quizzy/shared";
import { appApi, createSurveySchema, createVersion, db, eq, makeUser, sql, type Person } from "./fixtures";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { withDbContext } from "../src/db/context";
import { systemInIndexOrder } from "../src/db/latest";
import { options, questions, scales, surveyVersions } from "../src/db/schema";
import { alphasOf, normativeSamples } from "../src/lib/changeBasis";
import { requestSql } from "../src/lib/opsSql";
import { referenceSampleSets, referenceSamples, type SampleTarget } from "../src/lib/referenceSample";
import { getSurvey, surveysAtVersions, versionKey } from "../src/lib/surveys";

/**
 * Динамика человека читает выборки всех его методик пачкой (волна 27).
 *
 * Прежде нормативная выборка, выборка перцентиля и альфа читались запросом
 * на каждую методику и версию человека — по семь обращений к базе на
 * методику, на карточке с семью методиками за двести, — и каждое под
 * транзакцией запроса. Теперь — одним запросом на вид выборки, сколько бы
 * методик и версий ни было. Здесь проверяется, что пачка ничего не
 * смешивает и ничего не теряет:
 *
 *  — динамика по всем методикам сразу отдаёт по каждой ровно то же, что
 *    динамика по ней одной (?survey=), — у человека две методики, у второй
 *    две версии;
 *  — каждая выборка пачкой равна той же выборке, прочитанной по одной паре;
 *  — число обращений к базе не растёт с числом методик и версий;
 *  — systemInIndexOrder возвращает роль и настройки планировщика.
 *
 * Всё — под ролью приложения, сотрудник — врач (администратор групп).
 */

const TAG = `w27-batch-${crypto.randomUUID().slice(0, 8)}`;
let doctor: Person;
let patient: Person;
let a: MassSurvey;
let b: MassSurvey;
/** Вторая версия методики b — та же по устройству: версии совместимы */
let b2: { versionId: string; scaleId: string; items: { id: string; options: string[] }[] };

/** Пункты и шкала версии — как их отдаёт massSurvey для первой */
async function versionShape(versionId: string) {
  const [scale] = await db.select().from(scales).where(eq(scales.versionId, versionId));
  const qs = (await db.select().from(questions).where(eq(questions.versionId, versionId))).sort(
    (x, y) => x.position - y.position,
  );
  const opts = await db.select().from(options).where(inArray(options.questionId, qs.map((q) => q.id)));
  return {
    versionId,
    scaleId: scale!.id,
    items: qs.map((q) => ({
      id: q.id,
      options: opts
        .filter((o) => o.questionId === q.id)
        .sort((x, y) => x.position - y.position)
        .map((o) => o.id),
    })),
  };
}

/** Чужие прохождения второй версии: люди — те же, что у первой */
async function massOnVersion(s: MassSurvey, v: typeof b2, count: number, people: number) {
  await db.execute(sql`
    insert into responses (id, survey_id, user_id, status, version_id, started_at, submitted_at, duration_ms, reliable)
    select ${s.tag} || '-v2r' || g, ${s.surveyId}, ${s.tag} || '-u' || (1 + g % ${people}::int), 'completed', ${v.versionId},
           timestamptz '2026-03-01 00:00+00' + g * interval '9 minutes',
           timestamptz '2026-03-01 00:00+00' + g * interval '9 minutes' + interval '90 seconds', 60000, g % 40 <> 0
    from generate_series(1, ${count}::int) g`);
  await db.execute(sql`
    insert into answers (id, response_id, question_id, option_ids, score, duration_ms)
    select ${s.tag} || '-v2r' || g || '-a' || q.i, ${s.tag} || '-v2r' || g, q.x ->> 'id',
           jsonb_build_array(q.x -> 'options' ->> ((g / 3 + (case when q.i = 2 then 1 else 0 end)) % 4)::int),
           ((g / 3 + (case when q.i = 2 then 1 else 0 end)) % 4), 2000
    from generate_series(1, ${count}::int) g,
         jsonb_array_elements(${JSON.stringify(v.items)}::jsonb) with ordinality as q(x, i)`);
  await db.execute(sql`
    insert into response_scores (id, response_id, scale_id, raw_score, value, normalization, max_score, percent, normalized)
    select ${s.tag} || '-v2r' || g || '-s', ${s.tag} || '-v2r' || g, ${v.scaleId}, g % 12, g % 12, 'raw', 30, (g % 12) * 3.3, true
    from generate_series(1, ${count}::int) g`);
}

/** Сдачи человека: балл и время — заданные, ответы — по пунктам */
async function series(
  s: MassSurvey,
  v: { versionId: string; scaleId: string; items: { id: string; options: string[] }[] },
  label: string,
  start: string,
  values: number[],
) {
  for (const [i, value] of values.entries()) {
    const id = `${s.tag}-own-${label}-${i}`;
    await db.execute(sql`
      insert into responses (id, survey_id, user_id, status, version_id, started_at, submitted_at, duration_ms, reliable)
      values (${id}, ${s.surveyId}, ${patient.id}, 'completed', ${v.versionId},
              ${start}::timestamptz + ${i} * interval '20 days',
              ${start}::timestamptz + ${i} * interval '20 days' + interval '5 minutes', 300000, true)`);
    await db.execute(sql`
      insert into answers (id, response_id, question_id, option_ids, score, duration_ms)
      select ${id} || '-a' || q.i, ${id}, q.x ->> 'id', jsonb_build_array(q.x -> 'options' ->> ${value % 4}::int), ${value % 4}, 2000
      from jsonb_array_elements(${JSON.stringify(v.items)}::jsonb) with ordinality as q(x, i)`);
    await db.execute(sql`
      insert into response_scores (id, response_id, scale_id, raw_score, value, normalization, max_score, percent, normalized)
      values (${`${id}-s`}, ${id}, ${v.scaleId}, ${value}, ${value}, 'raw', 30, ${(value / 30) * 100}, true)`);
  }
}

async function dynamics(query = ""): Promise<{ body: RespondentDynamics; sql: number }> {
  const requestId = crypto.randomUUID();
  const res = await appApi<RespondentDynamics>(`/api/dynamics/respondents/${patient.id}${query}`, doctor.token, {
    headers: { "x-request-id": requestId },
  });
  expect(res.status).toBe(200);
  return { body: res.body, sql: requestSql(requestId)?.count ?? 0 };
}

/** Под ролью приложения, в транзакции врача — как внутри его запроса */
function asDoctor<T>(fn: () => Promise<T>): Promise<T> {
  return asAppRole(() => withDbContext(baseDb, { userId: doctor.id, role: "admin" }, fn));
}

/** Выборки — множествами значений: порядок строк в выборке ничего не значит */
const sorted = (m: Map<string, number[]>) =>
  Object.fromEntries([...m.entries()].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]).sort());

beforeAll(async () => {
  doctor = await makeUser("admin", `${TAG}-doctor@batch.test`);
  patient = await makeUser("user", `${TAG}-patient@batch.test`);
  a = await massSurvey(`${TAG}-a`, 3, doctor.id);
  b = await massSurvey(`${TAG}-b`, 3, doctor.id);
  await massResponses(a, 1, 400, 60);
  await massResponses(b, 1, 300, 60);
  await createVersion(
    b.surveyId,
    createSurveySchema.parse({
      title: { uk: `Обсяг ${b.tag}, друга редакція` },
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      visibility: "public",
      scales: [{ code: "S", title: { uk: "Сума" }, aggregation: "sum" }],
      questions: Array.from({ length: 3 }, (_, i) => ({
        type: "single",
        title: { uk: `Пункт ${i + 1}` },
        scaleCode: "S",
        options: [0, 1, 2, 3].map((score) => ({ text: { uk: `${score}` }, score })),
      })),
    }),
    doctor.id,
    "v2",
  );
  const [v2] = await db
    .select()
    .from(surveyVersions)
    .where(sql`${surveyVersions.surveyId} = ${b.surveyId} and ${surveyVersions.id} <> ${b.versionId}`);
  b2 = await versionShape(v2!.id);
  await massOnVersion(b, b2, 250, 60);
  await series(a, a, "a", "2026-01-10 09:00+00", [3, 7, 12]);
  await series(b, b, "b1", "2026-02-01 09:00+00", [5, 9]);
  await series(b, b2, "b2", "2026-05-01 09:00+00", [10, 14]);
  await db.execute(sql`analyze responses, answers, response_scores`);
}, 120_000);

afterAll(async () => {
  for (const s of [a, b]) if (s) await dropMass(s);
}, 60_000);

describe("динамика пачкой", () => {
  test("по каждой методике — то же, что запросом по ней одной", async () => {
    const all = (await dynamics()).body;
    expect(all.surveys.map((s) => s.surveyId).sort()).toEqual([a.surveyId, b.surveyId].sort());
    const twoVersions = all.surveys.find((s) => s.surveyId === b.surveyId)!;
    expect(new Set(twoVersions.scales[0]!.points.map((p) => p.versionNo)).size).toBe(2);
    /* выборки и альфа действительно посчитаны, а не одинаково пусты в обоих ответах */
    expect(all.surveys.every((s) => s.scales[0]!.points.every((p) => p.percentile !== null))).toBe(true);
    expect(all.surveys.some((s) => s.scales[0]!.reliableChange !== null)).toBe(true);

    for (const block of all.surveys) {
      const one = (await dynamics(`?survey=${block.surveyId}`)).body;
      expect(one.surveys).toEqual([block]);
    }
  }, 60_000);

  test("число обращений к базе не растёт с числом методик и версий", async () => {
    await dynamics();
    await dynamics(`?survey=${a.surveyId}`);
    const many = (await dynamics()).sql;
    const one = (await dynamics(`?survey=${a.surveyId}`)).sql;
    /* допуск — на кэш прав с коротким сроком (см. dynamicsScale.test.ts); запрос на методику дал бы больше */
    expect(many - one).toBeLessThanOrEqual(2);
    expect(many).toBeLessThan(45);
  }, 60_000);
});

describe("выборки пачкой равны выборкам по одной паре", () => {
  const pairs = () => [
    { surveyId: a.surveyId, versionId: a.versionId },
    { surveyId: b.surveyId, versionId: b.versionId },
    { surveyId: b.surveyId, versionId: b2.versionId },
  ];

  /* по одной паре — по очереди: в одной транзакции переключения роли не должны переплетаться */
  async function each<T>(fn: (p: ReturnType<typeof pairs>[number]) => Promise<T>): Promise<T[]> {
    const out: T[] = [];
    for (const p of pairs()) out.push(await fn(p));
    return out;
  }

  test("нормативная выборка", async () => {
    const { batch, single } = await asDoctor(async () => ({
      batch: await normativeSamples(pairs()),
      single: await each((p) => normativeSamples([p])),
    }));
    expect(batch.size).toBe(3);
    expect(sorted(batch)).toEqual(sorted(new Map(single.flatMap((m) => [...m.entries()]))));
  }, 60_000);

  test("альфа", async () => {
    const { batch, single } = await asDoctor(async () => ({
      batch: await alphasOf(pairs()),
      single: await each((p) => alphasOf([p])),
    }));
    expect(batch.size).toBe(3);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(single.flatMap((m) => [...m.entries()])));
  }, 60_000);

  test("выборка перцентиля", async () => {
    const target = (versionId: string): SampleTarget => ({ versionId, code: "S", maxScore: 30, unit: "raw" });
    const asked = [
      { surveyId: a.surveyId, targets: [target(a.versionId)] },
      { surveyId: b.surveyId, targets: [target(b.versionId), target(b2.versionId)] },
    ];
    const { batch, single } = await asDoctor(async () => {
      const batch = await referenceSampleSets(asked, "value");
      const single = [];
      for (const q of asked) single.push(await referenceSamples(q.surveyId, "value", q.targets));
      return { batch, single };
    });
    asked.forEach((q, i) => {
      for (const target of q.targets) {
        const got = [...batch.get(q.surveyId)!(target)].sort((x, y) => x - y);
        expect(got.length).toBeGreaterThan(10);
        expect(got).toEqual([...single[i]!(target)].sort((x, y) => x - y));
      }
    });
  }, 60_000);

  test("методики в версиях — то же, что getSurvey на каждую пару", async () => {
    const asked = [...pairs(), { surveyId: b.surveyId, versionId: null }, { surveyId: `${TAG}-нет`, versionId: null }];
    const { batch, single } = await asDoctor(async () => {
      const batch = await surveysAtVersions(asked, "uk");
      const single = [];
      for (const p of asked) single.push(await getSurvey(p.surveyId, p.versionId, "uk"));
      return { batch, single };
    });
    asked.forEach((p, i) => expect(batch.get(versionKey(p.surveyId, p.versionId))).toEqual(single[i]!));
    expect(batch.get(versionKey(b.surveyId, b2.versionId))?.versionId).toBe(b2.versionId);
    expect(batch.get(versionKey(b.surveyId, null))?.versionId).toBe(b2.versionId);
    expect(batch.get(versionKey(`${TAG}-нет`, null))).toBeNull();
  }, 60_000);
});

describe("systemInIndexOrder", () => {
  const settings = async () => {
    const [row] = (await db.execute(
      sql`select current_setting('app.role', true) as role, current_setting('enable_sort') as sort,
                 current_setting('enable_memoize') as memoize`,
    )) as unknown as { role: string; sort: string; memoize: string }[];
    return row!;
  };

  test("внутри — системная роль без сортировки и Memoize, после — как было", async () => {
    const seen = await asDoctor(async () => {
      const inside = await systemInIndexOrder(() => settings());
      return { inside, after: await settings() };
    });
    expect(seen.inside).toEqual({ role: "system", sort: "off", memoize: "off" });
    expect(seen.after).toEqual({ role: "admin", sort: "on", memoize: "on" });
  });

  test("ошибка не из базы — наружу она, роль и настройки возвращены", async () => {
    const after = await asDoctor(async () => {
      await systemInIndexOrder(async () => {
        throw new Error("сбой счёта");
      }).catch((e: Error) => expect(e.message).toBe("сбой счёта"));
      return settings();
    });
    expect(after).toEqual({ role: "admin", sort: "on", memoize: "on" });
  });
});
