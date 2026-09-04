import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../db";
import {
  appointments,
  departmentPatients,
  departments,
  episodes,
  responses,
  slots,
  specialistProfiles,
  surveys,
  users,
} from "../db/schema";
import { hashPassword } from "./auth";
import { encryptField, encryptPersonFields } from "./crypto";
import { normalizePhone, phoneFingerprint } from "./phone";
import { log } from "./log";
import { getSurvey } from "./surveys";
import { persistSubmission } from "./submission";
import { demoAnswers } from "./demoAnswers";
import { latentAt, makePeople, rng, type Person } from "./demoPeople";

/**
 * Наполнение экземпляра вымышленными людьми и их обследованиями.
 *
 * Запускается руками, никогда — выкатом. Наполнять живую картотеку сама
 * система не должна: то, что заводится по команде человека, он и уберёт по
 * команде, а то, что заводится само, однажды заведётся там, где не надо.
 *
 * Опознавательный признак — почта на домене `demo.local`. Домен
 * зарезервирован стандартом и не может существовать: письмо на него не
 * уйдёт, войти под ним снаружи никто не сможет, а найти и убрать всех разом
 * можно одним условием. Смешать вымышленных с настоящими в психиатрическом
 * учреждении означало бы, что кто-то однажды позвонит по несуществующему
 * случаю — или, наоборот, примет настоящую тревогу за посев.
 *
 * Прохождения идут через тот же `persistSubmission`, что и живые: считаются
 * шкалы, срабатывают тревоги, заводятся случаи, копится динамика. Вставлять
 * готовые баллы напрямую значило бы наполнить систему данными, которых она
 * сама произвести не может, — и не заметить, если она их производить
 * перестанет.
 */

export const DEMO_DOMAIN = "demo.local";
const DEMO_PASSWORD = "demo-only-not-a-secret";

export interface FillReport {
  created: number;
  existing: number;
  responses: number;
  appointments: number;
  episodes: number;
}

/** Сколько недель назад делался замер номер step из steps */
function weeksAgo(step: number, steps: number): number {
  // последний замер — на этой неделе, первый — примерно полгода назад
  const span = 24;
  return Math.round(span - (span * step) / Math.max(1, steps - 1));
}

async function ensurePerson(p: Person): Promise<{ id: string; created: boolean }> {
  const email = `${p.slug}@${DEMO_DOMAIN}`;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return { id: existing.id, created: false };

  const id = crypto.randomUUID();
  /*
   * Зерно берётся из НОМЕРА человека, а не из длины его кода.
   *
   * Стояло `p.slug.length * 31 + p.birthYear`, а длина кода у всех
   * одинаковая — «demo-001» и «demo-120» по восемь знаков. Зерно зависело
   * только от года рождения, и у ровесников совпадали телефоны: слепой
   * индекс уникален по построению, и посев падал на первой же паре. Ошибка
   * ровно того рода, ради которой этот индекс и заведён, — он поймал
   * дубликат, которого не должно быть.
   */
  const ordinal = Number(p.slug.replace(/\D/g, "")) || 1;
  const r = rng(ordinal * 7907 + p.birthYear);
  const phone = `+380${String(500000000 + ordinal * 4093 + Math.floor(r() * 4000))}`;
  await db.insert(users).values({
    id,
    email,
    ...encryptPersonFields({
      firstName: p.firstName,
      lastName: p.lastName,
      middleName: p.middleName,
    }),
    phoneEnc: encryptField(phone),
    phoneIndex: phoneFingerprint(normalizePhone(phone)!),
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: "user",
    sex: p.sex,
    birthDate: `${p.birthYear}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`,
    unit: p.unit,
  } as never);
  return { id, created: true };
}

