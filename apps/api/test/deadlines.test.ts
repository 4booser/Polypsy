import { beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  and,
  api,
  batteries,
  batteryAssignments,
  batteryItems,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  sr45,
  surveys,
} from "./fixtures";
import { surveyAccess } from "../src/db/schema";
import { addMonths, dayOf, deadlineOf, endOfDay } from "../src/lib/day";

/**
 * Сроки и даты: конец дня по поясу учреждения, месяц без переполнения,
 * назначение набора поверх существующего доступа.
 */

describe("срок, заданный датой", () => {
  test("конец дня по Киеву — летом, зимой и в дни перевода часов", () => {
    expect(endOfDay("2026-06-15")).toBe("2026-06-15T20:59:59.999Z");
    expect(endOfDay("2026-01-15")).toBe("2026-01-15T21:59:59.999Z");
    // 29.03 часы переводят вперёд: в этих сутках 23 часа, конец дня — уже по летнему
    expect(endOfDay("2026-03-29")).toBe("2026-03-29T20:59:59.999Z");
    // 25.10 — назад: 25 часов, конец дня — по зимнему
    expect(endOfDay("2026-10-25")).toBe("2026-10-25T21:59:59.999Z");
    // конец года переходит через границу месяца и года
    expect(endOfDay("2026-12-31")).toBe("2026-12-31T21:59:59.999Z");
  });

  test("полная метка времени и пустое проходят как есть", () => {
    expect(deadlineOf("2026-06-15T12:00:00.000Z")).toBe("2026-06-15T12:00:00.000Z");
    expect(deadlineOf(null)).toBeNull();
    expect(deadlineOf(undefined)).toBeNull();
    expect(deadlineOf("")).toBeNull();
  });
});

describe("месяц вперёд", () => {
  const kyiv = (iso: string) => addMonths(new Date(iso), 1).toISOString();

  test("31 января плюс месяц — конец февраля, а не 3 марта", () => {
    // 31.01.2026 12:00 по Киеву (UTC+2)
    expect(kyiv("2026-01-31T10:00:00.000Z")).toBe("2026-02-28T10:00:00.000Z");
    // високосный год
    expect(kyiv("2024-01-31T10:00:00.000Z")).toBe("2024-02-29T10:00:00.000Z");
    expect(kyiv("2026-03-31T09:00:00.000Z")).toBe("2026-04-30T09:00:00.000Z");
  });

  test("через перевод часов местное время сохраняется", () => {
    // 15.03 12:00 по Киеву (UTC+2) → 15.04 12:00 по Киеву (UTC+3)
    expect(kyiv("2026-03-15T10:00:00.000Z")).toBe("2026-04-15T09:00:00.000Z");
  });

  test("ночная отметка считается по Киеву, а не по Гринвичу", () => {
    // 31.01 00:30 по Киеву — это ещё 30.01 по Гринвичу; месяц вперёд — 28.02 00:30 по Киеву
    expect(kyiv("2026-01-30T22:30:00.000Z")).toBe("2026-02-27T22:30:00.000Z");
    expect(addMonths(new Date("2026-01-30T22:30:00.000Z"), 12).toISOString()).toBe("2027-01-30T22:30:00.000Z");
  });
});

/* ═══════════ через маршруты ═══════════ */

let restricted: string;
let batteryId: string;

