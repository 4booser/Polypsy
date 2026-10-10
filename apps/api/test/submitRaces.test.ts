import { afterAll, describe, expect, test } from "bun:test";
import { inArray, isNull } from "drizzle-orm";
import type { TransactionSql } from "postgres";
import {
  adminA,
  and,
  appApi,
  client,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  responsesTable,
  surveys,
  type Person,
} from "./fixtures";
import { alertCases, referrals, riskAlerts } from "../src/db/schema";

/**
 * Гонки вокруг сдачи (волна 21, участок submit; #146, #147, #148).
 *
 * Сдача, автосохранение черновика и повтор той же сдачи из очереди
 * встречаются на одной паре «человек × методика»: сдача читает черновик,
 * переносит его тревоги на итоговое прохождение и удаляет его, а
 * автосохранение в это время пишет в тот же черновик. Каждое чередование
 * задаётся удержанием замка посторонней транзакцией владельца: запрос
 * встаёт за ним, второй запрос — за первым, удержание снимается. Запросы —
 * ролью приложения (appApi), как в бою; проверки читают базу владельцем.
 */

const tag = () => crypto.randomUUID().slice(0, 8);
const people: string[] = [];
const myReferrals: string[] = [];

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };
type Reply = { status: number; body: any };

const NO = 0;
const YES = 1;

/** Один пункт со шкалой: «Ні» — без тревоги, «Так» — тяжёлая тревога */
async function makeSurvey(allowRetake: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Гонка здачі ${tag()}`, ru: "Гонка сдачи" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake,
    createdBy: adminA.id,
  } as never);
  const l = (uk: string) => ({ uk, ru: uk });
  await createVersion(
    id,
    createSurveySchema.parse({
      title: l("Гонка здачі"),
      administration: "self",
      scoringEnabled: true,
      questions: [
        {
          type: "single",
          title: l("Чи бувають думки про небажання жити?"),
          required: true,
          scaleCode: "S",
          options: [
            { text: l("Ні"), score: 0 },
            { text: l("Так"), score: 1, riskFlag: true, riskLabel: l("Так"), riskSeverity: "severe" },
          ],
        },
      ],
      scales: [
        {
          code: "S",
          title: l("Сума"),
          kind: "clinical",
          normalization: "raw",
          bands: [{ minScore: 0, maxScore: 1, label: l("Будь-який") }],
        },
      ],
    }),
    adminA.id,
    "v1",
  );
  return id;
}

async function makePatient(): Promise<Person> {
  const person = await makeUser("user", `w21-submit-${tag()}@test.dev`, { sex: "female", birthDate: "1990-03-03" });
  people.push(person.id);
  return person;
}

/**
 * Одна попытка человека: автосохранения и сдача с одним startedAt — так их
 * шлёт мобилка (app/survey/[id].tsx: startedAt экрана едет и в черновик, и в
 * сдачу).
 */
async function attempt(surveyId: string, person: Person) {
  const shown = (await appApi<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
  const startedAt = new Date(Date.now() - 120_000 - Math.floor(Math.random() * 1000)).toISOString();
  const answers = (option: number) => [
    {
      questionId: shown.questions[0]!.id,
      optionIds: [shown.questions[0]!.options[option]!.id],
      durationMs: 1500,
      changeCount: 0,
      visitCount: 1,
    },
  ];
  return {
    startedAt,
    draft: (option: number): Promise<Reply> =>
      appApi(`/api/surveys/${surveyId}/draft`, person.token, {
        method: "PUT",
        body: JSON.stringify({ startedAt, durationMs: 30_000, versionId: shown.versionId, answers: answers(option) }),
      }),
    submit: (option: number, extra: Record<string, unknown> = {}): Promise<Reply> =>
      appApi(`/api/surveys/${surveyId}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt,
          // конец попытки — недавно, но после выпуска версии: иначе сервер датирует сдачу приёмом
          durationMs: 100_000,
          events: [],
          versionId: shown.versionId,
          answers: answers(option),
          ...extra,
        }),
      }),
  };
}

