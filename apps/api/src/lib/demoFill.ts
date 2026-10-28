import { and, asc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { intervalsForDay, layOutDay, noteCode, type SurveyFull } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { dbContext } from "../db/context";
import {
  alertCases,
  appointments,
  batteries,
  batteryAssignments,
  batteryItems,
  conclusions,
  departmentPatients,
  departments,
  dispensary,
  episodes,
  invites,
  messages,
  noteSearch,
  patientNotes,
  referrals,
  responses,
  riskAlerts,
  roles,
  safetyPlans,
  scheduleTemplates,
  slots,
  specialistProfiles,
  staffRoles,
  surveyAccess,
  surveys,
  threads,
  users,
} from "../db/schema";
import { fullNameOf, hashPassword } from "./auth";
import { snapshotAssignment } from "./batteries";
import { hashInviteToken, newInviteCode, newInviteToken } from "./invites";
import { decryptField, encryptField, encryptPersonFields } from "./crypto";
import { normalizePhone, phoneFingerprint } from "./phone";
import { log } from "./log";
import { followupNote } from "./followup";
import { getSurvey } from "./surveys";
import { persistSubmission } from "./submission";
import { grantAccess } from "./grantAccess";
import { indexOf } from "./searchIndex";
import { zonedTime } from "./day";
import { demoAnswers } from "./demoAnswers";
import { ARCHETYPE_COUNTS, makePeople, rng, type ArchetypeKey, type Person } from "./demoPeople";
import { storyOf, type CaseDecision, type Measure, type NoteContext, type Story, type Visit } from "./demoStories";

/**
 * Наполнение экземпляра вымышленными людьми и их историей лечения.
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
 *
 * ═══ Что пишется на человека ═══
 *
 * История из lib/demoStories.ts — целиком и связно: обращение с поводом и
 * лечащим специалистом, приёмы в слотах этого специалиста (прошедшие —
 * состоялись или неявка, ближайшие — записаны), замеры к приёмам, записи
 * приёма с клиническим текстом, заключения, планы безопасности, направления,
 * переписка, учёт, назначенные повторы. Специалисты — те, у кого есть
 * расписание на полную неделю (loadClinicians); люди делятся между ними
 * поровну (attendingIndex).
 *
 * ═══ Даты ═══
 *
 * Сдача датируется моментом завершения, но только в пределах (волна 12,
 * completionTime): не раньше версии методики, а версия посева создана только
 * что. Правильно: время сдачи не должно приходить снаружи без меры. Поэтому
 * прохождение сдаётся «сейчас» и передатируется после записи, а вместе с ним —
 * и то, что сдача родила: сигналы риска, случаи, срабатывания правил,
 * закрытие набора. Прежде передатировалось одно прохождение, и все 678
 * сигналов наполнения стояли на минуте прогона, по восемь одинаковых строк в
 * карточке.
 *
 * Случаи разбирает лечащий специалист — с исходом и заметкой: поднятый на
 * приёме — на этом приёме, домашний — через часы, как в жизни (settleCases).
 * Неразобранными остаются только свежие домашние замеры, которых специалист
 * ещё не видел (Story.openFrom): около шести процентов картотеки, а не
 * восемьдесят четыре человека из ста двадцати.
 *
 * ═══ Повторный прогон ═══
 *
 * История пишется вместе с человеком и только с ним: уже заведённый человек
 * этой же редакции наполнения пропускается целиком, и второй прогон не
 * добавляет ни строки истории. Прежде клиническая часть дописывалась всем
 * при каждом прогоне — чтобы новое умение системы доезжало до уже
 * заведённых; для связной истории это не годится: дописанные куски чужой
 * редакции давали карточку, где заметки говорят о ПТСР, а замеры — о
 * случайном блуждании. Картотеку прежней редакции наполнение не трогает и
 * отказывает (DemoFillRefused): сначала demo-purge, затем demo-fill — для
 * вымышленных данных это одна команда, а не потеря.
 */

export const DEMO_DOMAIN = "demo.local";
const DEMO_PASSWORD = "demo-only-not-a-secret";
/* Пометка в заметке приглашения: по ней же его и убирают, см. purgeDemoData */
const DEMO_NOTE = "Демонстраційне запрошення";

export interface FillReport {
  created: number;
  existing: number;
  responses: number;
  appointments: number;
  episodes: number;
  notes: number;
  conclusions: number;
  safetyPlans: number;
  openCases: number;
  closedCases: number;
  assignments: number;
  referrals: number;
  threads: number;
  dispensary: number;
  ladder: number;
  invites: number;
  /** Портрет → сколько людей заведено этим прогоном */
  archetypes: Partial<Record<ArchetypeKey, number>>;
}

/**
 * Наполнение отказало, ничего не тронув: в базе вымышленные люди другой
 * редакции наполнения, и дописывать им историю этой — значит смешать две.
 */
export class DemoFillRefused extends Error {}

/* ═════════════ время учреждения ═════════════ */

const DAY_MS = 86_400_000;

interface Clock {
  now: number;
  tz: string;
  /** Сегодняшняя дата по поясу отделения */
  year: number;
  month: number;
  day: number;
}

function clockOf(tz: string, now = Date.now()): Clock {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(now))
    .split("-")
    .map(Number);
  return { now, tz, year: parts[0]!, month: parts[1]!, day: parts[2]! };
}

/** Календарный день со сдвигом от сегодняшнего: ключ YYYY-MM-DD и ISO-день недели */
function dateAt(clock: Clock, offset: number): { key: string; weekday: number; year: number; month: number; day: number } {
  const d = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + offset));
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return {
    key: d.toISOString().slice(0, 10),
    weekday,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Момент: день со сдвигом и минута суток по часам отделения */
function momentAt(clock: Clock, offset: number, minute: number): number {
  const d = dateAt(clock, offset);
  return zonedTime(
    { year: d.year, month: d.month, day: d.day, hour: Math.floor(minute / 60), minute: minute % 60, second: 0, ms: 0 },
    clock.tz,
  ).getTime();
}

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

/* ═════════════ люди ═════════════ */

async function ensurePerson(p: Person, story: Story, clock: Clock, lead: string | null): Promise<{ id: string; created: boolean }> {
  const email = `${p.slug}@${DEMO_DOMAIN}`;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
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
  const r = rng(p.ordinal * 7907 + Number(p.birthDate.slice(0, 4)));
  const phone = `+380${String(500000000 + p.ordinal * 4093 + Math.floor(r() * 4000))}`;
  /* в картотеке человек появился с первым поводом, а не в минуту прогона */
  const firstDay = Math.min(story.episode?.openDay ?? 0, ...story.visits.map((v) => v.day), ...story.home.map((h) => h.day), 0);
  await db.insert(users).values({
    id,
    email,
    // дата рождения шифруется вместе с ФИО: наполнение заводит обычные учётные записи, и хранятся они как боевые
    ...encryptPersonFields({ firstName: p.firstName, lastName: p.lastName, middleName: p.middleName, birthDate: p.birthDate }),
    phoneEnc: encryptField(phone),
    phoneIndex: phoneFingerprint(normalizePhone(phone)!),
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: "user",
    sex: p.sex,
    unit: p.unit,
    rank: p.rank,
    position: p.position,
    specialty: p.specialty,
    leadSpecialistId: lead,
    createdAt: iso(momentAt(clock, firstDay, 8 * 60 + Math.floor(r() * 120))),
  } as never);
  return { id, created: true };
}

/**
 * Картотека — той же редакции наполнения, или отказ.
 *
 * Опознаётся по именам: человек под номером N у одной редакции всегда один и
 * тот же (lib/demoPeople.ts), и расхождение ФИО означает, что его завела
 * другая. Отдельной пометки «редакция» в схеме нет и не нужно: имя и есть
 * то, что видно на экране, и то, что разошлось бы.
 */
async function assertSameGeneration(people: Person[]): Promise<void> {
  const expected = new Map(people.map((p) => [`${p.slug}@${DEMO_DOMAIN}`, p]));
  const rows = await db
    .select({ email: users.email, lastName: users.lastName, firstName: users.firstName })
    .from(users)
    .where(like(users.email, `demo-%@${DEMO_DOMAIN}`));
  const foreign = rows.filter((row) => {
    const p = expected.get(row.email);
    return p && (decryptField(row.lastName) !== p.lastName || decryptField(row.firstName) !== p.firstName);
  });
  if (foreign.length) {
    throw new DemoFillRefused(
      `В базе ${foreign.length} вымышленных людей прежней редакции наполнения — история новой к ним не дописывается. ` +
        "Сначала demo-purge, затем demo-fill; ничего не изменено.",
    );
  }
}

/* ═════════════ специалисты ═════════════ */

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
async function ensureDemoSpecialist(departmentId: string): Promise<void> {
  const [withSlots] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(specialistProfiles, eq(specialistProfiles.userId, users.id))
    .where(sql`exists (select 1 from slots s where s.specialist_id = ${users.id})`)
    .limit(1);
  if (withSlots) return;

  const email = `demo-specialist@${DEMO_DOMAIN}`;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await db.insert(users).values({
      id,
      email,
      ...encryptPersonFields({ firstName: "Олена", lastName: "Демченко", middleName: "Петрівна" }),
      passwordHash: await hashPassword(DEMO_PASSWORD),
      role: "admin",
      sex: "female",
    } as never);
    const { ensureBuiltinRole } = await import("./permissions");
    await ensureBuiltinRole(id);
  }

  await db.insert(specialistProfiles).values({ userId: id, departmentId, room: "212" }).onConflictDoNothing();

  // будни с перерывом: обычная неделя, по которой строится сетка слотов
  for (const weekday of [1, 2, 3, 4, 5]) {
    for (const [startsAt, endsAt] of [["09:00", "13:00"] as const, ["14:00", "17:00"] as const]) {
      await db
        .insert(scheduleTemplates)
        .values({ id: crypto.randomUUID(), specialistId: id, weekday, startsAt, endsAt, slotMinutes: 50 })
        .onConflictDoNothing();
    }
  }
  const { syncSlots } = await import("./schedule");
  await syncSlots(id);
}

