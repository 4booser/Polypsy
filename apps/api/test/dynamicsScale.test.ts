import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RespondentDynamics } from "@quizzy/shared";
import { appApi, db, makeUser, sql, type Person } from "./fixtures";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
import { requestSql } from "../src/lib/opsSql";

/**
 * Динамика одного пациента не читает баллы всего учреждения (#188).
 *
 * Маршрут /api/dynamics/respondents/:id без ?survey= (так его зовут карта
 * пациента в вебе и мобилка) собирал нормативную выборку по ВСЕМ методикам
 * зоны сотрудника — все нормированные баллы, — а выборку перцентиля и альфу
 * брал перебором всех прохождений каждой методики человека: на синтетике
 * ради одного человека читалось 309 тыс. строк, у врача 40 с, и с каждым
 * прохождением учреждения — больше. Теперь выборки — по версиям из ряда
 * человека и по последним прохождениям, путём по индексу.
 *
 * Условие закрытия — время не зависит от чужих прохождений: 10 тыс. против
 * 100 тыс. — не больше чем в полтора раза (с запасом на шум быстрого
 * ответа). Под ролью приложения, сотрудник — врач (администратор группы):
 * у него политика строк стоит на каждой прочитанной строке.
 *
 * И положительный контроль: на малом наборе — пока прохождений меньше
 * предела выборок — ответ тот же, что до правки (эталон снят с кода main).
 */

const TAG = `w21-dyn-${crypto.randomUUID().slice(0, 8)}`;
let doctor: Person;
let small: MassSurvey;
let large: MassSurvey;
let smallPatient: Person;
let largePatient: Person;

/** Четыре сдачи человека на методике: баллы и время — заданные, ответы — по пунктам */
async function series(s: MassSurvey, person: Person, values: number[]): Promise<void> {
  for (const [i, value] of values.entries()) {
    const id = `${s.tag}-own-${i}`;
    await db.execute(sql`
      insert into responses (id, survey_id, user_id, status, version_id, started_at, submitted_at, duration_ms, reliable)
      values (${id}, ${s.surveyId}, ${person.id}, 'completed', ${s.versionId},
              timestamptz '2026-01-05 09:00+00' + ${i} * interval '30 days',
              timestamptz '2026-01-05 09:05+00' + ${i} * interval '30 days', 300000, true)`);
    await db.execute(sql`
      insert into answers (id, response_id, question_id, option_ids, score, duration_ms)
      select ${id} || '-a' || q.i, ${id}, q.x ->> 'id', jsonb_build_array(q.x -> 'options' ->> ${value % 4}::int), ${value % 4}, 2000
      from jsonb_array_elements(${JSON.stringify(s.items)}::jsonb) with ordinality as q(x, i)`);
    await db.execute(sql`
      insert into response_scores (id, response_id, scale_id, raw_score, value, normalization, max_score, percent, normalized)
      values (${`${id}-s`}, ${id}, ${s.scaleId}, ${value}, ${value}, 'raw', 30, ${(value / 30) * 100}, true)`);
  }
}

async function dynamics(person: Person): Promise<{ body: RespondentDynamics; ms: number; sql: number }> {
  const requestId = crypto.randomUUID();
  const t0 = performance.now();
  const res = await appApi<RespondentDynamics>(`/api/dynamics/respondents/${person.id}`, doctor.token, {
    headers: { "x-request-id": requestId },
  });
  const ms = performance.now() - t0;
  expect(res.status).toBe(200);
  return { body: res.body, ms, sql: requestSql(requestId)?.count ?? 0 };
}

/** Лучшее из трёх — шум машины не должен решать исход */
async function fastest(person: Person): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) best = Math.min(best, (await dynamics(person)).ms);
  return best;
}

beforeAll(async () => {
  doctor = await makeUser("admin", `${TAG}-doctor@dyn.test`);
  small = await massSurvey(`${TAG}-s`, 3, doctor.id);
  large = await massSurvey(`${TAG}-l`, 2, doctor.id);
  smallPatient = await makeUser("user", `${TAG}-ps@dyn.test`);
  largePatient = await makeUser("user", `${TAG}-pl@dyn.test`);
}, 60_000);

afterAll(async () => {
  for (const s of [small, large]) if (s) await dropMass(s);
}, 60_000);

describe("малый набор: ответ тот же, что до правки", () => {
  beforeAll(async () => {
    await massResponses(small, 1, 300, 30);
    /*
     * Пункты посева идут по кругу со сдвигом и между собой не связаны —
     * альфа выходит отрицательной, и RCI с SEM не считаются вовсе. Здесь
     * они и нужны: два пункта отвечены одинаково, третий — близко к ним.
     */
    await db.execute(sql`
      update answers a
         set option_ids = jsonb_build_array(q.x -> 'options' ->> (case when q.i = 3 then (r.g + r.g / 5) % 4 else r.g % 4 end)::int)
        from (select id, substring(id from '-r([0-9]+)$')::int as g from responses where survey_id = ${small.surveyId}) r,
             jsonb_array_elements(${JSON.stringify(small.items)}::jsonb) with ordinality as q(x, i)
       where a.response_id = r.id and a.question_id = q.x ->> 'id'`);
    await series(small, smallPatient, [3, 8, 12, 20]);
    await db.execute(sql`analyze responses, answers, response_scores`);
  }, 60_000);

  test("баллы, перцентили, изменение, RCI и SEM — как на main", async () => {
    const { body } = await dynamics(smallPatient);
    const [survey] = body.surveys;
    expect(body.surveys).toHaveLength(1);
    const scale = survey!.scales[0]!;
    expect({
      points: scale.points.map((p) => [p.rawScore, p.percentile]),
      delta: scale.delta,
      direction: scale.direction,
      reliableChange: scale.reliableChange,
      sem: scale.sem,
      incomparable: scale.incomparable ?? null,
    } as unknown).toEqual(GOLDEN);
  }, 30_000);
});

describe("10 тыс. против 100 тыс. чужих прохождений", () => {
  test("время динамики одного человека не растёт с чужими прохождениями", async () => {
    await series(large, largePatient, [4, 9, 15, 22]);
    await massResponses(large, 1, 10_000, 1_000);
    const t10 = await fastest(largePatient);
    const sql10 = (await dynamics(largePatient)).sql;

    await massResponses(large, 10_001, 90_000, 1_000);
    const t100 = await fastest(largePatient);
    const sql100 = (await dynamics(largePatient)).sql;

    /*
     * Число запросов от объёма не зависит. Допуск в два запроса: между
     * замерами заливается 90 тыс. прохождений, и кэш с коротким сроком
     * (права, группы) успевает протухнуть — в CI это давало 47 против 48.
     * Зависимость от объёма дала бы разницу в десятки и тысячи запросов.
     */
    expect(Math.abs(sql100 - sql10)).toBeLessThanOrEqual(2);
    // полтора раза — условие задачи; 300 мс — запас на шум, когда весь ответ — десятки миллисекунд
    expect(t100).toBeLessThan(Math.max(t10 * 1.5, t10 + 300));
  }, 240_000);
});

/** Снято с кода main (a4cc2b48) на том же наборе */
const GOLDEN = {
  points: [
    [3, 33.9],
    [8, 82.3],
    [12, 96.8],
    [20, 98.4],
  ],
  delta: 17,
  direction: "up",
  reliableChange: { rci: 6.81, significant: true, direction: "up", basis: { sd: 3.03, alpha: 0.661, sampleN: 304 } },
  sem: 1.76,
  incomparable: null,
};
