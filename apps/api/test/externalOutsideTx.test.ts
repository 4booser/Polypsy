import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, makeUser, root } from "./fixtures";
import { asAppRole, taggedAppRolePool } from "./appRole";
import { baseDb, runOnPool } from "../src/db";
import { systemContext, withDbContext, withRequestContext } from "../src/db/context";
import { pushDeliveries, pushOutcomes, securityJobs, users } from "../src/db/schema";
import { type StartOutcome, startReencrypt } from "../src/lib/keyRotation";
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
