import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { noteCode } from "@quizzy/shared";
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
  sql,
  sr45,
  surveys,
} from "./fixtures";
import { batteryAssignmentItems, surveyAccess } from "../src/db/schema";
import { MIGRATIONS_FOLDER } from "../src/db/migrations";

/**
 * Происхождение доступов, выданных набором до волны 14 (#150).
 *
 * 0114 заполнила survey_access.via_assignment_id только для пометок-кодов
 * (⟦note.battery…⟧ и соседи), а до волны 14 те же пути выдачи писали фразу:
 * «Батарея «…»», «Расписание «…»», «Каскад по результату скрининга». Такие
 * строки остались без происхождения, и отмена назначения их не снимала —
 * пациент открывал методику из снятого набора.
 *
 * Состояние «до 0114» собирается руками: открытое назначение, строки
 * доступа с пометками разных эпох и с пустым происхождением. Затем —
 * заполнение из 0114 и новая миграция (обе — по тексту файлов, сужены на
 * своего человека: вся база теста общая на процесс), отмена назначения
 * под ролью приложения и попытка пациента открыть каждую методику.
 */

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
}, 15_000);

async function restricted(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: title, ru: title },
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

/** Операторы файла миграции — сужены на одного человека: остальная база теста не трогается */
async function replay(file: string, userId: string, pick: "all" | "last" = "all") {
  const text = await Bun.file(`${MIGRATIONS_FOLDER}/${file}`).text();
  const parts = text.split("--> statement-breakpoint").map((s) => s.trim());
  const statements = pick === "last" ? [parts.at(-1)!] : parts;
  for (const statement of statements) {
    // сужение дописывается к последнему WHERE: годится только для UPDATE доступов, кончающегося «;»
    expect(statement, `${file}: не тот оператор — сузить нельзя`).toContain("UPDATE survey_access sa");
    expect(statement.endsWith(";"), `${file}: оператор без «;» в конце — сузить нельзя`).toBe(true);
    await db.execute(sql.raw(`${statement.slice(0, -1)} AND sa.user_id = '${userId}';`));
  }
}

async function origins(userId: string): Promise<Map<string, string | null>> {
  const rows = await db
    .select({ surveyId: surveyAccess.surveyId, via: surveyAccess.viaAssignmentId })
    .from(surveyAccess)
    .where(eq(surveyAccess.userId, userId));
  return new Map(rows.map((r) => [r.surveyId, r.via]));
}

describe("миграция 0127: происхождение доступов с пометкой-фразой", () => {
  test("до 0114 → 0114 → 0127: отмена назначения снимает доступы набора и только их", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const s = {
      battery: await restricted(`Фраза набора ${tag}`),
      schedule: await restricted(`Фраза расписания ${tag}`),
      cascade: await restricted(`Фраза каскада ${tag}`),
      coded: await restricted(`Код набора ${tag}`),
      manual: await restricted(`Вручную ${tag}`),
      extended: await restricted(`Продлено набором ${tag}`),
      outside: await restricted(`Вне назначения ${tag}`),
    };
    const inBattery = [s.battery, s.schedule, s.cascade, s.coded, s.manual, s.extended];

    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: `Набор до волны 14 ${tag}`,
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db
      .insert(batteryItems)
      .values(inBattery.map((surveyId, position) => ({ batteryId, surveyId, position, required: true })));

    const p = await makeUser("user", `origin-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
    people.push(p.id);
    const assignmentId = crypto.randomUUID();
    await db.insert(batteryAssignments).values({
      id: assignmentId,
      batteryId,
      userId: p.id,
      assignedBy: adminA.id,
      assignedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    await db
      .insert(batteryAssignmentItems)
      .values(inBattery.map((surveyId, position) => ({ assignmentId, surveyId, position, required: true })));

    // ── «до 0114»: происхождения нет ни у кого ──
    const row = (surveyId: string, note: string) => ({ surveyId, userId: p.id, grantedBy: adminA.id, note });
    await db.insert(surveyAccess).values([
      // до волны 14 — фразой
      row(s.battery, `Батарея «Набор до волны 14 ${tag}»`),
      row(s.schedule, `Расписание «Ежемесячно ${tag}»`),
      row(s.cascade, "Каскад по результату скрининга"),
      // волна 14–16 — кодом (его заполнила 0114)
      row(s.coded, noteCode("note.battery", { title: `Набор ${tag}` })),
      // ручная выдача — своя пометка специалиста
      row(s.manual, "Выдано на приёме"),
      // фраза набора, но открытого назначения с этой методикой нет
      row(s.outside, `Батарея «Другой набор ${tag}»`),
    ]);

    await replay("0114_assignment_items.sql", p.id, "last");
    let via = await origins(p.id);
    expect(via.get(s.coded), "0114 не заполнила пометку-код").toBe(assignmentId);
    expect(via.get(s.battery), "0114 и так заполняла фразы — воспроизведение не то").toBeNull();

    // ── после 0114: ручной доступ, который набор лишь продлил, — код без происхождения, намеренно ──
    await db.insert(surveyAccess).values(row(s.extended, noteCode("note.battery", { title: `Набор ${tag}` })));

    await replay("0127_battery_access_origin.sql", p.id);
    via = await origins(p.id);
    const expected = new Map<string, string | null>([
      [s.battery, assignmentId],
      [s.schedule, assignmentId],
      [s.cascade, assignmentId],
      [s.coded, assignmentId],
      [s.manual, null],
      [s.extended, null],
      [s.outside, null],
    ]);
    expect(via).toEqual(expected);

    // повторный прогон ничего не меняет
    await replay("0127_battery_access_origin.sql", p.id);
    expect(await origins(p.id)).toEqual(expected);

    // ── отмена назначения сотрудником и попытка пациента открыть методики ──
    const cancel = await appApi(`/api/batteries/assignments/${assignmentId}/cancel`, adminA.token, { method: "POST" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    const opens = async (surveyId: string) => (await appApi(`/api/surveys/${surveyId}`, p.token)).status;
    for (const surveyId of [s.battery, s.schedule, s.cascade, s.coded]) {
      expect(await opens(surveyId), "доступ снятого набора остался").toBe(404);
    }
    for (const surveyId of [s.manual, s.extended, s.outside]) {
      expect(await opens(surveyId), "отмена набора отобрала доступ другого основания").toBe(200);
    }
  }, 60_000);
});
