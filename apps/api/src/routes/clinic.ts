import { Hono, type Context } from "hono";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  departmentSchema,
  rescheduleAppointmentSchema,
  scheduleExceptionSchema,
  scheduleTemplateSchema,
  specialistProfileSchema,
  t,
  type AppointmentView,
  type FreeSlot,
  type ScheduleExceptionView,
  type ScheduleTemplateView,
} from "@quizzy/shared";
import { db } from "../db";
import {
  appointments,
  departmentPatients,
  departments,
  scheduleExceptions,
  scheduleTemplates,
  slots,
  specialistProfiles,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, forbidden, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { HORIZON_WEEKS, syncSlots } from "../lib/schedule";
import { assertPatientAccess, isStaff } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const clinicRoutes = new Hono<AppEnv>();

clinicRoutes.use("*", requireAuth);

/** Позже этого срока отмена считается поздней и видна специалисту */
const LATE_CANCEL_HOURS = 24;

/* ═══════════ отделения и специалисты ═══════════ */

/**
 * Список отделений — открыт всем вошедшим.
 *
 * Пациент выбирает, куда записаться, ещё до того, как где-то состоит: скрыть
 * от него вывеску значило бы сделать самозапись невозможной.
 */
clinicRoutes.get("/departments", async (c) => {
  const lang = langOf(c);
  const rows = await db
    .select()
    .from(departments)
    .where(isNull(departments.archivedAt))
    .orderBy(asc(departments.id));
  return c.json({
    items: rows.map((d) => ({ id: d.id, title: t(d.title as never, lang), timezone: d.timezone })),
  });
});

clinicRoutes.post(
  "/departments",
  requireStaff,
  requirePermission("departments.manage"),
  async (c) => {
    const input = await parseBody(c.req.raw, departmentSchema);
    const id = crypto.randomUUID();
    await db.insert(departments).values({ id, title: input.title, timezone: input.timezone });
    await audit(c, { action: "clinic.department_create", resourceType: "department", resourceId: id });
    return c.json({ id }, 201);
  },
);

/** Кто принимает: список для записи. Открыт всем — пациент выбирает специалиста */
clinicRoutes.get("/specialists", async (c) => {
  const departmentId = c.req.query("departmentId");
  const rows = await db
    .select({ profile: specialistProfiles, person: users })
    .from(specialistProfiles)
    .innerJoin(users, eq(users.id, specialistProfiles.userId))
    .where(
      and(
        eq(specialistProfiles.acceptsBookings, true),
        departmentId ? eq(specialistProfiles.departmentId, departmentId) : undefined,
      ),
    );

  const me = c.get("user");
  return c.json({
    items: rows
      .map((r) => ({
        userId: r.profile.userId,
        fullName: fullNameOf(r.person),
        departmentId: r.profile.departmentId,
        position: r.profile.position,
        room: r.profile.room,
        /*
         * Свой специалист помечен и стоит первым.
         *
         * Записаться можно к любому свободному — это выбор в пользу
         * доступности. Плата за него — размывание преемственности, и гасит её
         * не запрет, а вот эта пометка: человек видит, кто его ведёт, и
         * выбирает другого осознанно, а не потому, что не разобрался.
         */
        isLead: me.leadSpecialistId === r.profile.userId,
      }))
      .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.fullName.localeCompare(b.fullName)),
  });
});

clinicRoutes.put(
  "/specialists/:userId",
  requireStaff,
  requirePermission("departments.manage"),
  async (c) => {
    const userId = c.req.param("userId");
    const input = await parseBody(c.req.raw, specialistProfileSchema);

    const person = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!person) notFound("err.userNotFound");
    if (person.role !== "admin" && person.role !== "superadmin") {
      badRequest("err.specialistMustBeStaff");
    }

    await db
      .insert(specialistProfiles)
      .values({ userId, ...input, position: input.position ?? null, room: input.room ?? null })
      .onConflictDoUpdate({
        target: specialistProfiles.userId,
        set: {
          departmentId: input.departmentId,
          position: input.position ?? null,
          room: input.room ?? null,
          defaultSlotMinutes: input.defaultSlotMinutes,
          acceptsBookings: input.acceptsBookings,
        },
      });
    await audit(c, {
      action: "clinic.specialist_profile",
      resourceType: "user",
      resourceId: userId,
      subjectUserId: userId,
    });
    return c.json({ ok: true });
  },
);

