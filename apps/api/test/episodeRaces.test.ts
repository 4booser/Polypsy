import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { renderError } from "@quizzy/shared";
import { adminA, api, appApi, db, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { auditLog, episodes } from "../src/db/schema";
import { decryptField } from "../src/lib/crypto";

/**
 * Обращение: гонки закрытия и открытия (#153).
 *
 * Прежде «ещё открыто» и «открытых нет» проверялись чтением, а запись шла
 * следом без замка: два одновременных закрытия оба получали 200 — в строке
 * оставался исход второго, в журнале две строки о закрытии; два открытия
 * давали 201 и 500 (второе натыкалось на уникальный индекс одного открытого
 * обращения).
 *
 * Приём — как в guardRaces.test.ts: отдельное соединение владельца держит
 * строку, запросы под ролью приложения запускаются по одному и каждый
 * дожидается, пока встанет в очередь за замком; порядок в очереди — порядок
 * прохода. Каждая проверка — в обоих порядках.
 */

const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

afterAll(async () => {
  await holder.end();
});

async function lockWaiters(fragments: string[]): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      and query ilike any (array[${sql.join(
        fragments.map((f) => sql`${`%${f}%`}`),
        sql`, `,
      )}]::text[])
  `);
  return Number(row?.n ?? 0);
}

async function untilWaiting(n: number, fragments: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

const ROLLBACK = new Error("откат держателя");

/**
 * Держать замок, пока все действия не встанут за ним в очередь, и отпустить.
 * rollback — держатель откатывается (его вставка исчезает), иначе фиксирует.
 */
async function whileHeld<T>(
  hold: (tx: postgres.TransactionSql) => Promise<unknown>,
  actions: (() => Promise<T>)[],
  waitsOn: string[],
  rollback = false,
): Promise<T[]> {
  const pending: Promise<T>[] = [];
  await holder
    .begin(async (tx) => {
      await hold(tx);
      for (const [i, start] of actions.entries()) {
        const p = start();
        p.catch(() => {});
        pending.push(p);
        await untilWaiting(i + 1, waitsOn);
      }
      if (rollback) throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
  return Promise.all(pending);
}

/** Человек в зоне adminA: обращение открывают тому, кто в зоне */
async function patientOf(tag: string) {
  const person = await makeUser("user", `ep-race-${tag}-${crypto.randomUUID()}@test`);
  const submitted = await submitSurvey(surveyInA, person.token);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
  return person;
}

async function openEpisode(patientId: string): Promise<string> {
  const res = await appApi("/api/episodes", adminA.token, { method: "POST", body: JSON.stringify({ patientId }) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const close = (id: string, body: Record<string, unknown>) => () =>
  appApi(`/api/episodes/${id}/close`, adminA.token, { method: "POST", body: JSON.stringify(body) });

async function closeRows(id: string) {
  return db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "episode.close"), eq(auditLog.resourceId, id)));
}

describe("закрытие обращения: исход — первого (#153)", () => {
  const worse = { outcomeKind: "worse", outcome: "Погіршення після повернення з відрядження" };
  const improved = { outcomeKind: "improved" };

  for (const [name, first, second] of [
    ["«гірше» зі словами, потім «покращення»", worse, improved],
    ["«покращення», потім «гірше» зі словами", improved, worse],
  ] as const) {
    test(`два закрытия одновременно — ${name}: первому 200, второму отказ, исход и журнал первого`, async () => {
      const person = await patientOf("close");
      const id = await openEpisode(person.id);
      const [a, b] = await whileHeld(
        (tx) => tx`select id from episodes where id = ${id} for update`,
        [close(id, first), close(id, second)],
        ['"episodes"'],
      );
      expect(a!.status, JSON.stringify(a!.body)).toBe(200);
      expect(b!.status, "второе закрытие затёрло исход первого").toBe(400);
      expect(b!.body.error).toBe(renderError("err.episodeClosed", "uk"));

      const [row] = await db.select().from(episodes).where(eq(episodes.id, id));
      expect(row!.outcomeKind as string | null).toBe(first.outcomeKind);
      expect(decryptField(row!.outcomeEnc)).toBe("outcome" in first ? first.outcome : null);
      const logged = await closeRows(id);
      expect(logged.map((r) => (r.details as { outcomeKind: string }).outcomeKind)).toEqual([first.outcomeKind]);
    }, 30_000);
  }

  test("контроль: последовательный повтор — тот же отказ, исход первого", async () => {
    const person = await patientOf("close-seq");
    const id = await openEpisode(person.id);
    expect((await close(id, worse)()).status).toBe(200);
    const again = await close(id, improved)();
    expect(again.status).toBe(400);
    const [row] = await db.select().from(episodes).where(eq(episodes.id, id));
    expect(row!.outcomeKind).toBe("worse");
    expect((await closeRows(id)).length).toBe(1);
  }, 30_000);
});

describe("открытие обращения: второе одновременное — отказ, а не 500 (#153)", () => {
  /*
   * Держатель вставляет незафиксированное открытое обращение того же
   * человека и откатывается, когда оба запроса встали в очередь: так оба
   * прочитали «открытых нет» до того, как появилось первое настоящее.
   */
  for (const [name, firstReason, secondReason] of [
    ["повод A, затем B", "Повод A", "Повод B"],
    ["повод B, затем A", "Повод B", "Повод A"],
  ] as const) {
    test(`два открытия одновременно — ${name}: 201 и 400, открыто одно — первое`, async () => {
      const person = await patientOf("open");
      const open = (reason: string) => () =>
        appApi("/api/episodes", adminA.token, {
          method: "POST",
          body: JSON.stringify({ patientId: person.id, reason }),
        });
      const [a, b] = await whileHeld(
        (tx) => tx`insert into episodes (id, patient_id, lead_specialist_id, created_by)
          values (${crypto.randomUUID()}, ${person.id}, ${adminA.id}, ${adminA.id})`,
        [open(firstReason), open(secondReason)],
        ['"episodes"', "pg_advisory_xact_lock"],
        true,
      );
      expect(a!.status, JSON.stringify(a!.body)).toBe(201);
      expect(b!.status, `второе открытие: ${JSON.stringify(b!.body)}`).toBe(400);
      expect(b!.body.error).toBe(renderError("err.episodeAlreadyOpen", "uk"));

      const opened = await db
        .select()
        .from(episodes)
        .where(and(eq(episodes.patientId, person.id), isNull(episodes.closedAt)));
      expect(opened.map((e) => e.id)).toEqual([a!.body.id]);
      expect(decryptField(opened[0]!.reasonEnc)).toBe(firstReason);
    }, 30_000);
  }

  test("контроль: открыть, закрыть, открыть снова — проходит", async () => {
    const person = await patientOf("open-seq");
    const id = await openEpisode(person.id);
    expect((await close(id, { outcomeKind: "stable" })()).status).toBe(200);
    const again = await api("/api/episodes", adminA.token, { method: "POST", body: JSON.stringify({ patientId: person.id }) });
    expect(again.status).toBe(201);
  }, 30_000);
});
