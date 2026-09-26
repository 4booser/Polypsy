import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { adminA, app, db, makeUser, surveyInA } from "./fixtures";
import { surveyAccess } from "../src/db/schema";
import { dbContext } from "../src/db/context";
import { publish } from "../src/lib/events";
import { currentRequestId } from "../src/lib/log";
import { eventStreamTiming } from "../src/routes/events";

/**
 * Поток событий живёт дольше своего запроса — и зона доступа в нём тоже.
 *
 * Внешний разбор 2026-09-26, два пункта об одном месте (routes/events.ts):
 *
 * 1. streamSSE отдаёт ответ раньше, чем кончается колбэк потока, и
 *    транзакция авторизации коммитится сразу после ответа. А колбэк
 *    продолжал перечитывать зону в той, сохранённой транзакции —
 *    завершённой, без гарантии, что под ней ещё стоит контекст этого
 *    сотрудника. Теперь каждое перечитывание — своя короткая транзакция с
 *    контекстом строк (app.user_id/app.role) сотрудника.
 * 2. Пациенты зоны читались один раз, при открытии: пульс перечитывал
 *    только методики. Отозвали доступ к человеку — события о нём (общий
 *    поток «action», без методик) шли до переподключения, то есть часами.
 */

const PULSE = 120;
let savedPulse = 0;

/* транзакции с контекстом человека, по номеру запроса: кто и под какой ролью */
const opened = new Map<string, { role: string; userId: string }[]>();
const originalRun = dbContext.run;

beforeAll(() => {
  savedPulse = eventStreamTiming.pulseMs;
  eventStreamTiming.pulseMs = PULSE;
  dbContext.run = function (this: typeof dbContext, store: never, fn: () => unknown) {
    const requestId = currentRequestId();
    // exit() в bun — это run(undefined): транзакции нет, считать нечего
    if (!requestId || !store) return originalRun.call(this, store, fn);
    return originalRun.call(this, store, async () => {
      const [row] = (await (store as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select current_setting('app.role', true) as role, current_setting('app.user_id', true) as uid`,
      )) as { role: string | null; uid: string | null }[];
      if (row?.role && row.role !== "system") {
        const list = opened.get(requestId) ?? [];
        list.push({ role: row.role, userId: row.uid ?? "" });
        opened.set(requestId, list);
      }
      return fn();
    });
  } as typeof dbContext.run;
});

afterAll(() => {
  eventStreamTiming.pulseMs = savedPulse;
  dbContext.run = originalRun;
});

async function openStream(token: string, requestId: string) {
  const res = await app.request("/api/events", {
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", "x-request-id": requestId },
  });
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  const first = await reader.read();
  seen += first.value ?? "";
  expect(seen).toContain("ready");
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += value;
      }
    } catch {
      /* поток закрыт отменой */
    }
  })();
  return {
    text: () => seen,
    pings: () => seen.split("event: ping").length - 1,
    close: async () => {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

async function until(check: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

function about(userId: string, resourceId: string) {
  return publish(db, {
    kind: "action",
    action: "safety.save",
    surveyIds: null,
    userId,
    resourceId,
    at: new Date().toISOString(),
  });
}

describe("поток событий и зона доступа", () => {
  test(
    "перечитывание зоны — своя транзакция с контекстом сотрудника",
    async () => {
      const requestId = crypto.randomUUID();
      const stream = await openStream(adminA.token, requestId);
      try {
        const before = (opened.get(requestId) ?? []).length;
        // три пульса — три перечитывания после того, как транзакция запроса закрылась
        expect(await until(() => stream.pings() >= 3), "поток перестал пульсировать").toBe(true);
        const after = opened.get(requestId) ?? [];
        expect(
          after.length - before,
          "перечитывание зоны шло в завершённой транзакции запроса, а не в своей",
        ).toBeGreaterThanOrEqual(2);
        for (const tx of after) {
          expect(tx.userId).toBe(adminA.id);
          expect(tx.role).toBe("admin");
        }
      } finally {
        await stream.close();
      }
    },
    15_000,
  );

  test(
    "отзыв доступа к пациенту — следующее событие о нём не приходит",
    async () => {
      const gone = await makeUser("user", `ev-revoke-${crypto.randomUUID()}@test`);
      const kept = await makeUser("user", `ev-kept-${crypto.randomUUID()}@test`);
      await db.insert(surveyAccess).values([
        { surveyId: surveyInA, userId: gone.id, grantedBy: adminA.id },
        { surveyId: surveyInA, userId: kept.id, grantedBy: adminA.id },
      ]);

      const mark = crypto.randomUUID();
      const stream = await openStream(adminA.token, crypto.randomUUID());
      try {
        // до отзыва человек в зоне — иначе проверка ниже ничего не доказывает
        await about(gone.id, `before-${mark}`);
        expect(await until(() => stream.text().includes(`before-${mark}`))).toBe(true);

        await db
          .delete(surveyAccess)
          .where(and(eq(surveyAccess.userId, gone.id), eq(surveyAccess.surveyId, surveyInA)));

        // два пульса после отзыва: зона перечитана хотя бы раз целиком
        const pings = stream.pings();
        expect(await until(() => stream.pings() >= pings + 2)).toBe(true);

        await about(gone.id, `after-${mark}`);
        await about(kept.id, `kept-${mark}`);
        expect(
          await until(() => stream.text().includes(`kept-${mark}`)),
          "поток замолчал целиком — проверка отзыва ничего бы не доказала",
        ).toBe(true);
        await Bun.sleep(100);
        expect(
          stream.text().includes(`after-${mark}`),
          "событие о человеке, доступ к которому отозван, ушло в поток",
        ).toBe(false);
      } finally {
        await stream.close();
        await db.delete(surveyAccess).where(eq(surveyAccess.userId, kept.id));
      }
    },
    15_000,
  );
});
