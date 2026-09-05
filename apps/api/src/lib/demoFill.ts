import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../db";
import {
  appointments,
  batteries,
  batteryAssignments,
  batteryItems,
  departmentPatients,
  departments,
  dispensary,
  episodes,
  messages,
  referrals,
  responses,
  roles,
  scheduleTemplates,
  slots,
  specialistProfiles,
  staffRoles,
  surveyAccess,
  surveyGroups,
  surveys,
  threads,
  users,
} from "../db/schema";
import { hashPassword } from "./auth";
import { encryptField, encryptPersonFields } from "./crypto";
import { normalizePhone, phoneFingerprint } from "./phone";
import { log } from "./log";
import { FOLLOWUP_NOTE } from "./followup";
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
  assignments: number;
  referrals: number;
  threads: number;
  dispensary: number;
  ladder: number;
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

/**
 * Вымышленный специалист с обычной неделей приёма.
 *
 * Без него наполнение показывает только измерения: экран дня, расписание и
 * очередь приёмов остаются пустыми, потому что принимать некому. Заводится
 * только если ни у кого ещё нет расписания — на работающем экземпляре
 * специалисты настоящие, и подставлять к ним вымышленного незачем.
 *
 * Помечен тем же доменом, что и остальные вымышленные, и убирается той же
 * командой: учётная запись персонала, оставшаяся после демонстрации, — это
 * рабочий доступ в систему с медицинскими данными.
 */
async function ensureDemoSpecialist(departmentId: string): Promise<string | null> {
  const [withSlots] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(specialistProfiles, eq(specialistProfiles.userId, users.id))
    .where(sql`exists (select 1 from slots s where s.specialist_id = ${users.id})`)
    .limit(1);
  if (withSlots) return withSlots.id;

  const email = `demo-specialist@${DEMO_DOMAIN}`;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await db.insert(users).values({
      id,
      email,
      ...encryptPersonFields({
        firstName: "Олена",
        lastName: "Демченко",
        middleName: "Петрівна",
      }),
      passwordHash: await hashPassword(DEMO_PASSWORD),
      role: "admin",
      sex: "female",
    } as never);
    const { ensureBuiltinRole } = await import("./permissions");
    await ensureBuiltinRole(id);
  }

  await db
    .insert(specialistProfiles)
    .values({ userId: id, departmentId, room: "212" })
    .onConflictDoNothing();

  // будни с перерывом: обычная неделя, по которой строится сетка слотов
  for (const weekday of [1, 2, 3, 4, 5]) {
    for (const [startsAt, endsAt] of [
      ["09:00", "13:00"] as const,
      ["14:00", "17:00"] as const,
    ]) {
      await db
        .insert(scheduleTemplates)
        .values({ id: crypto.randomUUID(), specialistId: id, weekday, startsAt, endsAt, slotMinutes: 50 })
        .onConflictDoNothing();
    }
  }
  const { syncSlots } = await import("./schedule");
  await syncSlots(id);
  return id;
}

/**
 * Обращение у человека, если его ещё нет.
 *
 * Проверяется по факту, а не по «только что завели»: наполнение должно
 * уметь дополнять уже существующую картотеку — иначе каждое новое умение
 * системы требовало бы стереть всё и начать сначала.
 */
