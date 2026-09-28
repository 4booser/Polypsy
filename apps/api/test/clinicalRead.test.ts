import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  appApi,
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  groupAdmins,
  makeUser,
  root,
  sr45,
  submitSurvey,
  surveys,
  type Person,
} from "./fixtures";
import { permissionExceptions } from "../src/db/schema";

/**
 * Запрет patients.read закрывает результаты во всех представлениях (волна 15,
 * внешний разбор, P1).
 *
 * Было: у сотрудника — администратора группы методик — личным исключением
 * отнято patients.read. Список прохождений и заключение отвечали 403, а
 * прохождение по известному id (JSON с баллами и id пациента), печатный
 * лист с ФИО и подписанным заключением, выдача одноразовой ссылки на него и
 * открытие этой ссылки — 200: каждый вход проверял роль и зону методики, но
 * не право читать данные пациента.
 *
 * Стало: одна проверка «сотрудник читает клинические данные по этому
 * прохождению» (lib/clinicalRead.ts) — её зовут заключения, прохождение по
 * id, печать, выдача и открытие ссылки. Собственное прохождение — отдельным
 * условием: пациент печатает своё, в том числе мобилкой по ссылке.
 *
 * Все запросы — ролью приложения (appApi / appRequest), как в бою: под
 * владельцем политики строк не действуют, и зелёная проверка доказывала бы
 * меньше, чем кажется.
 */

const MARK = `ПОДПИСАННЫЙ-ТЕКСТ-${crypto.randomUUID()}`;

let surveyId = "";
let patient: Person;
let denied: Person;
let colleague: Person;
let responseId = "";
/** Ссылка, выданная ДО того, как право отняли: открываться она уже не должна */
let earlyLink = "";

beforeAll(async () => {
  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: "Запрет чтения", ru: "Запрет чтения", en: "Read denial" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showResultsToPatient: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "clinicalRead");

  patient = await makeUser("user", `clinical-read-p-${crypto.randomUUID()}@test`);
  const done = await submitSurvey(surveyId, patient.token);
  expect(done.status, JSON.stringify(done.body)).toBe(201);
  responseId = done.body.id;

  /* подписанное заключение — то, что лист печатает и что запрет обязан закрыть */
  const saved = await appApi(`/api/conclusions/responses/${responseId}/conclusion`, root.token, {
    method: "PUT",
    body: JSON.stringify({ text: MARK, baseVersion: 0 }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const signed = await appApi(`/api/conclusions/responses/${responseId}/conclusion/sign`, root.token, {
    method: "POST",
    body: JSON.stringify({ version: 1, revision: 1 }),
  });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);

  /* два администратора группы А со встроенной ролью; у одного право отнимут */
  denied = await makeUser("admin", `clinical-read-denied-${crypto.randomUUID()}@test`);
  colleague = await makeUser("admin", `clinical-read-ok-${crypto.randomUUID()}@test`);
  await db.insert(groupAdmins).values([
    { groupId: groupA, userId: denied.id, addedBy: root.id },
    { groupId: groupA, userId: colleague.id, addedBy: root.id },
  ]);

  const early = await appApi<{ path: string }>(`/api/reports/responses/${responseId}/link`, denied.token, {
    method: "POST",
  });
  expect(early.status, JSON.stringify(early.body)).toBe(201);
  earlyLink = early.body.path;

  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: denied.id,
    permission: "patients.read",
    mode: "revoke",
    reason: "Проверка запрета чтения данных пациентов",
    grantedBy: root.id,
  });
}, 60_000);

afterAll(async () => {
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
});

/** Отказ именно по праву, и в теле нет ничего из прохождения */
function expectDenied(res: { status: number; body: unknown }, what: string) {
  expect(res.status, `${what}: ${JSON.stringify(res.body)?.slice(0, 200)}`).toBe(403);
  const text = JSON.stringify(res.body) ?? "";
  expect(text, what).toContain("patients.read");
  expect(text, `${what}: пациент в ответе`).not.toContain(patient.id);
  expect(text, `${what}: заключение в ответе`).not.toContain(MARK);
}

async function page(path: string, token?: string) {
  const res = token
    ? await appRequestWithToken(path, token)
    : await appRequest(path, { headers: { "Accept-Language": "uk" } });
  return { status: res.status, text: await res.text() };
}

function appRequestWithToken(path: string, token: string): Promise<Response> {
  return appRequest(path, { headers: { Authorization: `Bearer ${token}`, "Accept-Language": "uk" } });
}

describe("сотрудник без patients.read", () => {
  test("заключение — отказ (контрольный запрет, как был)", async () => {
    expectDenied(await appApi(`/api/conclusions/responses/${responseId}/conclusion`, denied.token), "заключение");
  });

  test("прохождение по id — отказ, без баллов и без id пациента", async () => {
    expectDenied(await appApi(`/api/responses/${responseId}`, denied.token), "прохождение по id");
  });

  test("печатный лист — отказ, без ФИО и заключения", async () => {
    const res = await page(`/api/reports/responses/${responseId}`, denied.token);
    expect(res.status).toBe(403);
    expect(res.text).toContain("patients.read");
    expect(res.text).not.toContain(MARK);
  });

  test("выдача одноразовой ссылки — отказ", async () => {
    expectDenied(
      await appApi(`/api/reports/responses/${responseId}/link`, denied.token, { method: "POST" }),
      "выдача ссылки",
    );
  });

  test("ссылка, выданная до запрета, не открывается", async () => {
    const res = await page(earlyLink);
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(MARK);
  });

  test("черновик заключения из результатов — тоже чтение данных, отказ", async () => {
    /*
     * Право готовить заключения у него осталось, но черновик из результатов —
     * это ФИО, возраст и баллы человека: запрет чтения обходился бы им так же,
     * как печатью.
     */
    expectDenied(
      await appApi(`/api/conclusions/responses/${responseId}/conclusion/draft`, denied.token),
      "черновик заключения",
    );
  });
});

describe("кому можно — по-прежнему можно", () => {
  test("коллега с правом: прохождение, лист, ссылка", async () => {
    const detail = await appApi(`/api/responses/${responseId}`, colleague.token);
    expect(detail.status, JSON.stringify(detail.body)?.slice(0, 200)).toBe(200);
    expect(detail.body.userId).toBe(patient.id);

    const sheet = await page(`/api/reports/responses/${responseId}`, colleague.token);
    expect(sheet.status).toBe(200);
    expect(sheet.text).toContain(MARK);

    const link = await appApi<{ path: string }>(`/api/reports/responses/${responseId}/link`, colleague.token, {
      method: "POST",
    });
    expect(link.status).toBe(201);
    const opened = await page(link.body.path);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain(MARK);
  });

  test("пациент: своё прохождение, свой лист и мобильная печать ссылкой", async () => {
    const detail = await appApi(`/api/responses/${responseId}`, patient.token);
    expect(detail.status).toBe(200);

    const sheet = await page(`/api/reports/responses/${responseId}`, patient.token);
    expect(sheet.status).toBe(200);
    expect(sheet.text).toContain(MARK);

    const link = await appApi<{ path: string }>(`/api/reports/responses/${responseId}/link`, patient.token, {
      method: "POST",
    });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const opened = await page(link.body.path);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain(MARK);
  });
});