/* ═══════════ расписание специалиста ═══════════ */

/**
 * Чьё расписание правим.
 *
 * По умолчанию своё. Чужое — только с правом записывать за других: вести
 * расписание коллеги приходится, когда он в отпуске, а приём переносить надо
 * сегодня. Без этой проверки любой сотрудник переписывал бы часы любого.
 */
async function scheduleTarget(c: Context<AppEnv>) {
  const me = c.get("user");
  const asked = c.req.query("specialistId");
  if (!asked || asked === me.id) return me.id;
  const { hasPermission } = await import("../lib/permissions");
  if (!(await hasPermission(me, "appointments.manage"))) {
    forbidden("err.permissionRequired", { permission: "appointments.manage" });
  }
  return asked;
}

clinicRoutes.get("/schedule", requireStaff, requirePermission("schedule.own"), async (c) => {
  const specialistId = await scheduleTarget(c);
  const templates = await db
    .select()
    .from(scheduleTemplates)
    .where(eq(scheduleTemplates.specialistId, specialistId))
    .orderBy(asc(scheduleTemplates.weekday), asc(scheduleTemplates.startsAt));
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = await db
    .select()
    .from(scheduleExceptions)
    .where(and(eq(scheduleExceptions.specialistId, specialistId), gte(scheduleExceptions.date, today)))
    .orderBy(asc(scheduleExceptions.date));

  return c.json({
    specialistId,
    templates: templates.map(
      (r): ScheduleTemplateView => ({
        id: r.id,
        weekday: r.weekday,
        startsAt: r.startsAt.slice(0, 5),
        endsAt: r.endsAt.slice(0, 5),
        slotMinutes: r.slotMinutes,
        kind: r.kind,
        capacity: r.capacity,
      }),
    ),
    exceptions: exceptions.map(
      (r): ScheduleExceptionView => ({
        id: r.id,
        date: r.date,
        kind: r.kind,
        startsAt: r.startsAt?.slice(0, 5) ?? null,
        endsAt: r.endsAt?.slice(0, 5) ?? null,
        slotMinutes: r.slotMinutes,
        note: r.note,
      }),
    ),
    horizonWeeks: HORIZON_WEEKS,
  });
});

/**
 * Обычная неделя задаётся целиком, а не по строке.
 *
 * Расписание читают как картину недели, и правят так же: «по вторникам с
 * девяти до часу, по четвергам с двух». Правка по одной строке заставила бы
 * собирать эту картину из отдельных запросов и позволила бы половине правок
 * доехать, а половине нет.
 */
clinicRoutes.put("/schedule", requireStaff, requirePermission("schedule.own"), async (c) => {
  const specialistId = await scheduleTarget(c);
  const input = await parseBody(
    c.req.raw,
    z.object({ templates: z.array(scheduleTemplateSchema).max(60) }),
  );

  await db.delete(scheduleTemplates).where(eq(scheduleTemplates.specialistId, specialistId));
  if (input.templates.length) {
    await db.insert(scheduleTemplates).values(
      input.templates.map((tpl) => ({ id: crypto.randomUUID(), specialistId, ...tpl })),
    );
  }

  const result = await syncSlots(specialistId);
  await audit(c, {
    action: "clinic.schedule_update",
    resourceType: "user",
    resourceId: specialistId,
    details: { rows: input.templates.length, ...result },
  });
  return c.json({ ok: true, ...result });
});

clinicRoutes.post(
  "/schedule/exceptions",
  requireStaff,
  requirePermission("schedule.own"),
  async (c) => {
    const specialistId = await scheduleTarget(c);
    const input = await parseBody(c.req.raw, scheduleExceptionSchema);
    const id = crypto.randomUUID();
    await db.insert(scheduleExceptions).values({
      id,
      specialistId,
      date: input.date,
      kind: input.kind,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      slotMinutes: input.slotMinutes ?? null,
      note: input.note ?? null,
      createdBy: c.get("user").id,
    });
    const result = await syncSlots(specialistId);
    await audit(c, {
      action: "clinic.schedule_exception",
      resourceType: "user",
      resourceId: specialistId,
      details: { date: input.date, kind: input.kind, ...result },
    });
    return c.json({ id, ...result }, 201);
  },
);

