import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appApi, db, makeUser, type Person, root } from "./fixtures";
import { asAppRole, taggedAppRolePool } from "./appRole";
import { baseDb, runOnPool } from "../src/db";
import { systemContext, withDbContext, withRequestContext } from "../src/db/context";
import {
  appointments,
  departments,
  googleCalendarTokens,
  pushDeliveries,
  pushOutcomes,
  securityJobs,
  slots,
  specialistProfiles,
  users,
} from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";
import { type StartOutcome, startReencrypt } from "../src/lib/keyRotation";
import { syncDueMeetings } from "../src/lib/meetSync";
import { tickOnce } from "../src/lib/opsJobs";
import {
  checkPushReceipts,
  type PushReceipt,
  type PushTicket,
  pushToUser,
  registerDevice,
  setPushReceiptFetcherForTests,
  setPushSenderForTests,
} from "../src/lib/push";

/**
 * Внешние вызовы и фоновые проходы вне транзакций (#204).
 *
 * Сеть не держит открытую транзакцию и не держит соединение пула; проход,
 * запущенный из запроса, живёт вне запроса — без его транзакции и без
 * отмены по его обрыву. Внешний вызов «висит» до команды теста — так видно,
 * что держит проход, пока ждёт сеть.
 */

const TAG = `w22ext${crypto.randomUUID().slice(0, 8)}`;

afterAll(() => {
  setPushSenderForTests(null);
  setPushReceiptFetcherForTests(null);
});

/** Вызов, который ждёт команды: сколько дошло и отпустить всех */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = 0;
  return {
    wait: async () => {
      reached += 1;
      await opened;
    },
    reached: () => reached,
    release: () => open(),
  };
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`не дождались: ${what}`);
}

