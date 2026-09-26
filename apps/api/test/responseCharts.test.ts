import { beforeAll, describe, expect, test } from "bun:test";
import type { RespondentDynamics, ResponseDetail } from "@quizzy/shared";
import {
  adminA,
  api,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  patient,
  submitSurvey,
  surveyInA,
  surveyInB,
  surveys,
  type Person,
} from "./fixtures";

/**
 * Что сервер отдаёт графикам прохождения.
 *
 * Экрану «Графіки» нужны три вещи, которых раньше не было: чьё это
 * прохождение (без человека динамику не у кого спросить), удалось ли
 * нормирование (без этого сырой балл неотличим от T-балла) и динамика одной
 * методики без подсчёта альфы по всем остальным методикам человека.
 *
 * Каждая защита проверена мутацией — снималась, и тест обязан был упасть,
 * назвав виновника.
 */

/** Короткая методика «так/ні» с одной суммой: хватает, чтобы у человека было две методики */
async function makeSurvey(extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: "Коротка методика" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
    ...extra,
  } as never);
  await createVersion(
    id,
    createSurveySchema.parse({
      title: { uk: "Коротка методика" },
      administration: "self",
      scoringEnabled: true,
      anonymous: extra.anonymous ?? false,
      questions: [1, 2].map((n) => ({
        type: "yesno",
        title: { uk: `Пункт ${n}` },
        required: true,
        options: [
          { text: { uk: "Ні" }, score: 0, keyCode: "no" },
          { text: { uk: "Так" }, score: 1, keyCode: "yes" },
        ],
      })),
      scales: [
        {
          code: "S",
          title: { uk: "Сума" },
          bands: [
            { minScore: 0, maxScore: 1, label: { uk: "Низький" } },
            { minScore: 2, maxScore: 2, label: { uk: "Високий" } },
          ],
          key: [1, 2].map((item) => ({ item, matchKey: "yes", weight: 1 })),
        },
      ],
    }),
    adminA.id,
    "Перша",
  );
  return id;
}

describe("прохождение для графиков", () => {
  let responseId: string;

  beforeAll(async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    responseId = res.body.id;
  });

  /**
   * Мутация: убрать `userId` из ответа маршрута — экран не знает человека,
   * раздел динамики пропадает у всех; проверка называет поле.
   */
  test("персоналу — чьё прохождение; самому обследуемому — он сам", async () => {
    const staff = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token);
    expect(staff.status, JSON.stringify(staff.body)).toBe(200);
    expect(staff.body.userId, "прохождение не знает своего обследуемого").toBe(patient.id);

    const own = await api<ResponseDetail>(`/api/responses/${responseId}`, patient.token);
    expect(own.body.userId).toBe(patient.id);
  });

  /**
   * Мутация: снова не отдавать `normalized` — поле приходит undefined, и
   * экран не отличает сырой балл от нормированного.
   */
  test("у каждого балла сказано, удалось ли нормирование", async () => {
    const { body } = await api<ResponseDetail>(`/api/responses/${responseId}`, adminA.token);
    expect(body.scores.length).toBeGreaterThan(0);
    for (const sc of body.scores) {
      expect(typeof sc.normalized, `шкала ${sc.scaleCode}: normalized не пришло`).toBe("boolean");
      // полоса только у нормированного — тот же договор, что у движка подсчёта
      if (!sc.normalized) expect(sc.band).toBeNull();
    }
  });

  test("анонимное прохождение — без человека", async () => {
    const id = await makeSurvey({ anonymous: true });
    const res = await submitSurvey(id, patient.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const detail = await api<ResponseDetail>(`/api/responses/${res.body.id}`, adminA.token);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.userId, "анонимное прохождение выдало человека").toBeNull();
  });
});

describe("динамика одной методики: ?survey=", () => {
  let person: Person;
  let other: string;

  beforeAll(async () => {
    person = await makeUser("user", `charts-${crypto.randomUUID()}@test`);
    other = await makeSurvey();
    for (const id of [surveyInA, surveyInA, other]) {
      const res = await submitSurvey(id, person.token);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
  });

  /**
   * Мутация: не применять `survey` к выборке методик — в ответе обе
   * методики человека, проверка называет лишнюю.
   */
  test("с параметром — только эта методика, со всеми её замерами", async () => {
    const all = await api<RespondentDynamics>(`/api/dynamics/respondents/${person.id}`, adminA.token);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.surveys.map((s) => s.surveyId).sort()).toEqual([surveyInA, other].sort());

    const one = await api<RespondentDynamics>(`/api/dynamics/respondents/${person.id}?survey=${surveyInA}`, adminA.token);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.surveys.map((s) => s.surveyId), "динамика не сужена до одной методики").toEqual([surveyInA]);
    expect(one.body.surveys[0]!.responseCount).toBe(2);
    // сужение не меняет самих рядов: те же точки, что и без параметра
    const same = all.body.surveys.find((s) => s.surveyId === surveyInA)!;
    expect(one.body.surveys[0]!.scales.map((s) => s.points.length)).toEqual(same.scales.map((s) => s.points.length));
  });

  /**
   * Мутация: отвечать на методику вне зоны отказом — по разнице «403 /
   * пусто» видно, проходил ли человек чужую методику.
   */
  test("методика вне зоны или не пройденная — тот же пустой ответ, а не отказ", async () => {
    const foreign = await api<RespondentDynamics>(`/api/dynamics/respondents/${person.id}?survey=${surveyInB}`, adminA.token);
    expect(foreign.status).toBe(200);
    expect(foreign.body.surveys).toEqual([]);

    const unknown = await api<RespondentDynamics>(
      `/api/dynamics/respondents/${person.id}?survey=${crypto.randomUUID()}`,
      adminA.token,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body.surveys).toEqual([]);
  });

  test("мусор в параметре — 400, а не пятисотка", async () => {
    const res = await api(`/api/dynamics/respondents/${person.id}?survey=${"x".repeat(65)}`, adminA.token);
    expect(res.status).toBe(400);
  });

  test("пациенту маршрут закрыт по-прежнему", async () => {
    const res = await api(`/api/dynamics/respondents/${person.id}?survey=${surveyInA}`, person.token);
    expect(res.status).toBe(403);
  });
});