clinicRoutes.delete(
  "/schedule/exceptions/:id",
  requireStaff,
  requirePermission("schedule.own"),
  async (c) => {
    const row = await db.query.scheduleExceptions.findFirst({
      where: eq(scheduleExceptions.id, c.req.param("id")),
    });
    if (!row) notFound("err.scheduleExceptionNotFound");
    const me = c.get("user");
    if (row.specialistId !== me.id) {
      const { hasPermission } = await import("../lib/permissions");
      if (!(await hasPermission(me, "appointments.manage"))) {
        forbidden("err.permissionRequired", { permission: "appointments.manage" });
      }
    }
    await db.delete(scheduleExceptions).where(eq(scheduleExceptions.id, row.id));
    const result = await syncSlots(row.specialistId);
    await audit(c, {
      action: "clinic.schedule_exception_delete",
      resourceType: "user",
      resourceId: row.specialistId,
      details: { date: row.date, ...result },
    });
    return c.json({ ok: true, ...result });
  },
);

/* ═══════════ свободное время ═══════════ */

const slotQuery = z.object({
  specialistId: z.string().optional(),
  departmentId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  kind: z.enum(["primary", "repeat"]).optional(),
});

/** К каким отделениям человек прикреплён */
async function attachedDepartments(patientId: string): Promise<string[]> {
  const rows = await db
    .select({ departmentId: departmentPatients.departmentId })
    .from(departmentPatients)
    .where(and(eq(departmentPatients.patientId, patientId), isNull(departmentPatients.detachedAt)));
  return rows.map((r) => r.departmentId);
}

/**
 * Свободное время.
 *
 * Первичные слоты видит любой зарегистрированный: прикрепление к отделению
 * создаётся самой записью, и требовать его заранее значило бы требовать
 * прийти, чтобы получить право прийти. Повторные — только прикреплённые.
 *
 * Занятость считается здесь, а не хранится в слоте: число живых приёмов
 * против вместимости. Отменённый приём освобождает место сам собой, без
 * отдельного шага, который можно забыть.
 */
clinicRoutes.get("/slots", async (c) => {
  const q = parseQuery(c, slotQuery);
  const me = c.get("user");
  const now = new Date().toISOString();
  const from = q.from && q.from > now ? q.from : now;
  const to = q.to ?? new Date(Date.now() + HORIZON_WEEKS * 7 * 24 * 3600 * 1000).toISOString();

  const rows = await db
    .select({ slot: slots, person: users, profile: specialistProfiles })
    .from(slots)
    .innerJoin(users, eq(users.id, slots.specialistId))
    .leftJoin(specialistProfiles, eq(specialistProfiles.userId, slots.specialistId))
    .where(
      and(
        eq(slots.status, "open"),
        eq(slots.offSchedule, false),
        gte(slots.startsAt, from),
        lte(slots.startsAt, to),
        q.specialistId ? eq(slots.specialistId, q.specialistId) : undefined,
        q.departmentId ? eq(slots.departmentId, q.departmentId) : undefined,
      ),
    )
    .orderBy(asc(slots.startsAt))
    .limit(2000);

  if (!rows.length) return c.json({ items: [] });

  const taken = await db
    .select({ slotId: appointments.slotId, n: sql<number>`count(*)` })
    .from(appointments)
    .where(
      and(
        inArray(appointments.slotId, rows.map((r) => r.slot.id)),
        ne(appointments.status, "cancelled"),
      ),
    )
    .groupBy(appointments.slotId);
  const busy = new Map(taken.map((t) => [t.slotId, Number(t.n)]));

  const attached = isStaff(me) ? null : new Set(await attachedDepartments(me.id));

  const items: FreeSlot[] = rows
    .filter((r) => {
      const free = r.slot.capacity - (busy.get(r.slot.id) ?? 0);
      if (free <= 0) return false;
      if (q.kind && r.slot.kind !== "any" && r.slot.kind !== q.kind) return false;
      // повторный приём — только прикреплённым; персонал видит всё
      if (attached && r.slot.kind === "repeat" && !attached.has(r.slot.departmentId)) return false;
      return true;
    })
    .map((r) => ({
      id: r.slot.id,
      specialistId: r.slot.specialistId,
      specialistName: fullNameOf(r.person),
      room: r.profile?.room ?? null,
      startsAt: r.slot.startsAt,
      endsAt: r.slot.endsAt,
      kind: r.slot.kind,
      free: r.slot.capacity - (busy.get(r.slot.id) ?? 0),
      capacity: r.slot.capacity,
    }));

  return c.json({ items });
});

