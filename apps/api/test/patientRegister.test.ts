import { describe, expect, test } from "bun:test";
import { instrumentCode } from "@quizzy/shared";
import { adminA, adminB, api, db, groupA, groupB, makeUser, submitSurvey, surveyInA, type Person } from "./fixtures";
import {
  alertCases,
  appointments,
  batteries,
  batteryAssignments,
  departments,
  dispensary,
  slots,
  specialistProfiles,
  surveyAccess,
} from "../src/db/schema";

/**
 * Реестр пациентов 2.0 (кадр patients-list): строка говорит, почему человек
 * в списке сейчас и что дальше, — открытый случай, главная шкала последнего
 * замера с ходом, ближайший приём, неявка, учёт, ведущий; подання
 * «Потребує уваги» со счётчиками и порядок «ризик спершу».
 *
 * Данные — свои на каждый тест (метка в почте и поиск по ней): зону adminA
 * наполняют все файлы сюиты, и счётчики по всей зоне зависели бы от порядка
 * файлов. Под ролью приложения (test:app-role) те же проверки идут через
 * политики alert_cases, appointments и dispensary.
 */

async function patientOfA(tag: string, extra: Record<string, unknown> = {}): Promise<Person & { email: string }> {
  const email = `reg-${tag}@test`;
  const person = await makeUser("user", email, extra);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return { ...person, email };
}

/** Приём у человека через `days` дней (отрицательное — в прошлом) со статусом */
async function visit(patientId: string, days: number, status: "booked" | "confirmed" | "no_show" | "done") {
  const doctor = await makeUser("admin", `reg-doc-${crypto.randomUUID()}@test`);
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: "Реєстр" }, timezone: "Europe/Kyiv" });
  await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId });
  const startsAt = new Date(Date.now() + days * 86_400_000);
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    departmentId,
    specialistId: doctor.id,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 3_000_000).toISOString(),
    kind: "primary",
  });
  await db.insert(appointments).values({
    id: crypto.randomUUID(),
    slotId,
    patientId,
    specialistId: doctor.id,
    kind: "primary",
    status,
    bookedBy: doctor.id,
  });
  return startsAt;
}

const ids = (body: { items: { id: string }[] }) => body.items.map((p) => p.id);

describe("GET /api/patients — реестр 2.0", () => {
  test("случай, приём, неявка, учёт и ведущий — в строке; подання и счётчики по поиску", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const risky = await patientOfA(`${tag}-risk`, { leadSpecialistId: adminA.id });
    const booked = await patientOfA(`${tag}-booked`);
    const missed = await patientOfA(`${tag}-missed`);

    const caseId = crypto.randomUUID();
    await db.insert(alertCases).values({ id: caseId, userId: risky.id, surveyId: surveyInA, severity: "severe" });
    const at = await visit(booked.id, 3, "confirmed");
    await visit(missed.id, -2, "no_show");
    await db.insert(dispensary).values({
      patientId: missed.id,
      groupLabel: "Д-2",
      intervalMonths: 3,
      nextDueAt: new Date(Date.now() - 86_400_000).toISOString(),
      addedBy: adminA.id,
    });

    const res = await api(`/api/patients?q=${tag}&sort=risk&limit=50`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.counts).toEqual({ all: 3, mine: 1, risk: 1, stale: 3, unbooked: 2 });

    /* «ризик спершу»: открытый случай, потом неявка, потом остальные */
    expect(ids(res.body)).toEqual([risky.id, missed.id, booked.id]);
    const [r, m, b] = res.body.items;
    expect(r.risk).toMatchObject({ cases: 1, caseId, severity: "severe", assigneeName: null });
    expect(r.leadName).toContain("Тест");
    expect(m.risk).toBeNull();
    expect(m.lastNoShowAt).toBeTruthy();
    expect(m.dispensary).toMatchObject({ groupLabel: "Д-2", overdue: true });
    expect(b.nextVisit?.at).toBe(at.toISOString());
    expect(b.lastNoShowAt).toBeNull();

    const view = async (v: string) => ids((await api(`/api/patients?q=${tag}&view=${v}`, adminA.token)).body);
    expect(await view("risk")).toEqual([risky.id]);
    expect(await view("mine")).toEqual([risky.id]);
    expect((await view("unbooked")).sort()).toEqual([missed.id, risky.id].sort());
    expect(await view("stale")).toHaveLength(3);
    /* незнакомое подання из старой закладки — все, а не отказ */
    expect(await view("nonsense")).toHaveLength(3);

    /* ближайший приём: со свободным временем — первым, без приёма — в конце */
    const next = await api(`/api/patients?q=${tag}&sort=next`, adminA.token);
    expect(ids(next.body)[0]).toBe(booked.id);
  });

  test("главная шкала последнего замера: короткое имя, ход, «краще», единицы", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const p = await patientOfA(`${tag}-measured`);
    const quiet = await patientOfA(`${tag}-quiet`);
    expect((await submitSurvey(surveyInA, p.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, p.token)).status).toBe(201);

    const res = await api(`/api/patients?q=${tag}&sort=last`, adminA.token);
    expect(ids(res.body)).toEqual([p.id, quiet.id]);
    const m = res.body.items[0].measure;
    expect(m.code).toBe("СР-45");
    expect(m.values).toHaveLength(2);
    expect(m.better).toBe("down");
    expect(m.normalization).toBe("ratio");
    expect(m.surveyId).toBe(surveyInA);
    expect(res.body.items[1].measure).toBeNull();
    /* замерянный сегодня — уже не «без заміру 30+ днів» */
    expect(res.body.counts.stale).toBe(1);
  });

  test("чужая зона: случай и строка по чужому человеку не видны", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const risky = await patientOfA(`${tag}-zone`);
    await db.insert(alertCases).values({ id: crypto.randomUUID(), userId: risky.id, surveyId: surveyInA, severity: "moderate" });
    const theirs = await api(`/api/patients?q=${tag}`, adminB.token);
    expect(theirs.body.items).toEqual([]);
    expect(theirs.body.counts.risk).toBe(0);
  });
});