/** Прохождения человека по методике — по статусам */
async function rowsOf(surveyId: string, userId: string) {
  const rows = await db
    .select({ id: responsesTable.id, status: responsesTable.status })
    .from(responsesTable)
    .where(and(eq(responsesTable.surveyId, surveyId), eq(responsesTable.userId, userId)));
  return {
    completed: rows.filter((r) => r.status === "completed").map((r) => r.id),
    drafts: rows.filter((r) => r.status === "in_progress").map((r) => r.id),
  };
}

const alertsOf = (userId: string) => db.select().from(riskAlerts).where(eq(riskAlerts.userId, userId));

/**
 * Посторонняя транзакция владельца берёт замок и держит его до release().
 * Ждём, пока замок взят, — иначе запрос, ради которого держим, проскочит.
 */
async function hold(take: (tx: TransactionSql) => Promise<unknown>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let taken!: () => void;
  const held = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const done = client.begin(async (tx) => {
    await take(tx);
    taken();
    await gate;
  });
  await held;
  return {
    release: async () => {
      open();
      await done;
    },
  };
}

/** Сколько запросов этой базы стоят в очереди за замком (любым: строки, советующим) */
async function lockWaiters(): Promise<number> {
  const [row] = await client`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
  return Number(row!.n);
}

/** Дождаться условия — по факту, а не по таймеру */
async function until(check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(what);
}

/** Запрос и признак «уже ответил»: на прежнем коде второй запрос замка не ждёт, а проходит сразу */
function track(run: Promise<Reply>) {
  const t = { done: false, run };
  run.finally(() => {
    t.done = true;
  }).catch(() => {});
  return t;
}

afterAll(async () => {
  // строки общих очередей — в конечное состояние: тревоги и случаи разобраны, направления закрыты
  if (people.length) {
    const now = new Date().toISOString();
    await db
      .update(riskAlerts)
      .set({ acknowledgedAt: now, acknowledgedBy: adminA.id })
      .where(and(inArray(riskAlerts.userId, people), isNull(riskAlerts.acknowledgedAt)));
    await db
      .update(alertCases)
      .set({ acknowledgedAt: now, acknowledgedBy: adminA.id, outcome: "not_confirmed" })
      .where(and(inArray(alertCases.userId, people), isNull(alertCases.acknowledgedAt)));
  }
  if (myReferrals.length) {
    await db.update(referrals).set({ status: "declined" }).where(inArray(referrals.id, myReferrals));
  }
});

/* ─────────── #146: автосохранение посреди сдачи ─────────── */

describe("автосохранение посреди сдачи (#146)", () => {
  /*
   * Сдача читала черновик и его тревоги без замка, а удаляла черновик в
   * конце. Автосохранение, державшее строку черновика, дописывало тревогу
   * между этими шагами; внешний ключ risk_alerts → responses не каскадный
   * (0106), и удаление черновика падало: сдача 500, прохождения нет.
   *
   * Чередование: посторонняя транзакция держит замок случая этого человека
   * (lib/alertCases.ts) — автосохранение с риском встаёт за ним, уже взяв
   * черновик; сдача без риска приходит следом и встаёт за автосохранением.
   */
  test("автосохранение с риском раньше сдачи без риска: 201, тревога на итоговом, прохождение одно", async () => {
    const surveyId = await makeSurvey(true);
    const person = await makePatient();
    const a = await attempt(surveyId, person);
    const start = await a.draft(NO);
    expect(start.status, JSON.stringify(start.body)).toBe(200);

    const caseLock = await hold(
      (tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`alert_case|${person.id}|${groupA}`}, 0))`,
    );
    let saving: ReturnType<typeof track> | undefined;
    let submitting: ReturnType<typeof track> | undefined;
    try {
      saving = track(a.draft(YES));
      await until(async () => (await lockWaiters()) >= 1, "автосохранение не встало за замком случая");
      submitting = track(a.submit(NO));
      await until(
        async () => submitting!.done || (await lockWaiters()) >= 2,
        "сдача не встала в очередь за автосохранением",
      );
    } finally {
      await caseLock.release();
    }
    const [saved, submitted] = await Promise.all([saving!.run, submitting!.run]);

    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const alerts = await alertsOf(person.id);
    expect(alerts, "тревога автосохранения потерялась или задвоилась").toHaveLength(1);
    expect(alerts[0]!.responseId, "тревога автосохранения не переехала на итоговое прохождение").toBe(
      submitted.body.id,
    );
    expect(alerts[0]!.severity).toBe("severe");
    const rows = await rowsOf(surveyId, person.id);
    expect(rows.completed).toEqual([submitted.body.id]);
    expect(rows.drafts, "черновик пережил сдачу").toEqual([]);
  }, 30_000);

  test("замок — на пару «человек × методика»: пока сдача идёт, чужое и своё по другой методике сохраняются", async () => {
    // страховка от «починки» замком пошире: соседние автосохранения сдачу не ждут
    const surveyId = await makeSurvey(true);
    const otherSurveyId = await makeSurvey(true);
    const person = await makePatient();
    const neighbour = await makePatient();
    const mine = await attempt(surveyId, person);
    const theirs = await attempt(surveyId, neighbour);
    const elsewhere = await attempt(otherSurveyId, person);
    expect((await mine.draft(NO)).status).toBe(200);

    // сдача доходит до своей строки журнала и стоит, держа всё, что взяла до неё
    const { AUDIT_CHAIN_LOCK } = await import("../src/lib/audit");
    const chain = await hold((tx) => tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    let submitting: ReturnType<typeof track> | undefined;
    try {
      submitting = track(mine.submit(NO));
      await until(async () => (await lockWaiters()) >= 1, "сдача не дошла до журнала");
      const [their, other] = await Promise.all([theirs.draft(YES), elsewhere.draft(NO)]);
      expect(their.status, JSON.stringify(their.body)).toBe(200);
      expect(other.status, JSON.stringify(other.body)).toBe(200);
    } finally {
      await chain.release();
    }
    const submitted = await submitting!.run;
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  }, 30_000);
});

