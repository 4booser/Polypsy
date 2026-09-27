import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { adminA, db, makeUser } from "./fixtures";
import {
  appointments,
  departments,
  mailingRecipients,
  mailings,
  pushDeliveries,
  pushTokens,
  slots,
  specialistProfiles,
  users,
} from "../src/db/schema";
import { pushMailings } from "../src/lib/mailingPush";
import { type PushTicket, pushToUser, registerDevice, setPushSenderForTests } from "../src/lib/push";
import { remindAppointments } from "../src/lib/remind";

/**
 * Пуш: что считается доставкой, по какому ключу напоминание считается
 * «уже было» и почему пачка не должна застревать на одних и тех же людях.
 *
 * Отправитель подменён: сообщения собираются по токену устройства, и
 * проверки смотрят только на свои токены — проходы рассыльщиков идут по
 * всей базе, и соседние файлы оставляют в ней своих людей с устройствами.
 */

type Sent = { to: string; title: string; body: string };
const sent: Sent[] = [];
/** Какой билет вернуть по токену; по умолчанию — принято */
let ticketFor: (token: string) => PushTicket = () => ({ status: "ok", id: crypto.randomUUID() });

beforeAll(() => {
  setPushSenderForTests(async (messages) => {
    for (const m of messages) sent.push({ to: m.to, title: m.title, body: m.body });
    return messages.map((m) => ticketFor(m.to));
  });
});

const cancelled: string[] = [];
/** Толпа «без устройств» — убирается целиком: пятьсот лишних людей замедлили бы соседей, листающих картотеку */
const crowd = { users: [] as string[], slots: [] as string[], appointments: [] as string[] };
afterAll(async () => {
  setPushSenderForTests(null);
  // ничего живого в общих очередях: напоминания идут по всей базе
  if (cancelled.length) {
    await db.update(appointments).set({ status: "cancelled" }).where(inArray(appointments.id, cancelled));
  }
  if (crowd.appointments.length) await db.delete(appointments).where(inArray(appointments.id, crowd.appointments));
  if (crowd.slots.length) await db.delete(slots).where(inArray(slots.id, crowd.slots));
  // получатели рассылок уходят вместе с людьми (cascade)
  if (crowd.users.length) await db.delete(users).where(inArray(users.id, crowd.users));
}, 30_000);

const to = (token: string) => sent.filter((s) => s.to === token);

async function personWithDevice(tag: string) {
  const person = await makeUser("user", `pd-${tag}-${crypto.randomUUID()}@test`);
  const token = `ExponentPushToken[${crypto.randomUUID()}]`;
  await registerDevice(person.id, token, "android", "uk");
  return { ...person, token };
}

const deliveries = (userId: string, eventKey: string) =>
  db
    .select()
    .from(pushDeliveries)
    .where(and(eq(pushDeliveries.userId, userId), eq(pushDeliveries.eventKey, eventKey)));

describe("билеты провайдера: принято или отказ", () => {
  const message = (eventKey: string) => ({ eventKey, kind: "test", title: "Т", body: "Т" });

  test("временный отказ (MessageRateExceeded) — не доставка: заявка снимается, следующий проход доставляет", async () => {
    /*
     * Expo отвечает 200 на весь запрос, а отказ лежит внутри билета.
     * Прежде это читалось как успех: заявка оставалась, уведомление
     * числилось отправленным, и повтора не было никогда — напоминание о
     * приёме пропадало из-за того, что в эту минуту сработал лимит частоты.
     */
    const p = await personWithDevice("rate");
    const key = `test:${crypto.randomUUID()}`;
    ticketFor = () => ({ status: "error", message: "rate", details: { error: "MessageRateExceeded" } });
    try {
      expect(await pushToUser(p.id, message(key))).toBe(false);
      expect(await deliveries(p.id, key), "отказ записан как доставка").toHaveLength(0);
    } finally {
      ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
    }
    expect(await pushToUser(p.id, message(key))).toBe(true);
    expect(to(p.token)).toHaveLength(2);
    // доставлено — дальше тишина
    expect(await pushToUser(p.id, message(key))).toBe(false);
    expect(to(p.token)).toHaveLength(2);
  });

  test("постоянный отказ (MessageTooBig) не повторяется и не числится доставленным", async () => {
    const p = await personWithDevice("big");
    const key = `test:${crypto.randomUUID()}`;
    ticketFor = () => ({ status: "error", message: "big", details: { error: "MessageTooBig" } });
    try {
      expect(await pushToUser(p.id, message(key))).toBe(false);
      const [row] = await deliveries(p.id, key);
      expect(row).toMatchObject({ ok: false, error: "MessageTooBig" });
      // тот же текст не станет короче от повтора
      expect(await pushToUser(p.id, message(key))).toBe(false);
      expect(to(p.token)).toHaveLength(1);
    } finally {
      ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
    }
  });

  test("устройство удалено (DeviceNotRegistered): токен забыт, заявка снята — новое устройство получит", async () => {
    const p = await personWithDevice("gone");
    const key = `test:${crypto.randomUUID()}`;
    ticketFor = (token) =>
      token === p.token
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: crypto.randomUUID() };
    try {
      expect(await pushToUser(p.id, message(key))).toBe(false);
      expect(await deliveries(p.id, key)).toHaveLength(0);
      expect(await db.select().from(pushTokens).where(eq(pushTokens.token, p.token))).toHaveLength(0);

      const fresh = `ExponentPushToken[${crypto.randomUUID()}]`;
      await registerDevice(p.id, fresh, "ios", "uk");
      expect(await pushToUser(p.id, message(key))).toBe(true);
      expect(to(fresh)).toHaveLength(1);
    } finally {
      ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
    }
  });

  test("приняло хотя бы одно устройство — доставлено", async () => {
    const p = await personWithDevice("half");
    const second = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(p.id, second, "ios", "uk");
    const key = `test:${crypto.randomUUID()}`;
    ticketFor = (token) =>
      token === p.token
        ? { status: "error", message: "rate", details: { error: "MessageRateExceeded" } }
        : { status: "ok", id: crypto.randomUUID() };
    try {
      expect(await pushToUser(p.id, message(key))).toBe(true);
      const [row] = await deliveries(p.id, key);
      expect(row).toMatchObject({ ok: true });
    } finally {
      ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
    }
  });
});