/**
 * Психиатр отделения — для осмотров историй (Story.psychiatry).
 *
 * Вымышленный, как и пациенты, и убирается той же командой: осмотр со
 * шкалами врача и подписанная консультация от имени настоящего сотрудника
 * были бы записью, которой этот сотрудник не делал. Расписания у него нет
 * намеренно: со слотами он стал бы лечащим (loadClinicians) и забрал бы
 * часть людей у психологов, а психиатр отделения смотрит по направлению,
 * не ведёт.
 */
async function ensureDemoPsychiatrist(departmentId: string): Promise<{ id: string; name: string }> {
  const email = `demo-psychiatrist@${DEMO_DOMAIN}`;
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  const id = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await db.insert(users).values({
      id,
      email,
      ...encryptPersonFields({ firstName: "Валентин", lastName: "Чорноус", middleName: "Петрович" }),
      passwordHash: await hashPassword(DEMO_PASSWORD),
      role: "admin",
      sex: "male",
    } as never);
    const { ensureBuiltinRole } = await import("./permissions");
    await ensureBuiltinRole(id);
  }
  await db
    .insert(specialistProfiles)
    .values({ userId: id, departmentId, position: "Лікар-психіатр", room: "217", acceptsBookings: false })
    .onConflictDoNothing();
  return { id, name: "Чорноус Валентин Петрович" };
}

interface Clinician {
  id: string;
  name: string;
  departmentId: string;
  templates: { weekday: number; from: string; to: string; slotMinutes: number }[];
}

/**
 * Сколько приёмов в неделю должно давать расписание лечащего. Тридцать
 * человек на специалиста с приёмом раз в одну-две недели — это пятнадцать-
 * двадцать приёмов в неделю; у посева — тридцать.
 */
export const DEMO_MIN_WEEKLY_SLOTS = 20;

/** Приёмов в неделю по шаблону — той же раскладкой дня, что строит сетку */
function weeklySlots(templates: Clinician["templates"]): number {
  let n = 0;
  for (const weekday of new Set(templates.map((t) => t.weekday))) n += layOutDay(intervalsForDay(weekday, templates, [], [])).length;
  return n;
}

/**
 * Кто ведёт вымышленных людей: специалисты с расписанием вперёд.
 *
 * Специалист берётся тот, у КОГО ЕСТЬ РАСПИСАНИЕ, а не первый попавшийся
 * сотрудник. Первым в таблице обычно оказывается технический администратор:
 * слотов у него нет, и записывать на приём было бы некуда — ровно это и
 * вышло на первом прогоне, приёмов завелось ноль. Порядок — по почте: время
 * создания у учёток, заведённых одним посевом, совпадает до миллисекунды, а
 * деление людей между врачами обязано быть одним и тем же на каждом прогоне.
 *
 * И расписание — на полную неделю (DEMO_MIN_WEEKLY_SLOTS), а не любое.
 * Специалисту с часом приёма в день (совместитель; в общей тестовой базе —
 * учётки проверок сетки) доставалась та же четверть картотеки: приёмы, которым
 * не нашлось слота, выпадали из истории, а с ними — и замер, по которому
 * человек попал в риск, и план безопасности оставался без повода. Полной
 * недели нет ни у кого — ведут те, у кого шаблон есть, от большего к меньшему:
 * история выйдет короче, но связной. Без шаблона недели прошлых приёмов не
 * построить вовсе — такой специалист не ведёт.
 */
async function loadClinicians(): Promise<Clinician[]> {
  const rows = await db
    .select({ user: users, departmentId: specialistProfiles.departmentId })
    .from(users)
    .innerJoin(specialistProfiles, eq(specialistProfiles.userId, users.id))
    .where(
      and(
        isNull(users.disabledAt),
        eq(specialistProfiles.acceptsBookings, true),
        sql`exists (select 1 from slots s where s.specialist_id = ${users.id} and s.status = 'open' and s.starts_at > now())`,
      ),
    )
    .orderBy(asc(users.email));
  const all: Clinician[] = [];
  for (const row of rows) {
    const templates = await db
      .select()
      .from(scheduleTemplates)
      .where(eq(scheduleTemplates.specialistId, row.user.id))
      .orderBy(asc(scheduleTemplates.startsAt), asc(scheduleTemplates.endsAt));
    if (!templates.length) continue;
    all.push({
      id: row.user.id,
      name: fullNameOf(row.user),
      departmentId: row.departmentId,
      templates: templates.map((t) => ({ weekday: t.weekday, from: t.startsAt.slice(0, 5), to: t.endsAt.slice(0, 5), slotMinutes: t.slotMinutes })),
    });
  }
  const full = all.filter((c) => weeklySlots(c.templates) >= DEMO_MIN_WEEKLY_SLOTS);
  const chosen = full.length ? full : [...all].sort((a, b) => weeklySlots(b.templates) - weeklySlots(a.templates));
  return chosen.slice(0, 4);
}

/** Порядок портретов — для деления людей между врачами: см. attendingIndex */
const ARCHETYPE_ORDER = Object.keys(ARCHETYPE_COUNTS) as ArchetypeKey[];

/**
 * Лечащий специалист человека.
 *
 * Номер внутри портрета плюс номер портрета — а не один номер внутри
 * портрета: иначе всем «нулевым» вариантам (а это и есть люди в остром
 * состоянии) достался бы один и тот же врач, и у второго в очереди риска не
 * было бы никого.
 */
function attendingIndex(p: Person, k: number): number {
  return (p.variant + ARCHETYPE_ORDER.indexOf(p.archetype)) % k;
}

/* ═════════════ сетка приёма ═════════════ */

interface Cell {
  id: string | null;
  startsAt: number;
  endsAt: number;
  busy: boolean;
}

/**
 * Время приёма специалистов — прошлое и ближайшее.
 *
 * Вперёд сетку строит расписание (lib/schedule.ts, на восемь недель), и
 * наполнение пишет только в её слоты: свободное время отделения — общее с
 * настоящими людьми. Назад сетки нет, если отделение только что заведено:
 * syncSlots прошлого не строит, а история лечения в полгода требует
 * прошедших приёмов. Такие слоты наполнение достраивает по тому же шаблону
 * недели — и только те, на которые записывает: пустая прошлая сетка никому
 * не нужна. Достроенный слот узнаётся по тому, что заведён позже своего
 * начала больше чем на сутки (живая синхронизация в прошлое не строит), —
 * по этому признаку его и убирает purgeDemoData.
 */
class ClinicBook {
  private cache = new Map<string, Cell[]>();

  private constructor(
    private readonly clock: Clock,
    private readonly clinicians: Clinician[],
    private readonly existing: Map<string, Cell[]>,
  ) {}

  static async load(clock: Clock, clinicians: Clinician[]): Promise<ClinicBook> {
    const from = iso(momentAt(clock, -230, 0));
    const to = iso(momentAt(clock, 40, 0));
    const existing = new Map<string, Cell[]>();
    for (const c of clinicians) {
      const rows = await db
        .select({
          id: slots.id,
          startsAt: slots.startsAt,
          endsAt: slots.endsAt,
          /*
           * slots.id — словами, а не ${slots.id}: в списке полей запроса по одной
           * таблице drizzle пишет колонку без имени таблицы, и «"id"» внутри
           * подзапроса становилось a.id — занятым не считался ни один слот, и
           * на приём посева ложился второй человек.
           */
          busy: sql<boolean>`exists (select 1 from appointments a where a.slot_id = slots.id and a.status <> 'cancelled')`,
        })
        .from(slots)
        .where(and(eq(slots.specialistId, c.id), eq(slots.status, "open"), sql`${slots.startsAt} >= ${from}`, sql`${slots.startsAt} < ${to}`));
      for (const row of rows) {
        const key = `${c.id}|${dayKeyOf(clock, Date.parse(row.startsAt))}`;
        const list = existing.get(key) ?? [];
        list.push({ id: row.id, startsAt: Date.parse(row.startsAt), endsAt: Date.parse(row.endsAt), busy: Boolean(row.busy) });
        existing.set(key, list);
      }
    }
    return new ClinicBook(clock, clinicians, existing);
  }

