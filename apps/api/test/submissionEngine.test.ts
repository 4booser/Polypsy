import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { and, api, db, eq, makeUser, root, type Person } from "./fixtures";
import {
  alertCases,
  answers,
  decisionRules,
  responseScores,
  responses as responsesTable,
  riskAlerts,
  ruleHits,
  surveyGroups,
  surveyVersions,
} from "../src/db/schema";

/**
 * Движок сдачи: подсчёт и риск (волна 12, участок engine).
 *
 * Три дефекта из внешнего разбора, каждый воспроизведён тестом, который
 * падал до правки:
 *   1. риск по полосе итоговой шкалы доходил только до тревоги — правила
 *      получали флаг риска лишь от критических ответов, а кризисная
 *      карточка зависела от их числа;
 *   2. ответы на скрытые условием вопросы не проверялись, но считались —
 *      и в баллы, и в поиск риска;
 *   3. повтор одного варианта в множественном выборе умножал балл.
 *
 * Данные свои у каждого теста: группа, методики и люди заводятся здесь с
 * uuid в названиях. Правило — в своей группе и выключается в afterAll, а
 * случаи тревоги своих людей закрываются: сюита идёт одним процессом, и
 * открытый случай в очереди дежурного испортил бы чужой подсчёт.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const L = (uk: string) => ({ uk, ru: uk });

const group = crypto.randomUUID();
const people: string[] = [];
let ruleId = "";

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: group, title: `Движок ${tag()}`, createdBy: root.id });
  /*
   * Правило «поднят тяжёлый риск» — в своей группе: на чужие методики оно
   * не действует, и его срабатывания ищутся по его же id.
   */
  const rule = await api("/api/decisions/rules", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: `Тяжёлый риск ${tag()}`,
      groupId: group,
      conditions: [{ kind: "risk", severity: "severe" }],
      actions: [{ kind: "notify_duty" }],
    }),
  });
  expect(rule.status).toBe(201);
  ruleId = rule.body.id;
});

afterAll(async () => {
  if (ruleId) await db.update(decisionRules).set({ enabled: false }).where(eq(decisionRules.id, ruleId));
  if (people.length) {
    const at = new Date().toISOString();
    await db
      .update(alertCases)
      .set({ acknowledgedAt: at, acknowledgedBy: root.id, outcome: "not_confirmed" })
      .where(inArray(alertCases.userId, people));
  }
});