/* ═══════════ напоминания о приёме ═══════════ */

let departmentId: string;
let specialistId: string;

async function clinic() {
  if (departmentId) return;
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення доставки", ru: "Отделение доставки" },
    timezone: "Europe/Kyiv",
  });
  specialistId = (await makeUser("admin", `pd-spec-${crypto.randomUUID()}@test`)).id;
  await db.insert(specialistProfiles).values({ userId: specialistId, departmentId }).onConflictDoNothing();
}

/*
 * Одна отметка «сейчас» на весь файл: слоты считаются от неё, а не от
 * своего Date.now(). Иначе полчаса «через 21,5 часа», созданные на долю
 * секунды позже, задевают слот «через 22 часа» из соседнего теста — и
 * ограничение базы slots_open_no_overlap (участок clinic) их не пускает.
 */
const SLOT_BASE = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;

async function slotAt(hoursAhead: number): Promise<string> {
  await clinic();
  const id = crypto.randomUUID();
  await db.insert(slots).values({
    id,
    specialistId,
    departmentId,
    startsAt: new Date(SLOT_BASE + hoursAhead * 3600_000).toISOString(),
    /*
     * Полчаса, а не час: у специалиста открытые слоты не пересекаются
     * (ограничение базы slots_open_no_overlap, участок clinic), а тесты ниже
     * ставят приёмы через полчаса друг от друга.
     */
    endsAt: new Date(SLOT_BASE + (hoursAhead + 0.5) * 3600_000).toISOString(),
    kind: "any",
  });
  return id;
}

async function booked(patientId: string, hoursAhead: number) {
  const slotId = await slotAt(hoursAhead);
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId, specialistId, status: "booked" });
  cancelled.push(id);
  return id;
}

describe("напоминание о приёме после переноса", () => {
  test("перенесённый приём получает напоминание о новом времени", async () => {
    /*
     * Ключ доставки был «приём и срок» — `appointment:<id>:day`. Перенос
     * сохраняет номер приёма, и напоминание о НОВОМ времени считалось уже
     * отправленным: человек помнил старое время, а о новом ему не
     * напомнил никто. Теперь в ключе время слота.
     */
    const p = await personWithDevice("moved");
    const id = await booked(p.id, 20);
    await remindAppointments();
    expect(to(p.token)).toHaveLength(1);

    const later = await slotAt(22);
    await db.update(appointments).set({ slotId: later }).where(eq(appointments.id, id));
    await remindAppointments();
    expect(to(p.token), "о новом времени не напомнили").toHaveLength(2);

    await remindAppointments();
    expect(to(p.token)).toHaveLength(2);
  });
});

/* ═══════════ пачка не застревает ═══════════ */

/**
 * Людей без устройства — больше пачки (500): прежде они выбирались первыми
 * в каждом проходе, заявки у них не появлялось (слать некуда), и в
 * следующем проходе они занимали пачку снова. Человек с устройством за ними
 * не получал уведомления никогда. Вставка — одним запросом с готовым хэшем
 * пароля: пятьсот makeUser заняли бы минуту.
 */
async function peopleWithoutDevice(n: number): Promise<string[]> {
  const [template] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, adminA.id));
  const ids = Array.from({ length: n }, () => crypto.randomUUID());
  await db.insert(users).values(
    ids.map((id) => ({
      id,
      email: `pd-crowd-${id}@test`,
      passwordHash: template!.hash,
      role: "user" as const,
      firstName: "x",
      lastName: "x",
    })),
  );
  crowd.users.push(...ids);
  return ids;
}

