import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { api, db, makeUser } from "./fixtures";
import { appointments, departments, scheduleTemplates, slots, specialistProfiles } from "../src/db/schema";
import { layOutDay, syncSlots } from "../src/lib/schedule";

/**
 * Сетка слотов без пересечений.
 *
 * Дефект из внешнего разбора (решение заказчика 2026-09-26): синхронизация
 * узнавала «свой» слот по одному началу. Смена длительности 50 → 30 минут
 * оставляла слот 09:00–09:50 — начало совпало, вставка молча ничего не
 * делала, — и рядом появлялся 09:30–10:00. Оба открыты для записи, и два
 * человека попадали к одному специалисту на одни и те же двадцать минут.
 *
 * Проверяется тремя слоями: что сетка после смены длительности правильная,
 * что занятый слот при этом не тронут и не даёт занять пересекающееся с ним
 * время, и что база сама не пускает пересечение, чем бы ни кончилась гонка.
 */

const TZ = "Europe/Kyiv";
let departmentId: string;
const mine: string[] = [];
const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

type Person = { id: string; token: string };

/** Обычная неделя «каждый день 09:00–10:00» — тем же маршрутом, каким её правит специалист */
async function setWeek(person: Person, slotMinutes: number) {
  const res = await api("/api/clinic/schedule", person.token, {
    method: "PUT",
    body: JSON.stringify({
      templates: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        startsAt: "09:00",
        endsAt: "10:00",
        slotMinutes,
      })),
    }),
  });
  expect(res.status).toBe(200);
  return res.body as { added: number; removed: number; flagged: number };
}

