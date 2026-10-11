import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, inArray } from "drizzle-orm";
import postgres from "postgres";
import { noteCode, renderNote } from "@quizzy/shared";
import {
  adminA,
  and,
  appApi,
  batteries,
  batteryAssignments,
  batteryItems,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  isNull,
  makeUser,
  runDueSchedules,
  schedules,
  sr45,
  surveys,
  type Person,
} from "./fixtures";
import { batteryAssignmentItems, scaleBands, scales, surveyVersions } from "../src/db/schema";
import { AUDIT_CHAIN_LOCK } from "../src/lib/audit";
import { asAppRole } from "./appRole";
import { untilWaiting } from "./lockQueue";

/**
 * Пропуск, завершённый между чтением и записью (#151).
 *
 * Расписание и каскад читают открытые назначения набора, решают по
 * прочитанному «просрочено — пропуск» и закрывают его (closeMissed) уже под
 * замком набора, по одному id. Пациент, сдавший последний шаг между
 * чтением и записью, завершал назначение — а закрытие ставило поверх
 * cancelledAt с пометкой «пропущено»: у назначения разом «пройдено» и
 * «пропущено», в очереди работы — пропуск, которого не было.
 *
 * Оба порядка. «Чтение раньше сдачи»: строку набора держит отдельное
 * соединение, расписание (каскад) встаёт за ней в очередь уже с
 * прочитанным пропуском, пациент в это время сдаёт. «Сдача раньше
 * закрытия»: сдача, уже завершившая назначение, стоит за замком цепочки
 * журнала, а закрытие встаёт в очередь за строкой назначения. Пациент — под
 * ролью приложения, проход расписания — пулом той же роли.
 */

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const people: string[] = [];
const madeSchedules: string[] = [];
const DAY = 86_400_000;

afterAll(async () => {
  if (madeSchedules.length) await db.update(schedules).set({ active: false }).where(inArray(schedules.id, madeSchedules));
  // ничего живого в общей очереди назначений
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
}, 15_000);

async function publishSr45(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(sr45), adminA.id, "v1");
  return id;
}

/** Набор из одной методики */
async function battery(tag: string): Promise<{ batteryId: string; stepId: string }> {
  const stepId = await publishSr45(`Шаг пропуска ${tag}`);
  const batteryId = crypto.randomUUID();
  await db.insert(batteries).values({
    id: batteryId,
    title: `Набор пропуска ${tag}`,
    groupId: groupA,
    strictOrder: false,
    createdBy: adminA.id,
  });
  await db.insert(batteryItems).values([{ batteryId, surveyId: stepId, position: 0, required: true }]);
  return { batteryId, stepId };
}

async function person(unit: string): Promise<Person> {
  const p = await makeUser("user", `missed-race-${crypto.randomUUID()}@test`, {
    unit,
    sex: "male",
    birthDate: "1990-01-01",
  });
  people.push(p.id);
  return p;
}

/** Открытое назначение со сроком, вышедшим вчера, — со снимком состава, как у выданного */
async function overdueAssignment(batteryId: string, stepId: string, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(batteryAssignments).values({
    id,
    batteryId,
    userId,
    assignedBy: adminA.id,
    assignedAt: new Date(Date.now() - 3 * DAY).toISOString(),
    dueAt: new Date(Date.now() - DAY).toISOString(),
    note: noteCode("note.battery", { title: "Пропуск" }),
  });
  await db.insert(batteryAssignmentItems).values({ assignmentId: id, surveyId: stepId, position: 0, required: true });
  return id;
}

/** Сдача «безопасными» ответами — под ролью приложения */
async function submit(surveyId: string, token: string) {
  const survey = await appApi(`/api/surveys/${surveyId}`, token);
  if (survey.status !== 200) return survey;
  const answers = survey.body.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id],
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return appApi(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    }),
  });
}

const assignment = async (id: string) =>
  (await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, id)))[0]!;

/** Завершено, не пропущено, пометка прежняя */
async function expectCompletedOnly(id: string) {
  const row = await assignment(id);
  expect(row.completedAt, "сдача не завершила назначение").not.toBeNull();
  expect(row.cancelledAt, "завершённое назначение закрыто ещё и пропуском").toBeNull();
  expect(renderNote(row.note, "ru")).not.toContain("пропущено");
}

/* ═══════════ расписание ═══════════ */