describe("пачка не застревает на тех, кому слать некуда", () => {
  test("рассылка: получатель с устройством за пятьюстами без устройств получает пуш", async () => {
    const crowd = await peopleWithoutDevice(505);
    const p = await personWithDevice("mail-last");
    const mailingId = crypto.randomUUID();
    await db.insert(mailings).values({
      id: mailingId,
      authorId: adminA.id,
      titleEnc: "x",
      bodyEnc: "x",
      status: "sent",
      sentAt: new Date().toISOString(),
    });
    await db.insert(mailingRecipients).values([...crowd, p.id].map((userId) => ({ mailingId, userId })));

    await pushMailings();
    expect(to(p.token), "пачку заняли люди без устройств").toHaveLength(1);
  }, 30_000);

  test("напоминания: приём с устройством за пятьюстами без устройств получает напоминание", async () => {
    await clinic();
    const [crowdPatient] = await peopleWithoutDevice(1);
    const rows = Array.from({ length: 505 }, (_, i) => ({
      slotId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      at: Date.now() + 2 * 3600_000 + i * 60_000,
    }));
    await db.insert(slots).values(
      rows.map((r) => ({
        id: r.slotId,
        specialistId,
        departmentId,
        startsAt: new Date(r.at).toISOString(),
        // встык, по минуте: слоты одного специалиста не пересекаются (slots_open_no_overlap)
        endsAt: new Date(r.at + 60_000).toISOString(),
        kind: "any" as const,
      })),
    );
    await db.insert(appointments).values(
      rows.map((r) => ({ id: r.id, slotId: r.slotId, patientId: crowdPatient!, specialistId, status: "booked" as const })),
    );
    crowd.slots.push(...rows.map((r) => r.slotId));
    crowd.appointments.push(...rows.map((r) => r.id));

    const p = await personWithDevice("remind-last");
    await booked(p.id, 23);

    await remindAppointments();
    expect(to(p.token), "пачку заняли приёмы без устройств").toHaveLength(1);
  }, 30_000);

  test("напоминания: пачка по одному проходит очередь, а не стоит на первом", async () => {
    // пачка в одну строку: второй проход обязан продолжить с места первого
    const a = await personWithDevice("remind-q1");
    const b = await personWithDevice("remind-q2");
    await booked(a.id, 21);
    await booked(b.id, 21.5);
    for (let pass = 0; pass < 20 && !(to(a.token).length && to(b.token).length); pass++) {
      await remindAppointments(new Date(), 1);
    }
    expect(to(a.token)).toHaveLength(1);
    expect(to(b.token)).toHaveLength(1);
  }, 30_000);

  test("рассылка: выключенной учётке пуш не уходит", async () => {
    // человек ушёл из учреждения (0088) — телефон его, а не наш
    const gone = await personWithDevice("mail-disabled");
    await db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, gone.id));
    const mailingId = crypto.randomUUID();
    await db.insert(mailings).values({
      id: mailingId,
      authorId: adminA.id,
      titleEnc: "x",
      bodyEnc: "x",
      status: "sent",
      sentAt: new Date().toISOString(),
    });
    await db.insert(mailingRecipients).values({ mailingId, userId: gone.id });
    await pushMailings();
    expect(to(gone.token)).toHaveLength(0);
  });

  test("рассылка: пачка идёт по очереди, а не топчется на тех, кому не удалось", async () => {
    /*
     * Отказ провайдера снимает заявку (см. выше) — значит, человек остаётся
     * в кандидатах. Если первые в пачке раз за разом получают отказ, пачка
     * меньше их числа не доходила бы до остальных никогда. Проход
     * продолжает с того места, где кончилась прошлая пачка.
     */
    const mailingId = crypto.randomUUID();
    await db.insert(mailings).values({
      id: mailingId,
      authorId: adminA.id,
      titleEnc: "x",
      bodyEnc: "x",
      status: "sent",
      sentAt: new Date().toISOString(),
    });
    const failing = await Promise.all([1, 2, 3].map((i) => personWithDevice(`busy-${i}`)));
    const target = await personWithDevice("after-busy");
    await db.insert(mailingRecipients).values([...failing, target].map((p) => ({ mailingId, userId: p.id })));

    const busy = new Set(failing.map((p) => p.token));
    ticketFor = (token) =>
      busy.has(token)
        ? { status: "error", message: "rate", details: { error: "MessageRateExceeded" } }
        : { status: "ok", id: crypto.randomUUID() };
    try {
      for (let pass = 0; pass < 20 && !to(target.token).length; pass++) await pushMailings(new Date(), 2);
      expect(to(target.token), "пачка из двух так и не дошла до пятого").toHaveLength(1);
    } finally {
      ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
      // занятым — доставить, чтобы не остались кандидатами у соседних файлов
      for (let pass = 0; pass < 20; pass++) if (!(await pushMailings(new Date(), 50))) break;
    }
  }, 30_000);
});
