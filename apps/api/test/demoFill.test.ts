import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { evaluateSubmission, type Answer } from "@quizzy/shared";
import { adminA, db, makeUser, type Person as Staff } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { systemContext } from "../src/db/context";
import {
  alertCases,
  appointments,
  batteryAssignments,
  conclusions,
  departmentPatients,
  departments,
  dispensary,
  episodes,
  messages,
  noteSearch,
  patientNotes,
  referrals,
  responses,
  riskAlerts,
  safetyPlans,
  scheduleTemplates,
  slots,
  specialistProfiles,
  surveyAccess,
  surveys,
  threads,
  users,
} from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";
import { decryptField, encryptField } from "../src/lib/crypto";
import { demoAnswers } from "../src/lib/demoAnswers";
import { DEMO_DOMAIN, DEMO_MIN_WEEKLY_SLOTS, DemoFillRefused, fillDemoData, purgeDemoData, type FillReport } from "../src/lib/demoFill";
import { ARCHETYPE_COUNTS, makePeople } from "../src/lib/demoPeople";
import { storyOf } from "../src/lib/demoStories";
import { syncSlots } from "../src/lib/schedule";
import { getSurvey } from "../src/lib/surveys";

/**
 * Наполнение демонстрационной картотекой (lib/demoFill.ts, demoPeople,
 * demoStories, demoAnswers).
 *
 * Прод судят по этим людям, поэтому проверяется не «завелось сто двадцать»,
 * а то, по чему картотека выглядела бы подделкой: повторы имён, открытый
 * случай риска у каждого второго, сигналы на минуте прогона, записи приёма
 * без приёма, двое на одном слоте, второй прогон, удваивающий историю, и
 * уборка, оставляющая хвосты. Наполнение и уборка идут ролью приложения в
 * системном контексте — как в обслуживании (maintenance → demoFill.ts):
 * политики строк действуют, и пишущее мимо них упало бы здесь, а не на проде.
 */

const N = 120;
const SLOW = 600_000;

let clinicians: Staff[] = [];
/** Специалист с часом приёма в день — первый по почте, но не лечащий */
let sparse: Staff;
/**
 * Кого наполнение возьмёт лечащими — тем же правилом, что loadClinicians:
 * в общей тестовой базе соседние файлы оставляют своих специалистов с
 * сеткой, и деление людей идёт и на них.
 */
let eligible: string[] = [];
let first: FillReport;
let second: FillReport;
let countsAfterFirst: Record<string, number>;
let countsAfterSecond: Record<string, number>;

const demo = sql`(select id from users where email like ${`%@${DEMO_DOMAIN}`})`;

/** Сколько строк вымышленных людей в каждой таблице истории */
async function historyCounts(): Promise<Record<string, number>> {
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const n = sql<number>`count(*)::int`;
  return {
    users: await count(db.select({ n }).from(users).where(like(users.email, `%@${DEMO_DOMAIN}`))),
    responses: await count(db.select({ n }).from(responses).where(sql`${responses.userId} in ${demo}`)),
    alerts: await count(db.select({ n }).from(riskAlerts).where(sql`${riskAlerts.userId} in ${demo}`)),
    cases: await count(db.select({ n }).from(alertCases).where(sql`${alertCases.userId} in ${demo}`)),
    episodes: await count(db.select({ n }).from(episodes).where(sql`${episodes.patientId} in ${demo}`)),
    appointments: await count(db.select({ n }).from(appointments).where(sql`${appointments.patientId} in ${demo}`)),
    notes: await count(db.select({ n }).from(patientNotes).where(sql`${patientNotes.userId} in ${demo}`)),
    noteSearch: await count(db.select({ n }).from(noteSearch).where(sql`${noteSearch.userId} in ${demo}`)),
    conclusions: await count(
      db.select({ n }).from(conclusions).where(sql`${conclusions.responseId} in (select id from responses where user_id in ${demo})`),
    ),
    safetyPlans: await count(db.select({ n }).from(safetyPlans).where(sql`${safetyPlans.userId} in ${demo}`)),
    referrals: await count(db.select({ n }).from(referrals).where(sql`${referrals.userId} in ${demo}`)),
    threads: await count(db.select({ n }).from(threads).where(sql`${threads.patientId} in ${demo}`)),
    messages: await count(db.select({ n }).from(messages).where(sql`${messages.threadId} in (select id from threads where patient_id in ${demo})`)),
    dispensary: await count(db.select({ n }).from(dispensary).where(sql`${dispensary.patientId} in ${demo}`)),
    access: await count(db.select({ n }).from(surveyAccess).where(sql`${surveyAccess.userId} in ${demo}`)),
    batteries: await count(db.select({ n }).from(batteryAssignments).where(sql`${batteryAssignments.userId} in ${demo}`)),
    attached: await count(db.select({ n }).from(departmentPatients).where(sql`${departmentPatients.patientId} in ${demo}`)),
    retroSlots: await count(
      db
        .select({ n })
        .from(slots)
        .where(and(inArray(slots.specialistId, eligible), sql`${slots.createdAt} > ${slots.startsAt} + interval '1 day'`)),
    ),
  };
}

