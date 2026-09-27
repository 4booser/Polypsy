import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, inArray } from "drizzle-orm";
import { renderNote } from "@quizzy/shared";
import {
  adminA,
  and,
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
  sr45,
  submitSurvey,
  surveys,
  type Person,
} from "./fixtures";
import { scaleBands, scales, surveyVersions } from "../src/db/schema";
import { underAppRole } from "./appRole";

/**
 * Каскад по результату скрининга и просроченное назначение.
 *
 * Расписание и ручное назначение с волны 12 считают открытое назначение с
 * вышедшим сроком пропуском: закрывают его с отметкой и выдают новое.
 * Каскад остался на «незакрытое — занято»: человек, не прошедший
 * углублённый набор в срок, больше не получал его ни при каком результате
 * повторного скрининга. Правило теперь одно (lib/batteries.ts).
 *
 * Свои методики, свой набор и свои люди: очередь назначений общая на
 * процесс, и открытое назначение, брошенное здесь, другим файлам видно.
 */

let screenId: string;
let deepBattery: string;
const people: string[] = [];

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

beforeAll(async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  screenId = await publishSr45(`Каскад-прострочка ${tag}`);
  const deepId = await publishSr45(`Поглиблена-прострочка ${tag}`);

  deepBattery = crypto.randomUUID();
  await db.insert(batteries).values({
    id: deepBattery,
    title: `Поглиблений набір ${tag}`,
    groupId: groupA,
    strictOrder: false,
    createdBy: adminA.id,
  });
  await db.insert(batteryItems).values([{ batteryId: deepBattery, surveyId: deepId, position: 0, required: true }]);

  // каскад — на всех полосах шкалы Sr: куда бы ни лёг балл, набор назначается
  const [version] = await db
    .select()
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, screenId))
    .orderBy(desc(surveyVersions.version))
    .limit(1);
  const sr = await db.query.scales.findFirst({ where: and(eq(scales.versionId, version!.id), eq(scales.code, "Sr")) });
  await db.update(scaleBands).set({ cascadeBatteryId: deepBattery, cascadeDueDays: 14 }).where(eq(scaleBands.scaleId, sr!.id));
}, 30_000);

afterAll(async () => {
  // ничего живого в общей очереди: свои открытые назначения — в конечное состояние
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
});

async function person(): Promise<Person> {
  const p = await makeUser("user", `cascade-overdue-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(p.id);
  return p;
}

const assignmentsOf = (userId: string) =>
  db
    .select()
    .from(batteryAssignments)
    .where(and(eq(batteryAssignments.batteryId, deepBattery), eq(batteryAssignments.userId, userId)));

describe("каскад и просроченное назначение", () => {
  test("просроченное закрывается с отметкой «пропущено», и выдаётся новое", async () => {
    const p = await person();
    const first = await submitSurvey(screenId, p.token);
    expect(first.status).toBe(201);
    expect(first.body.cascade.assignedBatteries.length).toBe(1);

    // срок вышел вчера: человек углублённый набор так и не прошёл
    const [open] = await assignmentsOf(p.id);
    await db
      .update(batteryAssignments)
      .set({ dueAt: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(batteryAssignments.id, open!.id));

    const second = await submitSurvey(screenId, p.token);
    expect(second.status).toBe(201);
    expect(second.body.cascade.assignedBatteries.length, "каскад счёл просроченное занятостью").toBe(1);

    const rows = await assignmentsOf(p.id);
    expect(rows.length).toBe(2);
    const old = rows.find((r) => r.id === open!.id)!;
    expect(old.cancelledAt, "пропуск не закрыт").not.toBeNull();
    expect(old.completedAt).toBeNull();
    // отметка дописана к примечанию, а не вместо него: видно, откуда назначение и чем кончилось
    // (обе части — кодом, волна 14; по-русски — прежними словами)
    expect(renderNote(old.note, "ru")).toContain("Каскад по результату скрининга");
    expect(renderNote(old.note, "ru")).toContain("пропущено");
    expect(renderNote(old.note, "uk")).toBe(
      "Каскад за результатом скринінгу · пропущено: строк минув, призначено знову за результатом скринінгу",
    );

    const fresh = rows.find((r) => r.id !== open!.id)!;
    expect(fresh.cancelledAt).toBeNull();
    expect(fresh.completedAt).toBeNull();
    expect(Date.parse(fresh.dueAt!)).toBeGreaterThan(Date.now());
  }, 30_000);

  test("не просроченное — по-прежнему занято: повторная сдача второго не плодит", async () => {
    const p = await person();
    await submitSurvey(screenId, p.token);
    const again = await submitSurvey(screenId, p.token);
    expect(again.status).toBe(201);
    expect(again.body.cascade.assignedBatteries).toEqual([]);
    const rows = await assignmentsOf(p.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.cancelledAt).toBeNull();
  }, 30_000);
});

describe("под боевой ролью базы", () => {
  /*
   * Каскад идёт внутри сдачи пациента — в его транзакции, под системной
   * ролью (asSystem в lib/submission.ts). Закрытие пропуска — новая запись
   * в чужую пациенту таблицу назначений, и под ролью владельца сюита не
   * увидела бы, если бы политика её не пустила: сдача откатилась бы целиком.
   */
  test("сдача пациента закрывает пропуск и выдаёт новое", async () => {
    const p = await person();
    await submitSurvey(screenId, p.token);
    const [open] = await assignmentsOf(p.id);
    await db
      .update(batteryAssignments)
      .set({ dueAt: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(batteryAssignments.id, open!.id));

    const out = await underAppRole<{ status: number; assigned: number }>(`
      const auth = { Authorization: ${JSON.stringify(`Bearer ${p.token}`)}, "Content-Type": "application/json" };
      const survey = await (await app.request(${JSON.stringify(`/api/surveys/${screenId}`)}, { headers: auth })).json();
      const answers = survey.questions
        .filter((q) => q.type !== "info" && q.options.length)
        .map((q) => ({ questionId: q.id, optionIds: [q.options[1]?.id ?? q.options[0].id], durationMs: 2000, changeCount: 0, visitCount: 1 }));
      const res = await app.request(${JSON.stringify(`/api/surveys/${screenId}/responses`)}, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ startedAt: new Date(Date.now() - 60000).toISOString(), durationMs: 60000, events: [], answers }),
      });
      out.status = res.status;
      out.assigned = ((await res.json()).cascade?.assignedBatteries ?? []).length;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);
    expect(out.status, "сдача упала под боевой ролью").toBe(201);
    expect(out.assigned, "каскад под боевой ролью счёл пропуск занятостью").toBe(1);

    const rows = await assignmentsOf(p.id);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === open!.id)!.cancelledAt).not.toBeNull();
  }, 60_000);
});

