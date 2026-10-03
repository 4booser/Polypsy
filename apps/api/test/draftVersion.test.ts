import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  adminA,
  and,
  api,
  appApi,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  sql,
  surveys,
} from "./fixtures";
import { responses } from "../src/db/schema";

/**
 * Черновик и обновлённая методика (волна 16, внешний разбор, P1).
 *
 * Мобилка открывала методику в действующей версии, а ответы черновика
 * брала из той, на которой человек начинал. Автосохранение слало
 * несовместимую пару — версию v2 и ответы на пункты v1, — и сервер отвечал
 * 200 с «answers: 1»: переписывал версию черновика, стирал прежние ответы и
 * молча пропускал пришедшие, потому что таких пунктов в v2 нет. Следующее
 * чтение показывало пустой черновик. Каждая версия заводит пункты с новыми
 * идентификаторами, так что «перенести» ответы нечем — их можно только
 * потерять.
 *
 * Здесь закреплено то, что должно быть вместо этого: сервер не принимает
 * молча ответы, которых не может сохранить (409 с понятной фразой), не
 * меняет версию черновика с ответами без явного «начинаю заново», а чтение
 * черновика называет его версию так, чтобы клиент мог её открыть.
 *
 * Сюита гоняется и под ролью приложения (test:app-role): черновик —
 * данные пациента, и политики строк под ним должны пропустить ровно то же.
 */

const tag = () => crypto.randomUUID().slice(0, 8);

/*
 * v1 — один обязательный текстовый пункт. v2 — как у ревьюера: первый пункт
 * необязательный, чтобы «Далі» пропускало без ввода, и тут же уходило
 * автосохранение с восстановленными ответами v1.
 */
function content(version: 1 | 2) {
  const text = (uk: string, required: boolean) => ({ type: "text" as const, title: { uk, ru: uk }, required });
  return createSurveySchema.parse({
    title: { uk: "Черновик и версия", ru: "Черновик и версия" },
    administration: "self",
    scoringEnabled: false,
    questions: version === 1 ? [text("Відповідь", true)] : [text("Відповідь", false), text("Другий пункт", false)],
  });
}