async function ensureEpisode(p: Person, userId: string, specialistId: string): Promise<boolean> {
  const [has] = await db.select().from(episodes).where(eq(episodes.patientId, userId)).limit(1);
  if (has) return false;

  const r = rng(p.birthYear * 31 + p.slug.length * 7);
  // не у всех: обращение заводят, когда человека ведут, а не при первом замере
  if (r() > 0.55) return false;

  const opened = new Date(Date.now() - (30 + Math.floor(r() * 120)) * 86_400_000);
  const closes = p.trend === "improving" && r() < 0.6;
  await db.insert(episodes).values({
    id: crypto.randomUUID(),
    patientId: userId,
    leadSpecialistId: specialistId,
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
  return true;
}

/**
 * Личное назначение методики со сроком.
 *
 * Без него в картотеке не видно разницы между «можно пройти» и «от вас
 * ждут»: у всех методик стоял бы один вид, просроченных назначений не
 * возникало бы вовсе, и очередь работы оставалась бы пустой в той её части,
 * ради которой она заведена. Часть сроков ставится в прошлое намеренно —
 * просрочка это то, что специалист должен видеть.
 */
async function ensureAssignment(
  p: Person,
  userId: string,
  specialistId: string,
  surveyId: string,
): Promise<boolean> {
  const [has] = await db
    .select()
    .from(surveyAccess)
    .where(and(eq(surveyAccess.userId, userId), eq(surveyAccess.surveyId, surveyId)))
    .limit(1);
  if (has) return false;

  const r = rng(p.birthYear * 17 + p.slug.length * 3 + surveyId.length);
  if (r() > 0.4) return false;

  // треть назначений просрочена: без просроченных очередь работы пуста
  const overdue = r() < 0.33;
  const dueAt = new Date(Date.now() + (overdue ? -1 : 1) * (2 + Math.floor(r() * 12)) * 86_400_000);
  await db
    .insert(surveyAccess)
    .values({
      surveyId,
      userId,
      grantedBy: specialistId,
      expiresAt: dueAt.toISOString(),
      note: `${FOLLOWUP_NOTE}: повтор через 14 дн.`,
    })
    .onConflictDoNothing();
  return true;
}

/**
 * Лестница должностей: главный врач, заведующий, специалист.
 *
 * Без неё экран прав показывает одну встроенную роль и никого, кому её можно
 * выдать: цепочка назначения есть в коде, но посмотреть на неё не на чем.
 * Заводятся именно люди на ступенях, а не роли — роли уже есть в справочнике.
 */
async function ensureLadder(departmentId: string | null): Promise<number> {
  const ladder = await db.select().from(roles).where(inArray(roles.code, ["chief", "head", "specialist"]));
  if (!ladder.length) return 0;

  const WHO = [
    { code: "chief", firstName: "Ярослав", lastName: "Ковальчук", middleName: "Богданович", sex: "male" as const },
    { code: "head", firstName: "Ірина", lastName: "Мельник", middleName: "Василівна", sex: "female" as const },
    { code: "specialist", firstName: "Андрій", lastName: "Гриценко", middleName: "Сергійович", sex: "male" as const },
  ];

  let made = 0;
  for (const who of WHO) {
    const role = ladder.find((r) => r.code === who.code);
    if (!role) continue;

    const email = `demo-${who.code}@${DEMO_DOMAIN}`;
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      await db.insert(users).values({
        id,
        email,
        ...encryptPersonFields({ firstName: who.firstName, lastName: who.lastName, middleName: who.middleName }),
        passwordHash: await hashPassword(DEMO_PASSWORD),
        role: "admin",
        sex: who.sex,
      } as never);
      made += 1;
    }

    await db.insert(staffRoles).values({ userId: id, roleId: role.id }).onConflictDoNothing();
    if (departmentId) {
      await db
        .insert(specialistProfiles)
        .values({ userId: id, departmentId, room: who.code === "chief" ? "101" : who.code === "head" ? "205" : "214" })
        .onConflictDoNothing();
    }
  }
  return made;
}

/**
 * Направления, часть — без движения дольше недели.
 *
 * Направление живёт своим экраном и своей строкой в очереди работы, и обе
 * пустовали: наполнение о направлениях не знало вовсе. Просроченность здесь
 * не украшение — это единственный вид работы, где срок считается не по
 * назначенной дате, а по молчанию принимающей стороны.
 */
async function ensureReferrals(patientIds: string[], specialistId: string): Promise<number> {
  const WHERE_TO = ["psychiatrist", "inpatient", "outpatient", "commander"] as const;
  let made = 0;

  for (const [i, patientId] of patientIds.entries()) {
    const [has] = await db.select().from(referrals).where(eq(referrals.userId, patientId)).limit(1);
    if (has) continue;

    // каждое третье — старое: без них строка «столько-то дней без движения» пуста
    const daysAgo = i % 3 === 0 ? 9 + (i % 5) : 1 + (i % 4);
    await db.insert(referrals).values({
      id: crypto.randomUUID(),
      userId: patientId,
      destination: WHERE_TO[i % WHERE_TO.length]!,
      urgency: i % 7 === 0 ? "urgent" : "routine",
      status: i % 2 === 0 ? "created" : "accepted",
      reason: "Потрібна консультація за результатами скринінгу",
      createdBy: specialistId,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    } as never);
    made += 1;
  }
  return made;
}

/**
 * Переписка с непрочитанными письмами от пациентов.
 *
 * Непрочитанное — вид работы, и в очереди он стоит выше рутины: человек
 * написал и знает, что письмо дошло. Пустая переписка означала, что вид
 * работы существует только в коде.
 */
async function ensureThreads(patientIds: string[], specialistId: string): Promise<number> {
  const SAID = [
    "Доброго дня. Останній тиждень майже не сплю, прокидаюсь о третій і більше не засинаю.",
    "Чи можна перенести прийом? На роботі поставили в зміну.",
    "Ліки допомагають, але з'явилась сонливість вдень. Це нормально?",
  ];

  let made = 0;
  for (const [i, patientId] of patientIds.entries()) {
    const [has] = await db.select().from(threads).where(eq(threads.patientId, patientId)).limit(1);
    if (has) continue;

    const threadId = crypto.randomUUID();
    const sentAt = new Date(Date.now() - (1 + (i % 3)) * 86_400_000).toISOString();
    await db.insert(threads).values({ id: threadId, patientId, specialistId, lastMessageAt: sentAt } as never);
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      threadId,
      authorId: patientId,
      textEnc: encryptField(SAID[i % SAID.length]!),
      sentAt,
      /* readAt намеренно пуст: прочитанное письмо в очередь работы не идёт */
    } as never);
    made += 1;
  }
  return made;
}