async function patient(): Promise<Person> {
  const person = await makeUser("user", `engine-${tag()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(person.id);
  return person;
}

/** Методика в своей группе — заводится и публикуется тем же путём, что в конструкторе */
async function publishedSurvey(content: Record<string, unknown>) {
  const created = await api("/api/surveys", root.token, {
    method: "POST",
    body: JSON.stringify({
      title: L(`Движок ${tag()}`),
      groupId: group,
      administration: "self",
      scoringEnabled: true,
      allowRetake: true,
      safetyPlan: L("Зателефонуйте 7333"),
      // баллы в ответе на сдачу нужны проверкам ниже; скрытие от пациента — свой блок в конце
      showResultsToPatient: true,
      ...content,
    }),
  });
  expect(created.status).toBe(201);
  const published = await api(`/api/surveys/${created.body.id}`, root.token, {
    method: "PATCH",
    body: JSON.stringify({ status: "published" }),
  });
  expect(published.status).toBe(200);
  return published.body;
}

function submit(surveyId: string, token: string, body: unknown[]) {
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers: body,
    }),
  });
}

describe("итоговый риск сдачи — один на тревогу, правила и карточку", () => {
  test("тяжёлая полоса без критических ответов: тревога, правило и кризисная карточка", async () => {
    /*
     * Так устроены МЛО и PHQ-9 в учреждении: критического варианта у пункта
     * нет, риск выражен полосой шкалы. До правки полоса поднимала тревогу —
     * а правило «тяжёлый риск» молчало (флаг риска шёл только от ответов), и
     * человек не видел плана безопасности (карточка считала только ответы).
     * Очередь дежурного, подсказки и экран пациента расходились в одном и
     * том же прохождении.
     */
    const survey = await publishedSurvey({
      questions: [
        { type: "scale", title: L("Наскільки важко"), required: true, minValue: 0, maxValue: 10, scaleCode: "D" },
      ],
      scales: [
        {
          code: "D",
          title: L("Виснаження"),
          kind: "clinical",
          normalization: "raw",
          bands: [
            { minScore: 0, maxScore: 4, label: L("Норма"), severity: "none" },
            { minScore: 5, maxScore: 10, label: L("Тяжкий рівень"), severity: "severe" },
          ],
        },
      ],
    });
    const person = await patient();
    const res = await submit(survey.id, person.token, [{ questionId: survey.questions[0].id, number: 8 }]);
    expect(res.status).toBe(201);

    const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id));
    expect(alerts.map((a) => a.severity)).toEqual(["severe"]);

    const hits = await db
      .select()
      .from(ruleHits)
      .where(and(eq(ruleHits.responseId, res.body.id), eq(ruleHits.ruleId, ruleId)));
    expect(hits.length, "правило «тяжёлый риск» не увидело тяжёлую полосу").toBe(1);

    expect(res.body.safetyPlan, "кризисная карточка не показана при тяжёлой полосе").toBe("Зателефонуйте 7333");
  });

  test("полоса шкалы достоверности риском не считается ни для кого", async () => {
    // качество протокола — не состояние человека: ни тревоги, ни правила, ни карточки
    const survey = await publishedSurvey({
      questions: [
        { type: "scale", title: L("Контрольний пункт"), required: true, minValue: 0, maxValue: 10, scaleCode: "L" },
      ],
      scales: [
        {
          code: "L",
          title: L("Щирість"),
          kind: "validity",
          normalization: "raw",
          bands: [{ minScore: 5, maxScore: 10, label: L("Сумнівно"), severity: "severe" }],
        },
      ],
    });
    const person = await patient();
    const res = await submit(survey.id, person.token, [{ questionId: survey.questions[0].id, number: 9 }]);
    expect(res.status).toBe(201);
    expect(await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).toEqual([]);
    expect(
      await db.select().from(ruleHits).where(and(eq(ruleHits.responseId, res.body.id), eq(ruleHits.ruleId, ruleId))),
    ).toEqual([]);
    expect(res.body.safetyPlan).toBeNull();
  });

  test("критический ответ по-прежнему поднимает всё три", async () => {
    const survey = await publishedSurvey({
      questions: [
        {
          type: "single",
          title: L("Думки про смерть"),
          required: true,
          options: [
            { text: L("Так"), score: 1, riskFlag: true, riskLabel: L("Суїцидальні думки"), riskSeverity: "severe" },
            { text: L("Ні"), score: 0 },
          ],
        },
      ],
    });
    const person = await patient();
    const q = survey.questions[0];
    const res = await submit(survey.id, person.token, [{ questionId: q.id, optionIds: [q.options[0].id] }]);
    expect(res.status).toBe(201);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).length).toBe(1);
    expect(
      (await db.select().from(ruleHits).where(and(eq(ruleHits.responseId, res.body.id), eq(ruleHits.ruleId, ruleId))))
        .length,
    ).toBe(1);
    expect(res.body.safetyPlan).toBe("Зателефонуйте 7333");
  });
});

describe("риск без подсчёта и по матрице — сервер решает как клиенты без сети", () => {
  test("числовой порог при выключенном подсчёте: тревога и карточка", async () => {
    // тот же случай, что в общем наборе (packages/shared/test/riskCases.ts): выключенный подсчёт риск не выключает
    const survey = await publishedSurvey({
      scoringEnabled: false,
      questions: [
        {
          type: "scale",
          title: L("Думки про самоушкодження"),
          required: true,
          minValue: 0,
          maxValue: 10,
          riskThreshold: 7,
          riskLabel: L("Високий бал"),
          riskSeverity: "severe",
        },
      ],
    });
    const person = await patient();
    const res = await submit(survey.id, person.token, [{ questionId: survey.questions[0].id, number: 7 }]);
    expect(res.status).toBe(201);
    expect(res.body.scores).toEqual([]);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).length).toBe(1);
    expect(res.body.safetyPlan).toBe("Зателефонуйте 7333");
  });

  test("критический столбец матрицы: тревога и карточка", async () => {
    const survey = await publishedSurvey({
      questions: [
        {
          type: "matrix",
          title: L("Як часто за тиждень"),
          required: true,
          options: [
            { text: L("Сон"), kind: "row" },
            { text: L("Думки про смерть"), kind: "row" },
            { text: L("Ніколи"), score: 0 },
            { text: L("Щодня"), score: 3, riskFlag: true, riskLabel: L("Щодня"), riskSeverity: "severe" },
          ],
        },
      ],
    });
    const q = survey.questions[0];
    const [sleep, death, never, daily] = q.options;
    const person = await patient();
    const res = await submit(survey.id, person.token, [
      { questionId: q.id, matrix: { [sleep.id]: never.id, [death.id]: daily.id } },
    ]);
    expect(res.status).toBe(201);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).length).toBe(1);
    expect(res.body.safetyPlan).toBe("Зателефонуйте 7333");
  });
});

describe("скрытые условием ответы не считаются", () => {
  test("ответ на скрытый пункт не даёт ни балла, ни тревоги и не сохраняется", async () => {
    /*
     * Проверка пропускала скрытые пункты, а подсчёт и поиск риска получали
     * исходный массив целиком. Ответ, оставшийся от прежней ветки (человек
     * ответил, потом вернулся и сменил развилку), или просто присланный
     * клиентом, попадал в баллы и поднимал тревогу по вопросу, которого
     * человеку по методике задавать не полагалось.
     */
    const survey = await publishedSurvey({
      questions: [
        {
          type: "yesno",
          title: L("Чи було це з вами?"),
          required: true,
          options: [
            { text: L("Так"), score: 1, keyCode: "yes" },
            { text: L("Ні"), score: 0, keyCode: "no" },
          ],
        },
        {
          type: "single",
          title: L("Як часто?"),
          required: true,
          scaleCode: "S",
          logic: [{ sourceIndex: 0, operator: "gte", value: 1, action: "show" }],
          options: [
            { text: L("Щодня"), score: 5, riskFlag: true, riskLabel: L("Щоденно"), riskSeverity: "severe" },
            { text: L("Ніколи"), score: 0 },
          ],
        },
        {
          type: "single",
          title: L("Сон"),
          required: true,
          scaleCode: "S",
          options: [
            { text: L("Погано"), score: 1 },
            { text: L("Добре"), score: 0 },
          ],
        },
      ],
      scales: [{ code: "S", title: L("Сума"), kind: "clinical", normalization: "raw", bands: [] }],
    });
    const [gate, hidden, plain] = survey.questions;
    const person = await patient();
    const res = await submit(survey.id, person.token, [
      { questionId: gate.id, optionIds: [gate.options[1].id] }, // «Ні» — второй пункт скрыт
      { questionId: hidden.id, optionIds: [hidden.options[0].id] },
      { questionId: plain.id, optionIds: [plain.options[0].id] },
    ]);
    expect(res.status).toBe(201);

    expect(res.body.scores[0].rawScore, "балл скрытого пункта попал в шкалу").toBe(1);
    expect(await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).toEqual([]);
    expect(res.body.safetyPlan).toBeNull();
    const stored = await db.select().from(answers).where(eq(answers.responseId, res.body.id));
    expect(stored.map((a) => a.questionId).sort()).toEqual([gate.id, plain.id].sort());
  });

  test("тот же пункт, открытый развилкой, считается как обычно", async () => {
    const survey = await publishedSurvey({
      questions: [
        {
          type: "yesno",
          title: L("Чи було це з вами?"),
          required: true,
          options: [
            { text: L("Так"), score: 1, keyCode: "yes" },
            { text: L("Ні"), score: 0, keyCode: "no" },
          ],
        },
        {
          type: "single",
          title: L("Як часто?"),
          required: true,
          scaleCode: "S",
          logic: [{ sourceIndex: 0, operator: "gte", value: 1, action: "show" }],
          options: [
            { text: L("Щодня"), score: 5, riskFlag: true, riskLabel: L("Щоденно"), riskSeverity: "severe" },
            { text: L("Ніколи"), score: 0 },
          ],
        },
      ],
      scales: [{ code: "S", title: L("Сума"), kind: "clinical", normalization: "raw", bands: [] }],
    });
    const [gate, shown] = survey.questions;
    const person = await patient();
    const res = await submit(survey.id, person.token, [
      { questionId: gate.id, optionIds: [gate.options[0].id] },
      { questionId: shown.id, optionIds: [shown.options[0].id] },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.scores[0].rawScore).toBe(5);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id))).length).toBe(1);
  });
});

describe("повтор варианта в множественном выборе", () => {
  test("три одинаковых id — отказ 400, а не балл 9 при максимуме 3", async () => {
    const survey = await publishedSurvey({
      questions: [
        {
          type: "multiple",
          title: L("Що з цього було?"),
          required: true,
          scaleCode: "M",
          options: [
            { text: L("Безсоння"), score: 3 },
            { text: L("Нічого"), score: 0 },
          ],
        },
      ],
      scales: [{ code: "M", title: L("Сума"), kind: "clinical", normalization: "raw", bands: [] }],
    });
    const q = survey.questions[0];
    const person = await patient();
    const res = await submit(survey.id, person.token, [
      { questionId: q.id, optionIds: [q.options[0].id, q.options[0].id, q.options[0].id] },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Що з цього було?");

    // те же варианты без повтора принимаются
    const ok = await submit(survey.id, person.token, [{ questionId: q.id, optionIds: [q.options[0].id] }]);
    expect(ok.status).toBe(201);
    expect(ok.body.scores[0].rawScore).toBe(3);
  });

  test("два ответа на один вопрос — отказ: проверялся только последний, записывались оба", async () => {
    const survey = await publishedSurvey({
      questions: [
        {
          type: "single",
          title: L("Настрій"),
          required: true,
          options: [
            { text: L("Добрий"), score: 0 },
            { text: L("Поганий"), score: 1 },
          ],
        },
      ],
    });
    const q = survey.questions[0];
    const person = await patient();
    const res = await submit(survey.id, person.token, [
      { questionId: q.id, optionIds: [crypto.randomUUID()] },
      { questionId: q.id, optionIds: [q.options[0].id] },
    ]);
    expect(res.status).toBe(400);
  });
});

describe("шкала без ответов — не вычислена, а не «Норма»", () => {
  test("три необязательных пункта пропущены: ни балла, ни полосы, ни строки баллов", async () => {
    const optional = (title: string) => ({
      type: "yesno",
      title: L(title),
      required: false,
      scaleCode: "S",
      options: [
        { text: L("Так"), score: 1, keyCode: "yes" },
        { text: L("Ні"), score: 0, keyCode: "no" },
      ],
    });
    const survey = await publishedSurvey({
      questions: [optional("Перший"), optional("Другий"), optional("Третій")],
      scales: [
        {
          code: "S",
          title: L("Сума"),
          kind: "clinical",
          normalization: "raw",
          bands: [
            { minScore: 0, maxScore: 1, label: L("Норма"), severity: "none" },
            { minScore: 2, maxScore: 3, label: L("Виражено"), severity: "severe" },
          ],
        },
      ],
    });
    const person = await patient();
    const res = await submit(survey.id, person.token, []);
    expect(res.status).toBe(201);
    expect(res.body.scores, "пустая шкала дала балл и полосу").toEqual([]);
    expect(res.body.warnings.some((w: string) => w.includes("0 из 3"))).toBe(true);
    expect(await db.select().from(responseScores).where(eq(responseScores.responseId, res.body.id))).toEqual([]);
  });
});

describe("результаты, скрытые от пациента, сервер ему не отдаёт", () => {
  /*
   * showResultsToPatient снят (PHQ-9, PCL-5, PQ-16): до правки пациент всё
   * равно получал балл и полосу в ответе на сдачу, в списке своих
   * прохождений, в разборе прохождения и в печатном отчёте. Кризисная
   * карточка остаётся: она помощь, а не результат.
   */
  async function hiddenSurvey() {
    return publishedSurvey({
      showResultsToPatient: false,
      questions: [
        { type: "scale", title: L("Наскільки важко"), required: true, minValue: 0, maxValue: 10, scaleCode: "D" },
      ],
      scales: [
        {
          code: "D",
          title: L("Виснаження"),
          kind: "clinical",
          normalization: "raw",
          bands: [
            { minScore: 0, maxScore: 4, label: L("Норма"), severity: "none" },
            { minScore: 5, maxScore: 10, label: L("Тяжкий рівень"), severity: "severe" },
          ],
        },
      ],
    });
  }

  test("сдача: без баллов, полосы и достоверности — но с кризисной карточкой", async () => {
    const survey = await hiddenSurvey();
    const person = await patient();
    const res = await submit(survey.id, person.token, [{ questionId: survey.questions[0].id, number: 9 }]);
    expect(res.status).toBe(201);
    expect(res.body.scores).toEqual([]);
    expect(res.body.reliable).toBeNull();
    expect(res.body.warnings).toEqual([]);
    expect(res.body.safetyPlan).toBe("Зателефонуйте 7333");
    // баллы при этом посчитаны и лежат в базе — их видит специалист
    expect((await db.select().from(responseScores).where(eq(responseScores.responseId, res.body.id))).length).toBe(1);

    const mine = await api("/api/me/responses", person.token);
    expect(mine.body.items.find((r: { id: string }) => r.id === res.body.id).scores).toEqual([]);

    const detail = await api(`/api/responses/${res.body.id}`, person.token);
    expect(detail.status).toBe(200);
    expect(detail.body.scores).toEqual([]);

    const report = await api(`/api/reports/responses/${res.body.id}`, person.token);
    expect(report.status).toBe(403);

    // специалист видит всё
    const staff = await api(`/api/responses/${res.body.id}`, root.token);
    expect(staff.body.scores[0].band.label).toBe("Тяжкий рівень");
    expect((await api(`/api/reports/responses/${res.body.id}`, root.token)).status).toBe(200);
  });

  test("показ включён — пациент видит свои баллы и отчёт", async () => {
    const survey = await publishedSurvey({
      questions: [
        { type: "scale", title: L("Наскільки важко"), required: true, minValue: 0, maxValue: 10, scaleCode: "D" },
      ],
      scales: [{ code: "D", title: L("Виснаження"), kind: "clinical", normalization: "raw", bands: [] }],
    });
    const person = await patient();
    const res = await submit(survey.id, person.token, [{ questionId: survey.questions[0].id, number: 3 }]);
    expect(res.body.scores[0].rawScore).toBe(3);
    expect((await api(`/api/responses/${res.body.id}`, person.token)).body.scores.length).toBe(1);
    expect((await api(`/api/reports/responses/${res.body.id}`, person.token)).status).toBe(200);
  });
});

describe("сдача датируется моментом завершения, а не синхронизации", () => {
  const DAY = 86_400_000;

  async function olderSurvey(daysAgo: number) {
    const survey = await publishedSurvey({
      questions: [{ type: "scale", title: L("Самопочуття"), required: true, minValue: 0, maxValue: 10, scaleCode: "W" }],
      scales: [{ code: "W", title: L("Самопочуття"), kind: "clinical", normalization: "raw", bands: [] }],
    });
    // версия заведена раньше — иначе прошлое завершение упрётся в её создание
    await db
      .update(surveyVersions)
      .set({ createdAt: new Date(Date.now() - daysAgo * DAY).toISOString() })
      .where(eq(surveyVersions.id, survey.versionId));
    return survey;
  }

  const offline = (surveyId: string, token: string, questionId: string, startedAt: number, durationMs: number) =>
    api(`/api/surveys/${surveyId}/responses`, token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        events: [],
        answers: [{ questionId, number: 5 }],
      }),
    });

  test("офлайн-сдача двухдневной давности — дата завершения и возраст на неё", async () => {
    /*
     * Человеку исполнилось 25 вчера. Ответил он позавчера, без сети, и сдача
     * дошла сегодня: датироваться она должна позавчерашним днём, а возраст
     * для норм — 24, а не 25 (другая возрастная страта).
     */
    const survey = await olderSurvey(5);
    const birthday = new Date(Date.now() - DAY);
    birthday.setFullYear(birthday.getFullYear() - 25);
    const person = await makeUser("user", `engine-age-${crypto.randomUUID().slice(0, 8)}@test`, {
      sex: "male",
      birthDate: birthday.toISOString().slice(0, 10),
    });
    people.push(person.id);

    const finished = Date.now() - 2 * DAY;
    const res = await offline(survey.id, person.token, survey.questions[0].id, finished - 10 * 60_000, 10 * 60_000);
    expect(res.status).toBe(201);
    expect(Math.abs(Date.parse(res.body.submittedAt) - finished)).toBeLessThan(1000);

    const [row] = await db.select().from(responsesTable).where(eq(responsesTable.id, res.body.id));
    expect(row!.respondentAgeBand, "возраст посчитан на момент синхронизации").toBe("<25");
  });

  test("из будущего и раньше версии — время приёма сервером", async () => {
    const survey = await olderSurvey(1);
    const person = await patient();
    const q = survey.questions[0].id;

    const future = await offline(survey.id, person.token, q, Date.now() + DAY, 60_000);
    expect(future.status).toBe(201);
    expect(Math.abs(Date.parse(future.body.submittedAt) - Date.now())).toBeLessThan(60_000);

    const tooOld = await offline(survey.id, person.token, q, Date.now() - 10 * DAY, 60_000);
    expect(tooOld.status).toBe(201);
    expect(Math.abs(Date.parse(tooOld.body.submittedAt) - Date.now())).toBeLessThan(60_000);
  });
});
