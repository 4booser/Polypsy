import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { renderError } from "@quizzy/shared";
import { and, appApi, client, createSurveySchema, createVersion, db, eq, groupA, makeUser, root, surveys } from "./fixtures";
import { auditLog, referrals, surveyFollowups } from "../src/db/schema";
import { AUDIT_CHAIN_LOCK } from "../src/lib/audit";
import { verifyChain } from "../src/lib/auditVerify";

/**
 * Замок журнала против замка строки (#145).
 *
 * Голову хэш-цепочки журнал берёт под advisory-замком транзакции, и замок
 * держится до коммита всего запроса. Сдача с каскадом берёт его рано
 * (строка cascade.followup), а строку направления, выписанного по черновику,
 * трогает позже (adoptDraftAlerts). PATCH /api/referrals/:id — наоборот:
 * сначала строка, потом журнал. Встретившись, они образуют цикл, и база
 * снимает одного. Если снимала запись журнала PATCH, audit() гасил
 * «deadlock detected», статус направления фиксировался, а строки
 * referral.update в журнале не было.
 *
 * Чередование задаётся удержанием замка журнала посторонней транзакцией:
 * сдача встаёт в очередь первой, PATCH — второй, удержание снимается, и
 * сдача, получив замок, идёт к строке, которую держит PATCH. Оба маршрута
 * настоящие, ролью приложения (appApi), как в бою.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const mySurveys: string[] = [];
const myReferrals: string[] = [];

/** Один пункт «Так/Ні», шкала-сумма, полоса 0–1 с повтором через 7 дней — каскад на каждой сдаче */
async function makeSurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Каскад ${tag()}`, ru: "Каскад" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: root.id,
  } as never);
  const l = (uk: string) => ({ uk, ru: uk });
  await createVersion(
    id,
    createSurveySchema.parse({
      title: l("Каскад"),
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "single",
          title: l("Пункт"),
          required: true,
          scaleCode: "S",
          options: [
            { text: l("Так"), score: 1 },
            { text: l("Ні"), score: 0 },
          ],
        },
      ],
      scales: [
        {
          code: "S",
          title: l("Сума"),
          kind: "clinical",
          normalization: "raw",
          bands: [{ minScore: 0, maxScore: 1, label: l("Будь-який"), followUpDays: "7" }],
        },
      ],
    }),
    root.id,
    "v1",
  );
  mySurveys.push(id);
  return id;
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Пациент с черновиком и направление, выписанное по этому черновику */
async function draftWithReferral() {
  const surveyId = await makeSurvey();
  const person = await makeUser("user", `lock-cycle-${tag()}@test.dev`, { sex: "male", birthDate: "1991-05-05" });
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
  const answers = [
    { questionId: shown.questions[0]!.id, optionIds: [shown.questions[0]!.options[0]!.id], durationMs: 1000, changeCount: 0, visitCount: 1 },
  ];
  const draft = await appApi(`/api/surveys/${surveyId}/draft`, person.token, {
    method: "PUT",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 20_000, versionId: shown.versionId, answers }),
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const referralId = crypto.randomUUID();
  await db.insert(referrals).values({
    id: referralId,
    userId: person.id,
    responseId: draft.body.id,
    destination: "psychiatrist",
    urgency: "routine",
    createdBy: root.id,
  } as never);
  myReferrals.push(referralId);

  return {
    referralId,
    draftId: draft.body.id as string,
    submit: () =>
      appApi(`/api/surveys/${surveyId}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          versionId: shown.versionId,
          answers,
        }),
      }),
    patch: () =>
      appApi(`/api/referrals/${referralId}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({ status: "accepted" }),
      }),
  };
}

/** Строки журнала о действии над записью */
async function logged(action: string, resourceId: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));
  return rows.length;
}

/** Сколько транзакций этой базы ждут замка журнала */
async function chainWaiters(): Promise<number> {
  const [row] = await client`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory'
       and database = (select oid from pg_database where datname = current_database())
       and classid::bigint = 0 and objid::bigint = ${AUDIT_CHAIN_LOCK} and objsubid = 1
       and not granted`;
  return Number(row!.n);
}

async function until(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

afterAll(async () => {
  // направления — в конечное состояние, окна повторов своих методик — прочь: очереди общие
  if (myReferrals.length) {
    await db.update(referrals).set({ status: "declined" }).where(inArray(referrals.id, myReferrals));
  }
  if (mySurveys.length) await db.delete(surveyFollowups).where(inArray(surveyFollowups.surveyId, mySurveys));
});

type Case = Awaited<ReturnType<typeof draftWithReferral>>;

/**
 * Чередование из задачи: посторонняя транзакция держит замок журнала, сдача
 * встаёт за ним первой, PATCH — уже взяв строку направления — второй; через
 * holdMs удержание снимается, сдача получает журнал и идёт к строке PATCH.
 *
 * Кого снимет база, решает holdMs. Проверка взаимоблокировки срабатывает
 * один раз, через deadlock_timeout (1 с) от начала ожидания.
 *   400 мс — цикл замыкается до проверки PATCH, первым проверяет он, и
 *     снимается его запись журнала (случай из задачи). Запас нужен: без
 *     него порядок решали бы миллисекунды (на macOS таймеры процессов
 *     срабатывают пачкой).
 *   1500 мс — PATCH проверяет ещё при удержании, цикла нет, и больше он не
 *     проверяет; цикл видит только сдача — снимается она.
 */
async function interleave(c: Case, holdMs: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding!: () => void;
  const held = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const holder = client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
    holding();
    await gate;
  });
  await held;
  try {
    // сдача доходит до каскада и встаёт за замком журнала первой
    const submitting = c.submit();
    expect(await until(async () => (await chainWaiters()) === 1), "сдача не дошла до замка журнала").toBe(true);
    // PATCH меняет строку направления и встаёт за журналом второй
    const patching = c.patch();
    expect(await until(async () => (await chainWaiters()) === 2), "PATCH не дошёл до замка журнала").toBe(true);
    await Bun.sleep(holdMs);
    release();
    await holder;
    const [submitted, patched] = await Promise.all([submitting, patching]);
    return { submitted, patched };
  } finally {
    release();
    await holder.catch(() => {});
  }
}

const RETRY_TEXTS = (["uk", "ru", "en"] as const).map((lang) => renderError("err.retryRequest", lang));

/** Снятый базой — 503 «повторите» с Retry-After, а не общий 500 */
function expectRetry(res: { status: number; headers: Headers; body: { error?: string } }) {
  expect(res.status, JSON.stringify(res.body)).toBe(503);
  expect(RETRY_TEXTS).toContain(res.body.error!);
  expect(res.headers.get("Retry-After")).toBe("1");
}

describe("замок журнала и замок строки (#145)", () => {
  test("сдача с каскадом и PATCH направления в цикле: строка журнала есть — или PATCH отказан и статус прежний", async () => {
    const c = await draftWithReferral();
    const { submitted, patched } = await interleave(c, 400);

    const [row] = await db.select().from(referrals).where(eq(referrals.id, c.referralId));
    if (patched.status === 200) {
      expect(await logged("referral.update", c.referralId), "PATCH закоммичен без строки журнала").toBe(1);
      expect(row!.status).toBe("accepted");
    } else {
      expect(row!.status, "PATCH отказан, а статус изменён").toBe("created");
      expect(await logged("referral.update", c.referralId)).toBe(0);
      expectRetry(patched);
    }
    // цикл действительно был: база сняла одного из двух, и снятый не закоммитил ничего
    const refused = [submitted.status, patched.status].filter((s) => s >= 400);
    expect(refused.length, `сдача ${submitted.status}, PATCH ${patched.status}`).toBe(1);
    if (submitted.status === 201) {
      expect(await logged("response.submit", submitted.body.id)).toBe(1);
    }
    // цепочка после конкурирующих записей цела
    const chain = await verifyChain();
    expect(chain.ok, `цепочка порвана на ${chain.brokenAtSeq}`).toBe(true);
  }, 30_000);

  test("снята сдача: 503 «повторите», ничего не сохранено, повтор проходит; PATCH — со строкой журнала", async () => {
    const c = await draftWithReferral();
    const { submitted, patched } = await interleave(c, 1500);

    expectRetry(submitted);
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await logged("referral.update", c.referralId)).toBe(1);
    // сдача откатилась целиком: прохождения нет, черновик и направление на нём — как были
    const [before] = await db.select().from(referrals).where(eq(referrals.id, c.referralId));
    expect(before!.responseId).toBe(c.draftId);

    const again = await c.submit();
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(await logged("response.submit", again.body.id)).toBe(1);
    const [after] = await db.select().from(referrals).where(eq(referrals.id, c.referralId));
    expect(after!.responseId).toBe(again.body.id);
    expect((await verifyChain()).ok).toBe(true);
  }, 30_000);

  test("контроль: без удержания обе строки журнала на месте", async () => {
    const { referralId, submit, patch } = await draftWithReferral();
    const patched = await patch();
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const submitted = await submit();
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    expect(await logged("referral.update", referralId)).toBe(1);
    expect(await logged("response.submit", submitted.body.id)).toBe(1);
    const [row] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(row!.status).toBe("accepted");
    // направление черновика переехало на сдачу
    expect(row!.responseId).toBe(submitted.body.id);
  }, 30_000);

  test("цепочка после одновременных записей: номера подряд, хэши сходятся", async () => {
    /*
     * Шесть настоящих запросов разом, каждый пишет журнал: три PATCH одних
     * направлений и три сдачи с каскадом по другим. Строк друг друга они не
     * трогают, так что цикла нет — только очередь за замком журнала.
     */
    const cases = await Promise.all(Array.from({ length: 6 }, () => draftWithReferral()));
    const patched = cases.slice(0, 3);
    const submitted = cases.slice(3);
    const results = await Promise.all([...patched.map((c) => c.patch()), ...submitted.map((c) => c.submit())]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);

    for (const c of patched) expect(await logged("referral.update", c.referralId)).toBe(1);
    for (const r of results.slice(3)) expect(await logged("response.submit", r.body.id)).toBe(1);
    const chain = await verifyChain();
    expect(chain.ok, `цепочка порвана на ${chain.brokenAtSeq}`).toBe(true);
  }, 60_000);
});
