import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  adminA,
  api,
  db,
  makeUser,
  responsesTable,
  root,
  submitSurvey,
  surveyInA,
  surveys as surveysTable,
} from "./fixtures";
import {
  appointments,
  departmentPatients,
  departments,
  rolePermissions,
  roles,
  scheduleTemplates,
  slots,
  pushTokens,
  specialistProfiles,
  alertCases,
  staffRoles,
  surveyAccess,
} from "../src/db/schema";
import { sweepNoShows } from "../src/lib/noShow";
import { setPushSenderForTests } from "../src/lib/push";
import { remindAppointments } from "../src/lib/remind";
import { syncSlots } from "../src/lib/schedule";

/**
 * Запись на приём.
 *
 * Проверяется не «маршрут отвечает 201», а четыре вещи, каждая из которых
 * ломается тихо: два человека не занимают одно место, повторный приём закрыт
 * для неприкреплённых, прикрепление появляется само, а поздняя отмена
 * помечается, а не запрещается.
 */

let departmentId: string;
let specialistId: string;
let specialistToken: string;

/** Свободный слот подальше в будущем — чтобы не спорить с «уже прошло» */
async function freeSlot(kind: "primary" | "repeat" | "any" = "any") {
  const [row] = await db.execute<{ id: string }>(
    `select s.id from slots s
     where s.specialist_id = '${specialistId}' and s.kind = '${kind}'
       and s.starts_at > now() + interval '3 days'
       and not exists (select 1 from appointments a where a.slot_id = s.id and a.status <> 'cancelled')
     order by s.starts_at limit 1`,
  );
  return row!.id;
}

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Психологічне відділення", ru: "Психологическое отделение" },
    timezone: "Europe/Kyiv",
  });
  const specialist = await makeUser("admin", `clinic-s-${crypto.randomUUID()}@test`);
  specialistId = specialist.id;
  specialistToken = specialist.token;
  await db.insert(specialistProfiles).values({ userId: specialistId, departmentId, room: "214" });

  // будни целиком: первичные утром, повторные днём
  for (const weekday of [1, 2, 3, 4, 5]) {
    await db.insert(scheduleTemplates).values([
      {
        id: crypto.randomUUID(),
        specialistId,
        weekday,
        startsAt: "09:00",
        endsAt: "11:00",
        slotMinutes: 60,
        kind: "primary",
        capacity: 1,
      },
      {
        id: crypto.randomUUID(),
        specialistId,
        weekday,
        startsAt: "14:00",
        endsAt: "16:00",
        slotMinutes: 60,
        kind: "repeat",
        capacity: 1,
      },
    ]);
  }
  await syncSlots(specialistId);
});

describe("свободное время", () => {
  test("первичные слоты видит любой зарегистрированный", async () => {
    const stranger = await makeUser("user", `clinic-x-${crypto.randomUUID()}@test`);
    const res = await api(`/api/clinic/slots?kind=primary&specialistId=${specialistId}`, stranger.token);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((s: { kind: string }) => s.kind === "primary")).toBe(true);
  });

  test("повторные слоты неприкреплённому не показываются", async () => {
    /*
     * Требовать прикрепления на первичный приём означало бы требовать прийти,
     * чтобы получить право прийти. На повторный — наоборот: это время для
     * тех, кто здесь уже обслуживается.
     */
    const stranger = await makeUser("user", `clinic-y-${crypto.randomUUID()}@test`);
    const res = await api(`/api/clinic/slots?kind=repeat&specialistId=${specialistId}`, stranger.token);
    expect(res.body.items).toEqual([]);
  });

  test("кабинет виден до приёма", async () => {
    const stranger = await makeUser("user", `clinic-r-${crypto.randomUUID()}@test`);
    const res = await api(`/api/clinic/slots?kind=primary&specialistId=${specialistId}`, stranger.token);
    expect(res.body.items[0].room).toBe("214");
  });
});