describe("GET /api/dynamics/respondents/:id — полосы шкалы", () => {
  test("у шкалы — полосы версии последнего замера, по возрастанию", async () => {
    const p = await patientOfA(`${crypto.randomUUID().slice(0, 8)}-bands`);
    expect((await submitSurvey(surveyInA, p.token)).status).toBe(201);
    const res = await api(`/api/dynamics/respondents/${p.id}`, adminA.token);
    expect(res.status).toBe(200);
    const sr = res.body.surveys[0].scales.find((s: { code: string }) => s.code === "Sr");
    expect(sr.bands.length).toBeGreaterThan(2);
    expect(sr.bands[0]).toMatchObject({ min: 0, severity: "none" });
    expect(typeof sr.bands[0].label).toBe("string");
    const mins = sr.bands.map((b: { min: number }) => b.min);
    expect(mins).toEqual([...mins].sort((a: number, b: number) => a - b));
  });
});

describe("GET /api/timeline/:id — назначение набора", () => {
  test("в строке — название набора, а не его идентификатор", async () => {
    const p = await patientOfA(`${crypto.randomUUID().slice(0, 8)}-battery`);
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({ id: batteryId, groupId: groupA, title: "Перед сесією 6", createdBy: adminA.id } as never);
    await db.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId,
      userId: p.id,
      assignedBy: adminA.id,
    } as never);
    const res = await api(`/api/timeline/${p.id}`, adminA.token);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { kind: string }) => i.kind === "assignment");
    expect(row.title).toBe("Перед сесією 6");
  });

  test("набор чужого отделения в хронологии не виден — ни названием, ни строкой; без группы — виден", async () => {
    /*
     * У таблицы наборов нет политики строк: левое соединение отдавало
     * название любого набора, и человек, общий для двух отделений, в
     * хронологии отделения A показывал «Набір чужого відділення». Назначение
     * набора чужой группы уходит целиком — как прохождения и тревоги по
     * чужим методикам; набор без группы виден всем сотрудникам, как в списке
     * наборов.
     */
    const tag = crypto.randomUUID().slice(0, 8);
    const p = await patientOfA(`${tag}-foreign-battery`);
    const foreign = crypto.randomUUID();
    const shared = crypto.randomUUID();
    await db.insert(batteries).values([
      { id: foreign, groupId: groupB, title: `Набір чужого відділення ${tag}`, createdBy: adminB.id },
      { id: shared, groupId: null, title: `Набір без групи ${tag}`, createdBy: adminB.id },
    ] as never);
    await db.insert(batteryAssignments).values([
      { id: crypto.randomUUID(), batteryId: foreign, userId: p.id, assignedBy: adminB.id },
      { id: crypto.randomUUID(), batteryId: shared, userId: p.id, assignedBy: adminB.id },
    ] as never);

    const res = await api(`/api/timeline/${p.id}`, adminA.token);
    expect(res.status).toBe(200);
    const rows = res.body.items.filter((i: { kind: string }) => i.kind === "assignment") as { title: string }[];
    expect(rows.map((r) => r.title)).toEqual([`Набір без групи ${tag}`]);
    expect(JSON.stringify(res.body)).not.toContain(foreign);
    expect(JSON.stringify(res.body)).not.toContain("чужого відділення");
  });
});

describe("instrumentCode", () => {
  test("код в скобках, код в начале, пометка в скобках — не код", () => {
    expect(instrumentCode("Депресія (PHQ-9)", "PHQ")).toBe("PHQ-9");
    expect(instrumentCode("СР-45. Схильність до суїцидальних реакцій", "Sr")).toBe("СР-45");
    expect(instrumentCode("Скринінг емоційного стану (демо)", "EMO")).toBe("EMO");
    expect(instrumentCode("Опитувальник Міні-мульт", "Hs")).toBe("Hs");
  });
});
