import { afterAll, describe, expect, test } from "bun:test";
import { and, inArray, isNull } from "drizzle-orm";
import { adminA, appApi, createSurveySchema, createVersion, db, eq, groupA, makeUser, surveys, type Person } from "./fixtures";
import { alertCases, answers, responses, riskAlerts } from "../src/db/schema";

/**
 * Автосохранение пишет только в черновик своей попытки (#147, находка #197).
 *
 * После #147 сдача забирает только черновик своей попытки — тот же
 * startedAt. А PUT /draft брал любой незданный черновик пары: следующая
 * попытка возвратной методики писала в призрак (черновик уже сданной
 * попытки) или в черновик брошенной прошлой попытки с её тревогой, сохраняя
 * ему чужое начало. Сдача новой попытки такой черновик не забирала — он
 * оставался висеть с ранними тревогами новой попытки, а GET /draft
 * предлагал «продолжить» призрака, автосохранение которого тут же получало
 * 409.
 *
 * Всё, что делает пациент, — ролью приложения (appApi), как в бою; проверки
 * читают базу владельцем.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const people: string[] = [];
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };
type Draft = { id: string; startedAt: string } | null;

/** Один пункт: «Ні» — без тревоги, «Часто» — тяжёлая; у каждой версии свои id пунктов */
function content() {
  const label = (uk: string) => ({ uk, ru: uk });
  return createSurveySchema.parse({
    title: label("Спроба"),
    administration: "self",
    questions: [
      {
        type: "single",
        title: label("Чи бувають думки про небажання жити?"),
        required: true,
        options: [
          { text: label("Ні") },
          { text: label("Часто"), riskFlag: true, riskLabel: label("Часто"), riskSeverity: "severe" },
        ],
      },
    ],
  });
}

async function setup(): Promise<{ surveyId: string; person: Person; shown: Loaded }> {
  const surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: `Спроба ${tag()}`, ru: "Попытка" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(surveyId, content(), adminA.id, "v1");
  const person = await makeUser("user", `attempt-${tag()}@test.dev`, { sex: "male", birthDate: "1989-02-02" });
  people.push(person.id);
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
  return { surveyId, person, shown };
}

function body(shown: Loaded, startedAt: string, option: 0 | 1) {
  const q = shown.questions[0]!;
  return { startedAt, versionId: shown.versionId, answers: [{ questionId: q.id, optionIds: [q.options[option]!.id] }] };
}