/* ─────────── #147: запоздалое автосохранение после сдачи ─────────── */

describe("запоздалое автосохранение после сдачи (#147)", () => {
  /*
   * Автосохранение не спрашивало, сдана ли уже попытка, которую оно
   * сохраняет: мобильная дорожка черновика досылает последнюю правку и
   * после сдачи. Черновик рождался заново — с тревогой и, если случай уже
   * разобран, с новым случаем. Невозвратную методику сдать с него нельзя
   * никогда (409), а у возвратной его тревогу присваивала следующая сдача.
   */

  /** Случай, открытый тревогой, разобран дежурным — ролью приложения */
  async function resolveCase(personId: string) {
    const [alert] = await alertsOf(personId);
    expect(alert?.caseId, "сдача с риском не открыла случай").toBeTruthy();
    const decided = await appApi(`/api/alert-cases/${alert!.caseId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ outcome: "not_confirmed" }),
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  }

  const openCases = (userId: string) =>
    db
      .select({ id: alertCases.id })
      .from(alertCases)
      .where(and(eq(alertCases.userId, userId), isNull(alertCases.acknowledgedAt)));

  test("невозвратная: автосохранение после сдачи — 409, ни черновика, ни тревоги, ни случая", async () => {
    const surveyId = await makeSurvey(false);
    const person = await makePatient();
    const a = await attempt(surveyId, person);
    expect((await a.draft(YES)).status).toBe(200);
    const done = await a.submit(YES);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    await resolveCase(person.id);

    const late = await a.draft(YES);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(late.body.error).toBe("Ви вже проходили цю методику");
    expect((await rowsOf(surveyId, person.id)).drafts, "черновик сданной попытки возродился").toEqual([]);
    const alerts = await alertsOf(person.id);
    expect(alerts.map((x) => x.responseId), "автосохранение подняло тревогу после сдачи").toEqual([done.body.id]);
    expect(await openCases(person.id), "автосохранение открыло случай после разбора").toEqual([]);
  }, 30_000);

  test("возвратная: черновик сданной попытки не возрождается, следующая сдача без риска чужой тревоги не получает", async () => {
    const surveyId = await makeSurvey(true);
    const person = await makePatient();
    const a = await attempt(surveyId, person);
    const done = await a.submit(YES);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    await resolveCase(person.id);

    const late = await a.draft(YES);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect((await rowsOf(surveyId, person.id)).drafts, "черновик сданной попытки возродился").toEqual([]);
    expect(await openCases(person.id)).toEqual([]);

    const next = await attempt(surveyId, person);
    const clean = await next.submit(NO);
    expect(clean.status, JSON.stringify(clean.body)).toBe(201);
    const alerts = await alertsOf(person.id);
    expect(alerts.map((x) => x.responseId), "сдача без риска получила тревогу прошлой попытки").toEqual([
      done.body.id,
    ]);
  }, 30_000);

  test("контроль: новая попытка возвратной методики после сдачи сохраняется как обычно", async () => {
    const surveyId = await makeSurvey(true);
    const person = await makePatient();
    const a = await attempt(surveyId, person);
    expect((await a.submit(NO)).status).toBe(201);
    const next = await attempt(surveyId, person);
    const saved = await next.draft(NO);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await rowsOf(surveyId, person.id)).drafts).toEqual([saved.body.id]);
  }, 30_000);

  /*
   * То же в гонке: сдача уже идёт (стоит на переносе направления черновика —
   * строку держит посторонняя транзакция), автосохранение той же попытки
   * приходит следом. Прежде оно проходило мимо сдачи, писало тревогу в
   * черновик, и сдача падала на его удалении (#146); теперь оно ждёт конца
   * сдачи и получает отказ, как и пришедшее позже.
   */
  for (const allowRetake of [true, false]) {
    test(`сдача раньше автосохранения той же попытки (allowRetake=${allowRetake}): 201 и 409, черновик не возрождается`, async () => {
      const surveyId = await makeSurvey(allowRetake);
      const person = await makePatient();
      const a = await attempt(surveyId, person);
      const start = await a.draft(NO);
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      const referralId = crypto.randomUUID();
      await db.insert(referrals).values({
        id: referralId,
        userId: person.id,
        responseId: start.body.id,
        destination: "psychiatrist",
        urgency: "routine",
        createdBy: adminA.id,
      } as never);
      myReferrals.push(referralId);

      const row = await hold((tx) => tx`select id from referrals where id = ${referralId} for update`);
      let submitting: ReturnType<typeof track> | undefined;
      let saving: ReturnType<typeof track> | undefined;
      try {
        submitting = track(a.submit(NO));
        await until(async () => (await lockWaiters()) >= 1, "сдача не дошла до направления черновика");
        saving = track(a.draft(YES));
        await until(
          async () => saving!.done || (await lockWaiters()) >= 2,
          "автосохранение не встало в очередь за сдачей",
        );
      } finally {
        await row.release();
      }
      const [submitted, saved] = await Promise.all([submitting!.run, saving!.run]);

      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      expect(saved.status, JSON.stringify(saved.body)).toBe(409);
      const rows = await rowsOf(surveyId, person.id);
      expect(rows.completed).toEqual([submitted.body.id]);
      expect(rows.drafts, "черновик сданной попытки возродился").toEqual([]);
      expect(await alertsOf(person.id), "запоздалое автосохранение подняло тревогу").toEqual([]);
      const [moved] = await db.select().from(referrals).where(eq(referrals.id, referralId));
      expect(moved!.responseId).toBe(submitted.body.id);
    }, 30_000);
  }
});