beforeAll(async () => {
  // закрытая методика: без действующей выдачи её не видно — на ней и виден срок доступа
  restricted = crypto.randomUUID();
  await db.insert(surveys).values({
    id: restricted,
    groupId: groupA,
    title: { uk: "Закрита методика строків", ru: "Закрытая методика сроков", en: "Restricted deadline survey" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "restricted",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(restricted, createSurveySchema.parse(sr45), adminA.id, "v1");

  batteryId = crypto.randomUUID();
  await db.insert(batteries).values({
    id: batteryId,
    title: `Набір строків ${crypto.randomUUID().slice(0, 6)}`,
    groupId: groupA,
    strictOrder: false,
    createdBy: adminA.id,
  });
  await db.insert(batteryItems).values([{ batteryId, surveyId: restricted, position: 0, required: true }]);
}, 30_000);

const accessOf = async (userId: string) =>
  (
    await db
      .select()
      .from(surveyAccess)
      .where(and(eq(surveyAccess.surveyId, restricted), eq(surveyAccess.userId, userId)))
  )[0];

const today = () => dayOf(new Date().toISOString())!;
const inDays = (n: number) => dayOf(new Date(Date.now() + n * 86_400_000).toISOString())!;

describe("срок сегодняшним числом", () => {
  test("выдача «до сегодня» открывает методику весь сегодняшний день", async () => {
    /*
     * Голая дата ложилась в базу полуночью по поясу сессии (в docker — UTC,
     * то есть 02:00–03:00 по Киеву): в сам день срока методика уже не
     * открывалась — 404 на экране пациента.
     */
    const person = await makeUser("user", `dl-${crypto.randomUUID()}@test`);
    const granted = await api(`/api/access/surveys/${restricted}/grants`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, expiresAt: today() }),
    });
    expect(granted.status).toBe(201);
    expect(new Date((await accessOf(person.id))!.expiresAt!).toISOString()).toBe(endOfDay(today()));
    expect((await api(`/api/surveys/${restricted}`, person.token)).status, "в день срока методика закрыта").toBe(200);
  });

  test("назначение набора «до сегодня» сегодня не просрочено", async () => {
    const person = await makeUser("user", `dl-b-${crypto.randomUUID()}@test`);
    const res = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, dueAt: today() }),
    });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(batteryAssignments).where(eq(batteryAssignments.id, res.body.id));
    expect(new Date(row!.dueAt!).toISOString()).toBe(endOfDay(today()));
    expect(new Date(row!.dueAt!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("назначение набора поверх существующего доступа", () => {
  test("истёкший доступ продлевается до срока набора", async () => {
    /*
     * Доступ писался через onConflictDoNothing: истёкший так и оставался
     * истёкшим — набор назначен, а методика из него не открывается.
     */
    const person = await makeUser("user", `dl-exp-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({
      surveyId: restricted,
      userId: person.id,
      grantedBy: adminA.id,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      note: "прошлогоднее назначение",
    });
    const res = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, dueAt: inDays(7) }),
    });
    expect(res.status).toBe(201);
    expect(new Date((await accessOf(person.id))!.expiresAt!).toISOString()).toBe(endOfDay(inDays(7)));
    expect((await api(`/api/surveys/${restricted}`, person.token)).status, "назначен набор, а методика закрыта").toBe(200);
  });

  test("бессрочный доступ набор со сроком не укорачивает", async () => {
    const person = await makeUser("user", `dl-open-${crypto.randomUUID()}@test`);
    await db.insert(surveyAccess).values({ surveyId: restricted, userId: person.id, grantedBy: adminA.id, expiresAt: null });
    const res = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, dueAt: inDays(7) }),
    });
    expect(res.status).toBe(201);
    expect((await accessOf(person.id))!.expiresAt).toBeNull();
  });

  test("повторное назначение при открытом первом — 409 с понятной причиной, а не 500", async () => {
    const person = await makeUser("user", `dl-twice-${crypto.randomUUID()}@test`);
    const body = JSON.stringify({ userId: person.id, dueAt: inDays(7) });
    expect((await api(`/api/batteries/${batteryId}/assign`, adminA.token, { method: "POST", body })).status).toBe(201);
    const again = await api(`/api/batteries/${batteryId}/assign`, adminA.token, { method: "POST", body });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain(inDays(7));
  });

  test("просроченное открытое закрывается как пропущенное, и набор назначается заново", async () => {
    const person = await makeUser("user", `dl-late-${crypto.randomUUID()}@test`);
    const first = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, dueAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    expect(first.status).toBe(201);
    const again = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id, dueAt: inDays(7) }),
    });
    expect(again.status).toBe(201);
    const rows = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, batteryId), eq(batteryAssignments.userId, person.id)));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === first.body.id)!.note).toContain("пропущено");
    expect(rows.find((r) => r.id === again.body.id)!.cancelledAt).toBeNull();
  });
});