/* ═══════════ запись ═══════════ */

/** Первичный или повторный — решает не пациент, а история: был ли уже приём здесь */
async function appointmentKind(patientId: string, departmentId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(
      and(
        eq(appointments.patientId, patientId),
        eq(slots.departmentId, departmentId),
        inArray(appointments.status, ["done", "arrived", "in_progress"]),
      ),
    );
  return Number(row?.n ?? 0) > 0 ? ("repeat" as const) : ("primary" as const);
}

/**
 * Занять слот.
 *
 * Строка слота берётся под замок до подсчёта занятых мест. Без замка два
 * человека, нажавших «записаться» одновременно, оба увидели бы свободное
 * место и оба записались бы: проверка «мест меньше вместимости» и вставка —
 * это два действия, и между ними успевает вклиниться чужая запись.
 *
 * Уникальным индексом это не выражается: он умеет запретить дубль, но не
 * умеет считать до вместимости. Замок на строке слота сериализует запись
 * именно в этот слот и не мешает записи в соседние.
 */
async function takeSlot(slotId: string): Promise<typeof slots.$inferSelect> {
  /*
   * Замок берётся сырым запросом, а строка читается через drizzle.
   *
   * Первая редакция делала одним `select *` и объявляла результат строкой
   * слота — а сырой ответ приходит в колонках базы, snake_case. Дальше
   * specialist_id молча становился undefined при вставке приёма, и, что
   * хуже, проверка «время уже прошло» сравнивала NaN и не срабатывала
   * никогда: приём на вчера прошёл бы без единого возражения.
   *
   * Поэтому здесь ровно то, ради чего запрос сырой, — `for update`, — а
   * данные берёт тот, кто умеет их разбирать.
   */
  await db.execute(sql`select id from slots where id = ${slotId} for update`);
  const slot = await db.query.slots.findFirst({ where: eq(slots.id, slotId) });
  if (!slot) notFound("err.slotNotFound");
  if (slot.status !== "open") badRequest("err.slotClosed");
  if (new Date(slot.startsAt).getTime() <= Date.now()) badRequest("err.slotInPast");

  const [busy] = await db
    .select({ n: sql<number>`count(*)` })
    .from(appointments)
    .where(and(eq(appointments.slotId, slotId), ne(appointments.status, "cancelled")));
  if (Number(busy?.n ?? 0) >= slot.capacity) badRequest("err.slotTaken");
  return slot;
}