async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Черновик ${tag()}`, ru: "Черновик" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: false,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, content(1), adminA.id, "v1");
  return id;
}

type Shown = { versionId: string; versionNumber: number; questions: { id: string }[] };
type Draft = {
  id: string;
  versionId: string;
  versionNumber: number | null;
  answers: { questionId: string; text?: string }[];
} | null;

const TEXT = `ВІДПОВІДЬ-${tag()}`;

function putDraft(surveyId: string, token: string, body: Record<string, unknown>) {
  return api(`/api/surveys/${surveyId}/draft`, token, {
    method: "PUT",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 7000, events: [], ...body }),
  });
}

/** Черновик на v1 с одним текстовым ответом, затем методику обновили до v2 */
async function draftOnV1ThenV2() {
  const surveyId = await makeSurvey();
  const person = await makeUser("user", `draft-v-${tag()}@test.dev`);
  const v1 = (await api<Shown>(`/api/surveys/${surveyId}`, person.token)).body;
  const first = await putDraft(surveyId, person.token, {
    versionId: v1.versionId,
    answers: [{ questionId: v1.questions[0]!.id, text: TEXT }],
  });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  await createVersion(surveyId, content(2), adminA.id, "v2");
  const v2 = (await api<Shown>(`/api/surveys/${surveyId}`, person.token)).body;
  expect(v2.versionId).not.toBe(v1.versionId);
  return { surveyId, person, v1, v2 };
}

describe("черновик и новая версия методики", () => {
  test("ответы v1 под версией v2 — 409 с понятной фразой, черновик v1 цел", async () => {
    const { surveyId, person, v1, v2 } = await draftOnV1ThenV2();

    // ровно то, что собирала мобилка: версия — с экрана, ответы — из черновика
    const remote = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    const res = await putDraft(surveyId, person.token, { versionId: v2.versionId, answers: remote.answers });
    expect(res.status, "сервер принял ответы, которых не может сохранить").toBe(409);
    expect(res.body.error).toContain("версії");

    const after = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(after.versionId, "версия черновика переписана").toBe(v1.versionId);
    expect(after.answers.map((a) => a.text), "ответы черновика стёрты").toEqual([TEXT]);
  });

  test("чтение черновика называет его версию и её номер — клиенту есть что открыть", async () => {
    const { surveyId, person, v1 } = await draftOnV1ThenV2();
    const draft = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(draft.versionId).toBe(v1.versionId);
    expect(draft.versionNumber).toBe(v1.versionNumber);

    // по номеру открывается именно та версия, на которой начато
    const opened = await api<Shown>(`/api/surveys/${surveyId}?version=${draft.versionNumber}`, person.token);
    expect(opened.status).toBe(200);
    expect(opened.body.versionId).toBe(v1.versionId);
    expect(opened.body.questions.map((q) => q.id)).toContain(draft.answers[0]!.questionId);
  });

  test("продолжение в своей версии после обновления — 200, ответы на месте", async () => {
    const { surveyId, person, v1 } = await draftOnV1ThenV2();
    const res = await putDraft(surveyId, person.token, {
      versionId: v1.versionId,
      answers: [{ questionId: v1.questions[0]!.id, text: `${TEXT}+` }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.answers).toBe(1);
    const after = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(after.versionId).toBe(v1.versionId);
    expect(after.answers.map((a) => a.text)).toEqual([`${TEXT}+`]);
  });

  test("новая версия поверх черновика с ответами — только явной заменой", async () => {
    const { surveyId, person, v1, v2 } = await draftOnV1ThenV2();
    const fresh = [{ questionId: v2.questions[1]!.id, text: "нове" }];

    // ответы v2 сами по себе верны, но черновик v1 с ответами молча не заменяется
    const implicit = await putDraft(surveyId, person.token, { versionId: v2.versionId, answers: fresh });
    expect(implicit.status, "черновик прежней версии заменён без спроса").toBe(409);
    expect(implicit.body.error).toContain("версії");
    const kept = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(kept.versionId).toBe(v1.versionId);
    expect(kept.answers.map((a) => a.text)).toEqual([TEXT]);

    // человек увидел, что черновик в другой версии, и начал заново — это отдельное явное действие
    const replaced = await putDraft(surveyId, person.token, {
      versionId: v2.versionId,
      replacesVersionId: v1.versionId,
      answers: fresh,
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const now = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(now.versionId).toBe(v2.versionId);
    expect(now.versionNumber).toBe(v2.versionNumber);
    expect(now.answers.map((a) => a.text)).toEqual(["нове"]);

    // черновик по-прежнему один
    const rows = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.userId, person.id), eq(responses.status, "in_progress")));
    expect(rows.length).toBe(1);
  });

  test("замена с устаревшим основанием — тоже 409: заменяют только ту версию, которую видели", async () => {
    const { surveyId, person, v2 } = await draftOnV1ThenV2();
    const res = await putDraft(surveyId, person.token, {
      versionId: v2.versionId,
      replacesVersionId: v2.versionId,
      answers: [{ questionId: v2.questions[1]!.id, text: "нове" }],
    });
    expect(res.status).toBe(409);
  });

  test("пустой черновик прежней версии заменяется без спроса — терять нечего", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `draft-empty-${tag()}@test.dev`);
    const v1 = (await api<Shown>(`/api/surveys/${surveyId}`, person.token)).body;
    expect((await putDraft(surveyId, person.token, { versionId: v1.versionId, answers: [] })).status).toBe(200);
    await createVersion(surveyId, content(2), adminA.id, "v2");
    const v2 = (await api<Shown>(`/api/surveys/${surveyId}`, person.token)).body;

    const res = await putDraft(surveyId, person.token, {
      versionId: v2.versionId,
      answers: [{ questionId: v2.questions[0]!.id, text: "перше" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const now = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(now.versionId).toBe(v2.versionId);
  });

  test("сдача с ответами чужой версии — 409, прохождения нет", async () => {
    /*
     * Та же причина на сдаче: пункты v2 необязательные, и прохождение с
     * ответами на пункты v1 записывалось пустым — «пройдено» без единого
     * ответа, которого человек не давал.
     */
    const { surveyId, person, v1, v2 } = await draftOnV1ThenV2();
    const res = await api(`/api/surveys/${surveyId}/responses`, person.token, {
      method: "POST",
      body: JSON.stringify({
        versionId: v2.versionId,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: [{ questionId: v1.questions[0]!.id, text: TEXT }],
      }),
    });
    expect(res.status, "сдача с чужими пунктами записана").toBe(409);
    expect(res.body.error).toContain("версії");
    const completed = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.userId, person.id), eq(responses.status, "completed")));
    expect(completed).toEqual([]);
  });
});

/* ═══════════ гонка: замена и продолжение одного черновика разом ═══════════ */

/** Отдельное соединение держит строку черновика — приём из transitionRaces.test.ts */
const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

afterAll(async () => {
  await holder.end();
});

async function waitingOnDrafts(): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      and query ilike ${'%"responses"%'}
  `);
  return Number(row?.n ?? 0);
}