export async function fillDemoData(count: number): Promise<FillReport> {
  const catalog = await db
    .select({ id: surveys.id, key: surveys.catalogKey })
    .from(surveys)
    .where(sql`${surveys.catalogKey} is not null and ${surveys.status} = 'published'`);
  if (!catalog.length) {
    throw new Error("Каталог методик не установлен: сначала installCatalog.ts");
  }

  const [department] = await db.select().from(departments).limit(1);
  /*
   * Специалист берётся тот, у КОГО ЕСТЬ РАСПИСАНИЕ, а не первый попавшийся
   * сотрудник. Первым в таблице обычно оказывается технический
   * администратор: слотов у него нет, и записывать на приём было бы некуда —
   * ровно это и вышло на первом прогоне, приёмов завелось ноль.
   */
  const [specialist] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(specialistProfiles, eq(specialistProfiles.userId, users.id))
    .where(sql`exists (select 1 from slots s where s.specialist_id = ${users.id})`)
    .limit(1);

  const people = makePeople(count);
  const report: FillReport = { created: 0, existing: 0, responses: 0, appointments: 0, episodes: 0 };

  for (const p of people) {
    const { id: userId, created } = await ensurePerson(p);
    if (created) report.created += 1;
    else {
      report.existing += 1;
      continue; // человек уже заведён — его обследования тоже
    }

    /*
     * Не все проходят всё. Человек, прошедший восемь опросников подряд,
     * бывает раз в год; обычная картотека — это два-три инструмента у
     * большинства и полный набор у единиц.
     */
    const r = rng(p.birthYear * 13 + p.slug.length);
    const chosen = catalog.filter((c) => {
      if (c.key === "gad7" || c.key === "phq9") return true;
      if (c.key === "who5") return r() < 0.7;
      if (c.key === "pss10") return r() < 0.5;
      if (c.key === "pcl5") return p.latent.ptsd > 0.3 || r() < 0.2;
      if (c.key === "audit") return p.latent.alcohol > 0.4 || r() < 0.25;
      if (c.key === "pq16") return p.latent.unusual > 0.35 || r() < 0.15;
      if (c.key === "big-five") return r() < 0.3;
      return false;
    });

    for (let step = 0; step < p.visits; step++) {
      const state = latentAt(p, step, p.visits);
      const back = weeksAgo(step, p.visits);
      const when = new Date(Date.now() - back * 7 * 86_400_000);
      // приём в рабочее время: обследование в три часа ночи выглядит подделкой
      when.setHours(9 + Math.floor(r() * 8), Math.floor(r() * 60), 0, 0);

      for (const c of chosen) {
        /*
         * Большая пятёрка меряется один раз: черты личности не меняются от
         * месяца к месяцу, и повторный замер рисовал бы динамику там, где
         * динамики нет.
         */
        if (c.key === "big-five" && step > 0) continue;

        const survey = await getSurvey(c.id, null, "uk");
        if (!survey) continue;
        const answers = demoAnswers(survey, c.key!, state, p.birthYear + step * 977 + c.key!.length);
        if (!answers.length) continue;

        const duration = answers.reduce((s, a) => s + a.durationMs, 0);
        const result = await persistSubmission(
          survey,
          { id: userId, sex: p.sex, birthDate: `${p.birthYear}-01-01` },
          {
            answers: answers as never,
            startedAt: new Date(when.getTime() - duration).toISOString(),
            durationMs: duration,
            status: "completed",
            events: [],
          },
          { filledBySelf: true, lang: "uk", source: "self" },
        );

        /*
         * Дата сдвигается ПОСЛЕ записи, а не подставляется в неё.
         *
         * persistSubmission ставит «сейчас» — и правильно делает: время
         * сдачи не должно приходить снаружи, иначе его можно подделать. Для
         * посева же нужна история: без разнесённых по месяцам замеров
         * динамика — одна точка, а график по одной точке не рисуется.
         */
        await db
          .update(responses)
          .set({ submittedAt: when.toISOString() })
          .where(eq(responses.id, result.responseId));
        report.responses += 1;
      }
    }

    // приёмы и обращение — только там, где есть отделение и специалист
    if (department && specialist) {
      await db
        .insert(departmentPatients)
        .values({ departmentId: department.id, patientId: userId, attachedVia: "staff" })
        .onConflictDoNothing();

      if (r() < 0.55) {
        const opened = new Date(Date.now() - (30 + Math.floor(r() * 120)) * 86_400_000);
        const closes = p.trend === "improving" && r() < 0.6;
        await db.insert(episodes).values({
          id: crypto.randomUUID(),
          patientId: userId,
          leadSpecialistId: specialist.id,
          openedAt: opened.toISOString(),
          reasonEnc: encryptField(p.reason),
          ...(closes
            ? {
                closedAt: new Date(opened.getTime() + 60 * 86_400_000).toISOString(),
                outcomeKind: "improved" as const,
                outcomeEnc: encryptField("Стан покращився, спостереження завершено"),
              }
            : {}),
        });
        report.episodes += 1;
      }
    }
  }

  // приёмы раздаются в конце: свободные слоты надо делить между всеми
  if (department && specialist) {
    report.appointments = await bookDemoAppointments(specialist.id);
  }

  log.info("demo.filled", { ...report });
  return report;
}

/**
 * Записать вымышленных людей на свободное время.
 *
 * Часть приёмов в прошлом и уже состоялась, часть впереди. Экран дня и
 * очередь работы без этого показывают пустоту, а неявки и подтверждения
 * проверить не на чем.
 */
async function bookDemoAppointments(specialistId: string): Promise<number> {
  const demo = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${DEMO_DOMAIN}`));
  if (!demo.length) return 0;

  const free = await db
    .select()
    .from(slots)
    .where(
      and(
        eq(slots.specialistId, specialistId),
        sql`${slots.startsAt} > now() - interval '60 days'`,
        sql`${slots.startsAt} < now() + interval '21 days'`,
        sql`not exists (select 1 from appointments a where a.slot_id = ${slots.id} and a.status <> 'cancelled')`,
      ),
    )
    .orderBy(slots.startsAt)
    .limit(140);

  let n = 0;
  const r = rng(4242);
  for (const slot of free) {
    const person = demo[Math.floor(r() * demo.length)]!;
    const past = new Date(slot.startsAt).getTime() < Date.now();
    /*
     * У прошедших приёмов разные исходы, и неявок примерно одна из семи:
     * столько их и бывает. Картотека без неявок не даёт проверить ни очередь
     * работы, ни пометку о повторном пропуске.
     */
    const status = past ? (r() < 0.14 ? "no_show" : "done") : r() < 0.5 ? "confirmed" : "booked";
    await db
      .insert(appointments)
      .values({
        id: crypto.randomUUID(),
        slotId: slot.id,
        patientId: person.id,
        specialistId,
        status,
        bookedBy: person.id,
        ...(status === "done" ? { arrivedAt: slot.startsAt, finishedAt: slot.endsAt } : {}),
        ...(status === "confirmed" ? { confirmedAt: new Date().toISOString() } : {}),
      })
      .onConflictDoNothing();
    n += 1;
  }
  return n;
}

/**
 * Убрать всех вымышленных.
 *
 * Одним условием по домену почты. Всё, что к ним привязано — прохождения,
 * тревоги, случаи, приёмы, обращения, — уходит каскадом по внешним ключам:
 * это и есть причина, по которой их можно заводить в живой системе, не боясь
 * оставить хвосты.
 */
export async function purgeDemoData(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${DEMO_DOMAIN}`));
  if (!rows.length) return 0;
  await db.delete(users).where(
    inArray(
      users.id,
      rows.map((x) => x.id),
    ),
  );
  log.info("demo.purged", { removed: rows.length });
  return rows.length;
}