clinicRoutes.post("/appointments", async (c) => {
  const input = await parseBody(c.req.raw, bookAppointmentSchema);
  const me = c.get("user");

  /*
   * За другого записывает только тот, кому это разрешено. Пациент из мобилки
   * записывает себя и не передаёт идентификатора вовсе: подставить чужой было
   * бы способом занять слот за постороннего.
   */
  let patientId = me.id;
  if (input.patientId && input.patientId !== me.id) {
    if (!isStaff(me)) forbidden("err.bookForSelfOnly");
    const { hasPermission } = await import("../lib/permissions");
    if (!(await hasPermission(me, "appointments.manage"))) {
      forbidden("err.permissionRequired", { permission: "appointments.manage" });
    }
    patientId = input.patientId;
  }

  const slot = await takeSlot(input.slotId);
  const kind = await appointmentKind(patientId, slot.departmentId);

  if (slot.kind !== "any" && slot.kind !== kind) {
    badRequest(kind === "primary" ? "err.slotForRepeatOnly" : "err.slotForPrimaryOnly");
  }

  const attached = await attachedDepartments(patientId);
  if (kind === "repeat" && !attached.includes(slot.departmentId)) {
    badRequest("err.notAttachedToDepartment");
  }

  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId: slot.id,
    patientId,
    specialistId: slot.specialistId,
    kind,
    mode: input.mode,
    meetingUrl: input.meetingUrl ?? null,
    reasonEnc: input.reason ? encryptField(input.reason) : null,
    bookedBy: me.id,
  });

  /*
   * Прикрепление создаётся самой записью на первичный приём.
   *
   * Отдельного действия «прикрепить», которое кто-то должен не забыть
   * сделать, нет: человек с телефона доходит до приёма без участия
   * сотрудника, и ровно ради этого всё затевалось.
   */
  if (kind === "primary" && !attached.includes(slot.departmentId)) {
    await db
      .insert(departmentPatients)
      .values({
        departmentId: slot.departmentId,
        patientId,
        attachedVia: me.id === patientId ? "visit" : "staff",
      })
      .onConflictDoNothing();
  }

  await audit(c, {
    action: "clinic.book",
    resourceType: "appointment",
    resourceId: id,
    subjectUserId: patientId,
    details: { slotId: slot.id, kind, bySelf: me.id === patientId },
  });
  return c.json({ id, kind }, 201);
});

/** Приём вместе со слотом и людьми — общая заготовка для всех списков */
async function loadAppointments(where: ReturnType<typeof and>) {
  const rows = await db
    .select({
      row: appointments,
      slot: slots,
      specialist: users,
    })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.specialistId))
    .where(where)
    .orderBy(asc(slots.startsAt));
  if (!rows.length) return [];

  const patientIds = [...new Set(rows.map((r) => r.row.patientId))];
  const patientRows = await db.select().from(users).where(inArray(users.id, patientIds));
  const patientNames = new Map(patientRows.map((p) => [p.id, fullNameOf(p)]));
  const leads = new Map(patientRows.map((p) => [p.id, p.leadSpecialistId ?? null]));

  const profileRows = await db
    .select()
    .from(specialistProfiles)
    .where(inArray(specialistProfiles.userId, [...new Set(rows.map((r) => r.row.specialistId))]));
  const rooms = new Map(profileRows.map((p) => [p.userId, p.room]));

  /*
   * Назначенное, но не сданное — одним запросом на весь список.
   *
   * Считается по двум источникам сразу: персональные назначения методик и
   * батареи. Разделять их на экране незачем — специалисту важно, что человек
   * пришёл без того, что должен был принести, а не какой формой это было
   * назначено.
   *
   * Отменённые батареи не в счёт: их и не ждали.
   */
  const pendingRows = await db.execute<{ user_id: string; n: number }>(
    sql`
      select u.id as user_id, (
        (select count(*) from survey_access sa
          where sa.user_id = u.id
            and (sa.expires_at is null or sa.expires_at > now())
            and not exists (
              select 1 from responses r
              where r.user_id = u.id and r.survey_id = sa.survey_id and r.status = 'completed'))
        +
        (select count(*) from battery_assignments ba
          join battery_items bi on bi.battery_id = ba.battery_id
          where ba.user_id = u.id and ba.cancelled_at is null
            and not exists (
              select 1 from responses r
              where r.user_id = u.id and r.survey_id = bi.survey_id and r.status = 'completed'))
      )::int as n
      from users u where u.id in ${patientIds}
    `,
  );
  const pending = new Map(pendingRows.map((r) => [r.user_id, Number(r.n)]));

  return rows.map(
    (r): AppointmentView => ({
      id: r.row.id,
      slotId: r.row.slotId,
      startsAt: r.slot.startsAt,
      endsAt: r.slot.endsAt,
      kind: r.row.kind,
      mode: r.row.mode,
      meetingUrl: r.row.meetingUrl,
      status: r.row.status,
      specialistId: r.row.specialistId,
      specialistName: fullNameOf(r.specialist),
      room: rooms.get(r.row.specialistId) ?? null,
      patientId: r.row.patientId,
      patientName: patientNames.get(r.row.patientId) ?? "—",
      reason: decryptField(r.row.reasonEnc),
      bookedAt: r.row.bookedAt,
      confirmedAt: r.row.confirmedAt,
      offSchedule: r.slot.offSchedule,
      leadSpecialistId: leads.get(r.row.patientId) ?? null,
      pendingAssignments: pending.get(r.row.patientId) ?? 0,
    }),
  );
}