/** Наполнение — ролью приложения в системном контексте, как в обслуживании */
const fillAsApp = (n: number) => asAppRole(() => systemContext(baseDb, () => fillDemoData(n)));
const purgeAsApp = () => asAppRole(() => systemContext(baseDb, () => purgeDemoData()));

beforeAll(async () => {
  await purgeDemoData();
  await installCatalog();

  /* два специалиста с обычной неделей приёма: наполнение делит людей между ними */
  let [department] = await db.select().from(departments).where(isNull(departments.archivedAt)).limit(1);
  if (!department) {
    [department] = await db
      .insert(departments)
      .values({ id: crypto.randomUUID(), title: { uk: "Психологічне відділення", ru: "Психологическое отделение" } })
      .returning();
  }
  const tag = crypto.randomUUID().slice(0, 8);
  /*
   * «0-» в начале почты: наполнение берёт специалистов по алфавиту почты, и
   * эти трое — первые. Самый первый принимает час в день: лечащим он стать не
   * должен — на четверть картотеки слотов у него нет, и приёмы с замерами
   * выпали бы из историй (так и было, пока соседние файлы оставляли такие
   * учётки в общей базе).
   */
  for (const [who, hours] of [
    ["0", [["09:00", "10:00"]]],
    ["a", [["09:00", "12:00"], ["14:00", "17:00"]]],
    ["b", [["09:00", "12:00"], ["14:00", "17:00"]]],
  ] as const) {
    const staff = await makeUser("admin", `0-dpe-${tag}-${who}@test.dev`);
    await db.insert(specialistProfiles).values({ userId: staff.id, departmentId: department!.id, room: "214" });
    for (const weekday of who === "0" ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5]) {
      for (const [startsAt, endsAt] of hours) {
        await db.insert(scheduleTemplates).values({ id: crypto.randomUUID(), specialistId: staff.id, weekday, startsAt, endsAt, slotMinutes: 50 });
      }
    }
    await syncSlots(staff.id);
    if (who === "0") sparse = staff;
    clinicians.push(staff);
  }
  eligible = (
    await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(specialistProfiles, eq(specialistProfiles.userId, users.id))
      .where(
        and(
          isNull(users.disabledAt),
          eq(specialistProfiles.acceptsBookings, true),
          sql`exists (select 1 from slots s where s.specialist_id = ${users.id} and s.status = 'open' and s.starts_at > now())`,
          sql`(select coalesce(sum(floor(extract(epoch from (t.ends_at - t.starts_at)) / 60 / t.slot_minutes)), 0) from schedule_templates t where t.specialist_id = ${users.id}) >= ${DEMO_MIN_WEEKLY_SLOTS}`,
        ),
      )
      .orderBy(users.email)
      .limit(4)
  ).map((r) => r.id);

  first = await fillAsApp(N);
  countsAfterFirst = await historyCounts();
  second = await fillAsApp(N);
  countsAfterSecond = await historyCounts();
}, SLOW);