/**
 * Диспансерный учёт с просроченными осмотрами.
 *
 * Просрочка на учёте — то, что сейчас держат в бумажном журнале и теряют.
 * Ради неё раздел и написан, а посмотреть на него было не на чем.
 */
async function ensureDispensary(patientIds: string[], specialistId: string): Promise<number> {
  const GROUPS = ["Група Д-II", "Група Д-III"];
  let made = 0;

  for (const [i, patientId] of patientIds.entries()) {
    const [has] = await db.select().from(dispensary).where(eq(dispensary.patientId, patientId)).limit(1);
    if (has) continue;

    const months = i % 2 === 0 ? 3 : 6;
    // половина просрочена: срок в прошлом, а осмотра не было
    const overdue = i % 2 === 0;
    const nextDueAt = new Date(Date.now() + (overdue ? -1 : 1) * (5 + (i % 20)) * 86_400_000);
    await db.insert(dispensary).values({
      patientId,
      groupLabel: GROUPS[i % GROUPS.length]!,
      intervalMonths: months,
      lastSeenAt: new Date(nextDueAt.getTime() - months * 30 * 86_400_000).toISOString(),
      nextDueAt: nextDueAt.toISOString(),
      addedBy: specialistId,
    } as never);
    made += 1;
  }
  return made;
}

/**
 * Набор методик и назначения по нему, часть просрочена.
 *
 * Шестой и последний вид работы. Набор — это то, что специалист выдаёт
 * человеку целиком: «пройдите вот это, вот это и вот это к пятнице». Ни
 * одного набора в наполнении не было, и вкладка «Просроченные назначения»
 * стояла с нулём при том, что комментарий рядом обещал обратное.
 */
