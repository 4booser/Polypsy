import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import postgres from "postgres";
import type { BatteryAssignment } from "@quizzy/shared";
import {
  adminA,
  and,
  appApi,
  batteryAssignments,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  isNull,
  makeUser,
  sql,
  sr45,
  surveys,
  type Person,
} from "./fixtures";

/**
 * Жизнь назначения набора (волна 16, участок batteries; внешний разбор
 * 2026-09-28, пп. 2–4).
 *
 * Три находки об одном: назначение набора жило отдельно от того, что оно
 * выдаёт и чем кончается. Завершение считалось в транзакции сдачи, которая
 * не видит соседнюю, — две последние методики, сданные одновременно,
 * оставляли назначение открытым навсегда. Состав назначения читался из
 * изменяемого набора — правка набора молча меняла выданные назначения, а
 * доступ к добавленной методике не выдавался. Отмена меняла только отметку —
 * доступ, выданный назначением, оставался.
 *
 * Всё — под ролью приложения (appApi): так эти пути видит бой, с политиками
 * строк. Гонка воспроизводится приёмом ревьюера (test/transitionRaces.test.ts):
 * отдельное соединение держит замок, запросы встают за ним в очередь, и
 * только когда стоят все — замок отпускается.
 *
 * Свои методики, свой набор и свои люди на каждый тест; открытые назначения
 * закрываются в afterAll — очередь назначений общая на процесс.
 */

/** Отдельное соединение — им «держат» замок, как служебной транзакцией у ревьюера */
const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const people: string[] = [];

afterAll(async () => {
  if (people.length) {
    await db
      .update(batteryAssignments)
      .set({ cancelledAt: new Date().toISOString() })
      .where(
        and(
          inArray(batteryAssignments.userId, people),
          isNull(batteryAssignments.completedAt),
          isNull(batteryAssignments.cancelledAt),
        ),
      );
  }
  await holder.end();
});

