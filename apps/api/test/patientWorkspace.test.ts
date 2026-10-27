import { describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CATALOG } from "../src/instruments/catalog";
import { clinicalDomainOf, isKeyDomain } from "../src/lib/clinicalDomains";
import {
  adminA,
  adminB,
  api,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  root,
  sr45,
  submitSurvey,
  surveyInA,
  type Person,
} from "./fixtures";
import {
  appointments,
  auditLog,
  departments,
  dispensary,
  referrals,
  responseScores,
  scales,
  slots,
  specialistProfiles,
  surveyAccess,
  surveys,
} from "../src/db/schema";

/**
 * Рабочее место пациента (участок dp-patient): шапка и «Огляд» читают одну
 * карточку, и она говорит, зачем человек здесь, что с ним по доменам и что
 * дальше; строка реестра — клинический стан, а не последнюю сданную
 * методику; вкладка «Направлення» — направления одного человека.
 *
 * Данные — свои на каждый тест (метка в почте): зону adminA наполняют все
 * файлы сюиты. Файл стоит в test:app-role — карточка читает обращения,
 * приёмы, учёт и направления под политиками строк.
 */

async function patientOfA(tag: string): Promise<Person & { email: string }> {
  const email = `ws-${tag}-${crypto.randomUUID().slice(0, 8)}@test`;
  const person = await makeUser("user", email);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return { ...person, email };
}

/** Методика группы А с полкой каталога — та же СР-45 под другим именем и полкой */
async function surveyWithShelf(domain: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const input = createSurveySchema.parse(sr45);
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Полиця ${domain ?? "немає"} (ПЛ-${id.slice(0, 4)})`, ru: `Полка ${domain ?? "нет"}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
    domain,
  } as never);
  await createVersion(id, input, adminA.id, "Тестова версія");
  return id;
}

/** Прохождение и его полоса по шкале Sr — нужной ступени (баллы ставит движок, ступень — тест) */
async function measured(surveyId: string, person: Person, severity: "none" | "mild" | "moderate" | "severe"): Promise<string> {
  await db.insert(surveyAccess).values({ surveyId, userId: person.id, grantedBy: adminA.id }).onConflictDoNothing();
  const res = await submitSurvey(surveyId, person.token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const responseId = res.body.id as string;
  const sr = await db
    .select({ id: responseScores.scaleId })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(and(eq(responseScores.responseId, responseId), eq(scales.code, "Sr")));
  await db
    .update(responseScores)
    .set({ severity, bandLabel: `ступінь ${severity}` })
    .where(and(eq(responseScores.responseId, responseId), inArray(responseScores.scaleId, sr.map((s) => s.id))));
  return responseId;
}

/** Приём человека через `days` дней у `doctor` */
async function visitWith(doctor: Person, patientId: string, days: number, status: "booked" | "confirmed" | "done" | "no_show" | "cancelled") {
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: "Робоче місце" }, timezone: "Europe/Kyiv" });
  await db.insert(specialistProfiles).values({ userId: doctor.id, departmentId }).onConflictDoNothing();
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
  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId,
    patientId,
    specialistId: doctor.id,
    kind: "repeat",
    mode: "remote",
    status,
    bookedBy: doctor.id,
  });
  return { id, startsAt };
}

describe("клинический домен шкалы", () => {
  test("пара «ключ — шкала» сильнее методики, методика сильнее полки, без полки — «інше»", () => {
    expect(clinicalDomainOf({ catalogKey: "dass42", surveyDomain: "distress", code: "D" })).toBe("depression");
    expect(clinicalDomainOf({ catalogKey: "dass42", surveyDomain: "distress", code: "A" })).toBe("anxiety");
    expect(clinicalDomainOf({ catalogKey: "dass21", surveyDomain: "distress", code: "S" })).toBe("stress");
    expect(clinicalDomainOf({ catalogKey: "phq4", surveyDomain: "distress", code: "ANX" })).toBe("anxiety");
    expect(clinicalDomainOf({ catalogKey: "phq4", surveyDomain: "distress", code: "PHQ4" })).toBe("distress");
    expect(clinicalDomainOf({ catalogKey: "pcl5", surveyDomain: "trauma", code: "PCL" })).toBe("trauma");
    expect(clinicalDomainOf({ catalogKey: "audit", surveyDomain: "addiction", code: "AUDIT" })).toBe("addiction");
    // методика полки «дистрес», которая меряет одно
    expect(clinicalDomainOf({ catalogKey: "phq2", surveyDomain: "distress", code: "PHQ2" })).toBe("depression");
    expect(clinicalDomainOf({ catalogKey: "gad7", surveyDomain: "distress", code: "GAD" })).toBe("anxiety");
    expect(clinicalDomainOf({ catalogKey: "k10", surveyDomain: "distress", code: "K10" })).toBe("distress");
    // полка — запасной путь: встроенные без ключа, методики учреждения
    expect(clinicalDomainOf({ catalogKey: null, surveyDomain: "suicide", code: "Sr" })).toBe("suicide");
    expect(clinicalDomainOf({ catalogKey: "cbi", surveyDomain: "staff", code: "WB" })).toBe("burnout");
    expect(clinicalDomainOf({ catalogKey: null, surveyDomain: "personality", code: "D" })).toBe("personality");
    // ни ключа, ни полки — «інше», а не догадка по коду шкалы
    expect(clinicalDomainOf({ catalogKey: null, surveyDomain: null, code: "mood" })).toBe("other");
    expect(isKeyDomain("personality")).toBe(false);
    expect(isKeyDomain("sleep")).toBe(true);
  });

  test("ключи карты есть в каталоге: переименованная методика не выпадает из домена молча", () => {
    const keys = new Set(CATALOG.map((e) => e.key));
    for (const key of ["phq9", "phq8", "phq2", "cesdr", "gds15", "gad7", "gad2", "pss10", "pss4", "k10", "k6", "core10", "srq20", "aaq2", "phq15", "dass21", "phq4"]) {
      expect(keys.has(key), `ключ ${key} пропал из каталога`).toBe(true);
    }
  });
});