async function specialistWithWeek(slotMinutes: number) {
  const person = await makeUser("admin", `grid-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  await setWeek(person, slotMinutes);
  return person;
}

/** Пары открытых слотов специалиста, пересекающиеся по времени */
async function overlaps(specialistId: string): Promise<{ a: string; b: string }[]> {
  const rows = await db.execute<{ a: string; b: string }>(sql`
    select a.id as a, b.id as b
    from slots a
    join slots b
      on b.specialist_id = a.specialist_id and a.id < b.id
     and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    where a.specialist_id = ${specialistId} and a.status = 'open' and b.status = 'open'
  `);
  return [...rows];
}

type WallSlot = {
  id: string;
  day: string;
  span: string;
  off_schedule: boolean;
  status: string;
};

/** Слоты специалиста в стенных часах отделения: день и «09:00–09:50» */
async function wall(specialistId: string, day?: string) {
  const rows = await db.execute<WallSlot>(sql`
    select id,
           to_char(starts_at at time zone ${TZ}, 'YYYY-MM-DD') as day,
           to_char(starts_at at time zone ${TZ}, 'HH24:MI') || '–' ||
             to_char(ends_at at time zone ${TZ}, 'HH24:MI') as span,
           off_schedule, status
    from slots where specialist_id = ${specialistId}
    order by starts_at, status
  `);
  return day ? rows.filter((r) => r.day === day) : [...rows];
}

/** День через несколько суток: у него точно ещё всё впереди */
async function dayAhead(n: number) {
  const [row] = await db.execute<{ day: string }>(
    sql`select to_char((now() at time zone ${TZ})::date + ${n}::int, 'YYYY-MM-DD') as day`,
  );
  return row!.day;
}

async function book(patient: Person, slotId: string) {
  const res = await api("/api/clinic/appointments", patient.token, {
    method: "POST",
    body: JSON.stringify({ slotId }),
  });
  expect(res.status).toBe(201);
  mine.push(res.body.id);
  return res.body.id as string;
}

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення сітки", ru: "Отделение сетки" },
    timezone: TZ,
  });
});

afterAll(async () => {
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
  await other.end();
});

describe("раскладка дня", () => {
  test("без пересечений раскладка та же, что прежде", () => {
    expect(
      layOutDay([
        { from: "09:00", to: "12:00", slotMinutes: 50 },
        { from: "14:00", to: "16:00", slotMinutes: 60 },
      ]),
    ).toEqual([
      { from: "09:00", to: "09:50" },
      { from: "09:50", to: "10:40" },
      { from: "10:40", to: "11:30" },
      { from: "14:00", to: "15:00" },
      { from: "15:00", to: "16:00" },
    ]);
  });

  test("дополнительные часы поверх обычной недели занимают только свободное время", () => {
    /*
     * Специалист добавил часы 09:45–11:00 к обычным 09:00–10:00. Прежде
     * получалось 09:45–10:15 поверх 09:30–10:00; теперь дополнительные часы
     * начинаются там, где кончается последний обычный слот.
     */
    expect(
      layOutDay([
        { from: "09:00", to: "10:00", slotMinutes: 30 },
        { from: "09:45", to: "11:00", slotMinutes: 30 },
      ]),
    ).toEqual([
      { from: "09:00", to: "09:30" },
      { from: "09:30", to: "10:00" },
      { from: "10:00", to: "10:30" },
      { from: "10:30", to: "11:00" },
    ]);
  });

  test("отброшенный хвост обычного интервала достаётся дополнительным часам", () => {
    // 09:00–10:10 по 50 минут — один слот; хвост 09:50–10:10 свободен
    expect(
      layOutDay([
        { from: "09:00", to: "10:10", slotMinutes: 50 },
        { from: "09:30", to: "10:30", slotMinutes: 20 },
      ]),
    ).toEqual([
      { from: "09:00", to: "09:50" },
      { from: "09:50", to: "10:10" },
      { from: "10:10", to: "10:30" },
    ]);
  });
});

describe("смена длительности", () => {
  test("50 → 30 минут: старый конец не остаётся, пересечений нет", async () => {
    const person = await specialistWithWeek(50);
    const day = await dayAhead(3);
    expect((await wall(person.id, day)).map((s) => s.span)).toEqual(["09:00–09:50"]);

    await setWeek(person, 30);

    expect(await overlaps(person.id), "в сетке остались пересекающиеся открытые слоты").toEqual([]);
    expect((await wall(person.id, day)).filter((s) => s.status === "open").map((s) => s.span)).toEqual([
      "09:00–09:30",
      "09:30–10:00",
    ]);

    // и пациенту не предлагается ничего, что пересекалось бы между собой
    const patient = await makeUser("user", `grid-p-${crypto.randomUUID()}@test`);
    const free = await api(`/api/clinic/slots?specialistId=${person.id}`, patient.token);
    const items = (free.body.items as { startsAt: string; endsAt: string }[])
      .map((s) => [Date.parse(s.startsAt), Date.parse(s.endsAt)] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) {
      expect(items[i]![0], "два предложенных слота пересекаются").toBeGreaterThanOrEqual(items[i - 1]![1]);
    }
  }, 30_000);

  test("повторный прогон после смены ничего не трогает", async () => {
    const person = await specialistWithWeek(50);
    await setWeek(person, 30);
    expect(await setWeek(person, 30)).toMatchObject({ added: 0, removed: 0, flagged: 0 });
  }, 30_000);

  test("занятый слот остаётся на своём интервале и не даёт занять пересекающееся время", async () => {
    /*
     * Решение: приём назначен на 09:00–09:50, и человек это время видел.
     * Растянуть или ужать его молча — та же молчаливая правка чужого приёма,
     * которую запрещает пояснение к offSchedule. Поэтому занятый слот живёт
     * на прежнем интервале и помечается «вне расписания», а новая сетка
     * этого дня строится вокруг него: 09:30–10:00 не появляется, пока
     * 09:00–09:50 занят, — иначе к специалисту записали бы двоих на одни и
     * те же двадцать минут. Переносить или оставить решает человек.
     */
    const person = await specialistWithWeek(50);
    const day = await dayAhead(4);
    const [busy] = (await wall(person.id, day)).filter((s) => s.span === "09:00–09:50");
    const patient = await makeUser("user", `grid-busy-${crypto.randomUUID()}@test`);
    const appointmentId = await book(patient, busy!.id);

    await setWeek(person, 30);

    const that = await wall(person.id, day);
    expect(that.filter((s) => s.status === "open").map((s) => [s.span, s.off_schedule])).toEqual([
      ["09:00–09:50", true],
    ]);
    expect(await overlaps(person.id)).toEqual([]);
    const [kept] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(kept!.slotId).toBe(busy!.id);
    expect(kept!.status).toBe("booked");

    // соседние дни — уже по-новому
    const next = await dayAhead(5);
    expect((await wall(person.id, next)).filter((s) => s.status === "open").map((s) => s.span)).toEqual([
      "09:00–09:30",
      "09:30–10:00",
    ]);

    // вернули прежнюю длительность — занятый слот снова в расписании
    await setWeek(person, 50);
    expect((await wall(person.id, day)).map((s) => [s.span, s.off_schedule])).toEqual([["09:00–09:50", false]]);
    expect(await overlaps(person.id)).toEqual([]);
  }, 30_000);

  test("освобождённое время возвращается в новую сетку, история отмены остаётся", async () => {
    const person = await specialistWithWeek(50);
    const day = await dayAhead(4);
    const [busy] = (await wall(person.id, day)).filter((s) => s.span === "09:00–09:50");
    const patient = await makeUser("user", `grid-freed-${crypto.randomUUID()}@test`);
    const appointmentId = await book(patient, busy!.id);
    await setWeek(person, 30);

    const cancel = await api(`/api/clinic/appointments/${appointmentId}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(200);
    await setWeek(person, 30);

    /*
     * Слот с отменённым приёмом не удалить — на нём история, и ключ базы
     * этого не даст. Он закрывается и уходит из сетки, а его время
     * достаётся новым слотам.
     */
    const that = await wall(person.id, day);
    expect(that.filter((s) => s.status === "open").map((s) => s.span)).toEqual(["09:00–09:30", "09:30–10:00"]);
    expect(that.filter((s) => s.status === "closed").map((s) => s.id)).toEqual([busy!.id]);
    const [history] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(history!.slotId).toBe(busy!.id);
    expect(await overlaps(person.id)).toEqual([]);
  }, 30_000);

  test("запись, пришедшая во время пересборки сетки, не теряется и не роняет пересборку", async () => {
    /*
     * Пересборка решает судьбу слота по прочитанной занятости. Пока она
     * читает, пациент может занимать тот же слот. Слоты окна берутся под
     * замок до чтения занятости — тем же замком, что и в takeSlot, — и
     * пересборка ждёт запись, а потом видит её.
     */
    const person = await specialistWithWeek(50);
    const day = await dayAhead(6);
    const [target] = (await wall(person.id, day)).filter((s) => s.span === "09:00–09:50");
    const patient = await makeUser("user", `grid-late-${crypto.randomUUID()}@test`);

    await db.delete(scheduleTemplates).where(eq(scheduleTemplates.specialistId, person.id));
    await db.insert(scheduleTemplates).values(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        id: crypto.randomUUID(),
        specialistId: person.id,
        weekday,
        startsAt: "09:00",
        endsAt: "10:00",
        slotMinutes: 30,
      })),
    );

    const appointmentId = crypto.randomUUID();
    mine.push(appointmentId);
    let pending!: Promise<unknown>;
    await other.begin(async (tx) => {
      // так занимает слот takeSlot: замок на строке слота, затем приём
      await tx`select id from slots where id = ${target!.id} for update`;
      await tx`insert into appointments (id, slot_id, patient_id, specialist_id, status, booked_by)
               values (${appointmentId}, ${target!.id}, ${patient.id}, ${person.id}, 'booked', ${patient.id})`;
      pending = syncSlots(person.id);
      pending.catch(() => {});
      const until = Date.now() + 5000;
      for (;;) {
        const [row] = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update%'
        `);
        if (Number(row?.n) > 0) break;
        if (Date.now() > until) throw new Error("пересборка не встала за замком слота");
        await Bun.sleep(10);
      }
    });
    await pending;

    const that = await wall(person.id, day);
    expect(that.filter((s) => s.status === "open").map((s) => [s.span, s.off_schedule])).toEqual([
      ["09:00–09:50", true],
    ]);
    const [kept] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(kept!.status).toBe("booked");
    expect(await overlaps(person.id)).toEqual([]);
  }, 30_000);
});

describe("дополнительные часы", () => {
  test("исключение поверх обычной недели не создаёт пересечений", async () => {
    const person = await specialistWithWeek(30);
    const day = await dayAhead(3);
    const res = await api("/api/clinic/schedule/exceptions", person.token, {
      method: "POST",
      body: JSON.stringify({ date: day, kind: "extra", startsAt: "09:45", endsAt: "11:00", slotMinutes: 30 }),
    });
    expect(res.status).toBe(201);
    expect(await overlaps(person.id)).toEqual([]);
    expect((await wall(person.id, day)).map((s) => s.span)).toEqual([
      "09:00–09:30",
      "09:30–10:00",
      "10:00–10:30",
      "10:30–11:00",
    ]);
  }, 30_000);
});

describe("защита на уровне базы", () => {
  test("два открытых слота одного специалиста не пересекаются", async () => {
    /*
     * Последний рубеж, не зависящий от порядка действий в коде: что бы ни
     * сделала синхронизация или ручная правка, база не примет второй
     * открытый слот поверх первого.
     */
    const a = await makeUser("admin", `grid-db-a-${crypto.randomUUID()}@test`);
    const b = await makeUser("admin", `grid-db-b-${crypto.randomUUID()}@test`);
    const at = (h: number) => new Date(Date.UTC(2031, 0, 15, h, 0)).toISOString();
    const put = (specialistId: string, from: number, to: number, status: "open" | "closed" = "open") =>
      db.insert(slots).values({
        id: crypto.randomUUID(),
        specialistId,
        departmentId,
        startsAt: at(from),
        endsAt: at(to),
        status,
      });

    await put(a.id, 10, 12);
    let refused = false;
    try {
      await put(a.id, 11, 13);
    } catch {
      refused = true;
    }
    expect(refused, "база приняла пересекающийся открытый слот").toBe(true);

    // впритык — не пересечение: конец не входит в интервал
    await put(a.id, 12, 13);
    // закрытый слот — история, а не обещание времени
    await put(a.id, 11, 12, "closed");
    // у другого специалиста то же время свободно
    await put(b.id, 10, 12);

    const rows = await db
      .select()
      .from(slots)
      .where(and(inArray(slots.specialistId, [a.id, b.id]), eq(slots.status, "open")));
    expect(rows.length).toBe(3);
  });
});

describe("миграция 0105 на накопленных данных", () => {
  test("разбирает пересечения, не трогая ни одного приёма, и после неё правило встаёт", async () => {
    /*
     * Боевая база уже содержит пересечения, которые наплодила прежняя
     * синхронизация: без разбора ограничение не создать, и выкатка упала бы
     * на миграции. Проверка воспроизводит все четыре вида пересечений на
     * базе без правила — в транзакции, которая потом откатывается, — и
     * прогоняет тот же разбор, что лежит в файле миграции.
     */
    const migration = await Bun.file(
      new URL("../drizzle/0105_slot_overlap.sql", import.meta.url).pathname,
    ).text();
    const cleanup = migration.split("--> statement-breakpoint")[0]!;
    const doctor = await makeUser("admin", `grid-mig-${crypto.randomUUID()}@test`);
    const patient = await makeUser("user", `grid-mig-p-${crypto.randomUUID()}@test`);

    const at = (h: number, m = 0) => new Date(Date.UTC(2032, 2, 10, h, m)).toISOString();
    const older = "2032-01-01T00:00:00Z";
    const newer = "2032-02-01T00:00:00Z";
    type Row = { id: string; status: string; off_schedule: boolean };
    const ROLLBACK = new Error("откат проверки миграции");
    let after: Row[] = [];
    let constraintAdded = false;

    try {
      await other.begin(async (tx) => {
        await tx`alter table slots drop constraint slots_open_no_overlap`;
        const slot = async (key: string, from: number, fromM: number, to: number, toM: number, created: string) => {
          await tx`insert into slots (id, specialist_id, department_id, starts_at, ends_at, created_at)
                   values (${`${key}-${doctor.id}`}, ${doctor.id}, ${departmentId}, ${at(from, fromM)}, ${at(to, toM)}, ${created})`;
        };
        const visit = async (key: string, status: string) => {
          await tx`insert into appointments (id, slot_id, patient_id, specialist_id, status)
                   values (${crypto.randomUUID()}, ${`${key}-${doctor.id}`}, ${patient.id}, ${doctor.id}, ${status})`;
        };
        // 50 → 30: старый пустой 09:00–09:50 под новым 09:30–10:00
        await slot("a", 9, 0, 9, 50, older);
        await slot("b", 9, 30, 10, 0, newer);
        // старый с отменённым приёмом под новым пустым
        await slot("c", 11, 0, 11, 50, older);
        await visit("c", "cancelled");
        await slot("d", 11, 30, 12, 0, newer);
        // новый пустой поверх занятого старого
        await slot("e", 13, 0, 13, 50, older);
        await visit("e", "booked");
        await slot("f", 13, 30, 14, 0, newer);
        // двойная запись: оба заняты
        await slot("g", 15, 0, 15, 50, older);
        await visit("g", "confirmed");
        await slot("h", 15, 30, 16, 0, newer);
        await visit("h", "booked");
        // одиночный — не трогается
        await slot("i", 17, 0, 18, 0, older);

        await tx.unsafe(cleanup);
        await tx`alter table slots add constraint slots_open_no_overlap
                 exclude using gist (specialist_id with =, tstzrange(starts_at, ends_at) with &&)
                 where (status = 'open')`;
        constraintAdded = true;
        after = await tx<Row[]>`
          select split_part(id, '-', 1) as id, status, off_schedule from slots
          where specialist_id = ${doctor.id} order by id`;
        const [lost] = await tx<{ n: number }[]>`
          select count(*)::int as n from appointments where specialist_id = ${doctor.id}`;
        expect(Number(lost!.n), "миграция тронула приёмы").toBe(4);
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    }

    expect(constraintAdded, "после разбора правило о пересечениях не встало").toBe(true);
    expect(after.map((r) => [r.id, r.status, r.off_schedule])).toEqual([
      // a удалён: пустой и старше пересекающего
      ["b", "open", false],
      ["c", "closed", false],
      ["d", "open", false],
      ["e", "open", false],
      // f удалён: пустой поверх занятого
      ["g", "open", false],
      ["h", "closed", true],
      ["i", "open", false],
    ]);
  }, 30_000);
});
