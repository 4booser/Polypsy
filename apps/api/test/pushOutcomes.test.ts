import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { adminA, db, makeUser } from "./fixtures";
import { asAppRole } from "./appRole";
import { baseDb } from "../src/db";
import { systemContext, withDbContext } from "../src/db/context";
import { pushDeliveries, pushOutcomes } from "../src/db/schema";
import { log } from "../src/lib/log";
import {
  checkPushReceipts,
  type PushTicket,
  pushToUser,
  registerDevice,
  setPushReceiptFetcherForTests,
  setPushSenderForTests,
} from "../src/lib/push";

/**
 * Исходы пушей, отправленных изнутри транзакции (#192).
 *
 * Заявка на отправку (push_deliveries) вставлялась в транзакции вызывающего
 * — запроса или задачи (каждый рассыльщик оборачивает pushToUser в
 * systemContext), — а исходы по устройствам (push_outcomes, внешний ключ на
 * заявку) писались своей транзакцией, которая незафиксированной заявки не
 * видит. Внешний ключ падал, ошибка глоталась (push.outcome_write_failed), и
 * исходов не было почти ни у одного пуша: квитанциям Expo не с чем было
 * сверяться — отказ «лимит частоты» не возвращал заявку на повтор, мёртвые
 * токены не забывались, техпанель не видела исходов. Сеть при этом шла
 * внутри транзакции вызывающего.
 *
 * Отправитель и квитанции подменены. Отправки — пулом роли приложения.
 */

/** Отдельное соединение владельца: видит только зафиксированное */
const observer = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

interface Seen {
  to: string;
  /** Заявка зафиксирована к моменту, когда сообщение уходит в сеть */
  claimCommitted: boolean;
}
const seen: Seen[] = [];
let watch: { userId: string; eventKey: string } | null = null;

beforeAll(() => {
  setPushSenderForTests(async (messages) => {
    const [row] = watch
      ? await observer`select 1 as ok from push_deliveries where user_id = ${watch.userId} and event_key = ${watch.eventKey}`
      : [];
    for (const m of messages) seen.push({ to: m.to, claimCommitted: Boolean(row) });
    return messages.map((): PushTicket => ({ status: "ok", id: `ticket-${crypto.randomUUID()}` }));
  });
});

afterEach(() => {
  watch = null;
  seen.length = 0;
  setPushReceiptFetcherForTests(null);
});

afterAll(async () => {
  setPushSenderForTests(null);
  setPushReceiptFetcherForTests(null);
  await observer.end();
}, 15_000);

/** Человек с двумя устройствами */
async function personWithDevices(tag: string) {
  const person = await makeUser("user", `po-${tag}-${crypto.randomUUID()}@test`);
  const tokens = [`ExponentPushToken[${crypto.randomUUID()}]`, `ExponentPushToken[${crypto.randomUUID()}]`];
  await registerDevice(person.id, tokens[0]!, "android", "uk");
  await registerDevice(person.id, tokens[1]!, "ios", "ru");
  return { ...person, tokens };
}

const message = (eventKey: string) => ({ eventKey, kind: "test", title: "Т", body: "Т" });

async function deliveryOf(userId: string, eventKey: string) {
  const [row] = await db
    .select()
    .from(pushDeliveries)
    .where(and(eq(pushDeliveries.userId, userId), eq(pushDeliveries.eventKey, eventKey)));
  return row;
}

const outcomesOf = (deliveryId: string) => db.select().from(pushOutcomes).where(eq(pushOutcomes.deliveryId, deliveryId));

/**
 * Отправить, проверить исходы после фиксации и вернуть заявку квитанцией
 * «лимит частоты» — общий путь для всех способов вызова.
 */
async function sendAndSettle(tag: string, send: (userId: string, eventKey: string) => Promise<boolean>) {
  const p = await personWithDevices(tag);
  const eventKey = `test:po:${crypto.randomUUID()}`;
  watch = { userId: p.id, eventKey };
  const warn = spyOn(log, "warn");
  let sent: boolean;
  let writeFailures: unknown[];
  try {
    sent = await send(p.id, eventKey);
  } finally {
    // до mockRestore: он сбрасывает и записанные вызовы
    writeFailures = warn.mock.calls.filter(([m]) => m === "push.outcome_write_failed");
    warn.mockRestore();
  }

  expect(sent).toBe(true);
  expect(seen.map((s) => s.to).sort()).toEqual([...p.tokens].sort());
  expect(writeFailures, "исход не записался").toEqual([]);
  expect(
    seen.every((s) => s.claimCommitted),
    "в сеть ушло раньше, чем зафиксирована заявка",
  ).toBe(true);

  const delivery = await deliveryOf(p.id, eventKey);
  expect(delivery?.ok).toBe(true);
  const outcomes = await outcomesOf(delivery!.id);
  expect(outcomes.length, "исходов по устройствам нет").toBe(2);
  expect(outcomes.every((o) => o.status === "accepted" && o.ticketId)).toBe(true);

  // квитанция через четверть часа: «лимит частоты» по всем устройствам — заявка возвращается на повтор
  const tickets = new Set(outcomes.map((o) => o.ticketId!));
  setPushReceiptFetcherForTests(async (ids) =>
    Object.fromEntries(
      ids
        .filter((id) => tickets.has(id))
        .map((id) => [id, { status: "error" as const, message: "rate", details: { error: "MessageRateExceeded" } }]),
    ),
  );
  const receipts = await asAppRole(() =>
    systemContext(baseDb, () => checkPushReceipts(new Date(Date.now() + 20 * 60_000))),
  );
  expect(receipts.requeued).toBeGreaterThanOrEqual(1);
  const after = await deliveryOf(p.id, eventKey);
  expect(after).toMatchObject({ ok: false, error: "MessageRateExceeded" });
  expect(after?.retryAfter, "квитанция не вернула заявку на повтор").not.toBeNull();
}

describe("исходы пуша, отправленного изнутри транзакции", () => {
  test("в транзакции задачи (как у рассыльщиков): исходы по каждому устройству, квитанция возвращает заявку", async () => {
    await sendAndSettle("task", (userId, eventKey) =>
      asAppRole(() => systemContext(baseDb, () => pushToUser(userId, message(eventKey)))),
    );
  }, 30_000);

  test("в транзакции запроса сотрудника: исходы по каждому устройству, квитанция возвращает заявку", async () => {
    await sendAndSettle("request", (userId, eventKey) =>
      asAppRole(() => withDbContext(baseDb, { userId: adminA.id, role: "admin" }, () => pushToUser(userId, message(eventKey)))),
    );
  }, 30_000);

  test("положительный контроль — вне транзакции: то же самое", async () => {
    await sendAndSettle("outside", (userId, eventKey) => pushToUser(userId, message(eventKey)));
  }, 30_000);
});