describe("GET /api/patients/:id/card — шапка и «Огляд» рабочего места", () => {
  test("домены — по шкалам с замерами; шкала достоверности в домены не идёт", async () => {
    const person = await patientOfA("domains");
    const suicide = await surveyWithShelf("suicide");
    const bare = await surveyWithShelf(null);
    await measured(suicide, person, "moderate");
    await measured(bare, person, "none");

    const card = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(card.status).toBe(200);
    const domains = card.body.domains as { surveyId: string; code: string; domain: string }[];
    expect(domains).toContainEqual({ surveyId: suicide, code: "Sr", domain: "suicide" });
    expect(domains).toContainEqual({ surveyId: bare, code: "Sr", domain: "other" });
    // «L» — шкала лжи: о бланке, а не о человеке
    expect(domains.some((d) => d.code === "L")).toBe(false);
  });

  test("обращение, ближайшие приёмы, учёт, незакрытые направления — одним чтением; приём не «открыт»", async () => {
    const person = await patientOfA("plan");
    const doctor = await makeUser("admin", `ws-doc-${crypto.randomUUID().slice(0, 8)}@test`);

    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id, reason: "Гостра реакція на стрес після обстрілу" }),
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    const soon = await visitWith(doctor, person.id, 2, "confirmed");
    await visitWith(doctor, person.id, 5, "booked");
    await visitWith(doctor, person.id, 1, "cancelled");
    await visitWith(doctor, person.id, -3, "done");
    await visitWith(doctor, person.id, -1, "no_show");

    await db.insert(dispensary).values({
      patientId: person.id,
      groupLabel: "Д-1",
      intervalMonths: 3,
      nextDueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      addedBy: adminA.id,
    });

    const issue = (destination: string, urgency: string) =>
      api("/api/referrals", adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId: person.id, destination, urgency, reason: "Повід, який у шапку не йде" }),
      });
    const open = await issue("psychiatrist", "urgent");
    expect(open.status).toBe(201);
    const closed = await issue("commander", "routine");
    for (const status of ["accepted", "completed"]) {
      await api(`/api/referrals/${closed.body.id}`, adminA.token, { method: "PATCH", body: JSON.stringify({ status }) });
    }

    const card = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(card.status).toBe(200);
    expect(card.body.episode).toMatchObject({ id: opened.body.id, reason: "Гостра реакція на стрес після обстрілу" });
    expect(card.body.episode.leadName).toContain("Тест");
    expect(Number.isFinite(Date.parse(card.body.episode.openedAt))).toBe(true);

    // ближайшие — только будущие записанные, по времени; отменённый, проведённый и неявка — нет
    const upcoming = card.body.upcoming as { id: string; at: string; kind: string; mode: string; status: string; mine: boolean; specialistName: string }[];
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]).toMatchObject({ id: soon.id, at: soon.startsAt.toISOString(), kind: "repeat", mode: "remote", status: "confirmed", mine: false });
    expect(upcoming[0]!.specialistName).toContain("ws-doc");
    // у ведущего приём специалиста — «мій»
    const asDoctor = await api(`/api/patients/${person.id}/card`, doctor.token);
    expect(asDoctor.status).toBe(200);
    expect((asDoctor.body.upcoming as { mine: boolean }[]).every((v) => v.mine)).toBe(true);

    expect(card.body.dispensary).toMatchObject({ groupLabel: "Д-1", overdue: true });

    // незакрытые направления — без повода: он во вкладке «Направлення»
    expect(card.body.openReferrals).toEqual([
      { id: open.body.id, destination: "psychiatrist", urgency: "urgent", status: "created", createdAt: expect.any(String) },
    ]);

    // чтение карточки — в журнале с пометкой, что повод обращения был показан; «открыл приём» — нет
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "patient.card_read"), eq(auditLog.subjectUserId, person.id), eq(auditLog.actorId, adminA.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(entry?.details).toMatchObject({ episode: true, referrals: 1 });
    const visitOpens = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, "clinic.visit_open"), eq(auditLog.subjectUserId, person.id)));
    expect(visitOpens).toEqual([]);
  });

  test("ничего не открыто — пусто, а не отсутствие полей", async () => {
    const person = await patientOfA("quiet");
    const card = await api(`/api/patients/${person.id}/card`, adminA.token);
    expect(card.status).toBe(200);
    expect(card.body.domains).toEqual([]);
    expect(card.body.episode).toBeNull();
    expect(card.body.upcoming).toEqual([]);
    expect(card.body.dispensary).toBeNull();
    expect(card.body.openReferrals).toEqual([]);
  });
});