async function saveDraft(s: Awaited<ReturnType<typeof setup>>, startedAt: string, option: 0 | 1) {
  const res = await appApi<{ id: string }>(`/api/surveys/${s.surveyId}/draft`, s.person.token, {
    method: "PUT",
    body: JSON.stringify({ ...body(s.shown, startedAt, option), durationMs: 10_000 }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id;
}

async function submit(s: Awaited<ReturnType<typeof setup>>, startedAt: string, option: 0 | 1) {
  const res = await appApi<{ id: string }>(`/api/surveys/${s.surveyId}/responses`, s.person.token, {
    method: "POST",
    body: JSON.stringify({ ...body(s.shown, startedAt, option), durationMs: 60_000, events: [] }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

async function getDraft(s: Awaited<ReturnType<typeof setup>>): Promise<Draft> {
  const res = await appApi<Draft>(`/api/surveys/${s.surveyId}/draft`, s.person.token);
  expect(res.status).toBe(200);
  return res.body;
}

async function draftsOf(s: Awaited<ReturnType<typeof setup>>) {
  return db
    .select({ id: responses.id, startedAt: responses.startedAt })
    .from(responses)
    .where(and(eq(responses.surveyId, s.surveyId), eq(responses.userId, s.person.id), eq(responses.status, "in_progress")));
}

/** Методику переиздали: новая версия со своими пунктами — клиент открывает её */
async function reissue(s: Awaited<ReturnType<typeof setup>>) {
  const before = s.shown.versionId;
  await createVersion(s.surveyId, content(), adminA.id, "v2");
  s.shown = (await appApi<Loaded>(`/api/surveys/${s.surveyId}`, s.person.token)).body;
  expect(s.shown.versionId).not.toBe(before);
}

/** Состояние «до #147»: черновик уже сданной попытки с тревогой — как его писало прежнее автосохранение */
async function ghostOf(
  s: Awaited<ReturnType<typeof setup>>,
  startedAt: string,
  o: { alert: boolean; option?: 0 | 1 } = { alert: true },
): Promise<{ id: string; alertId: string }> {
  const id = crypto.randomUUID();
  const q = s.shown.questions[0]!;
  await db.insert(responses).values({
    id,
    surveyId: s.surveyId,
    userId: s.person.id,
    versionId: s.shown.versionId,
    status: "in_progress",
    startedAt,
    lastSavedAt: new Date().toISOString(),
    durationMs: 61_000,
  });
  await db.insert(answers).values({ id: crypto.randomUUID(), responseId: id, questionId: q.id, optionIds: [q.options[o.option ?? 1]!.id] });
  const alertId = crypto.randomUUID();
  if (!o.alert) return { id, alertId };
  await db.insert(riskAlerts).values({
    id: alertId,
    responseId: id,
    surveyId: s.surveyId,
    questionId: q.id,
    userId: s.person.id,
    label: "Часто",
    severity: "severe",
  });
  return { id, alertId };
}

afterAll(async () => {
  // своё — в конечном состоянии: открытые тревоги и случаи разобраны (открытый случай — строка очереди дежурного)
  if (!people.length) return;
  const at = new Date().toISOString();
  await db.update(riskAlerts).set({ acknowledgedAt: at, acknowledgedBy: adminA.id }).where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
  await db
    .update(alertCases)
    .set({ acknowledgedAt: at, acknowledgedBy: adminA.id, outcome: "not_confirmed" })
    .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
}, 30_000);

describe("автосохранение — в черновик своей попытки", () => {
  test("положительный контроль: автосохранение своей попытки продолжается в своём черновике", async () => {
    const s = await setup();
    const started = minutesAgo(5);
    const first = await saveDraft(s, started, 0);
    const second = await saveDraft(s, started, 1);
    expect(second).toBe(first);
    expect((await draftsOf(s)).map((d) => d.id)).toEqual([first]);
    expect((await getDraft(s))?.id).toBe(first);
  }, 30_000);

  test("новая попытка не пишет в призрак: у неё свой черновик, призрак с тревогой цел", async () => {
    const s = await setup();
    const s1 = minutesAgo(30);
    await saveDraft(s, s1, 1);
    await submit(s, s1, 1);
    const ghost = await ghostOf(s, s1);

    const s2 = minutesAgo(1);
    const own = await saveDraft(s, s2, 0);
    expect(own, "новая попытка записалась в призрак").not.toBe(ghost.id);
    const [row] = await db.select().from(responses).where(eq(responses.id, ghost.id));
    expect(new Date(row!.startedAt).toISOString()).toBe(s1);
    const ghostAnswers = await db.select().from(answers).where(eq(answers.responseId, ghost.id));
    expect(ghostAnswers.map((a) => a.optionIds)).toEqual([[s.shown.questions[0]!.options[1]!.id]]);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.id, ghost.alertId))).length).toBe(1);
  }, 30_000);

  test("новая попытка не пишет в черновик прошлой попытки с тревогой; сдача новой его не трогает", async () => {
    const s = await setup();
    const s1 = minutesAgo(30);
    const earlier = await saveDraft(s, s1, 1);
    const [signal] = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, earlier));
    expect(signal).toBeDefined();

    const s2 = minutesAgo(1);
    const own = await saveDraft(s, s2, 0);
    expect(own, "новая попытка записалась в черновик прошлой — с её тревогой").not.toBe(earlier);
    expect((await getDraft(s))?.id, "продолжить предлагается не последняя попытка").toBe(own);

    await submit(s, s2, 0);
    // черновик прошлой попытки и его тревога — на месте: это настоящий сигнал своей попытки
    expect((await draftsOf(s)).map((d) => d.id)).toEqual([earlier]);
    const [kept] = await db.select().from(riskAlerts).where(eq(riskAlerts.id, signal!.id));
    expect(kept?.responseId).toBe(earlier);
  }, 30_000);

  test("брошенный черновик прошлой попытки без тревог убирается, новая попытка пишет в свой", async () => {
    const s = await setup();
    const abandoned = await saveDraft(s, minutesAgo(30), 0);
    const s2 = minutesAgo(1);
    const own = await saveDraft(s, s2, 0);
    expect(own).not.toBe(abandoned);
    const left = await draftsOf(s);
    expect(left.map((d) => [d.id, new Date(d.startedAt).toISOString()])).toEqual([[own, s2]]);

    // сдача новой попытки забирает его — черновиков у пары не остаётся
    await submit(s, s2, 0);
    expect(await draftsOf(s)).toEqual([]);
  }, 30_000);

  test("после переиздания методики новая попытка поверх призрака прежней версии без тревоги — пишет, ранняя тревога есть", async () => {
    /*
     * Ревью волны 22: призрака GET /draft не показывает, и клиенту не
     * узнать его версию для replacesVersionId. Запрет смены версии стоял и
     * на чужом черновике — новая попытка получала 409 на каждом
     * автосохранении, без черновика и без ранней тревоги.
     */
    const s = await setup();
    const s1 = minutesAgo(60);
    await submit(s, s1, 0);
    const ghost = await ghostOf(s, s1, { alert: false, option: 0 });
    await reissue(s);
    expect(await getDraft(s)).toBeNull();

    const s2 = minutesAgo(1);
    const own = await saveDraft(s, s2, 1);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, own))).length, "ранней тревоги нет").toBe(1);
    expect((await draftsOf(s)).map((d) => d.id)).toEqual([own]);
    expect((await db.select().from(responses).where(eq(responses.id, ghost.id))).length).toBe(0);
  }, 30_000);

  test("брошенный черновик прежней версии с ответами — новая попытка убирает его без явной замены", async () => {
    const s = await setup();
    const abandoned = await saveDraft(s, minutesAgo(60), 0);
    await reissue(s);
    const own = await saveDraft(s, minutesAgo(1), 1);
    expect(own).not.toBe(abandoned);
    expect((await draftsOf(s)).map((d) => d.id)).toEqual([own]);
    expect((await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, own))).length).toBe(1);
  }, 30_000);

  test("GET /draft не предлагает продолжить призрака", async () => {
    const s = await setup();
    const s1 = minutesAgo(30);
    await saveDraft(s, s1, 1);
    await submit(s, s1, 1);
    await ghostOf(s, s1);
    expect(await getDraft(s), "предложено продолжить уже сданную попытку").toBeNull();
  }, 30_000);
});
