import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { adminA, api, db, makeUser } from "./fixtures";
import {
  appointments,
  departmentPatients,
  departments,
  rolePermissions,
  roles,
  scheduleTemplates,
  slots,
  specialistProfiles,
  staffRoles,
} from "../src/db/schema";
import { syncSlots } from "../src/lib/schedule";

/**
 * Запись на приём.
 *
 * Проверяется не «маршрут отвечает 201», а четыре вещи, каждая из которых
 * ломается тихо: два человека не занимают одно место, повторный приём не
 * открыт непрwould, прикрепление появляется само, а поздняя отмена
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
