import { describe, expect, test } from "bun:test";
import {
  adminA,
  and,
  api,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  responsesTable,
  sr45,
  surveys,
} from "./fixtures";

/**
 * Методика, которую проходят один раз, проходится один раз и при гонке.
 *
 * Проверка «уже проходил» и запись результата идут в одной транзакции, но на
 * READ COMMITTED это гонку не закрывает: две отправки, ушедшие одновременно
 * (двойное нажатие, повтор из офлайн-очереди без clientRequestId), не видят
 * чужую незакоммиченную строку и обе записываются. В карте остаются два
 * «единственных» прохождения с разными баллами и разными тревогами — и
 * решить, какое из них результат, некому.
 */

/** Методика без повторного прохождения; версия заводится настоящим конвейером */
async function onceOnlySurvey(tag: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Один раз ${tag}`, ru: `Один раз ${tag}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    // ради этого флага тест и существует
    allowRetake: false,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

async function submission(surveyId: string, token: string) {
  const survey = (await api(`/api/surveys/${surveyId}`, token)).body;
  const answers = survey.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id],
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    }),
  };
}

describe("повторное прохождение при гонке", () => {
  test("две одновременные отправки дают 201 и 409, а в базе одно прохождение", async () => {
    const surveyId = await onceOnlySurvey("race");
    const person = await makeUser("user", `retake-${crypto.randomUUID()}@test`, {
      sex: "male",
      birthDate: "1990-01-01",
    });
    const init = await submission(surveyId, person.token);

    /*
     * Promise.all, а не два вызова подряд: обе транзакции должны успеть
     * сделать свою проверку до чужого коммита — иначе гонки нет и
     * проверять нечего.
     */
    const [first, second] = await Promise.all([
      api(`/api/surveys/${surveyId}/responses`, person.token, init),
      api(`/api/surveys/${surveyId}/responses`, person.token, init),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    /*
     * Ответ мог бы отказать и по другой причине — проверяем саму карту:
     * завершённое прохождение должно быть ровно одно.
     */
    const stored = await db
      .select({ id: responsesTable.id })
      .from(responsesTable)
      .where(
        and(
          eq(responsesTable.surveyId, surveyId),
          eq(responsesTable.userId, person.id),
          eq(responsesTable.status, "completed"),
        ),
      );
    expect(stored.length).toBe(1);
  });

  test("отказ достаётся второму, а не обоим: одиночная отправка проходит", async () => {
    // страховка от «починки» замком, который запирает всех подряд
    const surveyId = await onceOnlySurvey("solo");
    const person = await makeUser("user", `retake-solo-${crypto.randomUUID()}@test`, {
      sex: "male",
      birthDate: "1990-01-01",
    });
    const init = await submission(surveyId, person.token);
    const res = await api(`/api/surveys/${surveyId}/responses`, person.token, init);
    expect(res.status).toBe(201);
  });
});
