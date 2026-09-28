import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { BatteryAssignment } from "@quizzy/shared";
import {
  adminA,
  and,
  api,
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
  root,
  sr45,
  submitSurvey,
  surveys,
  type Person,
} from "./fixtures";
import { batteryProgress, type StepInput } from "../src/lib/batteries";

/**
 * Какие шаги набора держат порядок и завершение: исполнимые обязательные.
 *
 * Внешний разбор 2026-09-28 (P2): допуск к сдаче в строгом наборе
 * проверял все предшествующие шаги, не глядя ни на «обязательный», ни на
 * то, можно ли методику вообще пройти. Набор [необязательный A,
 * обязательный B] не пускал к B, пока не пройден A; снятая с использования
 * A — пройти её уже нельзя — запирала B навсегда. Завершение набора и
 * экран считали по-своему, и все три расходились.
 *
 * Теперь расчёт один (lib/batteries.ts, batteryProgress): шаг, методику
 * которого пройти нельзя (снята или не опубликована), — «знято», он не
 * запирает следующие и не входит в обязательные; необязательный шаг не
 * запирает следующие. Экран (/batteries/mine), допуск к сдаче и
 * завершение назначения зовут его же.
 *
 * Свои методики, свой набор и свои люди на каждый тест; открытые
 * назначения закрываются в afterAll — очередь назначений общая на процесс.
 */

const people: string[] = [];

afterAll(async () => {
  if (!people.length) return;
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
});

async function person(): Promise<Person> {
  const p = await makeUser("user", `battery-exec-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(p.id);
  return p;
}

async function publishSr45(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title, en: title },
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

/** Набор из методик (по порядку) и назначение его человеку */
async function assigned(
  steps: { required: boolean }[],
  strictOrder: boolean,
  who: Person,
): Promise<{ batteryId: string; surveyIds: string[]; assignmentId: string }> {
  const tag = crypto.randomUUID().slice(0, 8);
  const surveyIds: string[] = [];
  for (const [i] of steps.entries()) surveyIds.push(await publishSr45(`Крок ${i + 1} ${tag}`));
  const batteryId = crypto.randomUUID();
  await db.insert(batteries).values({ id: batteryId, title: `Набір ${tag}`, groupId: groupA, strictOrder, createdBy: adminA.id });
  await db
    .insert(batteryItems)
    .values(steps.map((s, i) => ({ batteryId, surveyId: surveyIds[i]!, position: i, required: s.required })));
  const assign = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
    method: "POST",
    body: JSON.stringify({ userId: who.id }),
  });
  expect(assign.status, JSON.stringify(assign.body)).toBe(201);
  return { batteryId, surveyIds, assignmentId: assign.body.id };
}

async function mine(who: Person, assignmentId: string): Promise<BatteryAssignment> {
  const res = await api<{ items: BatteryAssignment[] }>("/api/batteries/mine", who.token);
  expect(res.status).toBe(200);
  return res.body.items.find((a) => a.id === assignmentId)!;
}

async function completedAt(assignmentId: string): Promise<string | null> {
  const [row] = await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, assignmentId));
  return row!.completedAt;
}

describe("исполнимые обязательные шаги набора", () => {
  test("необязательный шаг не запирает обязательный в строгом порядке", async () => {
    const p = await person();
    const { surveyIds, assignmentId } = await assigned([{ required: false }, { required: true }], true, p);

    const before = await mine(p, assignmentId);
    expect(before.steps.map((s) => s.state)).toEqual(["current", "available"]);
    expect([before.doneRequired, before.totalRequired]).toEqual([0, 1]);

    const res = await submitSurvey(surveyIds[1]!, p.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // обязательный пройден — назначение закрыто, необязательный остаётся по желанию
    expect(await completedAt(assignmentId)).not.toBeNull();
  }, 60_000);

  test("снятая с использования методика не запирает следующий шаг, не считается обязательной и не держит завершение", async () => {
    const p = await person();
    const { surveyIds, assignmentId } = await assigned([{ required: true }, { required: true }], true, p);
    const archive = await api(`/api/surveys/${surveyIds[0]}`, root.token, { method: "DELETE" });
    expect(archive.status).toBe(204);

    const before = await mine(p, assignmentId);
    expect(before.steps.map((s) => s.state)).toEqual(["retired", "current"]);
    expect([before.doneRequired, before.totalRequired]).toEqual([0, 1]);

    const res = await submitSurvey(surveyIds[1]!, p.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await completedAt(assignmentId)).not.toBeNull();
    const after = await mine(p, assignmentId);
    expect([after.doneRequired, after.totalRequired]).toEqual([1, 1]);
  }, 60_000);

  test("исполнимый обязательный шаг по-прежнему запирает следующий", async () => {
    const p = await person();
    const { surveyIds, assignmentId } = await assigned([{ required: true }, { required: false }, { required: true }], true, p);
    expect((await mine(p, assignmentId)).steps.map((s) => s.state)).toEqual(["current", "locked", "locked"]);

    const early = await submitSurvey(surveyIds[2]!, p.token);
    expect(early.status).toBe(400);
    expect(early.body.error).toContain("суворий порядок");

    expect((await submitSurvey(surveyIds[0]!, p.token)).status).toBe(201);
    expect((await mine(p, assignmentId)).steps.map((s) => s.state)).toEqual(["done", "current", "available"]);
    expect((await submitSurvey(surveyIds[2]!, p.token)).status).toBe(201);
    expect(await completedAt(assignmentId)).not.toBeNull();
  }, 60_000);

  test("снятие последнего непройденного обязательного шага завершает назначение сразу", async () => {
    const p = await person();
    const { surveyIds, assignmentId } = await assigned([{ required: true }, { required: true }], false, p);
    expect((await submitSurvey(surveyIds[0]!, p.token)).status).toBe(201);
    expect(await completedAt(assignmentId)).toBeNull();

    const archive = await api(`/api/surveys/${surveyIds[1]}`, root.token, { method: "DELETE" });
    expect(archive.status).toBe(204);
    expect(await completedAt(assignmentId), "без новой сдачи назначение висело бы открытым").not.toBeNull();
  }, 60_000);

  test("снятие с публикации — то же, что снятие с использования", async () => {
    const p = await person();
    const { surveyIds, assignmentId } = await assigned([{ required: true }, { required: true }], false, p);
    expect((await submitSurvey(surveyIds[0]!, p.token)).status).toBe(201);

    const close = await api(`/api/surveys/${surveyIds[1]}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "closed" }),
    });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(await completedAt(assignmentId)).not.toBeNull();
  }, 60_000);
});