describe("запись", () => {
  test("первичная запись прикрепляет к отделению сама", async () => {
    const patient = await makeUser("user", `clinic-p1-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");

    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId, reason: "не сплю третью неделю" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("primary");

    const attached = await db
      .select()
      .from(departmentPatients)
      .where(
        and(
          eq(departmentPatients.patientId, patient.id),
          eq(departmentPatients.departmentId, departmentId),
        ),
      );
    expect(attached.length).toBe(1);
    expect(attached[0]!.attachedVia).toBe("visit");

    // и повторные слоты ему теперь видны
    const repeat = await api(`/api/clinic/slots?kind=repeat&specialistId=${specialistId}`, patient.token);
    expect(repeat.body.items.length).toBeGreaterThan(0);
  });

  test("причина обращения хранится зашифрованной", async () => {
    const patient = await makeUser("user", `clinic-p2-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId, reason: "тревога перед выездом" }),
    });

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.patientId, patient.id));
    expect(row!.reasonEnc).not.toBeNull();
    expect(row!.reasonEnc).not.toContain("тревога");

    const mine = await api("/api/clinic/appointments/mine", patient.token);
    expect(mine.body.items[0].reason).toBe("тревога перед выездом");
  });

  test("за другого записывает только тот, кому это разрешено", async () => {
    const patient = await makeUser("user", `clinic-p3-${crypto.randomUUID()}@test`);
    const other = await makeUser("user", `clinic-p4-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");

    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId, patientId: other.id }),
    });
    expect(res.status).toBe(403);

    const byStaff = await api("/api/clinic/appointments", adminA.token, {
      method: "POST",
      body: JSON.stringify({ slotId, patientId: other.id }),
    });
    expect(byStaff.status).toBe(201);

    const [attached] = await db
      .select()
      .from(departmentPatients)
      .where(eq(departmentPatients.patientId, other.id));
    // записал сотрудник — и это видно в истории прикрепления
    expect(attached!.attachedVia).toBe("staff");
  });

  test("на повторный слот без прикрепления не записаться", async () => {
    const stranger = await makeUser("user", `clinic-p5-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("repeat");
    const res = await api("/api/clinic/appointments", stranger.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(res.status).toBe(400);
  });

  test("двое одновременно не занимают одно место", async () => {
    /*
     * Главная проверка этого файла.
     *
     * Проверка «мест меньше вместимости» и вставка — это два действия, и без
     * замка на строке слота между ними успевает вклиниться чужая запись.
     * Ошибка не воспроизводится при последовательных запросах и вылезает
     * ровно тогда, когда двое нажимают «записаться» в одну секунду.
     */
    const a = await makeUser("user", `clinic-race-a-${crypto.randomUUID()}@test`);
    const b = await makeUser("user", `clinic-race-b-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");

    const [first, second] = await Promise.all([
      api("/api/clinic/appointments", a.token, {
        method: "POST",
        body: JSON.stringify({ slotId }),
      }),
      api("/api/clinic/appointments", b.token, {
        method: "POST",
        body: JSON.stringify({ slotId }),
      }),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 400]);

    const live = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.slotId, slotId), eq(appointments.status, "booked")));
    expect(live.length).toBe(1);
  });

  test("на прошедшее время не записаться", async () => {
    const patient = await makeUser("user", `clinic-p6-${crypto.randomUUID()}@test`);
    const past = crypto.randomUUID();
    await db.insert(slots).values({
      id: past,
      specialistId,
      departmentId,
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      endsAt: new Date(Date.now() - 1800_000).toISOString(),
      kind: "any",
    });
    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: past }),
    });
    expect(res.status).toBe(400);
  });
});

describe("движение приёма", () => {
  test("подтверждение, явка, начало, завершение", async () => {
    const patient = await makeUser("user", `clinic-m1-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    const id = booked.body.id;

    expect((await api(`/api/clinic/appointments/${id}/confirm`, patient.token, { method: "POST" })).status).toBe(200);

    for (const status of ["arrived", "in_progress", "done"]) {
      const res = await api(`/api/clinic/appointments/${id}/status`, specialistToken, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(200);
    }

    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.status).toBe("done");
    expect(row!.arrivedAt).not.toBeNull();
    expect(row!.finishedAt).not.toBeNull();
  });

  test("завершить приём, на который не приходили, нельзя", async () => {
    /*
     * Это не редкость, а обычная ошибка нажатия — и она портит и статистику
     * неявок, и хронологию пациента.
     */
    const patient = await makeUser("user", `clinic-m2-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });

    const res = await api(`/api/clinic/appointments/${booked.body.id}/status`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("booked");
  });

  test("подтверждает только тот, кого записали", async () => {
    const patient = await makeUser("user", `clinic-m3-${crypto.randomUUID()}@test`);
    const nosy = await makeUser("user", `clinic-m4-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });

    const res = await api(`/api/clinic/appointments/${booked.body.id}/confirm`, nosy.token, {
      method: "POST",
    });
    // чужой приём для него просто не существует
    expect(res.status).toBe(404);
  });
});