/** Свои приёмы — то, что видит пациент в мобилке */
clinicRoutes.get("/appointments/mine", async (c) => {
  const me = c.get("user");
  const past = c.req.query("past") === "1";
  const items = await loadAppointments(
    and(
      eq(appointments.patientId, me.id),
      past ? undefined : gte(slots.startsAt, new Date().toISOString()),
      past ? undefined : ne(appointments.status, "cancelled"),
    )!,
  );
  return c.json({ items });
});

/**
 * Кто и что от меня ждёт сегодня.
 *
 * Отдаётся весь день целиком, включая уже принятых: «Сегодня» — это картина
 * дня, а не очередь. Убери отработанные — и специалист потеряет возможность
 * вернуться к записи предыдущего приёма.
 */
clinicRoutes.get("/today", requireStaff, requirePermission("patients.read"), async (c) => {
  const specialistId = c.req.query("specialistId") ?? c.get("user").id;

  /*
   * Сутки считаются по часам отделения, а не по часам сервера.
   *
   * `::timestamptz` берёт пояс сессии Postgres — то есть пояс машины, где
   * запущена база. Приём в девять вечера по Киеву при сервере в UTC попал бы
   * в тот же день, а вот при сервере западнее — во вчерашний, и специалист
   * просто не увидел бы его в своём дне.
   */
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, specialistId),
  });
  const department = profile
    ? await db.query.departments.findFirst({ where: eq(departments.id, profile.departmentId) })
    : null;
  const tz = department?.timezone ?? "Europe/Kyiv";

  const nowLocal = await db.execute<{ today: string }>(
    sql`select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as today`,
  );
  const date = c.req.query("date") ?? nowLocal[0]!.today;

  const items = await loadAppointments(
    and(
      eq(appointments.specialistId, specialistId),
      ne(appointments.status, "cancelled"),
      sql`${slots.startsAt} >= (${`${date} 00:00`}::timestamp at time zone ${tz})`,
      sql`${slots.startsAt} < (${`${date} 00:00`}::timestamp at time zone ${tz}) + interval '1 day'`,
    )!,
  );

  await audit(c, {
    action: "clinic.today",
    details: { date, specialistId, count: items.length },
  });
  return c.json({ date, items });
});

/**
 * Приём, к которому у спрашивающего есть отношение.
 *
 * Проверка своя, а не «RLS уже отфильтровала». Политика на таблице есть, но
 * опираться на неё как на единственный заслон нельзя: она действует, только
 * если приложение ходит в базу не владельцем таблиц, а это свойство
 * развёртывания, а не кода. Прикладная проверка работает при любой настройке
 * подключения, и снять её значит поставить защиту в зависимость от того, под
 * какой учётной записью запущен сервер.
 *
 * Постороннему отвечаем «не найдено», а не «нельзя»: 403 подтвердил бы, что
 * приём существует, — а это уже сведения о человеке.
 */
async function loadOne(c: Context<AppEnv>, id: string) {
  const row = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!row) notFound("err.appointmentNotFound");
  const me = c.get("user");
  const mine = row.patientId === me.id || row.specialistId === me.id;
  if (!mine && !isStaff(me)) notFound("err.appointmentNotFound");
  return row;
}