/** Соединения пула с этим именем, у которых открыта транзакция */
async function openTransactions(applicationName: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and application_name = ${applicationName} and xact_start is not null`);
  return Number(row?.n ?? 0);
}

/** Соседний запрос тем же пулом: короткая системная транзакция — сколько он ждал */
async function neighbour(pool: Awaited<ReturnType<typeof taggedAppRolePool>>): Promise<number> {
  const t0 = performance.now();
  await runOnPool(pool, () => systemContext(baseDb, () => db.select({ id: users.id }).from(users).limit(1)));
  return performance.now() - t0;
}

/* ═══════════ перешифровка: запуск из запроса ═══════════ */

describe("перешифровка, запущенная запросом, идёт вне запроса (#204)", () => {
  /**
   * Запуск — как у маршрута POST /api/ops/sec/keys/reencrypt: в транзакции
   * запроса суперадмина, под ролью приложения. `leave` — клиент уходит
   * сразу, как получил ответ о запуске.
   */
  async function launch(leave: boolean) {
    const controller = new AbortController();
    const box: { outcome?: StartOutcome } = {};
    await asAppRole(() =>
      withRequestContext(
        baseDb,
        { userId: root.id, role: "superadmin" },
        async () => {
          box.outcome = await startReencrypt({ id: root.id, email: "root@test" });
          if (leave) controller.abort();
        },
        () => false,
        { signal: controller.signal },
      ),
    );
    const outcome = box.outcome!;
    if (!outcome.started) throw new Error(`перешифровка не запустилась: ${outcome.reason}`);
    await outcome.done;
    const [job] = await db.select().from(securityJobs).where(eq(securityJobs.id, outcome.job.id));
    return job!;
  }

  // первым: оборванный на прежнем коде проход висит «идущим» и не дал бы запустить следующий
  test("положительный контроль: клиент дождался — проход доходит до конца", async () => {
    const job = await launch(false);
    expect(job.status, job.error ?? "").toBe("done");
  }, 60_000);

  /*
   * Прежде проход выходил только из транзакции запроса (dbContext.exit), а
   * отмена по обрыву клиента (#186) оставалась на нём: каждый его запрос к
   * базе после обрыва отвергался, и перешифровка обрывалась вместе с
   * запросом, который лишь запустил её, — повиснув «идущей»: и отметка
   * сбоя, и строка журнала шли тем же отвергнутым путём. Изменяющие запросы
   * сегодня не отменяются (только чтение, middleware/auth.ts), но проход не
   * должен держаться за это.
   */
  test("клиент ушёл сразу после запуска — проход доходит до конца", async () => {
    const job = await launch(true);
    expect(job.status, job.error ?? "").toBe("done");
    expect(job.finishedAt).not.toBeNull();
  }, 60_000);
});

/* ═══════════ квитанции Expo ═══════════ */

describe("квитанции Expo спрашиваются вне транзакции (#204)", () => {
  /** Отправленный пуш с билетами — как после рассылки; квитанцию по нему можно спросить через четверть часа */
  async function sentPush(tag: string) {
    const person = await makeUser("user", `${TAG}-${tag}-${crypto.randomUUID()}@test`);
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    await registerDevice(person.id, token, "android", "uk");
    const tickets: string[] = [];
    setPushSenderForTests(async (messages) =>
      messages.map((): PushTicket => {
        const id = `${TAG}-ticket-${crypto.randomUUID()}`;
        tickets.push(id);
        return { status: "ok", id };
      }),
    );
    const eventKey = `test:${TAG}:${crypto.randomUUID()}`;
    expect(await pushToUser(person.id, { eventKey, kind: "test", title: "Т", body: "Т" })).toBe(true);
    const [delivery] = await db
      .select()
      .from(pushDeliveries)
      .where(and(eq(pushDeliveries.userId, person.id), eq(pushDeliveries.eventKey, eventKey)));
    return { deliveryId: delivery!.id, tickets: new Set(tickets) };
  }

  /** «Лимит частоты» по своим билетам — Expo велит повторить с задержкой */
  const rateLimited = (tickets: Set<string>) => (ids: string[]) =>
    Object.fromEntries(
      ids
        .filter((id) => tickets.has(id))
        .map((id): [string, PushReceipt] => [id, { status: "error", details: { error: "MessageRateExceeded" } }]),
    );

  const later = () => new Date(Date.now() + 20 * 60_000);

  /*
   * Прежде проход шёл одной транзакцией вызывающего (планировщик оборачивал
   * его в systemContext), и Expo спрашивался внутри неё: соединение пула
   * стояло открытой транзакцией весь ответ Expo, до 15 с. Без обёртки
   * проход под ролью приложения не видел ни одного исхода — работать вне
   * транзакции вызывающего он не умел вовсе. Теперь — так, как зовёт
   * планировщик: без обёртки; свои короткие транзакции проход открывает сам.
   */
  test("Expo висит: проходы не держат ни транзакции, ни соединения, соседний запрос не ждёт; итоги записаны", async () => {
    const sent = await sentPush("receipts");
    const appName = `${TAG}-receipts`;
    const pool = await taggedAppRolePool(appName);
    const expo = gate();
    setPushReceiptFetcherForTests(async (ids) => {
      await expo.wait();
      return rateLimited(sent.tickets)(ids);
    });
    try {
      // проходов больше, чем соединений в пуле: держи каждый своё — пул кончился бы
      const passes = Array.from({ length: 12 }, () => runOnPool(pool, () => checkPushReceipts(later())));
      for (const p of passes) p.catch(() => {});
      await until(() => expo.reached() >= 12, "все проходы дошли до Expo");

      expect(await openTransactions(appName), "проход держит транзакцию, пока ждёт Expo").toBe(0);
      expect(await neighbour(pool), "соседний запрос ждал свободного соединения").toBeLessThan(2000);

      expo.release();
      const results = await Promise.all(passes);
      expect(results.reduce((sum, r) => sum + r.requeued, 0)).toBe(1);
    } finally {
      expo.release();
      await pool.close();
    }

    const outcomes = await db.select().from(pushOutcomes).where(eq(pushOutcomes.deliveryId, sent.deliveryId));
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.receiptStatus === "error" && o.receiptError === "MessageRateExceeded")).toBe(true);
    const [delivery] = await db.select().from(pushDeliveries).where(eq(pushDeliveries.id, sent.deliveryId));
    expect(delivery).toMatchObject({ ok: false, error: "MessageRateExceeded" });
    expect(delivery?.retryAfter, "квитанция не вернула заявку на повтор").not.toBeNull();
  }, 60_000);

  test("положительный контроль: и внутри чужой транзакции проход видит и пишет то же", async () => {
    const sent = await sentPush("receipts-inside");
    setPushReceiptFetcherForTests(async (ids) => rateLimited(sent.tickets)(ids));
    const result = await asAppRole(() =>
      withDbContext(baseDb, { userId: null, role: "system" }, () => checkPushReceipts(later())),
    );
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const outcomes = await db
      .select()
      .from(pushOutcomes)
      .where(inArray(pushOutcomes.deliveryId, [sent.deliveryId]));
    expect(outcomes.every((o) => o.receiptStatus === "error")).toBe(true);
  }, 30_000);
});

/* ═══════════ фоновое сведение Google Calendar ═══════════ */

describe("фоновое сведение Google: сеть вне транзакции, приём держится захватом (#204)", () => {
  const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const meetOf = (id: string) => `https://meet.google.com/${id}`;
  const originalFetch = globalThis.fetch;
  const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };

  interface Call {
    method: string;
    url: string;
    start: string | null;
  }
  /** Календарь «Google»: событие и его начало */
  const calendar = new Map<string, { start: string }>();
  let eventSeq = 0;
  /** Вызовы, которые «висят» до команды теста: у каждого — один, первый подходящий */
  const holds: { match: (call: Call) => boolean; wait: () => Promise<void> }[] = [];
  /** Все вызовы к событиям — по ним видно, не звали ли Google дважды */
  const calls: Call[] = [];

  function holdGoogle(match: (call: Call) => boolean) {
    const g = gate();
    let taken = false;
    holds.push({
      match: (call) => {
        if (taken || !match(call)) return false;
        taken = true;
        return true;
      },
      wait: g.wait,
    });
    return g;
  }

  async function google(call: Call): Promise<Response> {
    calls.push(call);
    const held = holds.find((h) => h.match(call));
    if (held) await held.wait();
    if (call.method === "POST") {
      eventSeq += 1;
      const created = `${TAG}-evt-${eventSeq}`;
      calendar.set(created, { start: call.start ?? "" });
      return Response.json({ id: created, hangoutLink: meetOf(created) });
    }
    const id = decodeURIComponent(call.url.slice(EVENTS.length + 1).replace(/\?.*$/, ""));
    const event = calendar.get(id);
    if (!event) return Response.json({ error: "not found" }, { status: 404 });
    if (call.method === "DELETE") {
      calendar.delete(id);
      return new Response(null, { status: 204 });
    }
    if (call.method === "PATCH" && call.start) event.start = call.start;
    return Response.json({ id });
  }

  let departmentId: string;
  const mine: string[] = [];

  beforeAll(async () => {
    env.googleClientId = "test-client";
    env.googleClientSecret = "test-secret";
    env.googleRedirectUri = "http://localhost/meet/callback";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "synthetic-access" });
      if (url.startsWith("https://www.googleapis.com/")) {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { start?: { dateTime?: string } }) : null;
        return google({ method: init?.method ?? "GET", url, start: body?.start?.dateTime ?? null });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: `Сведення поза транзакцією ${TAG}`, ru: `Сведение вне транзакции ${TAG}` },
      timezone: "Europe/Kyiv",
    });
  });

  afterAll(async () => {
    holds.length = 0;
    globalThis.fetch = originalFetch;
    // настройки Google — назад: «вход через Google выключен, пока не настроен» проверяют соседи
    env.googleClientId = saved.id;
    env.googleClientSecret = saved.secret;
    env.googleRedirectUri = saved.redirect;
    // ничего живого в общей очереди сведения
    if (mine.length) {
      await db
        .update(appointments)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString(), meetingSyncAt: null })
        .where(inArray(appointments.id, mine));
    }
  }, 15_000);

  let slotSeq = 0;
  async function slotFor(specialistId: string) {
    slotSeq += 1;
    const start = Date.now() + 500 * 3600_000 + slotSeq * 2 * 3600_000;
    const id = crypto.randomUUID();
    const startsAt = new Date(start).toISOString();
    await db.insert(slots).values({ id, specialistId, departmentId, startsAt, endsAt: new Date(start + 3600_000).toISOString() });
    return { id, startsAt };
  }

  async function specialist(tag: string): Promise<Person> {
    const person = await makeUser("admin", `${TAG}-s-${tag}-${crypto.randomUUID()}@test`);
    await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
    await db
      .insert(googleCalendarTokens)
      .values({ userId: person.id, refreshTokenEnc: encryptField(`refresh-${tag}`)!, googleEmail: `${tag}@example.test` });
    return person;
  }

  const appointment = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;

  /** Дистанционный приём с событием в календаре врача — записью пациента, ролью приложения */
  async function remoteVisit(tag: string) {
    const doctor = await specialist(tag);
    const patient = await makeUser("user", `${TAG}-p-${tag}-${crypto.randomUUID()}@test`);
    const slot = await slotFor(doctor.id);
    const res = await appApi("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: slot.id, mode: "remote" }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    mine.push(res.body.id);
    const row = await appointment(res.body.id);
    expect(calendar.has(row.meetingEventId!)).toBe(true);
    return { id: res.body.id as string, doctor, patient, slot, row };
  }

  /** Сведение отложено прежним сбоем: строка ждёт фонового прохода */
  const pending = (id: string, set: Partial<typeof appointments.$inferInsert> = {}) =>
    db
      .update(appointments)
      .set({ ...set, meetingSyncAt: new Date(Date.now() - 60_000).toISOString(), meetingSyncAttempts: 1 })
      .where(eq(appointments.id, id));

  const later = () => new Date(Date.now() + 3600_000);
  const post = (path: string, token: string, body: unknown) =>
    appApi(path, token, { method: "POST", body: JSON.stringify(body) });

  /** Завершился ли запрос за отведённое время — не стоял ли он за чужим замком */
  async function doneWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
    return Promise.race([p.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
  }

  /*
   * Прежде фоновый проход держал строку приёма замком (и транзакцию с
   * соединением пула) всё время обращений к Google — до 8 с на вызов. Перенос
   * и отмена того же приёма стояли за этим замком.
   */
  test("Google висит на переносе события: проход не держит транзакции; отмена того же приёма не ждёт и сводит календарь сама", async () => {
    const visit = await remoteVisit("cancel");
    await pending(visit.id);
    const appName = `${TAG}-meet-cancel`;
    const pool = await taggedAppRolePool(appName);
    const g = holdGoogle((c) => c.method === "PATCH" && c.url.includes(visit.row.meetingEventId!));
    try {
      const pass = runOnPool(pool, () => syncDueMeetings(later()));
      pass.catch(() => {});
      await until(() => g.reached() > 0, "проход дошёл до Google");

      expect(await openTransactions(appName), "проход держит транзакцию, пока ждёт Google").toBe(0);
      const cancel = post(`/api/clinic/appointments/${visit.id}/cancel`, visit.patient.token, {});
      expect(await doneWithin(cancel, 5_000), "отмена ждала проход, который ждёт Google").toBe(true);
      expect((await cancel).status).toBe(200);

      g.release();
      await pass;
    } finally {
      g.release();
      await pool.close();
    }

    // запоздавший итог прохода, посчитанный по прежнему приёму, не записан
    const after = await appointment(visit.id);
    expect(after.status).toBe("cancelled");
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingSyncAt).toBeNull();
    expect(calendar.has(visit.row.meetingEventId!)).toBe(false);
  }, 60_000);

  test("положительный контроль: Google висит, приём никто не трогает — соседи не ждут, после ответа итог записан", async () => {
    const visit = await remoteVisit("settle");
    // перенос на другой слот того же врача, не дошедший до Google
    const next = await slotFor(visit.doctor.id);
    await pending(visit.id, { slotId: next.id });
    const appName = `${TAG}-meet-settle`;
    const pool = await taggedAppRolePool(appName);
    const g = holdGoogle((c) => c.method === "PATCH" && c.url.includes(visit.row.meetingEventId!));
    let result: { attempted: number; settled: number };
    try {
      const pass = runOnPool(pool, () => syncDueMeetings(later()));
      pass.catch(() => {});
      await until(() => g.reached() > 0, "проход дошёл до Google");
      expect(await openTransactions(appName)).toBe(0);
      expect(await neighbour(pool)).toBeLessThan(2000);
      // второй проход захваченный приём не берёт
      const second = await runOnPool(pool, () => syncDueMeetings(later()));
      expect(second.settled).toBe(0);
      g.release();
      result = await pass;
    } finally {
      g.release();
      await pool.close();
    }

    expect(result.settled).toBeGreaterThanOrEqual(1);
    const after = await appointment(visit.id);
    expect(after.meetingSyncAt).toBeNull();
    expect(after.meetingSyncAttempts).toBe(0);
    expect(after.meetingEventId).toBe(visit.row.meetingEventId);
    expect(calendar.get(visit.row.meetingEventId!)?.start).toBe(next.startsAt);
  }, 60_000);

  test("перенос, пока проход ждёт Google на переносе события: запрос не ждёт, запоздавший вызов прохода его не перебивает", async () => {
    const visit = await remoteVisit("late-move");
    const first = await slotFor(visit.doctor.id);
    await pending(visit.id, { slotId: first.id });
    const target = await slotFor(visit.doctor.id);
    const g = holdGoogle((c) => c.method === "PATCH" && c.url.includes(visit.row.meetingEventId!));
    try {
      const pass = syncDueMeetings(later());
      pass.catch(() => {});
      await until(() => g.reached() > 0, "проход дошёл до Google");
      const moved = post(`/api/clinic/appointments/${visit.id}/reschedule`, visit.patient.token, { slotId: target.id });
      expect(await doneWithin(moved, 5_000), "перенос ждал проход, который ждёт Google").toBe(true);
      expect((await moved).status).toBe(200);
      expect(calendar.get(visit.row.meetingEventId!)?.start).toBe(target.startsAt);

      // вызов прохода доходит до Google позже переноса — и ставит событие на прежнее время
      g.release();
      await pass;
    } finally {
      g.release();
    }
    expect(calendar.get(visit.row.meetingEventId!)?.start).toBe(first.startsAt);
    // но итог прохода не записан, сведение запрошено заново — и следующий проход ставит событие на место
    expect((await appointment(visit.id)).meetingSyncAt).not.toBeNull();
    await syncDueMeetings(later());
    expect(calendar.get(visit.row.meetingEventId!)?.start).toBe(target.startsAt);
    expect((await appointment(visit.id)).meetingSyncAt).toBeNull();
  }, 60_000);

  test("событие, созданное проходом, пока приём перенесли, не остаётся сиротой: приём берёт его и сводится заново", async () => {
    const visit = await remoteVisit("adopt");
    // сбой посреди пересоздания: прежнее событие убрано, новое не создано
    calendar.delete(visit.row.meetingEventId!);
    await pending(visit.id, { meetingEventId: null, meetingOrganizerId: null, meetingUrl: null });
    const target = await slotFor(visit.doctor.id);
    const g = holdGoogle((c) => c.method === "POST" && c.start === visit.slot.startsAt);
    let before = 0;
    try {
      const pass = syncDueMeetings(later());
      pass.catch(() => {});
      await until(() => g.reached() > 0, "проход дошёл до создания события");
      // перенос приёма без события сведения не просит; прежде он стоял за замком прохода
      const moved = post(`/api/clinic/appointments/${visit.id}/reschedule`, visit.patient.token, { slotId: target.id });
      expect(await doneWithin(moved, 5_000), "перенос ждал проход, который ждёт Google").toBe(true);
      expect((await moved).status).toBe(200);
      before = eventSeq;
      g.release();
      await pass;
    } finally {
      g.release();
    }

    // проход создал событие на прежнее время; приём его взял и попросил сведения
    const adopted = await appointment(visit.id);
    expect(adopted.meetingEventId).toBe(`${TAG}-evt-${before + 1}`);
    expect(adopted.meetingSyncAt).not.toBeNull();
    await syncDueMeetings(later());
    const after = await appointment(visit.id);
    expect(after.meetingEventId).toBe(adopted.meetingEventId);
    expect(after.meetingUrl).toBe(meetOf(after.meetingEventId!));
    expect(after.meetingSyncAt).toBeNull();
    expect(calendar.get(after.meetingEventId!)?.start).toBe(target.startsAt);
    expect(eventSeq, "создано лишнее событие").toBe(before + 1);
  }, 60_000);

  /*
   * Ревью волны 22: срок захвата считался от начала прохода. Проход идёт по
   * очереди, и при медленном Google приём, захваченный через три минуты
   * после начала, получал срок, истёкший ещё до захвата, — следующий такт
   * брал его же и звал Google второй раз.
   */
  test("медленный Google: срок захвата — от момента захвата; следующий такт не берёт приём, который проход ещё сводит", async () => {
    const slow = await remoteVisit("slow-first");
    const late = await remoteVisit("slow-late");
    // оба ждут сведения; медленный — раньше в очереди
    await db
      .update(appointments)
      .set({ meetingSyncAt: new Date(Date.now() - 120_000).toISOString(), meetingSyncAttempts: 1 })
      .where(eq(appointments.id, slow.id));
    await pending(late.id);
    const lateCalls = () => calls.filter((c) => c.method === "PATCH" && c.url.includes(late.row.meetingEventId!)).length;

    const start = Date.now();
    const first = holdGoogle((c) => c.method === "PATCH" && c.url.includes(slow.row.meetingEventId!));
    const second = holdGoogle((c) => c.method === "PATCH" && c.url.includes(late.row.meetingEventId!));
    try {
      const pass = syncDueMeetings(new Date(start));
      pass.catch(() => {});
      await until(() => first.reached() > 0, "проход дошёл до медленного приёма");
      // Google отвечал по медленному приёму три минуты — дольше срока захвата
      setSystemTime(new Date(start + 3 * 60_000));
      first.release();
      await until(() => second.reached() > 0, "проход захватил следующий приём и ждёт Google");

      // следующий такт — уже после этих трёх минут
      await syncDueMeetings(new Date());
      expect(lateCalls(), "следующий такт взял приём, который сводит проход").toBe(1);

      second.release();
      await pass;
    } finally {
      first.release();
      second.release();
      setSystemTime();
    }
    const after = await appointment(late.id);
    expect(after.meetingSyncAt).toBeNull();
    expect(after.meetingSyncAttempts).toBe(0);
  }, 60_000);

  test("такты сведения не накладываются: пока идёт прошлый проход, следующий такт пропускается", async () => {
    const name = `${TAG}-meet-tick`;
    const g = gate();
    let runs = 0;
    const slowPass = () => {
      runs += 1;
      return g.wait();
    };
    const first = tickOnce(name, slowPass);
    expect(await tickOnce(name, slowPass), "второй проход пошёл рядом с первым").toBeNull();
    expect(runs).toBe(1);
    g.release();
    await first;
    // прошлый кончился — следующий такт идёт
    expect(await tickOnce(name, async () => "ok")).toBe("ok");
  }, 15_000);
});