  private cells(clinician: Clinician, offset: number): Cell[] {
    const date = dateAt(this.clock, offset);
    const key = `${clinician.id}|${date.key}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const known = [...(this.existing.get(key) ?? [])];
    let cells = known;
    if (offset < 0) {
      // прошлое: по шаблону недели, мимо уже стоящих слотов того дня
      const pieces = layOutDay(intervalsForDay(date.weekday, clinician.templates, [], []));
      const virtual = pieces
        .map((piece) => {
          const [fh, fm] = piece.from.split(":").map(Number);
          const [th, tm] = piece.to.split(":").map(Number);
          return { id: null, startsAt: momentAt(this.clock, offset, fh! * 60 + fm!), endsAt: momentAt(this.clock, offset, th! * 60 + tm!), busy: false };
        })
        .filter((v) => !known.some((k) => v.startsAt < k.endsAt && k.startsAt < v.endsAt));
      cells = [...known, ...virtual];
    }
    cells.sort((a, b) => a.startsAt - b.startsAt);
    this.cache.set(key, cells);
    return cells;
  }

  /**
   * Свободный слот на этот день, в привычное время человека или рядом; нет —
   * в соседний будний день, не перескакивая через «сегодня»: прошедший приём
   * не становится будущим и наоборот.
   */
  async take(clinicianId: string, offset: number, prefer: number, urgent: boolean): Promise<(Cell & { offset: number }) | null> {
    const clinician = this.clinicians.find((c) => c.id === clinicianId)!;
    const tries = [0, 1, -1, 2, -2, 3, -3, 4, -4].map((d) => offset + d).filter((d) => (offset < 0 ? d < 0 : d >= 0));
    for (const day of tries) {
      const cells = this.cells(clinician, day);
      const free = cells.map((c, i) => ({ c, i })).filter(({ c }) => !c.busy);
      if (!free.length) continue;
      const pick = urgent
        ? free[0]!
        : free.reduce((best, x) => (Math.abs(x.i - prefer) < Math.abs(best.i - prefer) ? x : best), free[0]!);
      const cell = pick.c;
      if (!cell.id) {
        cell.id = crypto.randomUUID();
        await db.insert(slots).values({
          id: cell.id,
          specialistId: clinician.id,
          departmentId: clinician.departmentId,
          startsAt: iso(cell.startsAt),
          endsAt: iso(cell.endsAt),
        });
      }
      cell.busy = true;
      return { ...cell, offset: day };
    }
    return null;
  }

  /** Отменённый приём слот не держит: на это время записывают снова */
  release(slotId: string): void {
    for (const list of this.cache.values()) for (const c of list) if (c.id === slotId) c.busy = false;
  }
}

function dayKeyOf(clock: Clock, ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: clock.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/* ═════════════ история человека ═════════════ */

interface FillContext {
  clock: Clock;
  catalog: Map<string, string>;
  surveysById: Map<string, SurveyFull>;
  clinicians: Clinician[];
  book: ClinicBook;
  screeningBattery: { id: string; title: string; steps: { surveyId: string; position: number; required: boolean }[] } | null;
  report: FillReport;
  /** Неразобранные случаи прогона — множеством: случай, продлённый вторым замером, — всё ещё один случай */
  openCases: Set<string>;
  /** Психиатр отделения для осмотров историй (Story.psychiatry); нет отделения — осмотров нет */
  psychiatrist: { id: string; name: string } | null;
}

interface Booked {
  visit: Visit;
  index: number;
  /** День, на который приём встал на самом деле: свободный слот бывает не в тот день, что в истории */
  offset: number;
  appointmentId: string;
  startsAt: number;
  endsAt: number;
  /** Что с приёмом к моменту наполнения */
  state: "past" | "now" | "soon" | "future";
}

interface Session {
  day: number;
  at: number;
  measures: Measure[];
  booked?: Booked;
  /** Осмотр психиатра: запись консультации пишет он, а не лечащий психолог */
  psychiatry?: NonNullable<Story["psychiatry"]>[number];
}

/** Баллы одного замера: методика → шкала → значение и полоса */
type Scores = Map<string, Map<string, { value: number; band: string | null }>>;

async function surveyOf(ctx: FillContext, key: string): Promise<SurveyFull | null> {
  const id = ctx.catalog.get(key);
  if (!id) return null;
  const cached = ctx.surveysById.get(id);
  if (cached) return cached;
  const survey = await getSurvey(id, null, "uk");
  if (survey) ctx.surveysById.set(id, survey);
  return survey;
}

/** Зерно ответов: человек и методика задают рисунок пунктов, номер замера — разброс */
function answerSeed(p: Person, key: string, n: number): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ((p.ordinal * 977 + (h % 997)) % 2_000_000) * 1000 + n;
}

/** ДД.ММ.ГГГГ по часам отделения — так дату пишут в записи и заключении */
const fmtDate = (clock: Clock, ms: number) => {
  const [y, m, d] = dayKeyOf(clock, ms).split("-");
  return `${d}.${m}.${y}`;
};

async function writeStory(ctx: FillContext, p: Person, userId: string, story: Story, attending: Clinician): Promise<void> {
  const { clock, report } = ctx;
  const r = rng(p.ordinal * 31_337 + 7);
  const now = clock.now;
  const pastLimit = now - 5 * MIN;

  await db
    .insert(departmentPatients)
    .values({
      departmentId: attending.departmentId,
      patientId: userId,
      attachedVia: "staff",
      attachedAt: iso(momentAt(clock, Math.min(story.episode?.openDay ?? 0, 0), 9 * 60)),
    })
    .onConflictDoNothing();

  /* ─── обращение: строка сразу, исход — когда известны итоговые баллы ─── */
  let episodeId: string | null = null;
  let episodeOpened = 0;
  if (story.episode) {
    episodeId = crypto.randomUUID();
    episodeOpened = Math.min(pastLimit, momentAt(clock, story.episode.openDay, 9 * 60 + Math.floor(r() * 180)));
    await db.insert(episodes).values({
      id: episodeId,
      patientId: userId,
      leadSpecialistId: attending.id,
      departmentId: attending.departmentId,
      openedAt: iso(episodeOpened),
      reasonEnc: encryptField(story.episode.reason),
      createdBy: attending.id,
    });
    report.episodes += 1;
  }

  /* ─── приёмы ─── */
  const prefer = Math.floor(r() * 6);
  const booked: Booked[] = [];
  let primaryDone = false;
  let previousStart = episodeOpened;
  /*
   * Неявка и поздняя отмена — у обычного сеанса без замера, не первого и не
   * последнего прошедшего: примерно каждый пятнадцатый, как в отделении.
   * История задаёт неявки там, где они — сюжет (выбывающие); здесь — фон,
   * без которого неявка в очереди работы выглядит исключением, а не работой.
   */
  const lastPastDay = Math.max(...story.visits.filter((v) => v.day < 0).map((v) => v.day), -9999);
  const missed = (v: Visit, i: number) =>
    i > 0 && v.day < -2 && v.day !== lastPastDay && !v.urgent && !v.measures.length && v.outcome === "done" ? r() : 1;
  for (const [index, story_] of story.visits.entries()) {
    const roll = missed(story_, index);
    const v: Visit = roll < 0.05 ? { ...story_, outcome: "no_show", note: undefined } : roll < 0.075 ? { ...story_, outcome: "cancelled", note: undefined } : story_;
    const cell = await ctx.book.take(attending.id, v.day, prefer, v.urgent ?? false);
    if (!cell) continue;
    const state: Booked["state"] =
      cell.endsAt <= now ? "past" : cell.startsAt <= now ? "now" : cell.startsAt - 15 * MIN <= now ? "soon" : "future";
    const kind = primaryDone ? "repeat" : "primary";
    primaryDone = true;
    const bookedAt = Math.min(
      now - 30 * MIN,
      v.urgent ? cell.startsAt - (30 + Math.floor(r() * 60)) * MIN : Math.max(previousStart + HOUR, cell.startsAt - (2 + Math.floor(r() * 9)) * DAY_MS),
    );
    previousStart = cell.startsAt;
    const status =
      v.outcome === "cancelled" && state === "past"
        ? "cancelled"
        : state === "past"
          ? v.outcome
          : state === "now"
            ? "in_progress"
            : state === "soon"
              ? "arrived"
              : cell.startsAt - now < 2 * DAY_MS
                ? "confirmed"
                : "booked";
    const appointmentId = crypto.randomUUID();
    const done = status === "done";
    await db.insert(appointments).values({
      id: appointmentId,
      slotId: cell.id!,
      patientId: userId,
      specialistId: attending.id,
      kind,
      status,
      reasonEnc: kind === "primary" && v.reason ? encryptField(v.reason) : null,
      bookedBy: r() < 0.3 && !v.urgent ? userId : attending.id,
      bookedAt: iso(Math.min(bookedAt, cell.startsAt - 10 * MIN)),
      episodeId,
      ...(status === "confirmed" ? { confirmedAt: iso(now - (1 + Math.floor(r() * 5)) * HOUR) } : {}),
      ...((done || status === "no_show") && !v.urgent
        ? { confirmedAt: iso(Math.min(cell.startsAt - HOUR, Math.max(bookedAt + HOUR, cell.startsAt - 26 * HOUR))) }
        : {}),
      ...(done || status === "in_progress" || status === "arrived"
        ? { arrivedAt: iso(Math.min(now, cell.startsAt - (3 + Math.floor(r() * 10)) * MIN)) }
        : {}),
      ...(done || status === "in_progress" ? { startedAt: iso(Math.min(now, cell.startsAt + Math.floor(r() * 4) * MIN)) } : {}),
      ...(done ? { finishedAt: iso(cell.endsAt - Math.floor(r() * 8) * MIN) } : {}),
      ...(status === "cancelled"
        ? (() => {
            // треть отмен — меньше чем за сутки: такую специалист видит так же, как неявку
            const late = r() < 0.35;
            const before = late ? (2 + Math.floor(r() * 18)) * HOUR : (26 + Math.floor(r() * 48)) * HOUR;
            return { cancelledAt: iso(cell.startsAt - before), cancelledBy: userId, cancelledLate: late };
          })()
        : {}),
    });
    if (status === "cancelled") ctx.book.release(cell.id!);
    report.appointments += 1;
    booked.push({ visit: v, index, offset: cell.offset, appointmentId, startsAt: cell.startsAt, endsAt: cell.endsAt, state });
  }

  /* ─── набор «Первинний скринінг» — до сдачи, иначе сдача его не закроет ─── */
  let batteryAssignmentId: string | null = null;
  if (story.battery && ctx.screeningBattery) {
    const b = ctx.screeningBattery;
    batteryAssignmentId = crypto.randomUUID();
    const assignedAt = Math.min(pastLimit, momentAt(clock, story.battery.assignedDay, 10 * 60 + Math.floor(r() * 300)));
    const dueAt = momentAt(clock, story.battery.dueDay, 23 * 60 + 59);
    await db.insert(batteryAssignments).values({
      id: batteryAssignmentId,
      batteryId: b.id,
      userId,
      assignedBy: attending.id,
      assignedAt: iso(assignedAt),
      dueAt: iso(dueAt),
    } as never);
    // состав назначения — снимок, как у боевой выдачи (lib/batteries.ts), и доступ к шагам — тем же путём, что кнопка
    await snapshotAssignment(db, batteryAssignmentId, b.steps);
    await grantAccess(
      db as never,
      b.steps.map((s) => ({
        surveyId: s.surveyId,
        userId,
        grantedBy: attending.id,
        expiresAt: iso(dueAt),
        note: noteCode("note.battery", { title: b.title }),
        viaAssignmentId: batteryAssignmentId!,
      })),
      { term: "extend" },
    );
    await db
      .update(surveyAccess)
      .set({ grantedAt: iso(assignedAt) })
      .where(and(eq(surveyAccess.userId, userId), eq(surveyAccess.viaAssignmentId, batteryAssignmentId)));
    report.assignments += 1;
  }

  /* ─── замеры по порядку времени ─── */
  const sessions: Session[] = [];
  for (const b of booked) {
    if (!b.visit.measures.length || b.state === "future") continue;
    if (b.state === "past" && b.visit.outcome !== "done") continue;
    sessions.push({ day: b.visit.day, at: b.startsAt - (25 + Math.floor(r() * 45)) * MIN, measures: b.visit.measures, booked: b });
  }
  for (const h of story.home) {
    // «только что» — за час-три до наполнения, в какой бы час его ни запустили
    const at = h.recent ? now - (40 + Math.floor(r() * 140)) * MIN : momentAt(clock, h.day, h.minute);
    const day = h.recent ? (dayKeyOf(clock, at) === dateAt(clock, 0).key ? 0 : -1) : h.day;
    if (at < pastLimit) sessions.push({ day, at, measures: h.measures });
  }
  /*
   * Осмотр психиатра — сразу после приёма у психолога, к которому он
   * привязан (кризис, отмена алкоголя), или в рабочие часы дня, когда
   * закрыто направление. Приёма нет — нет и осмотра: врач смотрит того, кто
   * пришёл.
   */
  if (ctx.psychiatrist) {
    for (const entry of story.psychiatry ?? []) {
      const after = entry.afterVisit !== undefined ? booked.find((b) => b.index === entry.afterVisit) : undefined;
      if (entry.afterVisit !== undefined && (!after || after.state !== "past" || after.visit.outcome !== "done")) continue;
      const at = after ? after.endsAt + (20 + Math.floor(r() * 50)) * MIN : momentAt(clock, entry.day, 11 * 60 + Math.floor(r() * 240));
      if (at < pastLimit - HOUR) sessions.push({ day: after ? after.offset : entry.day, at, measures: entry.measures, psychiatry: entry });
    }
  }
  sessions.sort((a, b) => a.at - b.at);

  const history: { at: number; scores: Scores }[] = [];
  const sessionScores = new Map<Session, Scores>();
  const responseOf = new Map<string, { id: string; at: number; session: Session }[]>();
  let measured = 0;

  for (const s of sessions) {
    const scores: Scores = new Map();
    const ids: string[] = [];
    let selfAt = s.at;
    let clinicianAt = (s.booked?.startsAt ?? s.at) + 10 * MIN;
    for (const m of s.measures) {
      const survey = await surveyOf(ctx, m.key);
      if (!survey) continue;
      const answers = demoAnswers(survey, { targets: m.targets, fixed: m.fixed, allowRisk: m.allowRisk, seed: answerSeed(p, m.key, measured++) });
      if (!answers.length) continue;
      const duration = answers.reduce((sum, a) => sum + a.durationMs, 0);
      const at = m.clinician ? clinicianAt : selfAt + duration;
      if (at > pastLimit) continue;
      if (m.clinician) clinicianAt = at + duration + 2 * MIN;
      else selfAt = at + 40_000;
      const result = await persistSubmission(
        survey,
        { id: userId, sex: p.sex, birthDate: p.birthDate },
        {
          answers: answers as never,
          // «сейчас», а не задним числом: прошлую дату completionTime отверг бы с записью в журнал — дата ставится ниже
          startedAt: iso(Date.now() - duration),
          durationMs: duration,
          status: "completed",
          events: [],
        },
        m.clinician
          ? { filledBySelf: false, lang: "uk", source: "clinician" }
          : { filledBySelf: true, lang: "uk", source: "assigned" },
      );
      await db
        .update(responses)
        .set({ submittedAt: iso(at), startedAt: iso(at - duration) })
        .where(eq(responses.id, result.responseId));
      ids.push(result.responseId);
      report.responses += 1;
      const byScale = new Map<string, { value: number; band: string | null }>();
      for (const sc of result.scores) byScale.set(sc.scaleCode, { value: sc.value, band: sc.band?.label ?? null });
      scores.set(m.key, byScale);
      const list = responseOf.get(m.key) ?? [];
      list.push({ id: result.responseId, at, session: s });
      responseOf.set(m.key, list);
    }
    if (!ids.length) continue;
    sessionScores.set(s, scores);
    history.push({ at: s.at, scores });

    /*
     * Всё, что сдача родила «сейчас», — на время сдачи: сигналы, случай,
     * срабатывания правил, закрытие набора.
     */
    await db.execute(sql`update risk_alerts a set at = r.submitted_at from responses r where r.id = a.response_id and a.response_id in ${ids}`);
    await db.execute(sql`update rule_hits h set created_at = r.submitted_at from responses r where r.id = h.response_id and h.response_id in ${ids}`);
    if (batteryAssignmentId) {
      await db.execute(sql`
        update battery_assignments set completed_at = (select max(submitted_at) from responses where id in ${ids})
        where id = ${batteryAssignmentId} and completed_at is not null`);
    }
    const psychiatristNext = sessions.find((x) => x.psychiatry && x.at > s.at && x.at - s.at < 6 * HOUR)?.at;
    await settleCases(ctx, userId, story, attending, s, ids, r, seenAt(s, booked), psychiatristNext);
  }

  /* ─── записи приёма ─── */
  const scoresUpTo = (at: number) => history.filter((h) => h.at <= at);
  const valueOf = (entry: Map<string, { value: number; band: string | null }> | undefined, key: string, scale?: string) => {
    if (!entry) return null;
    const code = scale ?? defaultScale(ctx, key);
    return code ? (entry.get(code) ?? null) : null;
  };
  const contextAt = (at: number, current: Scores | undefined, visitNo: number): NoteContext => {
    const at0 = at;
    const known = scoresUpTo(at);
    const firstOf = (key: string, scale?: string) => {
      for (const h of known) {
        const v = valueOf(h.scores.get(key), key, scale);
        if (v) return v.value;
      }
      return null;
    };
    const lastOf = (key: string, scale?: string) => {
      for (let i = known.length - 1; i >= 0; i--) {
        const v = valueOf(known[i]!.scores.get(key), key, scale);
        if (v) return v;
      }
      return null;
    };
    return {
      person: p,
      score: (key, scale) => (current ? (valueOf(current.get(key), key, scale)?.value ?? null) : (lastOf(key, scale)?.value ?? null)),
      band: (key, scale) => (current ? (valueOf(current.get(key), key, scale)?.band ?? null) : (lastOf(key, scale)?.band ?? null)),
      first: firstOf,
      last: (key, scale) => lastOf(key, scale)?.value ?? null,
      visitNo,
      clinician: attending.name,
      measuredOn: (key) => {
        const at = (responseOf.get(key) ?? []).filter((x) => x.at <= at0).at(-1)?.at;
        return at === undefined ? "—" : fmtDate(clock, at);
      },
    };
  };

  /*
   * Записи — по времени, одной нумерацией версий: протоколы приёмов
   * психолога и консультации психиатра лежат в одной истории человека.
   */
  const written: { at: number; text: string; kind: "intake" | "session" | "observation" | "consult"; appointmentId: string | null; author: string; draft: boolean }[] = [];
  let visitNo = 0;
  for (const b of booked) {
    if (b.state === "future" || b.state === "soon") continue;
    if (b.state === "past" && b.visit.outcome !== "done") continue;
    visitNo += 1;
    const session = sessions.find((s) => s.booked === b);
    const current = session ? sessionScores.get(session) : undefined;
    const c = contextAt(b.endsAt, current ?? new Map(), visitNo);
    const inProgress = b.state === "now";
    written.push({
      at: inProgress ? now - 2 * MIN : b.endsAt - (3 + Math.floor(r() * 9)) * MIN,
      text: b.visit.note ? b.visit.note(c) : "Повторна консультація за планом лікування. Стан без суттєвих змін, план продовжено.",
      kind: visitNo === 1 ? "intake" : (b.visit.noteKind ?? "session"),
      appointmentId: b.appointmentId,
      author: attending.id,
      draft: inProgress || (b.visit.draft ?? false) || (b.visit.day === -1 && p.ordinal % 9 === 0),
    });
  }
  for (const s of sessions) {
    if (!s.psychiatry || !ctx.psychiatrist) continue;
    const scores = sessionScores.get(s);
    if (!scores) continue;
    written.push({
      at: Math.min(pastLimit - 5 * MIN, s.at + (25 + Math.floor(r() * 20)) * MIN),
      text: s.psychiatry.note(contextAt(s.at + HOUR, scores, visitNo)),
      kind: "consult",
      appointmentId: null,
      author: ctx.psychiatrist.id,
      draft: false,
    });
  }
  written.sort((a, b) => a.at - b.at);
  for (const [i, w] of written.entries()) {
    const noteId = crypto.randomUUID();
    const signed = Math.min(pastLimit, w.at + (3 + Math.floor(r() * 20)) * MIN);
    await db.insert(patientNotes).values({
      id: noteId,
      userId,
      version: i + 1,
      kind: w.kind,
      text: encryptField(w.text)!,
      appointmentId: w.appointmentId,
      createdBy: w.author,
      createdAt: iso(w.at),
      // черновик — только последняя запись: поверх неподписанной версии новая не заводится (routes/notes.ts)
      ...(w.draft && i === written.length - 1 ? {} : { status: "signed" as const, signedAt: iso(signed), signedBy: w.author }),
    });
    // слепой индекс — как у записи через маршрут (routes/notes.ts): иначе поиск по записям наполнения не находил бы ничего
    const fps = indexOf(w.text).map((fp) => ({ noteId, kind: "note", userId, fp }));
    if (fps.length) await db.insert(noteSearch).values(fps).onConflictDoNothing();
    report.notes += 1;
  }

  /* ─── заключение: к прохождению той методики, по которой оно написано ─── */
  if (story.conclusion) {
    const spec = story.conclusion;
    const target = booked.find((b) => b.index === spec.visit);
    const list = responseOf.get(spec.key) ?? [];
    const chosen =
      list.find((x) => target && x.session.booked === target) ??
      [...list].reverse().find((x) => !target || x.at <= target.endsAt) ??
      list[0];
    if (chosen) {
      const c = contextAt(chosen.at, sessionScores.get(chosen.session), 0);
      const created = Math.min(pastLimit - 10 * MIN, chosen.at + (60 + Math.floor(r() * 150)) * MIN);
      await db.insert(conclusions).values({
        id: crypto.randomUUID(),
        responseId: chosen.id,
        version: 1,
        revision: 1,
        text: encryptField(spec.text(c))!,
        status: "signed",
        createdBy: attending.id,
        createdAt: iso(created),
        signedAt: iso(Math.min(pastLimit, created + (5 + Math.floor(r() * 25)) * MIN)),
        signedBy: attending.id,
        episodeId,
      });
      report.conclusions += 1;
    }
  }

  /*
   * ─── план безопасности: версии, действует последняя ───
   * Только у того, у кого критический ответ и правда записан: приём, на
   * котором его дали, мог не встать в сетку лечащего, и план без сигнала был
   * бы документом без повода.
   */
  const [critical] = await db
    .select({ id: riskAlerts.id })
    .from(riskAlerts)
    .where(and(eq(riskAlerts.userId, userId), isNotNull(riskAlerts.questionId)))
    .limit(1);
  const plans = critical ? story.safetyPlans.filter((plan) => plan.day <= 0) : [];
  for (const [i, plan] of plans.entries()) {
    const visitEnd = booked.find((b) => b.visit.day === plan.day && b.state === "past")?.endsAt;
    const at = Math.min(pastLimit, visitEnd ?? momentAt(clock, plan.day, 13 * 60 + 30));
    await db.insert(safetyPlans).values({
      id: crypto.randomUUID(),
      userId,
      version: i + 1,
      content: encryptField(JSON.stringify(plan.content(attending.name)))!,
      active: i === plans.length - 1,
      createdBy: attending.id,
      createdAt: iso(at),
      reviewedAt: iso(at),
    });
    report.safetyPlans += 1;
  }

  /* ─── направления ─── */
  for (const ref of story.referrals) {
    if (ref.day > 0) continue;
    const visitEnd = booked.find((b) => b.visit.day === ref.day && b.state === "past")?.endsAt;
    const created = Math.min(pastLimit - HOUR, visitEnd ? visitEnd + 10 * MIN : momentAt(clock, ref.day, 12 * 60 + Math.floor(r() * 180)));
    const updated = ref.updatedDay !== undefined ? Math.min(pastLimit, Math.max(created + 30 * MIN, momentAt(clock, ref.updatedDay, 15 * 60))) : null;
    // ответ, датированный будущим, ещё не пришёл: направление пока только принято
    const answered = updated !== null && (ref.updatedDay ?? 1) <= 0;
    await db.insert(referrals).values({
      id: crypto.randomUUID(),
      userId,
      destination: ref.destination,
      urgency: ref.urgency,
      status: ref.status === "completed" && !answered ? "accepted" : ref.status,
      reason: ref.reason,
      outcomeNote: answered ? (ref.outcomeNote ?? null) : null,
      createdBy: attending.id,
      createdAt: iso(created),
      episodeId,
      updatedAt: updated !== null ? iso(updated) : null,
    } as never);
    report.referrals += 1;
  }

  /* ─── диспансерный учёт ─── */
  if (story.dispensary && story.dispensary.lastSeenDay <= 0) {
    const d = story.dispensary;
    await db.insert(dispensary).values({
      patientId: userId,
      groupLabel: d.groupLabel,
      intervalMonths: d.intervalMonths,
      lastSeenAt: iso(Math.min(pastLimit, momentAt(clock, d.lastSeenDay, 11 * 60))),
      nextDueAt: iso(momentAt(clock, d.nextDueDay, 12 * 60)),
      note: d.note ?? null,
      addedBy: attending.id,
      addedAt: iso(Math.min(pastLimit, momentAt(clock, d.lastSeenDay, 11 * 60 + 30))),
    } as never);
    report.dispensary += 1;
  }

  /* ─── переписка ─── */
  const said = (story.thread ?? []).map((m) => ({ ...m, at: momentAt(clock, m.day, m.minute) })).filter((m) => m.at < pastLimit);
  if (said.length) {
    const threadId = crypto.randomUUID();
    await db.insert(threads).values({
      id: threadId,
      patientId: userId,
      specialistId: attending.id,
      createdAt: iso(said[0]!.at),
      lastMessageAt: iso(said[said.length - 1]!.at),
    } as never);
    for (const m of said) {
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        threadId,
        authorId: m.fromPatient ? userId : attending.id,
        textEnc: encryptField(m.text)!,
        sentAt: iso(m.at),
        // непрочитанное письмо пациента — работа в очереди специалиста; прочитанное — нет
        ...(m.read ? { readAt: iso(Math.min(pastLimit, m.at + (15 + Math.floor(r() * 120)) * MIN)) } : {}),
      } as never);
    }
    report.threads += 1;
  }

  /* ─── назначения: что сдано и что ждут ─── */
  await writeGrants(ctx, userId, story, attending, booked, responseOf, r);

  /* ─── исход обращения ─── */
  if (episodeId && story.episode?.closeDay !== undefined && story.episode.closeDay <= 0) {
    const closedAt = Math.min(pastLimit - HOUR, Math.max(episodeOpened + DAY_MS, momentAt(clock, story.episode.closeDay, 15 * 60)));
    await db
      .update(episodes)
      .set({
        closedAt: iso(closedAt),
        outcomeKind: story.episode.outcome ?? "improved",
        outcomeEnc: encryptField(story.episode.outcomeText ? story.episode.outcomeText(contextAt(closedAt, undefined, visitNo)) : null),
      })
      .where(eq(episodes.id, episodeId));
  }
}

/**
 * Когда лечащий видит замер: в конце приёма, к которому он сдан; после
 * осмотра психиатра; домашний — на ближайшем прошедшем приёме после сдачи.
 * null — ещё не видел: приём идёт сейчас или впереди.
 */
function seenAt(s: Session, booked: Booked[]): number | null {
  if (s.psychiatry) return s.at + 40 * MIN;
  const attended = (b: Booked) => b.state === "past" && b.visit.outcome === "done";
  if (s.booked) return attended(s.booked) ? s.booked.endsAt - 5 * MIN : null;
  const next = booked.filter((b) => attended(b) && b.startsAt > s.at).sort((a, b) => a.startsAt - b.startsAt)[0];
  return next ? next.startsAt + 10 * MIN : null;
}

/** Первая шкала методики — та, о которой говорят, называя методику («PCL-5 — 41») */
function defaultScale(ctx: FillContext, key: string): string | null {
  const id = ctx.catalog.get(key);
  const survey = id ? ctx.surveysById.get(id) : undefined;
  return survey?.scales[0]?.code ?? null;
}

/**
 * Случаи риска после замера: даты сигналов, склейка по окну и решение врача.
 *
 * attachToCase решает «тот же эпизод или новый» по своему окну от момента
 * сдачи, а сдача здесь — «сейчас»: два замера одного кризиса с разницей в
 * сутки разошлись бы по разным случаям или, наоборот, слиплись бы с
 * давним. Поэтому после передатировки случай сверяется с окном
 * по-настоящему: если у человека есть неразобранный случай, чей последний
 * сигнал не старше трёх суток до этого замера, — сигналы переходят в него.
 *
 * Разбирает лечащий — тогда, когда видит замер. Сигнал, поднятый на приёме
 * или перед ним (опросник в ожидании, C-SSRS, CIWA-Ar), разбирается на этом
 * же приёме: специалист сам оценил риск, составил план безопасности,
 * направил к психиатру. Домашний — за час-два (критический пункт) или в тот
 * же и следующий рабочий день (полоса шкалы), но не позже ближайшего
 * прошедшего приёма. Неразобранным остаётся только то, чего специалист ещё
 * не видел: свежий домашний замер у тех, чья история это задаёт
 * (Story.openFrom). Прежде открытыми оставались и случаи, поднятые на приёме:
 * двое суток «прострочено» у человека с планом безопасности и осмотром
 * психиатра в тот же день.
 */
async function settleCases(
  ctx: FillContext,
  userId: string,
  story: Story,
  attending: Clinician,
  s: Session,
  ids: string[],
  r: () => number,
  /** Когда лечащий видит этот замер (seenAt); null — ещё не видел */
  seenAt: number | null,
  /** Осмотр психиатра того же дня: решение по случаю — после него, с его данными */
  holdUntil?: number,
): Promise<number> {
  const alerts = await db
    .select({ id: riskAlerts.id, caseId: riskAlerts.caseId, questionId: riskAlerts.questionId, label: riskAlerts.label, at: riskAlerts.at })
    .from(riskAlerts)
    .where(inArray(riskAlerts.responseId, ids));
  if (!alerts.length) return 0;
  const now = ctx.clock.now;
  let caseIds = [...new Set(alerts.map((a) => a.caseId).filter((id): id is string => !!id))];
  if (!caseIds.length) return 0;

  const recompute = async (caseId: string) => {
    await db.execute(sql`
      update alert_cases c
         set opened_at = x.first, last_alert_at = x.last,
             severity = case when x.severe then 'severe' else 'moderate' end
        from (select case_id, min(at) as first, max(at) as last, bool_or(severity = 'severe') as severe
                from risk_alerts where case_id = ${caseId} group by case_id) x
       where c.id = x.case_id`);
  };
  for (const id of caseIds) await recompute(id);

  /*
   * Предыдущий случай в окне — неразобранный или разобранный уже ПОСЛЕ этих
   * сигналов (решение отложено до осмотра психиатра того же дня, holdUntil):
   * тогда сигналы осмотра ложатся в него и делят его решение.
   */
  const [previous] = await db
    .select({ id: alertCases.id, last: alertCases.lastAlertAt, ackAt: alertCases.acknowledgedAt, ackBy: alertCases.acknowledgedBy, outcome: alertCases.outcome })
    .from(alertCases)
    .where(
      and(
        eq(alertCases.userId, userId),
        sql`(${alertCases.acknowledgedAt} is null or ${alertCases.acknowledgedAt} > ${iso(s.at)})`,
        sql`${alertCases.id} not in ${caseIds}`,
      ),
    )
    .orderBy(sql`${alertCases.lastAlertAt} desc`)
    .limit(1);
  if (previous && Date.parse(previous.last) >= s.at - 72 * HOUR) {
    await db.update(riskAlerts).set({ caseId: previous.id }).where(inArray(riskAlerts.caseId, caseIds));
    await db.delete(alertCases).where(inArray(alertCases.id, caseIds));
    await recompute(previous.id);
    if (previous.ackAt) {
      await db.execute(sql`
        update alert_cases set acknowledged_at = greatest(acknowledged_at, last_alert_at + interval '5 minutes')
        where id = ${previous.id}`);
      await db.execute(sql`
        update risk_alerts a set acknowledged_by = c.acknowledged_by, acknowledged_at = c.acknowledged_at, outcome = c.outcome
          from alert_cases c where c.id = a.case_id and a.case_id = ${previous.id}`);
      return 0;
    }
    caseIds = [previous.id];
  }

  const [earlier] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(alertCases)
    .where(and(eq(alertCases.userId, userId), sql`${alertCases.id} not in ${caseIds}`));
  let made = 0;
  for (const caseId of caseIds) {
    const [row] = await db.select().from(alertCases).where(eq(alertCases.id, caseId));
    if (!row) continue;
    const opened = Date.parse(row.openedAt);
    const last = Date.parse(row.lastAlertAt);
    const assignedAt = Math.min(now - MIN, opened + (10 + Math.floor(r() * 30)) * MIN);
    const stayOpen = seenAt === null && story.openFrom !== undefined && s.day >= story.openFrom;
    if (stayOpen) {
      await db.update(alertCases).set({ assignedTo: attending.id, assignedAt: iso(assignedAt) }).where(eq(alertCases.id, caseId));
      ctx.openCases.add(caseId);
      made += 1;
      continue;
    }
    const mine = alerts.filter((a) => a.caseId === caseId || caseIds.length === 1);
    const critical = mine.some((a) => a.questionId !== null);
    const decision: CaseDecision = story.decide({
      day: s.day,
      labels: mine.map((a) => a.label),
      critical,
      first: Number(earlier?.n ?? 0) === 0,
    });
    // критический пункт разбирают в течение часа-двух, полосу шкалы — в тот же или на следующий рабочий день; увиденное на приёме — на приёме
    const delay = critical ? (20 + Math.floor(r() * 70)) * MIN : (2 + Math.floor(r() * 18)) * HOUR;
    const due = seenAt === null ? last + delay : Math.min(last + delay, seenAt);
    const ackAt = Math.max(last + 5 * MIN, Math.min(now - 2 * MIN, Math.max(due, (holdUntil ?? 0) + 30 * MIN)));
    await db
      .update(alertCases)
      .set({
        assignedTo: attending.id,
        assignedAt: iso(Math.min(assignedAt, ackAt - MIN)),
        acknowledgedBy: attending.id,
        acknowledgedAt: iso(ackAt),
        outcome: decision.outcome,
        note: decision.note,
      })
      .where(eq(alertCases.id, caseId));
    await db
      .update(riskAlerts)
      .set({ acknowledgedBy: attending.id, acknowledgedAt: iso(ackAt), outcome: decision.outcome })
      .where(eq(riskAlerts.caseId, caseId));
    ctx.report.closedCases += 1;
    made += 1;
  }
  return made;
}

/**
 * Назначения методик — одна строка на методику и человека, как в жизни.
 *
 * Сданное — назначение со сроком, по которому человек и сдал (попытка
 * потрачена). Ждущее — следующий замер, назначенный на последнем приёме: к
 * ближайшему приёму или к сроку истории; срок в прошлом без сдачи — пропуск
 * повтора, он и попадает в очередь работы (worklist, «повтор по протоколу»).
 * Строки, которые выдал набор, не трогаются: у них своё происхождение.
 */
async function writeGrants(
  ctx: FillContext,
  userId: string,
  story: Story,
  attending: Clinician,
  booked: Booked[],
  responseOf: Map<string, { id: string; at: number }[]>,
  r: () => number,
): Promise<void> {
  const { clock } = ctx;
  const pastLimit = clock.now - 5 * MIN;
  const lastVisitEnd = (day: number) => booked.find((b) => b.visit.day === day && b.state === "past")?.endsAt;
  const wanted = new Map<string, { grantedAt: number; expiresAt: number; days: number }>();

  // ждущие замеры: из истории и к ближайшим приёмам
  const pastEnds = booked.filter((b) => b.state === "past" && b.visit.outcome === "done").map((b) => b.endsAt);
  const lastPastEnd = pastEnds.length ? Math.max(...pastEnds) : null;
  const upcoming = booked.filter((b) => b.state !== "past");
  for (const b of upcoming) {
    for (const m of b.visit.measures) {
      if (m.clinician || wanted.has(m.key)) continue;
      const grantedAt = lastPastEnd ?? b.startsAt - 7 * DAY_MS;
      wanted.set(m.key, { grantedAt, expiresAt: momentAt(clock, b.offset, 23 * 60 + 59), days: Math.max(1, Math.round((b.startsAt - grantedAt) / DAY_MS)) });
    }
  }
  for (const pend of story.pending) {
    if (wanted.has(pend.key) || !ctx.catalog.has(pend.key)) continue;
    let grantedAt = lastVisitEnd(pend.grantedDay) ?? momentAt(clock, pend.grantedDay, 12 * 60);
    const lastResponse = Math.max(0, ...(responseOf.get(pend.key) ?? []).map((x) => x.at));
    grantedAt = Math.min(pastLimit, Math.max(grantedAt, lastResponse + 20 * MIN));
    const expiresAt = momentAt(clock, pend.dueDay, 23 * 60 + 59);
    if (expiresAt <= grantedAt) continue;
    wanted.set(pend.key, { grantedAt, expiresAt, days: Math.max(1, Math.round((expiresAt - grantedAt) / DAY_MS)) });
  }

  const battery = await db
    .select({ surveyId: surveyAccess.surveyId })
    .from(surveyAccess)
    .where(and(eq(surveyAccess.userId, userId), sql`${surveyAccess.viaAssignmentId} is not null`));
  const fromBattery = new Set(battery.map((x) => x.surveyId));

  for (const [key, list] of responseOf) {
    const surveyId = ctx.catalog.get(key);
    if (!surveyId || fromBattery.has(surveyId)) continue;
    const pend = wanted.get(key);
    if (pend) {
      await upsertGrant(surveyId, userId, attending.id, pend.grantedAt, pend.expiresAt, followupNote(pend.days), 0);
      wanted.delete(key);
      continue;
    }
    // сданное: назначено за день-три до последнего замера, срок — несколько дней после
    const last = Math.max(...list.map((x) => x.at));
    const grantedAt = last - (1 + Math.floor(r() * 3)) * DAY_MS;
    await upsertGrant(surveyId, userId, attending.id, grantedAt, last + (3 + Math.floor(r() * 5)) * DAY_MS, followupNote(14), 1);
  }
  for (const [key, pend] of wanted) {
    const surveyId = ctx.catalog.get(key);
    if (!surveyId || fromBattery.has(surveyId)) continue;
    await upsertGrant(surveyId, userId, attending.id, pend.grantedAt, pend.expiresAt, followupNote(pend.days), 0);
  }
}

async function upsertGrant(
  surveyId: string,
  userId: string,
  grantedBy: string,
  grantedAt: number,
  expiresAt: number,
  note: string,
  used: number,
): Promise<void> {
  const values = { grantedBy, grantedAt: iso(grantedAt), expiresAt: iso(expiresAt), note, attemptsAllowed: 1, attemptsUsed: used };
  await db
    .insert(surveyAccess)
    .values({ surveyId, userId, ...values })
    .onConflictDoUpdate({ target: [surveyAccess.surveyId, surveyAccess.userId], set: { ...values, viaAssignmentId: null } });
}

/**
 * Сегодняшний день отделения — рабочий, а не пустой.
 *
 * Будущие приёмы историй разбросаны по ближайшим двум неделям, и у одного
 * врача на сегодня их может оказаться два из шести — экран дня тогда
 * выглядит как выходной. Ближайший будущий приём тех, кто давно не был,
 * переносится на свободное сегодняшнее время, пока у врача не наберётся
 * пять приёмов (или пока есть свободное). Сдвигается только то, что ещё не
 * наступило: прошедшие приёмы и их записи не трогаются.
 */
async function fillToday(ctx: FillContext): Promise<number> {
  const { clock } = ctx;
  const dayStart = momentAt(clock, 0, 0);
  const dayEnd = momentAt(clock, 1, 0);
  let moved = 0;
  for (const c of ctx.clinicians) {
    const todays = await db
      .select({
        id: slots.id,
        startsAt: slots.startsAt,
        // словами, а не ${slots.id}: см. ClinicBook.load
        busy: sql<boolean>`exists (select 1 from appointments a where a.slot_id = slots.id and a.status <> 'cancelled')`,
      })
      .from(slots)
      .where(and(eq(slots.specialistId, c.id), eq(slots.status, "open"), sql`${slots.startsAt} >= ${iso(dayStart)}`, sql`${slots.startsAt} < ${iso(dayEnd)}`))
      .orderBy(asc(slots.startsAt));
    const free = todays.filter((s) => !s.busy && Date.parse(s.startsAt) > clock.now + 30 * MIN);
    const want = Math.min(5, todays.length) - todays.filter((s) => s.busy).length;
    if (want <= 0 || !free.length) continue;

    const here = new Set(
      (
        await db
          .select({ patientId: appointments.patientId })
          .from(appointments)
          .innerJoin(slots, eq(slots.id, appointments.slotId))
          .where(and(sql`${slots.startsAt} >= ${iso(dayStart)}`, sql`${slots.startsAt} < ${iso(dayEnd)}`, sql`${appointments.status} <> 'cancelled'`))
      ).map((x) => x.patientId),
    );
    const candidates = await db
      .select({
        id: appointments.id,
        patientId: appointments.patientId,
        last: sql<string | null>`(select max(ps.starts_at) from appointments pa join slots ps on ps.id = pa.slot_id
          where pa.patient_id = ${appointments.patientId} and pa.status = 'done')`,
      })
      .from(appointments)
      .innerJoin(slots, eq(slots.id, appointments.slotId))
      .innerJoin(users, eq(users.id, appointments.patientId))
      .where(
        and(
          eq(appointments.specialistId, c.id),
          inArray(appointments.status, ["booked", "confirmed"]),
          like(users.email, `%@${DEMO_DOMAIN}`),
          sql`${slots.startsAt} >= ${iso(dayEnd)}`,
          sql`${slots.startsAt} < ${iso(dayEnd + 6 * DAY_MS)}`,
        ),
      )
      .orderBy(asc(slots.startsAt));
    // давно не был — первым: перенос на сегодня у того, кто был позавчера, выглядел бы опиской
    const order = candidates
      .filter((x) => !here.has(x.patientId) && (!x.last || Date.parse(x.last) < clock.now - 5 * DAY_MS))
      .sort((a, b) => Date.parse(a.last ?? "1970-01-01") - Date.parse(b.last ?? "1970-01-01"));
    for (const slot of free.slice(0, want)) {
      const next = order.shift();
      if (!next) break;
      await db
        .update(appointments)
        .set({ slotId: slot.id, status: "confirmed", confirmedAt: iso(clock.now - (2 + moved) * HOUR) })
        .where(eq(appointments.id, next.id));
      here.add(next.patientId);
      moved += 1;
    }
  }
  return moved;
}

/* ═════════════ должности, приглашения ═════════════ */

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
 * Выписанные пригласительные ссылки — по одной каждого вида.
 *
 * Вкладка «Приглашения» без них открывается пустой, и посмотреть, ради чего
 * её заводили, не на чем: привязка к методике и врачу видна только на
 * выписанной ссылке. Трёх достаточно — по одной на каждый вид привязки, а
 * не по одной на каждого вымышленного человека: список из ста двадцати
 * ссылок показывал бы не работу, а стену.
 *
 * Сам токен нигде не сохраняется, и это не упущение: в базе только его хеш,
 * и «посмотреть ссылку ещё раз» невозможно намеренно. Войти по этим
 * приглашениям можно кодом — он в списке и виден.
 */
async function ensureInvites(specialistId: string, ctx: FillContext): Promise<number> {
  const [existing] = await db.select({ id: invites.id }).from(invites).where(like(invites.note, `${DEMO_NOTE}%`)).limit(1);
  if (existing) return 0;

  const survey = ctx.catalog.get("phq9") ?? [...ctx.catalog.values()][0] ?? null;
  const kinds: { surveyId: string | null; batteryId: string | null; note: string; unit: string | null }[] = [
    { surveyId: survey, batteryId: null, note: `${DEMO_NOTE}: одна методика до першого прийому`, unit: "Механізований батальйон" },
    { surveyId: null, batteryId: ctx.screeningBattery?.id ?? null, note: `${DEMO_NOTE}: набір методик на реєстрації`, unit: null },
    { surveyId: null, batteryId: null, note: `${DEMO_NOTE}: вхід без призначення`, unit: null },
  ];

  let made = 0;
  for (const [i, kind] of kinds.entries()) {
    await db.insert(invites).values({
      id: crypto.randomUUID(),
      tokenHash: hashInviteToken(newInviteToken()),
      code: newInviteCode(),
      createdBy: specialistId,
      batteryId: kind.batteryId,
      surveyId: kind.surveyId,
      /* врача ставим не всем: «ничей» вход тоже надо видеть на экране */
      specialistId: i === 2 ? null : specialistId,
      unit: kind.unit,
      note: kind.note,
      maxUses: 5,
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    } as never);
    made += 1;
  }
  return made;
}

/**
 * Набор «Первинний скринінг» каталога — по ключу заготовки, а не по названию:
 * название вправе изменить отделение (instruments/catalogBatteries.ts).
 * Нет заготовки — новые люди сдают скрининг без набора; своего набора
 * наполнение не заводит: набор, заведённый от имени настоящего сотрудника,
 * пережил бы уборку вымышленных.
 */
async function screeningBattery(): Promise<FillContext["screeningBattery"]> {
  const [row] = await db
    .select({ id: batteries.id, title: batteries.title })
    .from(batteries)
    .where(and(eq(batteries.catalogKey, "primary-screening"), eq(batteries.archived, false)))
    .limit(1);
  if (!row) return null;
  const steps = await db
    .select({ surveyId: batteryItems.surveyId, position: batteryItems.position, required: batteryItems.required })
    .from(batteryItems)
    .where(eq(batteryItems.batteryId, row.id))
    .orderBy(batteryItems.position);
  return steps.length ? { id: row.id, title: row.title, steps } : null;
}

/* ═════════════ наполнение ═════════════ */

export async function fillDemoData(count: number): Promise<FillReport> {
  const catalogRows = await db
    .select({ id: surveys.id, key: surveys.catalogKey })
    .from(surveys)
    .where(sql`${surveys.catalogKey} is not null and ${surveys.status} = 'published'`);
  if (!catalogRows.length) {
    throw new Error("Каталог методик не установлен: сначала installCatalog.ts");
  }
  const catalog = new Map(catalogRows.map((c) => [c.key!, c.id]));

  const people = makePeople(count);
  await assertSameGeneration(people);

  const [department] = await db.select().from(departments).where(isNull(departments.archivedAt)).limit(1);
  if (department) await ensureDemoSpecialist(department.id);
  const clinicians = await loadClinicians();
  if (!clinicians.length) {
    throw new Error("Нет специалиста с расписанием приёма: наполнению некого назначить лечащим");
  }
  const [home] = await db.select().from(departments).where(eq(departments.id, clinicians[0]!.departmentId));
  const clock = clockOf(home?.timezone ?? "Europe/Kyiv");

  const report: FillReport = {
    created: 0,
    existing: 0,
    responses: 0,
    appointments: 0,
    episodes: 0,
    notes: 0,
    conclusions: 0,
    safetyPlans: 0,
    openCases: 0,
    closedCases: 0,
    assignments: 0,
    referrals: 0,
    threads: 0,
    dispensary: 0,
    invites: 0,
    ladder: 0,
    archetypes: {},
  };
  const ctx: FillContext = {
    clock,
    catalog,
    surveysById: new Map(),
    clinicians,
    book: await ClinicBook.load(clock, clinicians),
    screeningBattery: await screeningBattery(),
    report,
    openCases: new Set(),
    psychiatrist: await ensureDemoPsychiatrist(clinicians[0]!.departmentId),
  };

  report.ladder = await ensureLadder(department?.id ?? null);

  for (const p of people) {
    const story = storyOf(p);
    const attending = clinicians[attendingIndex(p, clinicians.length)]!;
    const { id, created } = await ensurePerson(p, story, clock, attending.id);
    if (!created) {
      report.existing += 1;
      continue;
    }
    report.created += 1;
    report.archetypes[p.archetype] = (report.archetypes[p.archetype] ?? 0) + 1;
    await writeStory(ctx, p, id, story, attending);
  }

  report.openCases = ctx.openCases.size;
  if (report.created) await fillToday(ctx);
  report.invites = await ensureInvites(clinicians[0]!.id, ctx);
  log.info("demo.filled", { ...report, archetypes: JSON.stringify(report.archetypes) });
  return report;
}

/* ═════════════ уборка ═════════════ */

/**
 * Уборка отказала, ничего не тронув: вымышленный автор держит то, чем уже
 * пользуются настоящие люди.
 */
export class DemoPurgeRefused extends Error {}

async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (dbContext.getStore()) return fn();
  return baseDb.transaction((tx) => dbContext.run(tx as never, fn));
}

/**
 * Убрать всех вымышленных.
 *
 * Одним условием по домену почты — и явным удалением того, что каскад не
 * уносит или уносить не должен (клиническое ревью волны 12). Прежде здесь
 * стояло одно `delete from users`, и два хвоста оставались:
 *
 *   · прохождения. responses.user_id объявлен SET NULL — обезличенное
 *     прохождение не должно пропадать вместе с учётной записью. Для
 *     вымышленных это правило работало против нас: их прохождения
 *     оставались безымянными строками и считались в живой статистике и
 *     аналитике методик (на стенде ревью — 84 выдуманных прохождения после
 *     «убрать всех вымышленных»). Теперь они удаляются первыми, а с ними
 *     ответы, баллы, тревоги и срабатывания правил;
 *   · то, что вымышленный сотрудник написал сам: набор, приглашения,
 *     направления. Их авторство объявлено RESTRICT, и уборка падала на
 *     первом же наборе, если наполнение шло от demo-specialist (так бывает,
 *     когда в учреждении ещё нет специалиста с расписанием). Теперь это
 *     убирается до людей — если только настоящие люди этим не пользуются:
 *     набор, назначенный настоящему человеку, и направление на настоящего
 *     человека остаются, а уборка отказывает, ничего не удалив, и говорит,
 *     что передать настоящему сотруднику.
 *
 * С историей лечения (lib/demoStories.ts) добавились подписанные документы:
 * записи приёма, заключения, планы безопасности. Подписанное неизменяемо
 * триггерами базы (0015, 0034); уборка удаляет их явно и до людей — в
 * служебном режиме заключений (app.maintenance) и в режиме уборки заметок
 * (app.demo_purge, миграция 0135), который пропускает только заметки о
 * вымышленных. Достроенные задним числом слоты приёма (ClinicBook) уходят
 * последними, когда приёмы на них уже удалены.
 *
 * Всё — одним куском: скрипт (src/demoFill.ts) зовёт уборку в системном
 * контексте, то есть в одной транзакции, и отказ посреди пути откатывает
 * сделанное. Вне контекста уборка открывает транзакцию сама: режимы выше
 * ставятся до конца транзакции, и без неё они не дожили бы до удаления.
 */
export async function purgeDemoData(): Promise<number> {
  return inTransaction(async () => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `%@${DEMO_DOMAIN}`));
    if (!rows.length) return 0;
    const ids = rows.map((x) => x.id);
    const demo = sql`(select id from users where email like ${`%@${DEMO_DOMAIN}`})`;

    /* сначала — не держит ли вымышленный автор настоящих людей */
    const held = (await db.execute(sql`
      select 'battery' as kind, b.title as what, count(ba.*)::int as n
        from batteries b join battery_assignments ba on ba.battery_id = b.id
        where b.created_by in ${demo} and ba.user_id not in ${demo}
        group by b.id, b.title
      union all
      select 'referral', r.destination, count(*)::int
        from referrals r
        where r.created_by in ${demo} and r.user_id not in ${demo}
        group by r.destination
      union all
      select 'note', 'запис прийому', count(*)::int
        from patient_notes n
        where (n.created_by in ${demo} or n.signed_by in ${demo}) and n.user_id not in ${demo}
        having count(*) > 0
      union all
      select 'conclusion', 'заключення', count(*)::int
        from conclusions c join responses r on r.id = c.response_id
        where (c.created_by in ${demo} or c.signed_by in ${demo}) and (r.user_id is null or r.user_id not in ${demo})
        having count(*) > 0
      union all
      select 'plan', 'план безпеки', count(*)::int
        from safety_plans s
        where s.created_by in ${demo} and s.user_id not in ${demo}
        having count(*) > 0`)) as unknown as { kind: string; what: string; n: number }[];
    if (held.length) {
      const name: Record<string, string> = { battery: "набор", referral: "направление", note: "", conclusion: "", plan: "" };
      const list = held.map((h) => `${name[h.kind] ? `${name[h.kind]} ` : ""}«${h.what}»: ${h.n}`).join("; ");
      throw new DemoPurgeRefused(
        `Вымышленный сотрудник — автор того, чем пользуются настоящие люди (${list}). ` +
          "Передайте это настоящему сотруднику; уборка не начата.",
      );
    }

    /*
     * Приглашения — по пометке (их выписывает и настоящий сотрудник от имени
     * наполнения) и по вымышленному автору: без второго условия RESTRICT на
     * invites.created_by уронил бы удаление людей ниже.
     */
    await db.delete(invites).where(sql`${invites.note} like ${`${DEMO_NOTE}%`} or ${invites.createdBy} in ${demo}`);
    await db.delete(referrals).where(sql`${referrals.userId} in ${demo} or ${referrals.createdBy} in ${demo}`);
    /*
     * Наборы вымышленного автора — проверено выше, что назначены они только
     * вымышленным. Их назначения — явно и первыми: battery_assignments.battery_id
     * с миграции 0119 RESTRICT, каскада больше нет.
     */
    await db
      .delete(batteryAssignments)
      .where(sql`${batteryAssignments.batteryId} in (select id from batteries where created_by in ${demo})`);
    await db.delete(batteries).where(sql`${batteries.createdBy} in ${demo}`);

    /* подписанные документы — в своих режимах, до людей: см. докблок */
    await db.execute(sql`select set_config('app.maintenance', '1', true), set_config('app.demo_purge', '1', true)`);
    await db
      .delete(conclusions)
      .where(
        sql`${conclusions.responseId} in (select id from responses where user_id in ${demo}) or ${conclusions.createdBy} in ${demo} or ${conclusions.signedBy} in ${demo}`,
      );
    await db.delete(patientNotes).where(inArray(patientNotes.userId, ids));
    await db.execute(sql`select set_config('app.maintenance', '', true), set_config('app.demo_purge', '', true)`);
    await db.delete(safetyPlans).where(inArray(safetyPlans.userId, ids));
    await db.delete(episodes).where(inArray(episodes.patientId, ids));

    /*
     * Тревоги вымышленных — явно и до их прохождений. С волны 12
     * risk_alerts.response_id стоит на RESTRICT (0106: тревога не должна
     * исчезать каскадом вместе с удалённым черновиком), и удаление прохождений
     * ниже упёрлось бы в неё. Случаи — следом: случай без сигналов в очереди
     * ни к чему, а risk_alerts.case_id (0107) не даёт снести случай раньше.
     */
    await db
      .delete(riskAlerts)
      .where(
        sql`${riskAlerts.userId} in ${demo} or ${riskAlerts.responseId} in (select id from responses where user_id in ${demo})`,
      );
    await db.delete(alertCases).where(inArray(alertCases.userId, ids));
    const removedResponses = await db
      .delete(responses)
      .where(inArray(responses.userId, ids))
      .returning({ id: responses.id });

    /* слоты приёмов вымышленных — запомнить до того, как приёмы уйдут каскадом с людьми */
    const heldSlots = (
      await db
        .selectDistinct({ id: appointments.slotId })
        .from(appointments)
        .where(sql`${appointments.patientId} in ${demo} or ${appointments.specialistId} in ${demo}`)
    ).map((x) => x.id);

    await db.delete(users).where(inArray(users.id, ids));

    /*
     * Слоты, которые наполнение достроило в прошлое (ClinicBook): на них
     * стояли приёмы вымышленных, заведены они позже своего начала больше чем
     * на сутки — живая синхронизация в прошлое не строит, — и после
     * удаления людей на них нет ни одного приёма. Прошлый слот настоящей
     * сетки (заведён заранее) остаётся: это время отделения, а не посев.
     */
    const removedSlots = heldSlots.length
      ? await db
          .delete(slots)
          .where(
            and(
              inArray(slots.id, heldSlots),
              sql`${slots.createdAt} > ${slots.startsAt} + interval '1 day'
                  and not exists (select 1 from appointments a where a.slot_id = ${slots.id})`,
            ),
          )
          .returning({ id: slots.id })
      : [];

    log.info("demo.purged", { removed: rows.length, responses: removedResponses.length, slots: removedSlots.length });
    return rows.length;
  });
}
