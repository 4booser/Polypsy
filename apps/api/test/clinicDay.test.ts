import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { api, db, makeUser, root, type Person } from "./fixtures";
import { appointments, departments, slots, specialistProfiles } from "../src/db/schema";
import { runOnPool, type PoolOverride } from "../src/db";
import { APP_ROLE_MODE, rlsRoleUrl } from "./appRole";

/**
 * Приёмный день на днях перевода часов и пояс отделения (волна 18, внешний
 * разбор, #22 и #24).
 *
 * #22. Граница дня в /clinic/today считалась как «местная полночь → момент,
 * плюс interval '1 day'». Прибавление суток к моменту (timestamptz) идёт по
 * поясу СЕССИИ базы: на машине разработчика это Киев, и день выходил
 * календарным; в docker-compose база работает в UTC, и «день» становился
 * ровно 24 часами. День Europe/Kyiv бывает 23 и 25 часов: приём 25.10 в 23:30
 * не попадал ни в 25-е, ни в 26-е, а приём 30.03 в 00:30 — и в 29-е, и в
 * 30-е. Сюита этого не видела — её база в поясе Киева. Здесь запросы идут
 * отдельным пулом с TimeZone=UTC у соединения, как в бою.
 *
 * #24. Пояс отделения проверялся только на длину строки: любая строка
 * записывалась, а следующий GET /today падал пятисоткой на неизвестном
 * поясе PostgreSQL. Неверный пояс отклоняется до записи; верные работают и
 * в API, и в базе.
 */

let departmentId: string;
let specialist: Person;
let patient: Person;
let utcPool: PoolOverride;
let ownerApp: { request: (path: string, init?: RequestInit) => Promise<Response> | Response };
const mine: string[] = [];

/** Момент, когда на часах Киева — заданные дата и время; смещение задаётся явно, чтобы тест не доверял проверяемому коду */
function kyiv(local: string, offset: "+02:00" | "+03:00"): string {
  return new Date(`${local}${offset}`).toISOString();
}

/** Приём на заданный момент: слот и строка приёма напрямую, без записи через API */
async function visitAt(startsAt: string): Promise<string> {
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: specialist.id,
    departmentId,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId: patient.id, specialistId: specialist.id });
  mine.push(id);
  return id;
}

/** Приёмы дня — запросом, у которого соединение с базой в UTC */
async function dayUnderUtc(date: string): Promise<string[]> {
  const res = await runOnPool(utcPool, () =>
    ownerApp.request(`/api/clinic/today?date=${date}`, {
      headers: { Authorization: `Bearer ${specialist.token}` },
    }),
  );
  const body = (await res.json()) as { items: { id: string }[] };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.items.map((a) => a.id).sort();
}

beforeAll(async () => {
  /*
   * Пул с TimeZone=UTC у соединения — ровно как у базы в docker-compose.
   * В прогоне под ролью приложения — той же ролью без прав владельца, чтобы
   * проверка дня шла с теми же политиками, что и остальная сюита.
   */
  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../src/db/schema");
  const url = APP_ROLE_MODE ? await rlsRoleUrl() : process.env.DATABASE_URL!;
  const client = postgres(url, {
    max: 4,
    idle_timeout: 20,
    transform: undefined,
    onnotice: () => {},
    connection: { TimeZone: "UTC" },
  });
  utcPool = { db: drizzle(client, { schema }), url };
  const [tz] = await client`show timezone`;
  expect(tz?.TimeZone).toBe("UTC");
  ownerApp = (await import("../src/app")).app;

  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення годинникових переводів", ru: "Отделение перевода часов" },
    timezone: "Europe/Kyiv",
  });
  specialist = await makeUser("admin", `cday-s-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId });
  patient = await makeUser("user", `cday-p-${crypto.randomUUID()}@test`);
});

afterAll(async () => {
  // ничего живого в общей очереди приёмов (порядок файлов в CI)
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
});

describe("#22 приёмный день при TimeZone=UTC у базы", () => {
  test("25.10.2026 — 25 часов: вечерний приём остаётся в своём дне, ночной — в следующем", async () => {
    // до 04:00 25.10 Киев — UTC+3, после — UTC+2
    const night25 = await visitAt(kyiv("2026-10-25T00:30:00", "+03:00"));
    const evening25 = await visitAt(kyiv("2026-10-25T23:30:00", "+02:00"));
    const night26 = await visitAt(kyiv("2026-10-26T00:30:00", "+02:00"));

    expect(await dayUnderUtc("2026-10-25")).toEqual([night25, evening25].sort());
    expect(await dayUnderUtc("2026-10-26")).toEqual([night26]);
  });

  test("29.03.2026 — 23 часа: ночной приём 30-го не попадает в 29-е", async () => {
    // до 03:00 29.03 Киев — UTC+2, после — UTC+3
    const night29 = await visitAt(kyiv("2026-03-29T00:30:00", "+02:00"));
    const evening29 = await visitAt(kyiv("2026-03-29T23:30:00", "+03:00"));
    const night30 = await visitAt(kyiv("2026-03-30T00:30:00", "+03:00"));

    expect(await dayUnderUtc("2026-03-29")).toEqual([night29, evening29].sort());
    expect(await dayUnderUtc("2026-03-30")).toEqual([night30]);
  });
});