/** Подтверждение приёма пациентом — за сутки, одним нажатием */
clinicRoutes.post("/appointments/:id/confirm", async (c) => {
  const row = await loadOne(c, c.req.param("id"));
  const me = c.get("user");
  if (row.patientId !== me.id) forbidden("err.confirmSelfOnly");
  if (row.status !== "booked") badRequest("err.appointmentNotPending");

  await db
    .update(appointments)
    .set({ status: "confirmed", confirmedAt: new Date().toISOString() })
    .where(eq(appointments.id, row.id));
  await audit(c, {
    action: "clinic.confirm",
    resourceType: "appointment",
    resourceId: row.id,
    subjectUserId: row.patientId,
  });
  return c.json({ ok: true });
});

/**
 * Перенос — это отмена и запись одним действием.
 *
 * Отдельной операцией, а не двумя запросами клиента: между ними слот успевает
 * занять кто-то другой, и человек остаётся вообще без приёма, отменив тот,
 * который у него был.
 */
clinicRoutes.post("/appointments/:id/reschedule", async (c) => {
  const row = await loadOne(c, c.req.param("id"));
  const me = c.get("user");
  const input = await parseBody(c.req.raw, rescheduleAppointmentSchema);

  if (row.patientId !== me.id) {
    if (!isStaff(me)) forbidden("err.rescheduleSelfOnly");
    const { hasPermission } = await import("../lib/permissions");
    if (!(await hasPermission(me, "appointments.manage"))) {
      forbidden("err.permissionRequired", { permission: "appointments.manage" });
    }
  }
  if (["done", "no_show", "cancelled"].includes(row.status)) badRequest("err.appointmentClosed");

  const slot = await takeSlot(input.slotId);
  if (slot.kind !== "any" && slot.kind !== row.kind) {
    badRequest(row.kind === "primary" ? "err.slotForRepeatOnly" : "err.slotForPrimaryOnly");
  }

  await db
    .update(appointments)
    .set({
      slotId: slot.id,
      specialistId: slot.specialistId,
      // подтверждение относилось к прежнему времени и на новое не переносится
      status: "booked",
      confirmedAt: null,
    })
    .where(eq(appointments.id, row.id));

  await audit(c, {
    action: "clinic.reschedule",
    resourceType: "appointment",
    resourceId: row.id,
    subjectUserId: row.patientId,
    details: { from: row.slotId, to: slot.id, bySelf: me.id === row.patientId },
  });
  return c.json({ ok: true });
});

/**
 * Отмена.
 *
 * За сутки и раньше — свободно. Позже — тоже можно, но событие помечается и
 * видно специалисту так же, как неявка.
 *
 * Запрета на позднюю отмену нет намеренно: он не удерживает человека, а
 * меняет позднюю отмену на молчаливую неявку — специалист теряет и слот, и
 * сигнал. Разрешённая отмена оставляет хотя бы сигнал, а часто и
 * освободившееся время.
 */
clinicRoutes.post("/appointments/:id/cancel", async (c) => {
  const row = await loadOne(c, c.req.param("id"));
  const me = c.get("user");
  const input = await parseBody(c.req.raw, cancelAppointmentSchema);

  if (row.patientId !== me.id && row.specialistId !== me.id) {
    if (!isStaff(me)) forbidden("err.cancelSelfOnly");
    const { hasPermission } = await import("../lib/permissions");
    if (!(await hasPermission(me, "appointments.manage"))) {
      forbidden("err.permissionRequired", { permission: "appointments.manage" });
    }
  }
  if (["done", "cancelled"].includes(row.status)) badRequest("err.appointmentClosed");

  const [slot] = await db.select().from(slots).where(eq(slots.id, row.slotId));
  const hoursLeft = (new Date(slot!.startsAt).getTime() - Date.now()) / 3600000;
  const late = hoursLeft < LATE_CANCEL_HOURS && hoursLeft > 0;

  await db
    .update(appointments)
    .set({
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancelledBy: me.id,
      cancelledLate: late,
    })
    .where(eq(appointments.id, row.id));

  await audit(c, {
    action: "clinic.cancel",
    resourceType: "appointment",
    resourceId: row.id,
    subjectUserId: row.patientId,
    details: { late, hoursLeft: Math.round(hoursLeft), reason: input.reason ?? null, by: me.id },
  });
  return c.json({ ok: true, late });
});

