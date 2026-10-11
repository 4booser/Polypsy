import { afterAll, describe, expect, test } from "bun:test";
import { adminA, api, createSurveySchema, createVersion, db, groupA, makeUser, root, sr45, submitSurvey, surveys } from "./fixtures";
import { consentTexts, consents } from "../src/db/schema";

/**
 * 403 «сначала примите согласие» — с машинным кодом рядом с текстом (#201).
 *
 * Отказ отдавался только текстом на языке человека, и клиент узнавал
 * причину лишним вопросом о статусе согласия после любого 403, а очередь
 * веб-кабинета не узнавала вовсе: сдача на новой редакции согласия
 * становилась отвергнутой. Теперь ключ err.consentRequired едет и в поле
 * `code` (app.ts, onError, CLIENT_DECISION_CODES); прочие отказы — как были,
 * только текстом.
 *
 * Запросы — через api() фикстур: в шаге test:app-role ролью приложения.
 */

/* текст согласия общий на всю базу: после файла его не остаётся (как в submitIntegrity.test.ts) */
afterAll(async () => {
  await db.delete(consents);
  await db.delete(consentTexts);
});

const tag = () => crypto.randomUUID().slice(0, 8);

async function publicSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: "Згода (код)", ru: "Согласие (код)" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

describe("код отказа «нужно согласие»", () => {
  test("сдача и черновик без принятой редакции — 403 с кодом err.consentRequired; принял — сдача проходит", async () => {
    const put = await api("/api/consents/text", root.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: `Згода, редакція ${tag()}`, ru: `Согласие ${tag()}` } }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const surveyId = await publicSurvey();
    const person = await makeUser("user", `consent-code-${tag()}@test.dev`, { sex: "female", birthDate: "1990-05-06" });

    const refused = await submitSurvey(surveyId, person.token);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("err.consentRequired");
    // текст — как был, на языке человека
    expect(typeof refused.body.error).toBe("string");
    expect(refused.body.error).not.toBe("err.consentRequired");

    const draft = await api(`/api/surveys/${surveyId}/draft`, person.token, {
      method: "PUT",
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMs: 1000, answers: [] }),
    });
    expect(draft.status).toBe(403);
    expect(draft.body.code).toBe("err.consentRequired");

    // положительный контроль: принял показанную редакцию — та же сдача проходит
    const status = await api("/api/consents/me", person.token);
    const accepted = await api("/api/consents/me/accept", person.token, {
      method: "POST",
      body: JSON.stringify({ textId: status.body.textId }),
    });
    expect(accepted.status).toBe(200);
    const sent = await submitSurvey(surveyId, person.token);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  }, 30_000);

  test("положительный контроль: другой 403 ключа не раскрывает", async () => {
    const person = await makeUser("user", `consent-code-n-${tag()}@test.dev`);
    // пациенту маршрут сотрудников закрыт классом учётки — тоже 403, но не о согласии
    const denied = await api("/api/dynamics/respondents", person.token);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBeUndefined();
    expect(typeof denied.body.error).toBe("string");
  }, 30_000);
});