afterAll(async () => {
  await purgeDemoData();
  /* специалисты этого файла со своей сеткой не должны попадать в выборки соседних файлов */
  const ids = clinicians.map((c) => c.id);
  if (!ids.length) return;
  await db.delete(slots).where(inArray(slots.specialistId, ids));
  await db.delete(users).where(inArray(users.id, ids));
}, SLOW);

describe("люди", () => {
  test("картотека детерминирована, и первые k людей одни и те же при любом n", () => {
    const today = new Date("2026-10-28T10:00:00Z");
    expect(makePeople(N, today)).toEqual(makePeople(N, today));
    expect(makePeople(60, today)).toEqual(makePeople(N, today).slice(0, 60));
    // история — от номера, а не от часов
    const p = makePeople(N, today)[17]!;
    expect(JSON.stringify(storyOf(p))).toBe(JSON.stringify(storyOf(p)));
  });

  test("имена неповторимы и на пятистах; отчество — по полу, возраст — служивый", () => {
    const people = makePeople(500);
    const names = people.map((p) => `${p.lastName} ${p.firstName} ${p.middleName}`);
    expect(new Set(names).size).toBe(500);
    // на ста двадцати и фамилии не повторяются: однофамильцы в одной картотеке путают
    expect(new Set(people.slice(0, N).map((p) => p.lastName)).size).toBe(N);
    for (const p of people) {
      expect(p.middleName.endsWith(p.sex === "male" ? "ич" : "на"), `${p.slug}: ${p.middleName}`).toBe(true);
      const age = new Date().getUTCFullYear() - Number(p.birthDate.slice(0, 4));
      expect(age, p.slug).toBeGreaterThanOrEqual(19);
      expect(age, p.slug).toBeLessThanOrEqual(63);
    }
  });

  test("на ста двадцати — ровно таблица портретов", () => {
    const tally: Record<string, number> = {};
    for (const p of makePeople(N)) tally[p.archetype] = (tally[p.archetype] ?? 0) + 1;
    expect(tally).toEqual(ARCHETYPE_COUNTS);
  });

  test("в базе — те же люди: ФИО расшифровываются, подразделения воинские, а не отделения госпиталя", async () => {
    const rows = await db
      .select({ email: users.email, last: users.lastName, firstName: users.firstName, middle: users.middleName, unit: users.unit, lead: users.leadSpecialistId })
      .from(users)
      .where(like(users.email, `demo-%@${DEMO_DOMAIN}`));
    const patients = rows.filter((r) => /^demo-\d{3}@/.test(r.email));
    expect(patients.length).toBe(N);
    const full = patients.map((r) => `${decryptField(r.last)} ${decryptField(r.firstName)} ${decryptField(r.middle)}`);
    expect(new Set(full).size).toBe(N);
    // фамилия зашифрована, а не лежит открытым текстом
    expect(patients.every((r) => r.last !== decryptField(r.last))).toBe(true);
    for (const unit of ["Лабораторія", "Адміністрація", "Приймальне відділення", "Терапевтичне відділення"]) {
      expect(patients.some((r) => r.unit === unit), unit).toBe(false);
    }
    // лечащий — у каждого, и это специалист с расписанием на неделю; люди поделены между всеми такими
    const leads = new Set(patients.map((r) => r.lead));
    expect([...leads].every((id) => id && eligible.includes(id))).toBe(true);
    expect(leads.size).toBe(eligible.length);
    for (const c of clinicians) expect(leads.has(c.id), c === sparse ? "час приёма в день" : c.id).toBe(c !== sparse);
  });
});

