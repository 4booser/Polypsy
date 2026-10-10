import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  adminB,
  appApi,
  createSurveySchema,
  createVersion,
  db,
  makeUser,
  root,
  sr45,
  surveyInB,
  surveys,
  type Person,
} from "./fixtures";
import {
  appointments,
  batteries,
  batteryAssignments,
  batteryItems,
  departmentPatients,
  departments,
  groupAdmins,
  patientNotes,
  slots,
  specialistProfiles,
  surveyAccess,
  surveyGroups,
} from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";
import { grantAccess } from "../src/lib/grantAccess";

/**
 * Расширить свою зону на чужого пациента нельзя (#139).
 *
 * Запись на приём, выдача методики и выдача набора — каждое само основание
 * видеть человека. Сотрудник X другого отделения, зная идентификатор
 * пациента, которого уже ведёт кто-то другой, записывал его к себе или
 * выдавал ему методику своей группы — и получал карту и заметки чужого
 * автора. Запись отказывала только прикреплённому к чужому отделению,
 * выдача методики и набора — никому.
 *
 * «Ведёт кто-то другой» — трояко: прикреплён к чужому отделению, в зоне
 * чужой группы (выдача методики группы Б с подписанной заметкой её
 * администратора), на приёме у другого специалиста. Каждое основание
 * пробуется каждым из трёх путей на свежем человеке, чтобы удача одного
 * пути не открывала двери другим. Всё — под ролью приложения.
 *
 * Положительный контроль: «ничей» новый человек по-прежнему записывается и
 * получает методику и набор, после чего X видит его карту.
 */

const SECRET = "СЕКРЕТ-ЧУЖОГО-ОТДЕЛЕНИЯ";

let x: Person;
let otherSpecialist: Person;
let ownDepartment: string;
let otherDepartment: string;
let ownSurvey: string;
let ownBattery: string;
const people: string[] = [];

/** Слоты — каждый на своём часе, далеко впереди: открытые слоты одного специалиста не пересекаются (0105) */
let slotHour = 0;
async function slotOf(specialistId: string, departmentId: string): Promise<string> {
  const id = crypto.randomUUID();
  const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + (24 * 30 + 2 * slotHour++) * 3_600_000;
  await db.insert(slots).values({
    id,
    specialistId,
    departmentId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  });
  return id;
}

beforeAll(async () => {
  ownDepartment = crypto.randomUUID();
  otherDepartment = crypto.randomUUID();
  await db.insert(departments).values([
    { id: ownDepartment, title: { uk: "Відділення X", ru: "Отделение X" }, timezone: "Europe/Kyiv" },
    { id: otherDepartment, title: { uk: "Інше відділення", ru: "Другое отделение" }, timezone: "Europe/Kyiv" },
  ]);

  x = await makeUser("admin", `oc-x-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: x.id, departmentId: ownDepartment });
  otherSpecialist = await makeUser("admin", `oc-s2-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: otherSpecialist.id, departmentId: otherDepartment });

  // своя группа X — со своей методикой и своим набором
  const group = crypto.randomUUID();
  await db.insert(surveyGroups).values({ id: group, title: "Группа X", createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId: group, userId: x.id, addedBy: root.id });
  ownSurvey = crypto.randomUUID();
  await db.insert(surveys).values({
    id: ownSurvey,
    groupId: group,
    title: { uk: "Методика групи X", ru: "Методика группы X" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: x.id,
  } as never);
  await createVersion(ownSurvey, createSurveySchema.parse(sr45), x.id, "Тестовая версия");
  ownBattery = crypto.randomUUID();
  await db.insert(batteries).values({ id: ownBattery, title: "Набор X", groupId: group, createdBy: x.id });
  await db.insert(batteryItems).values({ batteryId: ownBattery, surveyId: ownSurvey, position: 0 });
}, 30_000);