async function untilWaiting(n: number, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await waitingOnDrafts()) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за строкой черновика меньше ${n} запросов — гонка не воспроизведена`);
}

describe("черновик: смена версии и запись — одним куском", () => {
  test("одно устройство начало заново на v2, другое тут же сохраняет v1 — второе получает 409, ответы v2 целы", async () => {
    /*
     * Без замка строки оба запроса читали черновик на v1: замена проходила
     * по своему основанию, продолжение — как «та же версия», и позднее
     * записанное продолжение молча возвращало черновик на v1, стирая
     * ответы, данные на v2. Теперь второй ждёт замка, видит уже v2 и
     * получает отказ — решать по черновику, которого больше нет, нельзя.
     */
    const { surveyId, person, v1, v2 } = await draftOnV1ThenV2();
    const [row] = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.userId, person.id), eq(responses.status, "in_progress")));
    const common = { startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 9000, events: [] };
    const restart = () =>
      appApi(`/api/surveys/${surveyId}/draft`, person.token, {
        method: "PUT",
        body: JSON.stringify({
          ...common,
          versionId: v2.versionId,
          replacesVersionId: v1.versionId,
          answers: [{ questionId: v2.questions[1]!.id, text: "НОВЕ" }],
        }),
      });
    const resume = () =>
      appApi(`/api/surveys/${surveyId}/draft`, person.token, {
        method: "PUT",
        body: JSON.stringify({ ...common, versionId: v1.versionId, answers: [{ questionId: v1.questions[0]!.id, text: "СТАРЕ" }] }),
      });

    const results: { status: number }[] = [];
    const pending: Promise<{ status: number }>[] = [];
    await holder.begin(async (tx) => {
      await tx`select id from responses where id = ${row!.id} for update`;
      for (const [i, start] of [restart, resume].entries()) {
        const p = start();
        p.catch(() => {});
        pending.push(p);
        await untilWaiting(i + 1);
      }
    });
    results.push(...(await Promise.all(pending)));

    expect(results.map((r) => r.status)).toEqual([200, 409]);
    const now = (await api<Draft>(`/api/surveys/${surveyId}/draft`, person.token)).body!;
    expect(now.versionId, "запоздалое продолжение вернуло черновик на прежнюю версию").toBe(v2.versionId);
    expect(now.answers.map((a) => a.text)).toEqual(["НОВЕ"]);
  }, 60_000);
});