describe("расписание: пропуск, завершённый между чтением и записью", () => {
  async function world(tag: string) {
    const unit = `Пропуск ${tag} ${crypto.randomUUID().slice(0, 8)}`;
    const { batteryId, stepId } = await battery(tag);
    const p = await person(unit);
    const missedId = await overdueAssignment(batteryId, stepId, p.id);
    const scheduleId = crypto.randomUUID();
    const planned = new Date(Date.now() - 1000).toISOString();
    await db.insert(schedules).values({
      id: scheduleId,
      title: `Расписание пропуска ${tag}`,
      batteryId,
      scope: "unit",
      unit,
      intervalDays: 30,
      dueDays: 7,
      startsAt: planned,
      nextRunAt: planned,
      active: true,
      createdBy: adminA.id,
    });
    madeSchedules.push(scheduleId);
    return { batteryId, stepId, p, missedId };
  }

  const run = () => asAppRole(() => runDueSchedules(new Date()));

  test("проход прочитал пропуск и ждёт набор, пациент сдаёт: у назначения только «пройдено»", async () => {
    const w = await world("чтение-раньше");

    let ran!: Promise<number>;
    await holder.begin(async (tx) => {
      await tx`select id from batteries where id = ${w.batteryId} for update`;
      ran = run();
      ran.catch(() => {});
      await untilWaiting(1, ["for share"]);
      // сдача набора не ждёт: строку назначения держит она сама, набор ей не нужен
      const done = await submit(w.stepId, w.p.token);
      expect(done.status, JSON.stringify(done.body)).toBe(201);
    });
    await ran;

    await expectCompletedOnly(w.missedId);
    // новое назначение выдано, как выдалось бы человеку без открытого
    const rows = await db.select().from(batteryAssignments).where(eq(batteryAssignments.batteryId, w.batteryId));
    expect(rows.length).toBe(2);
  }, 60_000);

  test("сдача завершила назначение и не зафиксирована, проход закрывает пропуск: у назначения только «пройдено»", async () => {
    const w = await world("сдача-раньше");

    let ran!: Promise<number>;
    let done!: Promise<Awaited<ReturnType<typeof submit>>>;
    await holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      done = submit(w.stepId, w.p.token);
      done.catch(() => {});
      // сдача уже отметила назначение завершённым и стоит за строкой журнала
      await untilWaiting(1, ["pg_advisory_xact_lock"]);
      ran = run();
      ran.catch(() => {});
      await untilWaiting(1, ['update "battery_assignments"']);
    });
    expect((await done).status).toBe(201);
    await ran;

    await expectCompletedOnly(w.missedId);
  }, 60_000);
});

/* ═══════════ каскад ═══════════ */

describe("каскад: пропуск, завершённый между чтением и записью", () => {
  let screenId: string;
  let deep: { batteryId: string; stepId: string };

  beforeAll(async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    screenId = await publishSr45(`Скрининг пропуска ${tag}`);
    deep = await battery(`каскад ${tag}`);
    // каскад — на всех полосах шкалы Sr: куда бы ни лёг балл, набор назначается
    const [version] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, screenId))
      .orderBy(desc(surveyVersions.version))
      .limit(1);
    const sr = await db.query.scales.findFirst({ where: and(eq(scales.versionId, version!.id), eq(scales.code, "Sr")) });
    await db
      .update(scaleBands)
      .set({ cascadeBatteryId: deep.batteryId, cascadeDueDays: 14 })
      .where(eq(scaleBands.scaleId, sr!.id));
  }, 30_000);

  test("каскад прочитал пропуск и ждёт набор, пациент сдаёт шаг набора: у назначения только «пройдено»", async () => {
    const p = await person(`Каскад ${crypto.randomUUID().slice(0, 8)}`);
    const missedId = await overdueAssignment(deep.batteryId, deep.stepId, p.id);

    let screened!: Promise<Awaited<ReturnType<typeof submit>>>;
    await holder.begin(async (tx) => {
      await tx`select id from batteries where id = ${deep.batteryId} for update`;
      screened = submit(screenId, p.token);
      screened.catch(() => {});
      await untilWaiting(1, ["for share"]);
      const done = await submit(deep.stepId, p.token);
      expect(done.status, JSON.stringify(done.body)).toBe(201);
    });
    const res = await screened;
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await expectCompletedOnly(missedId);
  }, 60_000);

  test("сдача шага завершила назначение и не зафиксирована, каскад закрывает пропуск: у назначения только «пройдено»", async () => {
    const p = await person(`Каскад ${crypto.randomUUID().slice(0, 8)}`);
    const missedId = await overdueAssignment(deep.batteryId, deep.stepId, p.id);

    let done!: Promise<Awaited<ReturnType<typeof submit>>>;
    let screened!: Promise<Awaited<ReturnType<typeof submit>>>;
    await holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      done = submit(deep.stepId, p.token);
      done.catch(() => {});
      await untilWaiting(1, ["pg_advisory_xact_lock"]);
      screened = submit(screenId, p.token);
      screened.catch(() => {});
      await untilWaiting(1, ['update "battery_assignments"']);
    });
    expect((await done).status).toBe(201);
    const res = await screened;
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    await expectCompletedOnly(missedId);
  }, 60_000);
});