afterAll(async () => {
  // ничего живого в общих очередях: приёмы — отменены, наборы — сняты
  if (!people.length) return;
  await db.update(appointments).set({ status: "cancelled" }).where(inArray(appointments.patientId, people));
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

async function person(tag: string): Promise<Person> {
  const p = await makeUser("user", `oc-${tag}-${crypto.randomUUID()}@test`, { sex: "male", birthDate: "1990-01-01" });
  people.push(p.id);
  return p;
}

/** Подписанная заметка чужого автора — то, что утекало */
async function foreignNote(patientId: string) {
  await db.insert(patientNotes).values({
    id: crypto.randomUUID(),
    userId: patientId,
    version: 1,
    kind: "session",
    text: encryptField(SECRET)!,
    status: "signed",
    createdBy: adminB.id,
    signedAt: new Date().toISOString(),
    signedBy: adminB.id,
  });
}

type Owner = "отделение" | "зона группы" | "приём у другого специалиста";

/** Человек, которого уже ведёт кто-то другой, — с заметкой, которую X видеть не должен */
async function ownedBy(owner: Owner, tag: string): Promise<Person> {
  const p = await person(tag);
  if (owner === "отделение") {
    await db.insert(departmentPatients).values({ departmentId: otherDepartment, patientId: p.id, attachedVia: "visit" });
  } else if (owner === "зона группы") {
    await grantAccess(
      db,
      [{ surveyId: surveyInB, userId: p.id, grantedBy: adminB.id, expiresAt: null, note: null }],
      { term: "set" },
    );
  } else {
    await db.insert(appointments).values({
      id: crypto.randomUUID(),
      slotId: await slotOf(otherSpecialist.id, otherDepartment),
      patientId: p.id,
      specialistId: otherSpecialist.id,
      bookedBy: otherSpecialist.id,
    });
  }
  await foreignNote(p.id);
  return p;
}

type Path = "запись на приём" | "выдача методики" | "выдача набора";

function attempt(path: Path, patientId: string) {
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  if (path === "запись на приём") {
    return slotOf(x.id, ownDepartment).then((slotId) =>
      appApi("/api/clinic/appointments", x.token, post({ slotId, patientId })),
    );
  }
  if (path === "выдача методики") return appApi(`/api/access/surveys/${ownSurvey}/grants`, x.token, post({ userId: patientId }));
  return appApi(`/api/batteries/${ownBattery}/assign`, x.token, post({ userId: patientId }));
}

/** Что X получил бы в руки: приём у себя, прикрепление к своему отделению, свою выдачу, свой набор */
async function rowsForX(patientId: string) {
  const [appts, attached, grants, assigned] = await Promise.all([
    db.select().from(appointments).where(and(eq(appointments.patientId, patientId), eq(appointments.specialistId, x.id))),
    db
      .select()
      .from(departmentPatients)
      .where(and(eq(departmentPatients.patientId, patientId), eq(departmentPatients.departmentId, ownDepartment))),
    db.select().from(surveyAccess).where(and(eq(surveyAccess.userId, patientId), eq(surveyAccess.surveyId, ownSurvey))),
    db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.userId, patientId), eq(batteryAssignments.batteryId, ownBattery))),
  ]);
  return { appointments: appts.length, attached: attached.length, grants: grants.length, assigned: assigned.length };
}

async function xSees(patientId: string) {
  const notes = await appApi(`/api/notes/patients/${patientId}`, x.token);
  const card = await appApi(`/api/patients/${patientId}/card`, x.token);
  return { notes, card };
}

const owners: Owner[] = ["отделение", "зона группы", "приём у другого специалиста"];
const paths: Path[] = ["запись на приём", "выдача методики", "выдача набора"];

describe("чужого пациента в свою зону не ввести (#139)", () => {
  for (const owner of owners) {
    for (const path of paths) {
      test(`${owner}: ${path} — отказ, ни строки, ни карты, ни заметок`, async () => {
        const p = await ownedBy(owner, "owned");

        // до попытки X человека не видит — иначе проверять нечего
        const before = await xSees(p.id);
        expect(before.notes.status).toBe(404);
        expect(before.card.status).toBe(404);

        const res = await attempt(path, p.id);
        expect([403, 404], `${path}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
        expect(await rowsForX(p.id), "отказ оставил строки").toEqual({
          appointments: 0,
          attached: 0,
          grants: 0,
          assigned: 0,
        });

        const after = await xSees(p.id);
        expect(after.notes.status, `заметки чужого автора открылись: ${JSON.stringify(after.notes.body)}`).toBe(404);
        expect(JSON.stringify(after.notes.body ?? "")).not.toContain(SECRET);
        expect(after.card.status, "карта чужого пациента открылась").toBe(404);
      }, 30_000);
    }
  }

  test("свой пациент, которого ведут и другие, — выдача проходит", async () => {
    // зона X уже включает человека: чужое участие не повод отказывать своему
    const p = await ownedBy("зона группы", "shared");
    await grantAccess(
      db,
      [{ surveyId: ownSurvey, userId: p.id, grantedBy: x.id, expiresAt: null, note: null }],
      { term: "set" },
    );
    const res = await attempt("выдача набора", p.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }, 30_000);

  for (const path of paths) {
    test(`положительный контроль: «ничей» новый человек — ${path} проходит, карта открывается`, async () => {
      const p = await person("nobody");
      const res = await attempt(path, p.id);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(201);
      const after = await xSees(p.id);
      expect(after.card.status).toBe(200);
      expect(after.notes.status).toBe(200);
    }, 30_000);
  }
});
