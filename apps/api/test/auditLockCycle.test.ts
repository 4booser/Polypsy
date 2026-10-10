import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
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

describe("замок журнала и замок строки (#145)", () => {
  test("сдача с каскадом и PATCH направления в цикле: строка журнала есть — или PATCH отказан и статус прежний", async () => {
    const { referralId, submit, patch } = await draftWithReferral();

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

    let submitted: Awaited<ReturnType<typeof submit>> | undefined;
    let patched: Awaited<ReturnType<typeof patch>> | undefined;
    try {
      // сдача доходит до каскада и встаёт за замком журнала первой
      const submitting = submit();
      expect(await until(async () => (await chainWaiters()) === 1), "сдача не дошла до замка журнала").toBe(true);
      // PATCH меняет строку направления и встаёт за журналом второй
      const patching = patch();
      expect(await until(async () => (await chainWaiters()) === 2), "PATCH не дошёл до замка журнала").toBe(true);
      /*
       * Снятым база делает того, чья проверка взаимоблокировки сработает
       * первой, а срабатывает она через deadlock_timeout (1 с) от начала
       * ожидания. Удержание ещё на 400 мс ставит ожидание сдачи на строке
       * заметно позже ожидания PATCH: первым проверяет PATCH, и снимается
       * его запись журнала — случай из задачи. Без запаса порядок решали бы
       * миллисекунды (на macOS таймеры процессов срабатывают пачкой).
       */
      await Bun.sleep(400);
      release();
      await holder;
      [submitted, patched] = await Promise.all([submitting, patching]);
    } finally {
      release();
      await holder.catch(() => {});
    }

    const [row] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (patched!.status === 200) {
      expect(await logged("referral.update", referralId), "PATCH закоммичен без строки журнала").toBe(1);
      expect(row!.status).toBe("accepted");
    } else {
      expect(row!.status, "PATCH отказан, а статус изменён").toBe("created");
      expect(await logged("referral.update", referralId)).toBe(0);
    }
    // цикл действительно был: база сняла одного из двух, и снятый не закоммитил ничего
    const refused = [submitted!.status, patched!.status].filter((s) => s >= 400);
    expect(refused.length, `сдача ${submitted!.status}, PATCH ${patched!.status}`).toBe(1);
    if (submitted!.status === 201) {
      expect(await logged("response.submit", submitted!.body.id)).toBe(1);
    }
    // цепочка после конкурирующих записей цела
    const chain = await verifyChain();
    expect(chain.ok, `цепочка порвана на ${chain.brokenAtSeq}`).toBe(true);
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