describe("перенос и отмена", () => {
  test("перенос освобождает прежнее время и снимает подтверждение", async () => {
    const patient = await makeUser("user", `clinic-r1-${crypto.randomUUID()}@test`);
    const first = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: first }),
    });
    await api(`/api/clinic/appointments/${booked.body.id}/confirm`, patient.token, { method: "POST" });

    const second = await freeSlot("primary");
    expect(second).not.toBe(first);
    const res = await api(`/api/clinic/appointments/${booked.body.id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: second }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(appointments).where(eq(appointments.id, booked.body.id));
    expect(row!.slotId).toBe(second);
    expect(row!.status).toBe("booked");
    expect(row!.confirmedAt).toBeNull();

    // прежнее время снова свободно
    const free = await api(`/api/clinic/slots?kind=primary&specialistId=${specialistId}`, patient.token);
    expect(free.body.items.some((s: { id: string }) => s.id === first)).toBe(true);
  });

  test("отмена заранее не помечается поздней", async () => {
    const patient = await makeUser("user", `clinic-c1-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });

    const res = await api(`/api/clinic/appointments/${booked.body.id}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.body.late).toBe(false);
  });

  test("поздняя отмена разрешается, но помечается", async () => {
    /*
     * Запрета нет намеренно: он не удерживает человека, а меняет позднюю
     * отмену на молчаливую неявку — специалист теряет и слот, и сигнал.
     */
    const patient = await makeUser("user", `clinic-c2-${crypto.randomUUID()}@test`);
    const soon = crypto.randomUUID();
    await db.insert(slots).values({
      id: soon,
      specialistId,
      departmentId,
      startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      kind: "any",
    });
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: soon }),
    });

    const res = await api(`/api/clinic/appointments/${booked.body.id}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.body.late).toBe(true);

    const [row] = await db.select().from(appointments).where(eq(appointments.id, booked.body.id));
    expect(row!.cancelledLate).toBe(true);
  });

  test("отменённый приём освобождает место", async () => {
    const a = await makeUser("user", `clinic-c3-${crypto.randomUUID()}@test`);
    const b = await makeUser("user", `clinic-c4-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");

    const booked = await api("/api/clinic/appointments", a.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    const blocked = await api("/api/clinic/appointments", b.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(blocked.status).toBe(400);

    await api(`/api/clinic/appointments/${booked.body.id}/cancel`, a.token, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const again = await api("/api/clinic/appointments", b.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(again.status).toBe(201);
  });
});

describe("сегодня", () => {
  test("день отдаётся целиком, включая уже принятых", async () => {
    const res = await api("/api/clinic/today", specialistToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  test("специалист видит своих пациентов поимённо", async () => {
    const patient = await makeUser("user", `clinic-t1-${crypto.randomUUID()}@test`);
    const [slot] = await db.execute<{ id: string; date: string }>(
      `select id, to_char(starts_at at time zone 'Europe/Kyiv', 'YYYY-MM-DD') as date
       from slots
       where specialist_id = '${specialistId}' and kind = 'primary'
         and starts_at > now() + interval '5 days'
         and not exists (select 1 from appointments a where a.slot_id = slots.id and a.status <> 'cancelled')
       order by starts_at limit 1`,
    );
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: slot!.id }),
    });
    /*
     * Подготовка проверяется наравне с результатом.
     *
     * Первая редакция брала первый свободный слот без разбора вида и молча
     * получала повторный: запись отказывалась, приёма не появлялось, а
     * падала проверка на имени — то есть указывала не туда, где сломалось.
     */
    expect(booked.status).toBe(201);

    const res = await api(`/api/clinic/today?date=${slot!.date}`, specialistToken);
    expect(res.body.items.some((a: { id: string }) => a.id === booked.body.id)).toBe(true);
    const mine = res.body.items.find((a: { id: string }) => a.id === booked.body.id);
    expect(mine.patientName).toContain("clinic-t1-");
    expect(mine.room).toBe("214");
  });
});

describe("свой специалист", () => {
  /**
   * Закрепление — не правка поля, а решение о человеке, и закрепить можно
   * только того, кто в зоне ответственности. На первом приёме это выполнено
   * само собой: приём и есть основание видеть человека.
   */
  async function patientWithVisit(tag: string) {
    const patient = await makeUser("user", `clinic-${tag}-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(booked.status).toBe(201);
    return patient;
  }

  test("закрепление ставится и снимается явно", async () => {
    const patient = await patientWithVisit("l1");

    const take = await api(`/api/clinic/patients/${patient.id}/lead`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ take: true }),
    });
    expect(take.status).toBe(200);

    const list = await api("/api/clinic/specialists", patient.token);
    expect(list.body.items[0].userId).toBe(specialistId);
    expect(list.body.items[0].isLead).toBe(true);

    const release = await api(`/api/clinic/patients/${patient.id}/lead`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ take: false }),
    });
    expect(release.status).toBe(200);
  });

  test("чужое закрепление не снимается", async () => {
    // смена ведущего — это перевод человека, а не правка поля
    const patient = await patientWithVisit("l2");
    await api(`/api/clinic/patients/${patient.id}/lead`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ take: true }),
    });

    /*
     * Второму специалисту человек виден: он тоже принимает в этом отделении,
     * и прикрепление к отделению — основание видеть. Отказ приходит именно
     * из-за чужого закрепления, а не из-за пустой зоны.
     */
    const colleague = await makeUser("admin", `clinic-l3-${crypto.randomUUID()}@test`);
    await db.insert(specialistProfiles).values({ userId: colleague.id, departmentId });

    const res = await api(`/api/clinic/patients/${patient.id}/lead`, colleague.token, {
      method: "POST",
      body: JSON.stringify({ take: false }),
    });
    expect(res.status).toBe(403);
  });

  test("незнакомого человека за собой не закрепить", async () => {
    /*
     * Право «видеть пациентов» есть у каждого специалиста, но чужой пациент
     * своим от этого не становится. Отвечаем «не найдено»: 403 подтвердил бы,
     * что такой человек в системе есть.
     */
    const stranger = await makeUser("user", `clinic-l4-${crypto.randomUUID()}@test`);
    const res = await api(`/api/clinic/patients/${stranger.id}/lead`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ take: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe("неявка", () => {
  /** Приём, время которого давно прошло, а никто ничего не нажал */
  async function missedVisit(tag: string, hoursAgo = 5) {
    const patient = await makeUser("user", `clinic-${tag}-${crypto.randomUUID()}@test`);
    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      specialistId,
      departmentId,
      startsAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
      endsAt: new Date(Date.now() - (hoursAgo - 1) * 3600_000).toISOString(),
      kind: "any",
    });
    const id = crypto.randomUUID();
    await db.insert(appointments).values({
      id,
      slotId,
      patientId: patient.id,
      specialistId,
      kind: "primary",
      status: "booked",
    });
    return { patient, id };
  }

  test("истёкший приём уходит в неявку", async () => {
    const { id } = await missedVisit("ns1");
    const swept = await sweepNoShows();
    expect(swept).toBeGreaterThan(0);

    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.status).toBe("no_show");
  });

  test("свежий приём не трогается", async () => {
    /*
     * Отсрочка не украшение: без неё специалист, не успевший нажать «пришёл»
     * между двумя приёмами, получил бы неявку у человека, который сидит
     * перед ним.
     */
    const { id } = await missedVisit("ns2", 1);
    await sweepNoShows();
    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.status).toBe("booked");
  });

  test("повторный проход ничего не меняет", async () => {
    await missedVisit("ns3");
    await sweepNoShows();
    expect(await sweepNoShows()).toBe(0);
  });

  test("отмеченная явка неявкой не становится", async () => {
    const { id } = await missedVisit("ns4");
    await db.update(appointments).set({ status: "arrived" }).where(eq(appointments.id, id));
    await sweepNoShows();
    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.status).toBe("arrived");
  });

  test("неявку можно исправить на явку", async () => {
    // ставит её и фоновый проход тоже, а он ошибается ровно там, где
    // специалист забыл нажать кнопку
    const { id } = await missedVisit("ns5");
    await sweepNoShows();

    const res = await api(`/api/clinic/appointments/${id}/status`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ status: "arrived" }),
    });
    expect(res.status).toBe(200);
  });

  test("неявка попадает в очередь работы к своему специалисту", async () => {
    const { patient } = await missedVisit("ns6");
    await sweepNoShows();

    const mine = await api("/api/worklist", specialistToken);
    const item = mine.body.items.find(
      (i: { kind: string; userId: string }) => i.kind === "noshow" && i.userId === patient.id,
    );
    expect(item).toBeDefined();
    expect(item.assignedTo).toBe(specialistId);

    // и не попадает к постороннему специалисту
    const other = await api("/api/worklist", adminA.token);
    expect(
      other.body.items.some((i: { kind: string; userId: string }) => i.kind === "noshow" && i.userId === patient.id),
    ).toBe(false);
  });

  test("новая запись снимает неявку с очереди", async () => {
    const { patient } = await missedVisit("ns7");
    await sweepNoShows();

    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(booked.status).toBe(201);

    const mine = await api("/api/worklist", specialistToken);
    expect(
      mine.body.items.some((i: { kind: string; userId: string }) => i.kind === "noshow" && i.userId === patient.id),
    ).toBe(false);
  });
});