describe("ответы под историю", () => {
  test(
    "замеры историй попадают в цели по шкалам, и критический вариант — только там, где его задал сюжет",
    async () => {
      const keys = new Map(
        (await db.select({ id: surveys.id, key: surveys.catalogKey }).from(surveys).where(isNotNull(surveys.catalogKey))).map((s) => [s.key!, s.id]),
      );
      const cache = new Map<string, Awaited<ReturnType<typeof getSurvey>>>();
      let checked = 0;
      for (const p of makePeople(N)) {
        const story = storyOf(p);
        const all = [
          ...story.visits.flatMap((v) => v.measures),
          ...story.home.flatMap((h) => h.measures),
          ...(story.psychiatry ?? []).flatMap((e) => e.measures),
        ];
        for (const [i, m] of all.entries()) {
          const id = keys.get(m.key);
          expect(id, m.key).toBeDefined();
          if (!cache.has(m.key)) cache.set(m.key, await getSurvey(id!, null, "uk"));
          const survey = cache.get(m.key)!;
          const answers = demoAnswers(survey!, { ...m, seed: p.ordinal * 1000 + i });
          const evaluation = evaluateSubmission(survey!, answers as Answer[], { sex: p.sex, age: 35 });
          // сервер отбросил бы ответ на скрытый пункт — его быть не должно
          expect(evaluation.hidden, `${p.slug} ${m.key}`).toEqual([]);
          for (const [code, target] of Object.entries(m.targets)) {
            const score = evaluation.profile.scores.find((s) => s.scaleCode === code);
            expect(score, `${p.slug} ${m.key}.${code}`).toBeDefined();
            const scale = survey!.scales.find((s) => s.code === code)!;
            // среднее (BAT-12) — с точностью до шага одного пункта, сумма — точно или ближайший достижимый балл
            const tolerance = scale.aggregation === "average" ? 1 / scale.items.length + 1e-9 : 1;
            expect(Math.abs(score!.value - target), `${p.slug} ${m.key}.${code}: ${score!.value} ≠ ${target}`).toBeLessThanOrEqual(tolerance);
          }
          if (!m.allowRisk) {
            const fixed = new Set(Object.keys(m.fixed ?? {}).map(Number));
            const flagged = evaluation.risk.answers.filter((a) => !fixed.has(survey!.questions.findIndex((q) => q.id === a.questionId) + 1));
            expect(flagged, `${p.slug} ${m.key}`).toEqual([]);
          }
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(700);
    },
    SLOW,
  );
});

describe("история в базе", () => {
  test("заведено сто двадцать человек с историей; отчёт сходится с базой", () => {
    expect(first.created).toBe(N);
    expect(first.existing).toBe(0);
    expect(countsAfterFirst.responses).toBe(first.responses);
    expect(countsAfterFirst.notes).toBe(first.notes);
    expect(countsAfterFirst.conclusions).toBe(first.conclusions);
    expect(countsAfterFirst.episodes).toBe(N);
    // заключение — примерно у трети: подписанный документ, а не у каждого
    expect(first.conclusions).toBeGreaterThanOrEqual(30);
    expect(first.conclusions).toBeLessThanOrEqual(48);
  });

  test("риск: открыт у 5–8 % людей, у каждого случая есть ответственный, разобранный — с исходом и разобравшим", async () => {
    const cases = await db.select().from(alertCases).where(sql`${alertCases.userId} in ${demo}`);
    const open = new Set(cases.filter((c) => !c.acknowledgedAt).map((c) => c.userId));
    // отчёт считает случаи, а не замеры: второй замер в том же окне продлевает случай, а не заводит ещё один
    expect(first.openCases).toBe(cases.filter((c) => !c.acknowledgedAt).length);
    expect(first.closedCases).toBe(cases.filter((c) => c.acknowledgedAt).length);
    expect(open.size).toBeGreaterThanOrEqual(Math.floor(N * 0.05));
    expect(open.size).toBeLessThanOrEqual(Math.ceil(N * 0.08));
    expect(cases.every((c) => c.assignedTo !== null)).toBe(true);
    const closed = cases.filter((c) => c.acknowledgedAt);
    expect(closed.length).toBeGreaterThan(0);
    for (const c of closed) {
      expect(c.outcome, c.id).not.toBeNull();
      expect(c.acknowledgedBy, c.id).not.toBeNull();
      expect(Date.parse(c.acknowledgedAt!), c.id).toBeGreaterThanOrEqual(Date.parse(c.lastAlertAt));
    }
  });

  test("неразобранное — только свежая домашняя сдача; поднятое на приёме разобрано на приёме", async () => {
    const rows = await db
      .select({ caseId: alertCases.id, userId: alertCases.userId, last: alertCases.lastAlertAt, ack: alertCases.acknowledgedAt, source: responses.source })
      .from(alertCases)
      .innerJoin(riskAlerts, eq(riskAlerts.caseId, alertCases.id))
      .innerJoin(responses, eq(responses.id, riskAlerts.responseId))
      .where(sql`${alertCases.userId} in ${demo}`);
    const open = rows.filter((x) => !x.ack);
    expect(open.length).toBeGreaterThan(0);
    for (const o of open) {
      // шкалу врача заполняет специалист на приёме — такой случай открытым не остаётся
      expect(o.source, o.caseId).not.toBe("clinician");
      // сдано вчера вечером или сегодня, а не позавчера
      expect(Date.now() - Date.parse(o.last), o.caseId).toBeLessThan(36 * 3_600_000);
      // и с тех пор человек на приёме не был: иначе разобрали бы там
      const seen = await db
        .select({ id: appointments.id })
        .from(appointments)
        .innerJoin(slots, eq(slots.id, appointments.slotId))
        .where(and(eq(appointments.patientId, o.userId), eq(appointments.status, "done"), sql`${slots.startsAt} > ${o.last}`))
        .limit(1);
      expect(seen.length, o.caseId).toBe(0);
    }
    // случай со шкалой врача (C-SSRS, CIWA-Ar, осмотр психиатра) разобран в тот же день, а не через сутки
    for (const x of rows.filter((x) => x.source === "clinician")) {
      expect(x.ack, x.caseId).not.toBeNull();
      expect(Date.parse(x.ack!) - Date.parse(x.last), x.caseId).toBeLessThan(8 * 3_600_000);
    }
  });

  test("сигналы датированы сдачей, которая их подняла, и не повторяются в пределах прохождения", async () => {
    const rows = await db
      .select({ at: riskAlerts.at, submitted: responses.submittedAt, caseId: riskAlerts.caseId, ack: riskAlerts.acknowledgedAt, caseAck: alertCases.acknowledgedAt })
      .from(riskAlerts)
      .innerJoin(responses, eq(responses.id, riskAlerts.responseId))
      .innerJoin(alertCases, eq(alertCases.id, riskAlerts.caseId))
      .where(sql`${riskAlerts.userId} in ${demo}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Date.parse(r.at)).toBe(Date.parse(r.submitted!));
    // прохождение старше суток не может нести сигнал «на минуте прогона»
    const spread = new Set(rows.map((r) => r.at.slice(0, 10)));
    expect(spread.size).toBeGreaterThan(30);
    // сигнал разобран тем же решением, что и его случай
    for (const r of rows) expect(r.ack === null).toBe(r.caseAck === null);
    const dupes = await db.execute(sql`
      select response_id, coalesce(question_id, scale_id) as rule, count(*)::int as n from risk_alerts
      where user_id in ${demo} group by 1, 2 having count(*) > 1`);
    expect(dupes.length).toBe(0);
  });

  test("обращение: повод расшифровывается, лечащий — специалист с расписанием на неделю; закрытое — с исходом", async () => {
    const rows = await db.select().from(episodes).where(sql`${episodes.patientId} in ${demo}`);
    expect(rows.length).toBe(N);
    for (const c of clinicians) {
      if (c === sparse) expect(eligible).not.toContain(c.id);
      else expect(eligible).toContain(c.id);
    }
    for (const e of rows) {
      expect((decryptField(e.reasonEnc) ?? "").length, e.id).toBeGreaterThan(10);
      expect(eligible, e.id).toContain(e.leadSpecialistId!);
      expect(Date.parse(e.openedAt)).toBeLessThan(Date.now());
      if (e.closedAt) {
        expect(e.outcomeKind, e.id).not.toBeNull();
        expect((decryptField(e.outcomeEnc) ?? "").length, e.id).toBeGreaterThan(10);
      }
    }
    expect(rows.some((e) => e.closedAt)).toBe(true);
    expect(rows.some((e) => !e.closedAt)).toBe(true);
  });

  test("приёмы: прошедшие — состоялись, неявка или отмена; записи приёма — к состоявшимся приёмам того же человека", async () => {
    const visits = await db
      .select({ id: appointments.id, patientId: appointments.patientId, status: appointments.status, startsAt: slots.startsAt, endsAt: slots.endsAt })
      .from(appointments)
      .innerJoin(slots, eq(slots.id, appointments.slotId))
      .where(sql`${appointments.patientId} in ${demo}`);
    const now = Date.now();
    for (const v of visits) {
      const startsAt = Date.parse(v.startsAt);
      if (Date.parse(v.endsAt) < now - 3 * 3_600_000) expect(["done", "no_show", "cancelled"], v.id).toContain(v.status);
      // за четверть часа до начала человек уже может ждать у кабинета — смотря в котором часу прогон
      if (startsAt > now) expect(startsAt - 15 * 60_000 <= now ? ["booked", "confirmed", "arrived"] : ["booked", "confirmed"], v.id).toContain(v.status);
    }
    const noShows = visits.filter((v) => v.status === "no_show").length;
    expect(noShows).toBeGreaterThan(5);

    const notes = await db
      .select({ note: patientNotes, visit: appointments })
      .from(patientNotes)
      .leftJoin(appointments, eq(appointments.id, patientNotes.appointmentId))
      .where(sql`${patientNotes.userId} in ${demo}`);
    expect(notes.length).toBeGreaterThan(N * 3);
    for (const { note, visit } of notes) {
      // без приёма — только консультация психиатра (проверена отдельно)
      if (note.appointmentId === null) {
        expect(note.kind, note.id).toBe("consult");
        continue;
      }
      expect(visit, note.id).not.toBeNull();
      expect(visit!.patientId).toBe(note.userId);
      expect(["done", "in_progress"], note.id).toContain(visit!.status);
      expect((decryptField(note.text) ?? "").length, note.id).toBeGreaterThan(20);
    }
    // записи подписаны, кроме единичных черновиков вчерашних приёмов
    expect(notes.filter((n) => n.note.status === "signed").length).toBeGreaterThan(notes.length * 0.95);
  });

  test("осмотр психиатра: шкалы врача заполнены специалистом, консультацию подписал психиатр, а не лечащий психолог", async () => {
    const clinicianKeys = ["hamd17", "hama", "cgi_s", "cgi_i", "bprs"];
    const rows = await db
      .select({ key: surveys.catalogKey, source: responses.source })
      .from(responses)
      .innerJoin(surveys, eq(surveys.id, responses.surveyId))
      .where(and(sql`${responses.userId} in ${demo}`, inArray(surveys.catalogKey, clinicianKeys)));
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.source === "clinician")).toBe(true);
    const [psychiatrist] = await db.select().from(users).where(eq(users.email, `demo-psychiatrist@${DEMO_DOMAIN}`));
    expect(psychiatrist).toBeDefined();
    // у психиатра нет расписания: он смотрит по направлению и не становится лечащим
    expect(eligible).not.toContain(psychiatrist!.id);
    const consults = await db
      .select()
      .from(patientNotes)
      .where(and(eq(patientNotes.createdBy, psychiatrist!.id), sql`${patientNotes.userId} in ${demo}`));
    expect(consults.length).toBeGreaterThan(10);
    for (const n of consults) {
      expect(n.kind).toBe("consult");
      expect(n.appointmentId).toBeNull();
      expect(n.status).toBe("signed");
      expect(decryptField(n.text)).toContain("лікаря-психіатра");
    }
  });

  test("ни один слот не занят дважды", async () => {
    const twice = await db.execute(sql`
      select a.slot_id, count(*)::int as n from appointments a
      where a.status <> 'cancelled' and a.slot_id in (select slot_id from appointments where patient_id in ${demo})
      group by a.slot_id having count(*) > 1`);
    expect(twice.length).toBe(0);
  });

  test("планы безопасности — у тех, кто был в риске, и последняя версия действует", async () => {
    const plans = await db.select().from(safetyPlans).where(sql`${safetyPlans.userId} in ${demo}`);
    expect(plans.length).toBeGreaterThan(0);
    const byUser = new Map<string, typeof plans>();
    for (const p of plans) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
    for (const [userId, list] of byUser) {
      const latest = list.reduce((a, b) => (a.version > b.version ? a : b));
      expect(list.filter((p) => p.active).map((p) => p.id), userId).toEqual([latest.id]);
      const alerted = await db.select({ id: riskAlerts.id }).from(riskAlerts).where(and(eq(riskAlerts.userId, userId), isNotNull(riskAlerts.questionId))).limit(1);
      expect(alerted.length, `план без критического ответа у ${userId}`).toBe(1);
    }
  });
});

describe("повторный прогон", () => {
  test("ничего не добавляет: та же редакция пропускается целиком", () => {
    expect(second.created).toBe(0);
    expect(second.existing).toBe(N);
    expect(second.responses).toBe(0);
    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });
});

describe("уборка", () => {
  test(
    "убирает всё вымышленное, включая подписанные записи и достроенные слоты; настоящие специалисты и их сетка остаются",
    async () => {
      const futureSlots = async () =>
        Number(
          (
            await db
              .select({ n: sql<number>`count(*)::int` })
              .from(slots)
              .where(and(inArray(slots.specialistId, eligible), sql`${slots.startsAt} > now()`))
          )[0]?.n ?? 0,
        );
      const before = await futureSlots();
      const removed = await purgeAsApp();
      expect(removed).toBeGreaterThanOrEqual(N);
      const left = await historyCounts();
      for (const [table, n] of Object.entries(left)) expect(n, table).toBe(0);
      expect(await futureSlots()).toBe(before);
      for (const c of clinicians) expect(await db.query.users.findFirst({ where: eq(users.id, c.id) })).toBeDefined();
    },
    SLOW,
  );

  test("подписанная запись приёма настоящего человека не удаляется и в режиме уборки", async () => {
    const real = await makeUser("user", `dpe-real-${crypto.randomUUID().slice(0, 8)}@test.dev`);
    const noteId = crypto.randomUUID();
    await db.insert(patientNotes).values({
      id: noteId,
      userId: real.id,
      version: 1,
      text: encryptField("підписаний запис")!,
      status: "signed",
      signedAt: new Date().toISOString(),
      // автор — сотрудник фикстур, а не специалист этого файла: подписанное держит автора навсегда (RESTRICT)
      signedBy: adminA.id,
      createdBy: adminA.id,
    });
    const attempt = baseDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.demo_purge', '1', true), set_config('app.maintenance', '1', true)`);
      await tx.execute(sql`delete from patient_notes where id = ${noteId}`);
    });
    await expect(attempt).rejects.toThrow(/неизменяема/);
    expect(await db.query.patientNotes.findFirst({ where: eq(patientNotes.id, noteId) })).toBeDefined();
  });

  test("картотеку другой редакции наполнение не дописывает: отказ, ничего не изменено", async () => {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email: `demo-001@${DEMO_DOMAIN}`,
      firstName: encryptField("Марія")!,
      lastName: encryptField("Мельник")!,
      passwordHash: "x".repeat(60),
      role: "user",
    } as never);
    const refused = await fillAsApp(N).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DemoFillRefused);
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(like(users.email, `%@${DEMO_DOMAIN}`))) as [{ n: number }];
    expect(n).toBe(1);
    await db.delete(users).where(eq(users.id, id));
  });
});
