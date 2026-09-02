import { beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  adminB,
  api,
  app,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  sr45,
  submitSurvey,
  surveyInA,
  surveys,
  json,
} from "./fixtures";

/**
 * Мульти-информант.
 *
 * Главное свойство контура — оценка со стороны НЕ смешивается с самоотчётом.
 * Расхождение между ними это сигнал; сложенные в одну кучу, они перестают
 * быть и тем, и другим.
 */

let informantSurvey: string;
let patient: { id: string; token: string };

beforeAll(async () => {
  informantSurvey = crypto.randomUUID();
  await db.insert(surveys).values({
    id: informantSurvey,
    groupId: groupA,
    title: { uk: "Оцінка командира", ru: "Оценка командира" },
    administration: "informant",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(informantSurvey, createSurveySchema.parse(sr45), adminA.id, "v1");

  patient = await makeUser("user", `inf-${crypto.randomUUID()}@test`);
  await submitSurvey(surveyInA, patient.token);
});

async function invite(role = "commander") {
  return api(`/api/informants/patients/${patient.id}`, adminA.token, {
    method: "POST",
    body: JSON.stringify({ surveyId: informantSurvey, role }),
  });
}

async function fillForm(token: string) {
  const state = await app.request(`/api/informants/form/${token}`);
  const body = (await json(state)) as {
    valid: boolean;
    survey: { questions: { id: string; type: string; options: { id: string }[] }[] };
  };
  const answers = body.survey.questions
    .filter((q) => q.type !== "info" && q.options.length)
    .map((q) => ({
      questionId: q.id,
      optionIds: [q.options[0]!.id],
      durationMs: 1200,
      changeCount: 0,
      visitCount: 1,
    }));

  return app.request(`/api/informants/form/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answers,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
    }),
  });
}

describe("запрос к информанту", () => {
  test("ссылка выдаётся один раз и открывает форму без учётной записи", async () => {
    const created = await invite();
    expect(created.status).toBe(201);
    expect(created.body.token).toBeTruthy();

    // без заголовка Authorization — у информанта нет учётной записи
    const form = await app.request(`/api/informants/form/${created.body.token}`);
    expect(form.status).toBe(200);
    const body = await json(form);
    expect(body.valid).toBe(true);
    expect(body.role).toBe("commander");
  });

  test("пациент показан инициалами, а не именем", async () => {
    /*
     * Ссылку могут переслать не тому. Полное имя в такой ссылке — утечка,
     * которую никто не заметит.
     */
    const created = await invite();
    const form = await app.request(`/api/informants/form/${created.body.token}`);
    const body = await json(form);
    expect(body.about.length).toBeLessThanOrEqual(2);
  });

  test("самоотчётную методику информанту выдать нельзя", async () => {
    // иначе взгляд со стороны попал бы в ту же выборку, и норма с альфой
    // поехали бы молча
    const bad = await api(`/api/informants/patients/${patient.id}`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: surveyInA, role: "commander" }),
    });
    expect(bad.status).toBe(400);
  });

  test("чужой админ ссылку не выдаст", async () => {
    const denied = await api(`/api/informants/patients/${patient.id}`, adminB.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: informantSurvey, role: "commander" }),
    });
    expect(denied.status).toBe(404);
  });
});

describe("заполнение информантом", () => {
  test("ссылка одноразовая", async () => {
    const created = await invite();
    expect((await fillForm(created.body.token)).status).toBe(201);

    const second = await app.request(`/api/informants/form/${created.body.token}`);
    const body = await json(second);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("used");
  });

  test("отозванная ссылка не открывается", async () => {
    const created = await invite();
    await api(`/api/informants/${created.body.id}/revoke`, adminA.token, { method: "POST" });

    const form = await app.request(`/api/informants/form/${created.body.token}`);
    expect((await json(form)).reason).toBe("revoked");
  });

  test("оценка со стороны не попадает в динамику пациента", async () => {
    /*
     * Самое важное здесь. Если бы прохождение информанта записалось на
     * пациента, оно легло бы в его график, в расчёт достоверности изменения и
     * в выборку норм — и никто бы не заметил, потому что число выглядит как
     * обычный замер.
     */
    const before = await api(`/api/dynamics/respondents/${patient.id}`, adminA.token);
    const countBefore = before.body.surveys.reduce(
      (n: number, s: { responseCount: number }) => n + s.responseCount,
      0,
    );

    const created = await invite("peer");
    expect((await fillForm(created.body.token)).status).toBe(201);

    const after = await api(`/api/dynamics/respondents/${patient.id}`, adminA.token);
    const countAfter = after.body.surveys.reduce(
      (n: number, s: { responseCount: number }) => n + s.responseCount,
      0,
    );

    expect(countAfter).toBe(countBefore);
    expect(after.body.surveys.some((s: { surveyId: string }) => s.surveyId === informantSurvey)).toBe(
      false,
    );
  });
});

describe("сравнение перспектив", () => {
  test("шкалы сопоставляются по коду, расхождение считается только по общим", async () => {
    const created = await invite("family");
    await fillForm(created.body.token);

    const compare = await api(`/api/informants/compare/${patient.id}`, adminA.token);
    expect(compare.status).toBe(200);

    const family = compare.body.items.find((i: { role: string }) => i.role === "family");
    expect(family).toBeTruthy();
    expect(family.scales.length).toBeGreaterThan(0);

    /*
     * У шкал, которых нет в самоотчёте, расхождение null, а не ноль: ноль
     * означал бы «человек оценил себя на ноль», а он просто не отвечал.
     */
    for (const s of family.scales) {
      if (s.self === null) expect(s.gap).toBeNull();
      else expect(s.gap).toBeCloseTo(s.informant - s.self, 2);
    }
  });

  test("чужой админ сравнение не получает", async () => {
    const denied = await api(`/api/informants/compare/${patient.id}`, adminB.token);
    expect(denied.status).toBe(404);
  });
});