describe("GET /api/patients — клинический стан строки", () => {
  test("самая тяжёлая полоса ключевых доменов, ступень от прошлого замера, другие домены в клиническом диапазоне", async () => {
    const person = await patientOfA("state");
    const suicide = await surveyWithShelf("suicide");
    const sleep = await surveyWithShelf("sleep");
    const personality = await surveyWithShelf("personality");
    await measured(sleep, person, "moderate");
    await measured(suicide, person, "moderate");
    await measured(sleep, person, "severe");
    // личностный опросник тяжелее и свежее — но он о складе, а не о нынешнем состоянии
    await measured(personality, person, "severe");

    const res = await api(`/api/patients?q=${encodeURIComponent(person.email)}`, adminA.token);
    expect(res.status).toBe(200);
    const m = res.body.items[0].measure;
    expect(m.surveyId).toBe(sleep);
    expect(m.severity).toBe("severe");
    expect(m.domain).toBe("sleep");
    expect(m.trend).toBe("worse");
    expect(m.values).toHaveLength(2);
    expect(m.also).toEqual(["suicide"]);
  });

  test("при равной тяжести — домен поважнее; без ключевых полос — личностный опросник, а не пусто", async () => {
    const even = await patientOfA("even");
    const suicide = await surveyWithShelf("suicide");
    const sleep = await surveyWithShelf("sleep");
    await measured(suicide, even, "moderate");
    await measured(sleep, even, "moderate");
    const one = await api(`/api/patients?q=${encodeURIComponent(even.email)}`, adminA.token);
    expect(one.body.items[0].measure).toMatchObject({ surveyId: suicide, domain: "suicide", trend: null, also: ["sleep"] });

    const only = await patientOfA("only");
    const personality = await surveyWithShelf("personality");
    await measured(personality, only, "mild");
    const two = await api(`/api/patients?q=${encodeURIComponent(only.email)}`, adminA.token);
    expect(two.body.items[0].measure).toMatchObject({ surveyId: personality, domain: "personality", severity: "mild", also: [] });
  });
});

describe("GET /api/referrals?patient= — направления одного человека", () => {
  test("только его, с поводом и счётчиками; вне зоны — не найдено; журнал называет человека", async () => {
    const person = await patientOfA("refs");
    const other = await patientOfA("refs-other");
    const issue = (userId: string, reason: string) =>
      api("/api/referrals", adminA.token, {
        method: "POST",
        body: JSON.stringify({ userId, destination: "psychiatrist", urgency: "routine", reason }),
      });
    const mine = await issue(person.id, "Повід свого");
    await issue(other.id, "Повід чужого");

    const res = await api(`/api/referrals?patient=${person.id}&all=1`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([mine.body.id]);
    expect(res.body.items[0].reason).toBe("Повід свого");
    expect(res.body.total).toBe(1);
    expect(res.body.counts).toEqual({ created: 1, accepted: 0, completed: 0, declined: 0 });

    expect((await api(`/api/referrals?patient=${person.id}`, adminB.token)).status).toBe(404);
    // суперадмину — тоже только этот человек
    const asRoot = await api(`/api/referrals?patient=${person.id}&all=1`, root.token);
    expect(asRoot.body.items.map((r: { id: string }) => r.id)).toEqual([mine.body.id]);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "referral.list"), eq(auditLog.subjectUserId, person.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(entry?.actorId).toBe(root.id);

    /* направления — в закрытые: реестр adminA общий для всей сюиты */
    await db.update(referrals).set({ status: "declined" }).where(inArray(referrals.userId, [person.id, other.id]));
  });
});