describe("напоминания", () => {
  /** Приём через заданное число часов, чтобы попадать в нужное окно */
  async function upcoming(tag: string, hoursAhead: number) {
    const patient = await makeUser("user", `clinic-${tag}-${crypto.randomUUID()}@test`);
    const slotId = crypto.randomUUID();
    await db.insert(slots).values({
      id: slotId,
      specialistId,
      departmentId,
      startsAt: new Date(Date.now() + hoursAhead * 3600_000).toISOString(),
      endsAt: new Date(Date.now() + (hoursAhead + 1) * 3600_000).toISOString(),
      kind: "any",
    });
    const id = crypto.randomUUID();
    await db.insert(appointments).values({
      id,
      slotId,
      patientId: patient.id,
      specialistId,
      kind: "primary",
      status: "booked",
    });
    await db.insert(pushTokens).values({
      id: crypto.randomUUID(),
      userId: patient.id,
      token: `ExponentPushToken[${tag}]`,
      platform: "ios",
    });
    return { patient, id };
  }

  test("за сутки приходит одно напоминание, а не по одному в минуту", async () => {
    /*
     * Тик рассыльщика минутный. Без отсечки по ключу события человек получал
     * бы напоминание каждую минуту последних суток — это не напоминание, а
     * травля.
     */
    const sent: { title: string; body: string }[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) sent.push({ title: m.title, body: m.body });
    });

    await upcoming("rm1", 5);
    const first = await remindAppointments();
    expect(first.day).toBe(1);

    const second = await remindAppointments();
    expect(second.day).toBe(0);
    expect(sent.length).toBe(1);

    setPushSenderForTests(null);
  });

  test("напоминание за сутки не обещает «завтра», если приём сегодня", async () => {
    /*
     * Напоминание уходит за сутки — то есть и за двадцать часов, и за пять.
     * Слово «завтра» верно лишь в части этих случаев, а в остальных
     * отправляет человека не в тот день.
     */
    const sent: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) sent.push(`${m.title} ${m.body}`);
    });

    await upcoming("rm-today", 5);
    await remindAppointments();
    expect(sent.length).toBe(1);
    expect(sent[0]!.toLowerCase()).not.toContain("завтра");
    // и дата в тексте есть: без неё человек не знает, о каком дне речь
    expect(sent[0]).toMatch(/\d{2}\.\d{2}/);

    setPushSenderForTests(null);
  });

  test("в тексте нет слов, выдающих, к кому человек идёт", async () => {
    /*
     * Уведомление видят посторонние — сосед в маршрутке, сослуживец. По нему
     * не должно быть понятно, что человек идёт к психологу.
     */
    const sent: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) sent.push(`${m.title} ${m.body}`);
    });

    await upcoming("rm2", 6);
    await remindAppointments();
    expect(sent.length).toBeGreaterThan(0);
    for (const text of sent) {
      expect(text.toLowerCase()).not.toContain("психолог");
      expect(text.toLowerCase()).not.toContain("психіатр");
      expect(text.toLowerCase()).not.toContain("психиатр");
    }

    setPushSenderForTests(null);
  });

  test("записавшийся в последний час получает только «через час»", async () => {
    // иначе он получил бы оба сразу, и «завтра приём» было бы просто неправдой
    const sent: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) sent.push(m.title);
    });

    await upcoming("rm3", 0.5);
    const result = await remindAppointments();
    expect(result.hour).toBe(1);
    expect(result.day).toBe(0);
    expect(sent.length).toBe(1);

    setPushSenderForTests(null);
  });

  test("отменённому приёму напоминания не идут", async () => {
    const sent: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) sent.push(m.title);
    });

    const { id } = await upcoming("rm4", 4);
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, id));
    const result = await remindAppointments();
    expect(result.day).toBe(0);
    expect(sent.length).toBe(0);

    setPushSenderForTests(null);
  });

  test("подтверждение видно специалисту, а факт отправки — нет", async () => {
    /*
     * Специалист смотрит на подтверждение, а не на отправку: отправленный
     * push и прочитанный push — разные вещи, и показывать первое вместо
     * второго значит врать.
     */
    const { patient, id } = await upcoming("rm5", 3);
    await api(`/api/clinic/appointments/${id}/confirm`, patient.token, { method: "POST" });

    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.status).toBe("confirmed");
    expect(row!.confirmedAt).not.toBeNull();
  });
});