/**
 * Движение приёма: пришёл — начали — закончили, либо не пришёл.
 *
 * Каждый переход в журнал. Явка отмечается одним нажатием — это то место, где
 * экономится время: специалист не заполняет форму, а нажимает кнопку.
 */
const NEXT: Record<string, string[]> = {
  booked: ["arrived", "no_show"],
  confirmed: ["arrived", "no_show"],
  arrived: ["in_progress", "no_show"],
  in_progress: ["done"],
  /*
   * Из неявки можно вернуться в «пришёл», и это не послабление.
   *
   * Неявку ставит не только человек, но и фоновый проход — по тому, что
   * через два часа после конца приёма никто ничего не нажал. Специалист,
   * забывший нажать «пришёл» между двумя приёмами, получил бы неявку у
   * человека, который у него сидел, — и без обратного перехода это уже не
   * исправить: пошло бы напоминание тому, кто пришёл.
   */
  no_show: ["arrived"],
};

clinicRoutes.post(
  "/appointments/:id/status",
  requireStaff,
  requirePermission("appointments.manage"),
  async (c) => {
    const row = await loadOne(c, c.req.param("id"));
    const input = await parseBody(
      c.req.raw,
      z.object({ status: z.enum(["arrived", "in_progress", "done", "no_show"]) }),
    );

    /*
     * Переходы заданы списком, а не проверяются по одному условию: «закончили
     * приём, на который человек не приходил» — это не редкость, а обычная
     * ошибка нажатия, и она портит и статистику неявок, и хронологию.
     */
    if (!NEXT[row.status]?.includes(input.status)) {
      badRequest("err.appointmentBadTransition", { from: row.status, to: input.status });
    }

    const now = new Date().toISOString();
    await db
      .update(appointments)
      .set({
        status: input.status,
        ...(input.status === "arrived" && { arrivedAt: now }),
        ...(input.status === "in_progress" && { startedAt: now }),
        ...(input.status === "done" && { finishedAt: now }),
      })
      .where(eq(appointments.id, row.id));

    await audit(c, {
      action: "clinic.status",
      resourceType: "appointment",
      resourceId: row.id,
      subjectUserId: row.patientId,
      details: { from: row.status, to: input.status },
    });
    return c.json({ ok: true });
  },
);

/**
 * Закрепить пациента за собой.
 *
 * Явное действие, а не следствие приёма: иначе один визит к коллеге на замене
 * молча переназначал бы ведущего, и переписка пациента уходила бы не тому
 * человеку. На первом приёме кнопка стоит уже отмеченной — специалист снимает
 * её, если ведёт разово, а не ставит, если ведёт.
 */
clinicRoutes.post(
  "/patients/:userId/lead",
  requireStaff,
  requirePermission("patients.read"),
  async (c) => {
    const patientId = c.req.param("userId");
    const me = c.get("user");

    /*
     * Зона ответственности проверяется до разбора тела.
     *
     * Право отвечает «что можно делать», зона — «над кем», и второе здесь не
     * следует из первого: patients.read есть у каждого специалиста, а чужой
     * пациент своим от этого не становится. Проверка полноты зоны это и
     * поймала — маршрут отвечал о человеке вне зоны разбором тела.
     */
    await assertPatientAccess(me, patientId);
    const input = await parseBody(c.req.raw, z.object({ take: z.boolean() }));

    const person = await db.query.users.findFirst({ where: eq(users.id, patientId) });
    if (!person) notFound("err.userNotFound");

    // снять можно только своё закрепление: смена ведущего — это перевод человека
    if (!input.take && person.leadSpecialistId && person.leadSpecialistId !== me.id) {
      forbidden("err.leadNotYours");
    }

    await db
      .update(users)
      .set({ leadSpecialistId: input.take ? me.id : null })
      .where(eq(users.id, patientId));
    await audit(c, {
      action: input.take ? "clinic.lead_take" : "clinic.lead_release",
      resourceType: "user",
      resourceId: patientId,
      subjectUserId: patientId,
      details: { previous: person.leadSpecialistId },
    });
    return c.json({ ok: true });
  },
);
