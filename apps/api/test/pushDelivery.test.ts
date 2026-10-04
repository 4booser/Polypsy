import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { adminA, db, makeUser } from "./fixtures";
import {
  appointments,
  departments,
  mailingRecipients,
  mailings,
  pushDeliveries,
  pushOutcomes,
  pushTokens,
  slots,
  specialistProfiles,
  users,
} from "../src/db/schema";
import { pushMailings } from "../src/lib/mailingPush";
import {
  checkPushReceipts,
  expoSender,
  type PushTicket,
  pushToUser,
  registerDevice,
  setPushReceiptFetcherForTests,
  setPushSenderForTests,
} from "../src/lib/push";
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

/** Подменённый отправитель: собирает сообщения и отвечает билетами по ticketFor */
const stubSender = async (messages: { to: string; title: string; body: string }[]) => {
  for (const m of messages) sent.push({ to: m.to, title: m.title, body: m.body });
  return messages.map((m) => ticketFor(m.to));
};

beforeAll(() => {
  setPushSenderForTests(stubSender);
});

const cancelled: string[] = [];
/** Толпа «без устройств» — убирается целиком: пятьсот лишних людей замедлили бы соседей, листающих картотеку */
const crowd = { users: [] as string[], slots: [] as string[], appointments: [] as string[] };
afterAll(async () => {
  setPushSenderForTests(null);
  setPushReceiptFetcherForTests(null);
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

describe("ответ провайдера не той формы — не успех (внешний разбор, #19)", () => {
  const message = (eventKey: string) => ({ eventKey, kind: "test.proto", title: "Т", body: "Т" });
  const originalFetch = globalThis.fetch;
  /** Что ответит «Expo» на отправку; настоящий отправитель, подменена только сеть */
  let expoBody: unknown = { data: [] };

  beforeAll(() => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("exp.host/--/api/v2/push/send")) {
        return new Response(JSON.stringify(expoBody), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    setPushSenderForTests(expoSender);
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    setPushSenderForTests(stubSender);
  });

  const outcomesOf = (kind: string) => db.select().from(pushOutcomes).where(eq(pushOutcomes.kind, kind));

  test("пустые, короткие и бесстатусные билеты — исход protocol, заявка снята, следующий проход доставляет", async () => {
    /*
     * Прежде отсутствующий билет читался как принятый (`!ticket`), а ответ
     * без массива билетов — как «принято без билета»: заявка оставалась с
     * ok = true, и уведомление с неизвестной судьбой не повторялось никогда.
     */
    const p = await personWithDevice("proto");
    const second = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(p.id, second, "ios", "uk");
    const key = `test:${crypto.randomUUID()}`;
    const malformed: unknown[] = [
      { data: [] },
      {},
      null,
      { data: [{ status: "ok", id: "t-only-one" }] }, // билетов меньше, чем устройств
      { data: [{ status: "ok" }, { status: "ok" }] }, // принято без id — квитанцию не спросить
      { data: [{ foo: 1 }, { status: "ok", id: "t" }] }, // без статуса
    ];
    for (const body of malformed) {
      expoBody = body;
      expect(await pushToUser(p.id, message(key)), `ответ ${JSON.stringify(body)} принят за успех`).toBe(false);
      expect(await deliveries(p.id, key), `после ${JSON.stringify(body)} заявка осталась`).toHaveLength(0);
    }
    const failed = (await outcomesOf("test.proto")).filter((o) => o.status === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(malformed.length * 2);
    expect(new Set(failed.map((o) => o.error))).toEqual(new Set(["protocol"]));

    // настоящий ответ — доставка, и дальше тишина
    expoBody = { data: [{ status: "ok", id: `t-${crypto.randomUUID()}` }, { status: "ok", id: `t-${crypto.randomUUID()}` }] };
    expect(await pushToUser(p.id, message(key))).toBe(true);
    expect(await deliveries(p.id, key)).toHaveLength(1);
    expect(await pushToUser(p.id, message(key))).toBe(false);
  });
});

describe("квитанция возвращает событие в очередь (внешний разбор, #18)", () => {
  const message = (eventKey: string) => ({ eventKey, kind: "test.receipt", title: "Т", body: "Т" });
  const later = () => new Date(Date.now() + 20 * 60_000);

  afterAll(() => {
    ticketFor = () => ({ status: "ok", id: crypto.randomUUID() });
    setPushReceiptFetcherForTests(null);
  });

  test("лимит частоты в квитанции — повтор с задержкой; подтверждённая доставка не дублируется", async () => {
    /*
     * Билет «принято» создавал заявку, а поздняя квитанция с временной
     * ошибкой лишь отмечала исход: заявка оставалась ok = true, повтор
     * pushToUser отсекался, напоминание не доходило никогда.
     */
    const p = await personWithDevice("receipt-retry");
    const key = `test:${crypto.randomUUID()}`;
    const first = `ticket-${crypto.randomUUID()}`;
    ticketFor = () => ({ status: "ok", id: first });
    expect(await pushToUser(p.id, message(key))).toBe(true);

    setPushReceiptFetcherForTests(async () => ({ [first]: { status: "error", details: { error: "MessageRateExceeded" } } }));
    const pass = await checkPushReceipts(later());
    expect(pass.requeued, "квитанция не вернула событие в очередь").toBeGreaterThanOrEqual(1);
    const [row] = await deliveries(p.id, key);
    expect(row).toMatchObject({ ok: false, error: "MessageRateExceeded", attempts: 1 });
    expect(row!.retryAfter, "срок повтора не назначен").not.toBeNull();
    expect(new Date(row!.retryAfter!).getTime()).toBeGreaterThan(Date.now());

    // до срока — не шлём
    expect(await pushToUser(p.id, message(key))).toBe(false);
    expect(to(p.token)).toHaveLength(1);

    // срок вышел — та же заявка, вторая попытка
    await db.update(pushDeliveries).set({ retryAfter: new Date(Date.now() - 1000).toISOString() }).where(eq(pushDeliveries.id, row!.id));
    const second = `ticket-${crypto.randomUUID()}`;
    ticketFor = () => ({ status: "ok", id: second });
    expect(await pushToUser(p.id, message(key))).toBe(true);
    expect(to(p.token)).toHaveLength(2);
    const [again] = await deliveries(p.id, key);
    expect(again).toMatchObject({ id: row!.id, ok: true, error: null, retryAfter: null, attempts: 2 });

    // квитанция ok — доставлено, больше не шлём
    setPushReceiptFetcherForTests(async () => ({ [second]: { status: "ok" } }));
    await checkPushReceipts(later());
    expect(await pushToUser(p.id, message(key))).toBe(false);
    expect((await deliveries(p.id, key))[0]).toMatchObject({ ok: true, retryAfter: null });
    expect(to(p.token)).toHaveLength(2);
  });

  test("задержка растёт с каждой попыткой", async () => {
    const p = await personWithDevice("receipt-backoff");
    const key = `test:${crypto.randomUUID()}`;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ticket = `ticket-${crypto.randomUUID()}`;
      ticketFor = () => ({ status: "ok", id: ticket });
      expect(await pushToUser(p.id, message(key))).toBe(true);
      setPushReceiptFetcherForTests(async () => ({ [ticket]: { status: "error", details: { error: "MessageRateExceeded" } } }));
      const now = later();
      await checkPushReceipts(now);
      const [row] = await deliveries(p.id, key);
      expect(row).toMatchObject({ ok: false, attempts: attempt });
      delays.push(new Date(row!.retryAfter!).getTime() - now.getTime());
      await db.update(pushDeliveries).set({ retryAfter: new Date(Date.now() - 1000).toISOString() }).where(eq(pushDeliveries.id, row!.id));
    }
    expect(delays[0]).toBe(15 * 60_000);
    expect(delays[1]).toBe(30 * 60_000);
    expect(delays[2]).toBe(60 * 60_000);
  });

  test("одно из двух устройств подтверждено — повтора нет", async () => {
    const p = await personWithDevice("receipt-half");
    const second = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(p.id, second, "ios", "uk");
    const key = `test:${crypto.randomUUID()}`;
    const okTicket = `ticket-${crypto.randomUUID()}`;
    const busyTicket = `ticket-${crypto.randomUUID()}`;
    ticketFor = (token) => ({ status: "ok", id: token === p.token ? busyTicket : okTicket });
    expect(await pushToUser(p.id, message(key))).toBe(true);
    setPushReceiptFetcherForTests(async () => ({
      [okTicket]: { status: "ok" },
      [busyTicket]: { status: "error", details: { error: "MessageRateExceeded" } },
    }));
    await checkPushReceipts(later());
    expect((await deliveries(p.id, key))[0], "человек уведомление видел, а повтор назначен").toMatchObject({ ok: true, retryAfter: null });
  });

  test("постоянный отказ в квитанции закрывает заявку без повтора", async () => {
    const p = await personWithDevice("receipt-big");
    const key = `test:${crypto.randomUUID()}`;
    const ticket = `ticket-${crypto.randomUUID()}`;
    ticketFor = () => ({ status: "ok", id: ticket });
    expect(await pushToUser(p.id, message(key))).toBe(true);
    setPushReceiptFetcherForTests(async () => ({ [ticket]: { status: "error", details: { error: "MessageTooBig" } } }));
    const pass = await checkPushReceipts(later());
    expect(pass.requeued).toBe(0);
    expect((await deliveries(p.id, key))[0]).toMatchObject({ ok: false, error: "MessageTooBig", retryAfter: null });
    expect(await pushToUser(p.id, message(key))).toBe(false);
    expect(to(p.token)).toHaveLength(1);
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