async function person(tag: string): Promise<Person> {
  const p = await makeUser("user", `bl-${tag}-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(p.id);
  return p;
}

/** Закрытая методика группы А: открывается пациенту только по назначению */
async function restrictedSurvey(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title, en: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

/** Набор штатным путём (POST /batteries) — так же, как собирает его сотрудник */
async function makeBattery(title: string, surveyIds: string[], strictOrder = false): Promise<string> {
  const res = await appApi("/api/batteries", adminA.token, {
    method: "POST",
    body: JSON.stringify({ title, groupId: groupA, strictOrder, items: surveyIds.map((surveyId) => ({ surveyId })) }),
  });
  expect(res.status, `набор: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as string;
}

async function assign(batteryId: string, who: Person): Promise<string> {
  const res = await appApi(`/api/batteries/${batteryId}/assign`, adminA.token, {
    method: "POST",
    body: JSON.stringify({ userId: who.id }),
  });
  expect(res.status, `назначение: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as string;
}

async function mine(who: Person, assignmentId: string): Promise<BatteryAssignment | undefined> {
  const res = await appApi<{ items: BatteryAssignment[] }>("/api/batteries/mine", who.token);
  expect(res.status).toBe(200);
  return res.body.items.find((a) => a.id === assignmentId);
}

/** Тело сдачи «безопасными» ответами — собирается заранее, до удержания замка */
async function answersFor(surveyId: string, who: Person): Promise<string> {
  const res = await appApi(`/api/surveys/${surveyId}`, who.token);
  expect(res.status, `методика открывается: ${JSON.stringify(res.body)}`).toBe(200);
  const answers = (res.body.questions as { id: string; type: string; options: { id: string }[] }[])
    .filter((q) => q.type !== "info" && q.options.length)
    .map((q) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id],
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return JSON.stringify({
    versionId: res.body.versionId,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    durationMs: 60_000,
    events: [],
    answers,
  });
}

function submit(surveyId: string, who: Person, body: string) {
  return appApi(`/api/surveys/${surveyId}/responses`, who.token, { method: "POST", body });
}

/**
 * Сколько запросов к этой базе стоят в очереди за замком — из тех, чей
 * текст касается проверяемого (см. transitionRaces.test.ts: до правки и
 * после неё запрос встаёт в очередь разными операторами).
 */
async function lockWaiters(fragments: string[]): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      and query ilike any (array[${sql.join(
        fragments.map((f) => sql`${`%${f}%`}`),
        sql`, `,
      )}]::text[])
  `);
  return Number(row?.n ?? 0);
}

async function untilWaiting(n: number, fragments: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

/** Держать замок, пока все действия не встанут за ним в очередь, и отпустить */
async function whileHeld<T>(
  hold: (tx: postgres.TransactionSql) => Promise<unknown>,
  actions: (() => Promise<T>)[],
  waitsOn: string[],
): Promise<T[]> {
  const pending: Promise<T>[] = [];
  await holder.begin(async (tx) => {
    await hold(tx);
    for (const [i, start] of actions.entries()) {
      const p = start();
      p.catch(() => {});
      pending.push(p);
      await untilWaiting(i + 1, waitsOn);
    }
  });
  return Promise.all(pending);
}

/** Замок цепочки журнала (lib/audit.ts): сдача берёт его последним, перед коммитом */
const AUDIT_CHAIN_LOCK = 7_154_301;

/* ═══════════ п. 1: завершение при параллельной сдаче ═══════════ */

describe("назначение набора: последние методики, сданные одновременно, завершают его", () => {
  test("обе сдачи 201, «2 из 2» — и назначение завершено, а не висит открытым", async () => {
    /*
     * Воспроизведение из разбора (п. 2): набор из двух методик без строгого
     * порядка, обе сдаются одновременно. Каждая транзакция сдачи видит своё
     * прохождение и не видит соседнее (оно ещё не зафиксировано), обе
     * решают «не всё пройдено» — и после обоих коммитов никто назначение
     * не пересчитывает: «2 из 2», а completedAt пуст, после срока —
     * «просрочено». Замок журнала держит обе сдачи после проверки
     * завершения и до коммита — ровно тот интерливинг, что у ревьюера.
     */
    const p = await person("race");
    const tag = crypto.randomUUID().slice(0, 8);
    const s1 = await restrictedSurvey(`Паралельна 1 ${tag}`);
    const s2 = await restrictedSurvey(`Паралельна 2 ${tag}`);
    const batteryId = await makeBattery(`Паралельний ${tag}`, [s1, s2]);
    const assignmentId = await assign(batteryId, p);

    const body1 = await answersFor(s1, p);
    const body2 = await answersFor(s2, p);
    const replies = await whileHeld(
      (tx) => tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`,
      [() => submit(s1, p, body1), () => submit(s2, p, body2)],
      // до правки обе встают за замком журнала, после — вторая ждёт строку назначения
      ["pg_advisory_xact_lock", "battery_assignments"],
    );
    for (const r of replies) expect(r.status, JSON.stringify(r.body)).toBe(201);

    const [row] = await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, assignmentId));
    expect(row!.completedAt, "пройдены оба обязательных шага, а назначение открыто").not.toBeNull();

    const seen = await mine(p, assignmentId);
    expect([seen!.doneRequired, seen!.totalRequired]).toEqual([2, 2]);
    expect(seen!.completedAt).not.toBeNull();
  }, 60_000);
});

/* ═══════════ п. 2: правка набора и выданные назначения ═══════════ */

async function editBattery(batteryId: string, title: string, surveyIds: string[]) {
  return appApi(`/api/batteries/${batteryId}`, adminA.token, {
    method: "PUT",
    body: JSON.stringify({ title, groupId: groupA, strictOrder: false, items: surveyIds.map((surveyId) => ({ surveyId })) }),
  });
}

describe("правка набора не меняет выданных назначений", () => {
  test("добавленный шаг: у выданного назначения не появляется, у нового — есть вместе с доступом", async () => {
    /*
     * Воспроизведение из разбора (п. 3): назначен набор из одной методики;
     * в набор добавили вторую, закрытую. У пациента в /mine стало два
     * обязательных шага, новый — «доступна», а открыть её — 404: доступа
     * назначение не выдавало, и завершить его стало нельзя.
     */
    const p = await person("edit-add");
    const other = await person("edit-add-other");
    const tag = crypto.randomUUID().slice(0, 8);
    const s1 = await restrictedSurvey(`Правка A1 ${tag}`);
    const s2 = await restrictedSurvey(`Правка A2 ${tag}`);
    const batteryId = await makeBattery(`Правка A ${tag}`, [s1]);
    const assignmentId = await assign(batteryId, p);

    const edited = await editBattery(batteryId, `Правка A ${tag}`, [s1, s2]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const seen = await mine(p, assignmentId);
    expect(seen!.steps.map((s) => s.surveyId), "выданное назначение получило шаг, которого не выдавали").toEqual([s1]);
    expect([seen!.doneRequired, seen!.totalRequired]).toEqual([0, 1]);
    // доступа на новую методику у него нет — и шага тоже; закрытая методика не открывается
    expect((await appApi(`/api/surveys/${s2}`, p.token)).status).toBe(404);

    // новое назначение — по новому составу, с доступом на оба шага
    const fresh = await assign(batteryId, other);
    const freshSeen = await mine(other, fresh);
    expect(freshSeen!.steps.map((s) => s.surveyId)).toEqual([s1, s2]);
    expect((await appApi(`/api/surveys/${s2}`, other.token)).status).toBe(200);

    // выданное завершается своим составом
    expect((await submit(s1, p, await answersFor(s1, p))).status).toBe(201);
    const [row] = await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, assignmentId));
    expect(row!.completedAt, "назначение из одного шага не завершилось после его сдачи").not.toBeNull();
  }, 60_000);

  test("убранный шаг: у выданного назначения остаётся, открывается и завершает его", async () => {
    /*
     * Обратное направление: шаг убрали из набора после выдачи. Выданное
     * назначение — протокол, по которому человека уже обследуют: шаг
     * остаётся в нём, методика открывается, и назначение завершается по
     * своему составу, а не по новому шаблону.
     */
    const p = await person("edit-remove");
    const tag = crypto.randomUUID().slice(0, 8);
    const s1 = await restrictedSurvey(`Правка B1 ${tag}`);
    const s2 = await restrictedSurvey(`Правка B2 ${tag}`);
    const batteryId = await makeBattery(`Правка B ${tag}`, [s1, s2]);
    const assignmentId = await assign(batteryId, p);
    expect((await submit(s1, p, await answersFor(s1, p))).status).toBe(201);

    const edited = await editBattery(batteryId, `Правка B ${tag}`, [s1]);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);

    const seen = await mine(p, assignmentId);
    expect(seen!.steps.map((s) => s.surveyId), "выданное назначение потеряло шаг").toEqual([s1, s2]);
    expect([seen!.doneRequired, seen!.totalRequired]).toEqual([1, 2]);
    expect(seen!.completedAt, "назначение завершилось по новому шаблону, а не по своему составу").toBeNull();

    expect((await appApi(`/api/surveys/${s2}`, p.token)).status).toBe(200);
    expect((await submit(s2, p, await answersFor(s2, p))).status).toBe(201);
    const [row] = await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, assignmentId));
    expect(row!.completedAt).not.toBeNull();
    expect((await mine(p, assignmentId))!.steps.map((s) => s.state)).toEqual(["done", "done"]);
  }, 60_000);
});