describe("batteryProgress — чистый расчёт", () => {
  const at = "2026-09-01T00:00:00.000Z";
  const step = (surveyId: string, position: number, over: Partial<StepInput> = {}): StepInput => ({
    surveyId,
    position,
    required: true,
    administration: "self",
    executable: true,
    ...over,
  });
  const done = (surveyId: string, submittedAt = "2026-09-02T00:00:00.000Z") => ({
    surveyId,
    responseId: `r-${surveyId}`,
    submittedAt,
  });

  test("пройденный до снятия шаг остаётся пройденным и засчитывается", () => {
    const p = batteryProgress([step("a", 0, { executable: false }), step("b", 1)], true, at, [done("a")]);
    expect(p.steps.map((s) => s.state)).toEqual(["done", "current"]);
    expect([p.doneRequired, p.totalRequired, p.complete]).toEqual([1, 2, false]);
  });

  test("шаги специалиста и информанта — параллельная дорожка: не запирают и не заперты", () => {
    const p = batteryProgress(
      [
        step("a", 0, { administration: "clinician" }),
        step("b", 1, { administration: "informant" }),
        step("c", 2),
        step("d", 3),
      ],
      true,
      at,
      [],
    );
    expect(p.steps.map((s) => s.state)).toEqual(["available", "available", "current", "locked"]);
  });

  test("прохождение до назначения не засчитывается; набор без обязательных сам не завершается", () => {
    const old = batteryProgress([step("a", 0)], false, at, [done("a", "2026-08-31T23:59:59.000Z")]);
    expect([old.steps[0]!.state, old.complete]).toEqual(["available", false]);
    const optional = batteryProgress([step("a", 0, { required: false })], false, at, [done("a")]);
    expect([optional.totalRequired, optional.complete]).toEqual([0, false]);
  });
});
