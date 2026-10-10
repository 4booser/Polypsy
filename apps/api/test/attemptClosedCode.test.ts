import { describe, expect, test } from "bun:test";
import { adminA, api, createSurveySchema, createVersion, db, groupA, makeUser, sr45, submitSurvey, surveys } from "./fixtures";

/**
 * Отказ «попытка закрыта» — с машинным кодом рядом с текстом (волна 21, мобилка).
 *
 * Сервер отвечает на автосохранение уже сданной попытки 409 (err.alreadyTaken
 * у невозвратной методики, err.attemptAlreadySubmitted у той же попытки), но
 * только текстом на языке человека. Мобилка по такому ответу должна стереть
 * свой черновик, а по соседнему 409 того же маршрута (err.draftOtherVersion)
 * — нет; различить их по тексту нельзя. Поэтому эти ключи едут ещё и в поле
 * `code` (app.ts, onError), а прочие отказы — по-прежнему только текстом.
 *
 * Запросы — через api() фикстур: в шаге test:app-role ролью приложения.
 */

async function onceOnlySurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: "Один раз (код)", ru: "Один раз (код)" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: false,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

describe("код отказа «попытка закрыта»", () => {
  test("повторная сдача невозвратной методики — 409 с кодом err.alreadyTaken", async () => {
    const surveyId = await onceOnlySurvey();
    const person = await makeUser("user", `closed-${crypto.randomUUID()}@test`, {
      sex: "female",
      birthDate: "1991-02-03",
    });

    const first = await submitSurvey(surveyId, person.token);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const again = await submitSurvey(surveyId, person.token);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("err.alreadyTaken");
    // текст — как был, на языке человека
    expect(typeof again.body.error).toBe("string");
    expect(again.body.error).not.toBe("err.alreadyTaken");
  }, 30_000);

  test("прочие отказы ключа не раскрывают", async () => {
    const person = await makeUser("user", `closed-n-${crypto.randomUUID()}@test`);
    const missing = await api(`/api/surveys/${crypto.randomUUID()}`, person.token);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBeUndefined();
    expect(typeof missing.body.error).toBe("string");
  }, 30_000);
});