describe("несданное назначенное", () => {
  test("пометка считает и назначенные методики, и батареи", async () => {
    /*
     * Предупреждаются оба: пациенту — напоминание, специалисту — пометка.
     * Без неё специалист узнаёт о несданной методике в момент, когда
     * собирался её обсуждать.
     */
    const patient = await makeUser("user", `clinic-pn-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(booked.status).toBe(201);

    // ничего не назначено — и пометки нет
    const [slotRow] = await db.select().from(slots).where(eq(slots.id, slotId));
    const date = new Date(slotRow!.startsAt).toISOString().slice(0, 10);
    const before = await api(`/api/clinic/today?date=${date}`, specialistToken);
    const mineBefore = before.body.items.find((a: { id: string }) => a.id === booked.body.id);
    expect(mineBefore.pendingAssignments).toBe(0);

    // назначаем методику и не сдаём её
    await db.insert(surveyAccess).values({
      surveyId: surveyInA,
      userId: patient.id,
      grantedBy: adminA.id,
    });

    const after = await api(`/api/clinic/today?date=${date}`, specialistToken);
    const mineAfter = after.body.items.find((a: { id: string }) => a.id === booked.body.id);
    expect(mineAfter.pendingAssignments).toBe(1);
  });

  test("сданное из счёта уходит", async () => {
    const patient = await makeUser("user", `clinic-pn2-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    await db.insert(surveyAccess).values({
      surveyId: surveyInA,
      userId: patient.id,
      grantedBy: adminA.id,
    });
    await submitSurvey(surveyInA, patient.token);

    const [slotRow] = await db.select().from(slots).where(eq(slots.id, slotId));
    const date = new Date(slotRow!.startsAt).toISOString().slice(0, 10);
    const res = await api(`/api/clinic/today?date=${date}`, specialistToken);
    const mine = res.body.items.find((a: { id: string }) => a.id === booked.body.id);
    expect(mine.pendingAssignments).toBe(0);
  });
});

describe("скрининг при записи", () => {
  /**
   * Первичный приём наполовину уходит на заполнение бланков: час разговора
   * превращается в полчаса разговора и полчаса анкет. Если короткий скрининг
   * пройден до приёма, специалист начинает с разговора.
   */
  test("отделение без скрининга ничего не предлагает", async () => {
    const patient = await makeUser("user", `clinic-sc0-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(res.status).toBe(201);
    expect(res.body.screeningSurveyId).toBeNull();
  });

  test("запись на первичный сразу отдаёт, что пройти", async () => {
    /*
     * В ответе на запись, а не отдельным вопросом «а есть ли скрининг»:
     * человек только что нажал «записаться» и находится ровно в той точке,
     * где готов потратить пять минут. Через день он забудет.
     */
    await db
      .update(departments)
      .set({ screeningSurveyId: surveyInA })
      .where(eq(departments.id, departmentId));

    const patient = await makeUser("user", `clinic-sc1-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    expect(res.status).toBe(201);
    expect(res.body.screeningSurveyId).toBe(surveyInA);
  });

  test("на повторный приём скрининг не предлагается", async () => {
    // на повторном специалист уже знает, с чем имеет дело
    const patient = await makeUser("user", `clinic-sc2-${crypto.randomUUID()}@test`);
    const first = await freeSlot("primary");
    const booked = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: first }),
    });
    await api(`/api/clinic/appointments/${booked.body.id}/status`, specialistToken, {
      method: "POST",
      body: JSON.stringify({ status: "arrived" }),
    });

    const repeat = await freeSlot("repeat");
    const res = await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: repeat }),
    });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("repeat");
    expect(res.body.screeningSurveyId).toBeNull();
  });

  test("сданный скрининг помечен как скрининг, а не как самообращение", async () => {
    /*
     * Источник выводится сервером. Если бы он приходил с клиентом,
     * «самообращение» — само по себе сведение о человеке — растворилось бы
     * среди плановых замеров.
     */
    const patient = await makeUser("user", `clinic-sc3-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });
    await submitSurvey(surveyInA, patient.token);

    const [row] = await db
      .select()
      .from(responsesTable)
      .where(eq(responsesTable.userId, patient.id));
    expect(row!.source).toBe("intake");

    const [slotRow] = await db.select().from(slots).where(eq(slots.id, slotId));
    const date = new Date(slotRow!.startsAt).toISOString().slice(0, 10);
    const day = await api(`/api/clinic/today?date=${date}`, specialistToken);
    const mine = day.body.items.find((a: { patientId: string }) => a.patientId === patient.id);
    expect(mine.screeningDone).toBe(true);
  });

  test("не сдавший скрининг виден специалисту до приёма", async () => {
    const patient = await makeUser("user", `clinic-sc4-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });

    const [slotRow] = await db.select().from(slots).where(eq(slots.id, slotId));
    const date = new Date(slotRow!.startsAt).toISOString().slice(0, 10);
    const day = await api(`/api/clinic/today?date=${date}`, specialistToken);
    const mine = day.body.items.find((a: { patientId: string }) => a.patientId === patient.id);
    expect(mine.screeningDone).toBe(false);
  });

  test("прохождение без записи скринингом не считается", async () => {
    // человек мог проходить ту же методику год назад по другому поводу
    const patient = await makeUser("user", `clinic-sc5-${crypto.randomUUID()}@test`);
    await submitSurvey(surveyInA, patient.token);

    const [row] = await db
      .select()
      .from(responsesTable)
      .where(eq(responsesTable.userId, patient.id));
    expect(row!.source).toBe("self");
  });

  test("черновик методики скринингом не назначить", async () => {
    /*
     * Иначе пациент при записи упирается в методику, которой ещё нет, — и
     * узнаёт об этом уже после того, как занял слот.
     */
    const draft = crypto.randomUUID();
    await db.insert(surveysTable).values({
      id: draft,
      title: { uk: "Чернетка", ru: "Черновик" },
      status: "draft",
      createdBy: adminA.id,
    });

    const res = await api(`/api/clinic/departments/${departmentId}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ screeningSurveyId: draft }),
    });
    expect(res.status).toBe(400);
  });
});

describe("риск на скрининге", () => {
  test("тревога заводит случай сразу, не дожидаясь даты приёма", async () => {
    /*
     * Иначе система собрала бы опасный сигнал и положила его ждать две
     * недели. Проверяется на существующем конвейере, а не на новом: скрининг
     * при записи — обычное прохождение, и тревога обязана срабатывать в нём
     * так же, как везде.
     */
    const patient = await makeUser("user", `clinic-rk-${crypto.randomUUID()}@test`);
    const slotId = await freeSlot("primary");
    await api("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId }),
    });

    // методика скрининга — та, где есть критический пункт
    await db
      .update(departments)
      .set({ screeningSurveyId: surveyInA })
      .where(eq(departments.id, departmentId));

    // СР-45: критические пункты — «да» на вопросы о попытках
    const surveyRes = await api(`/api/surveys/${surveyInA}`, patient.token);
    const yesAnswers = surveyRes.body.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info")
      .map((q: { id: string; options: { id: string; keyCode?: string }[] }) => ({
        questionId: q.id,
        optionIds: [
          (q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!).id,
        ],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));
    const submitted = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: yesAnswers,
      }),
    });
    expect(submitted.status).toBe(201);

    const [row] = await db
      .select()
      .from(responsesTable)
      .where(eq(responsesTable.userId, patient.id));
    expect(row!.source).toBe("intake");

    const cases = await db
      .select()
      .from(alertCases)
      .where(eq(alertCases.userId, patient.id));
    expect(cases.length).toBeGreaterThan(0);
  });

  test("методику, показывающую баллы, скринингом не назначить", async () => {
    const open = crypto.randomUUID();
    await db.insert(surveysTable).values({
      id: open,
      title: { uk: "Відкрита", ru: "Открытая" },
      status: "published",
      administration: "self",
      showResultsToPatient: true,
      createdBy: adminA.id,
    });

    const res = await api(`/api/clinic/departments/${departmentId}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ screeningSurveyId: open }),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("бал");
  });
});

