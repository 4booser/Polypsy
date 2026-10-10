import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeUser, type Person } from "./fixtures";
import { asAppRole } from "./appRole";
import { dropMass, massResponses, massSurvey, type MassSurvey } from "./massSurvey";
// само приложение: под QUIZZY_TEST_APP_ROLE обёртка fixtures сделала бы то же, что asAppRole здесь
import { app } from "../src/app";
import { requestSql } from "../src/lib/opsSql";

/**
 * SPSS-выгрузка на объёме (#182).
 *
 * Строки выгрузки собирались так: для каждого прохождения — перебор ВСЕХ
 * ответов и баллов методики, синхронно, в цикле событий. Big Five на 7 тыс.
 * прохождений (358 тыс. ответов) — 132 с, и 66 с подряд процесс не отвечал
 * никому, включая сдачу методик и тревоги. В обезличенном профиле всё это
 * делалось дважды: план обобщения квазиидентификаторов грузил строки
 * отдельно от самой выгрузки; manifest.json — ещё раз.
 *
 * Условие закрытия — проверки ниже: 20 тыс. прохождений × 20 пунктов —
 * data.csv и manifest.json быстрее 5 с, лёгкий запрос во время выгрузки
 * быстрее 200 мс, строки грузятся один раз, а вдвое больший объём стоит не
 * больше чем в 2,5 раза дороже (квадрат дал бы вчетверо). Под ролью
 * приложения, сотрудник — суперадмин, как в замерах разбора: у
 * администратора политика строк ответов зовёт rls_admin_sees_survey на
 * каждую строку, и 400 тыс. ответов стоят секунды базы сами по себе — это
 * своя цена (в отчёт волны), не склейка, которую проверяет этот файл.
 */

const TAG = `w20pe-spss-${crypto.randomUUID().slice(0, 8)}`;
const ITEMS = 20;
let staff: Person;
let small: MassSurvey;
let large: MassSurvey;

const request = (path: string, requestId = crypto.randomUUID()) =>
  asAppRole(async () =>
    app.request(path, { headers: { Authorization: `Bearer ${staff.token}`, "x-request-id": requestId } }),
  );

/**
 * Выгрузка целиком: статус, тело, время и номер запроса (по нему — счёт SQL).
 * Номер задаётся свой: файл выгрузки отдаётся готовым Response, и заголовка
 * x-request-id в ответе нет.
 */
async function fetchExport(path: string) {
  const requestId = crypto.randomUUID();
  const t0 = performance.now();
  const res = await request(path, requestId);
  const body = await res.text();
  return { status: res.status, body, ms: performance.now() - t0, requestId };
}

/** Сколько раз за запрос выполнилась загрузка строк выгрузки (прохождения вместе с людьми) */
function rowLoads(requestId: string): number {
  const top = requestSql(requestId)?.top ?? [];
  return top.filter((q) => /from "responses" left join "users"/.test(q.query)).reduce((n, q) => n + q.calls, 0);
}

beforeAll(async () => {
  staff = await makeUser("superadmin", `${TAG}@spss-scale.test`);
  small = await massSurvey(`${TAG}-s`, ITEMS, staff.id);
  large = await massSurvey(`${TAG}-l`, ITEMS, staff.id);
  await massResponses(small, 1, 10_000, 1_000);
  await massResponses(large, 1, 20_000, 2_000);
}, 120_000);

afterAll(async () => {
  for (const s of [small, large]) if (s) await dropMass(s);
}, 60_000);

describe("SPSS-выгрузка: 20 тыс. прохождений × 20 пунктов", () => {
  test("data.csv и manifest.json быстрее 5 с, строки грузятся один раз", async () => {
    const data = await fetchExport(`/api/spss/surveys/${large.surveyId}/data.csv?profile=deidentified`);
    expect(data.status).toBe(200);
    expect(data.body.split("\r\n").length - 1).toBe(20_000);
    // план обобщения квазиидентификаторов строится по тем же строкам, а не по загруженным заново
    expect(rowLoads(data.requestId)).toBe(1);
    expect(data.ms).toBeLessThan(5_000);

    const manifest = await fetchExport(`/api/spss/surveys/${large.surveyId}/manifest.json?profile=deidentified`);
    expect(manifest.status).toBe(200);
    expect(rowLoads(manifest.requestId)).toBe(1);
    expect(manifest.ms).toBeLessThan(5_000);
    expect(JSON.parse(manifest.body).versions[0].responses).toBe(20_000);
  }, 60_000);

  test("лёгкий запрос во время выгрузки отвечает быстрее 200 мс", async () => {
    let done = false;
    const heavy = fetchExport(`/api/spss/surveys/${large.surveyId}/data.csv?profile=deidentified`).finally(() => {
      done = true;
    });
    /*
     * Пробы — подряд, без пауз: синхронный кусок выгрузки длиннее 200 мс
     * попадёт на ту пробу, что в этот момент в полёте. Заодно меряется
     * задержка таймера — цикл событий, занятый между пробами.
     */
    const probes: number[] = [];
    let lag = 0;
    let tick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - tick - 10);
      tick = now;
    }, 10);
    try {
      while (!done) {
        const t0 = performance.now();
        const res = await request("/api/auth/me");
        await res.arrayBuffer();
        expect(res.status).toBe(200);
        probes.push(performance.now() - t0);
      }
    } finally {
      clearInterval(timer);
    }
    expect((await heavy).status).toBe(200);
    expect(probes.length).toBeGreaterThan(5);
    expect(Math.max(...probes)).toBeLessThan(200);
    expect(lag).toBeLessThan(200);
  }, 60_000);

  test("вдвое больше прохождений — не дороже чем в 2,5 раза", async () => {
    /*
     * Лучшее из трёх, объёмы поочерёдно: одиночный замер на общей машине CI
     * шумит сильнее, чем различие линейного и квадратичного, а первый заход
     * по набору платит ещё и за холодные кэши базы.
     */
    const once = async (s: MassSurvey) => {
      const r = await fetchExport(`/api/spss/surveys/${s.surveyId}/data.csv?profile=deidentified`);
      expect(r.status).toBe(200);
      return r.ms;
    };
    const small10: number[] = [];
    const large20: number[] = [];
    for (let i = 0; i < 3; i++) {
      small10.push(await once(small));
      large20.push(await once(large));
    }
    const t10 = Math.min(...small10);
    const t20 = Math.min(...large20);
    expect(t20 / t10).toBeLessThan(2.5);
  }, 120_000);
});