async function ensureBatteryWork(
  patientIds: string[],
  specialistId: string,
  catalog: { id: string; key: string | null }[],
): Promise<number> {
  const title = "Первинний скринінг";
  const [existing] = await db.select().from(batteries).where(eq(batteries.title, title)).limit(1);
  const batteryId = existing?.id ?? crypto.randomUUID();

  if (!existing) {
    const [group] = await db.select({ id: surveyGroups.id }).from(surveyGroups).limit(1);
    await db.insert(batteries).values({
      id: batteryId,
      title,
      description: "Тривога, настрій, самопочуття — три методики одним призначенням",
      groupId: group?.id ?? null,
      createdBy: specialistId,
    } as never);

    /* порядок обязателен: методики влияют друг на друга через утомление */
    const wanted = ["gad7", "phq9", "who5"];
    let position = 0;
    for (const key of wanted) {
      const found = catalog.find((c) => c.key === key);
      if (!found) continue;
      await db
        .insert(batteryItems)
        .values({ batteryId, surveyId: found.id, position: position++ })
        .onConflictDoNothing();
    }
  }

  let made = 0;
  for (const [i, userId] of patientIds.entries()) {
    const [has] = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.userId, userId), eq(batteryAssignments.batteryId, batteryId)))
      .limit(1);
    if (has) continue;

    // половина просрочена: только просроченные попадают в очередь работы
    const overdue = i % 2 === 0;
    const dueAt = new Date(Date.now() + (overdue ? -1 : 1) * (2 + (i % 9)) * 86_400_000);
    await db.insert(batteryAssignments).values({
      id: crypto.randomUUID(),
      batteryId,
      userId,
      assignedBy: specialistId,
      dueAt: dueAt.toISOString(),
    } as never);
    made += 1;
  }
  return made;
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
  if (department) await ensureDemoSpecialist(department.id);
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
  const report: FillReport = {
    created: 0,
    existing: 0,
    responses: 0,
    appointments: 0,
    episodes: 0,
    assignments: 0,
    referrals: 0,
    threads: 0,
    dispensary: 0,
    ladder: 0,
  };

  /* кого завели за прогон — им и раздаются направления, переписка и учёт */
  const touched: string[] = [];

  for (const p of people) {
    const { id: userId, created } = await ensurePerson(p);
    if (created) report.created += 1;
    else report.existing += 1;
    touched.push(userId);

    /*
     * Клиническая часть делается ВСЕМ, а не только заведённым сейчас.
     *
     * Раньше здесь стоял `continue`: уже существующий человек пропускался
     * целиком. Из-за этого повторный прогон ничего не добавлял, и когда в
     * системе появилось то, чего в первом наполнении не было — приёмы,
     * обращения, специалист с расписанием, — картотека так и осталась без
     * них: сто двадцать человек с измерениями и пустой экран дня. Дополнять
     * уже заведённых надо уметь, иначе каждое новое умение системы требует
     * стирать всё и наполнять заново.
     *
     * Прохождения при этом не повторяются: они делаются только для тех,
     * кого завели сейчас, — иначе каждый прогон дорисовывал бы человеку
     * лишнюю историю, и динамика показывала бы не течение, а число
     * запусков посева.
     */
    if (department && specialist) {
      await db
        .insert(departmentPatients)
        .values({ departmentId: department.id, patientId: userId, attachedVia: "staff" })
        .onConflictDoNothing();
      if (await ensureEpisode(p, userId, specialist.id)) report.episodes += 1;

      // назначение на одну из методик каталога: со сроком, часть просрочена
      const target = catalog[Math.floor(rng(p.slug.length + p.birthYear)() * catalog.length)];
      if (target && (await ensureAssignment(p, userId, specialist.id, target.id))) {
        report.assignments += 1;
      }
    }

    if (!created) continue;

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

  }

  // приёмы раздаются в конце: свободные слоты надо делить между всеми
  if (department && specialist) {
    report.appointments = await bookDemoAppointments(specialist.id);
  }

  /*
   * Остальные виды работы раздаются немногим, а не всем.
   *
   * Очередь работы, где у каждого из ста двадцати человек направление,
   * письмо и просроченный учёт, — это не наполненная система, а стена: по
   * ней нельзя понять ни порядок, ни веса видов. В настоящем отделении
   * направлений единицы, писем — единицы, на учёте — десятки.
   */
  report.ladder = await ensureLadder(department?.id ?? null);
  if (specialist) {
    report.referrals = await ensureReferrals(touched.slice(0, 9), specialist.id);
    report.threads = await ensureThreads(touched.slice(9, 14), specialist.id);
    report.dispensary = await ensureDispensary(touched.slice(14, 32), specialist.id);
    report.assignments += await ensureBatteryWork(touched.slice(32, 44), specialist.id, catalog);
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