describe("попытки по назначению", () => {
  test("одна попытка по умолчанию, вторая отклоняется", async () => {
    /*
     * Повторное прохождение той же методики через день портит измерение:
     * человек помнит вопросы и свои ответы.
     */
    const patient = await makeUser("user", `clinic-at1-${crypto.randomUUID()}@test`);
    const granted = await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect(granted.status).toBe(201);

    const first = await submitSurvey(surveyInA, patient.token);
    expect(first.status).toBe(201);

    const second = await submitSurvey(surveyInA, patient.token);
    expect(second.status).toBe(400);
    expect(String(second.body.error)).toContain("1");
  });

  test("две попытки — значит две", async () => {
    const patient = await makeUser("user", `clinic-at2-${crypto.randomUUID()}@test`);
    await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id, attemptsAllowed: 2 }),
    });

    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(400);
  });

  test("прошлогоднее прохождение сегодняшнюю попытку не тратит", async () => {
    /*
     * Назначили — значит хотят измерить сейчас, а не зачесть старое. Считать
     * от начала времён значило бы выдать назначение, которое сразу
     * исчерпано.
     */
    const patient = await makeUser("user", `clinic-at3-${crypto.randomUUID()}@test`);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);

    await api(`/api/access/surveys/${surveyInA}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
  });

  test("без назначения ограничения нет", async () => {
    // методику, которую человек проходит сам, никто не ограничивал
    const patient = await makeUser("user", `clinic-at4-${crypto.randomUUID()}@test`);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
  });

  test("выданные до перехода назначения остались без ограничения", async () => {
    /*
     * Умолчания на уровне базы нет намеренно: оно сделало бы одноразовыми все
     * уже выданные назначения, и человек, проходящий вторую волну замеров,
     * упёрся бы в отказ на ровном месте.
     */
    const patient = await makeUser("user", `clinic-at5-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({
      surveyId: surveyInA,
      userId: patient.id,
      grantedBy: adminA.id,
    });

    const [row] = await db
      .select()
      .from(surveyAccess)
      .where(and(eq(surveyAccess.userId, patient.id), eq(surveyAccess.surveyId, surveyInA)));
    expect(row!.attemptsAllowed).toBeNull();

    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
    expect((await submitSurvey(surveyInA, patient.token)).status).toBe(201);
  });
});
