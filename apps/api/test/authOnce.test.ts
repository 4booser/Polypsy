import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { app, root, surveyInA } from "./fixtures";
import { dbContext } from "../src/db/context";
import { currentRequestId } from "../src/lib/log";

/**
 * Одна авторизация — одна транзакция запроса.
 *
 * Внешний разбор 2026-09-26 (P1): `/api/ops/data` попадал под
 * `use("*", requireAuth)` двух наборов маршрутов — общего заслона
 * техпанели (/api/ops) и своего. Второй requireAuth открывал вторую
 * транзакцию, пока первая держала соединение. Пул — десять соединений
 * (db/index.ts): десять одновременных запросов занимают весь пул первыми
 * транзакциями и ждут свободного соединения для вторых — которое никто уже
 * не отдаст. Процесс стоит, не падая и ничего не записывая в лог.
 *
 * Тот же узор — у сдачи прохождения: POST /api/surveys/:id/responses
 * проходит заслон /api/surveys, а затем заслон набора прохождений,
 * подключённого на /api (routes/responses.ts). То есть самый важный
 * запрос кабинета пациента стоил двух соединений.
 *
 * Сторож считает транзакции с контекстом ЧЕЛОВЕКА (app.role не system) на
 * каждый запрос: системные короткие транзакции requireAuth (чтение учётки)
 * закрываются до открытия транзакции запроса и соединение не держат.
 * Считается по номеру запроса (x-request-id), а не общим счётчиком: хвост
 * предыдущего запроса не должен попасть в счёт следующего.
 *
 * Отдельно считаются ВЛОЖЕННЫЕ транзакции любого рода — открытые, пока
 * транзакция запроса держит своё соединение. Системная вложенная ничем не
 * лучше второй авторизации: тот же второй запрос к пулу изнутри первого.
 * Так стояла страница состояния техпанели (GET /api/ops/maint/status:
 * история объявлений читалась systemContext поверх транзакции запроса).
 */

const userTx = new Map<string, number>();
const nestedTx = new Map<string, number>();
const originalRun = dbContext.run;

beforeAll(() => {
  /*
   * Подмена на экземпляре, а не на модуле: withDbContext ставит контекст
   * через dbContext.run, как бы ни была устроена сама транзакция, — и
   * счёт не зависит от того, как её переделают.
   */
  dbContext.run = function (this: typeof dbContext, store: never, fn: () => unknown) {
    const requestId = currentRequestId();
    // exit() в bun — это run(undefined): транзакции нет, считать нечего
    if (!requestId || !store) return originalRun.call(this, store, fn);
    if (dbContext.getStore()) nestedTx.set(requestId, (nestedTx.get(requestId) ?? 0) + 1);
    return originalRun.call(this, store, async () => {
      const [row] = (await (store as { execute: (q: unknown) => Promise<unknown> }).execute(
        sql`select current_setting('app.role', true) as role`,
      )) as { role: string | null }[];
      if (row?.role && row.role !== "system") userTx.set(requestId, (userTx.get(requestId) ?? 0) + 1);
      return fn();
    });
  } as typeof dbContext.run;
});

afterAll(() => {
  dbContext.run = originalRun;
});

async function call(method: string, path: string, body?: unknown) {
  const requestId = crypto.randomUUID();
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${root.token}`,
      "Content-Type": "application/json",
      "x-request-id": requestId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // поток событий не кончается сам — закрываем, чтобы не держать подписку
  await res.body?.cancel().catch(() => {});
  return { status: res.status, tx: userTx.get(requestId) ?? 0, nested: nestedTx.get(requestId) ?? 0 };
}

describe("одна транзакция запроса", () => {
  test(
    "ни один GET-маршрут не открывает вторую транзакцию запроса",
    async () => {
      /*
       * Все маршруты из живой таблицы приложения, а не из списка: новый
       * набор, подключённый поверх чужого заслона, попадает сюда сам.
       * Только GET — обход изменяющих маршрутов суперадмином включил бы
       * обслуживание, выход и ротацию ключей; изменяющий путь с тем же
       * узором проверяется ниже поимённо.
       */
      const seen = new Set<string>();
      const doubled: string[] = [];
      for (const route of app.routes) {
        if (route.method !== "GET" || route.path.includes("*")) continue;
        if (seen.has(route.path)) continue;
        seen.add(route.path);
        const path = route.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, () => crypto.randomUUID());
        const { status, tx, nested } = await call("GET", path);
        if (tx > 1) doubled.push(`GET ${route.path} → ${tx} транзакции (${status})`);
        if (nested > 0) doubled.push(`GET ${route.path} → вложенных транзакций: ${nested} (${status})`);
      }
      expect(seen.size).toBeGreaterThan(100);
      expect(doubled, "маршрут проходит авторизацию дважды и держит два соединения").toEqual([]);
    },
    120_000,
  );

  test("техпанель «Дані й продукт» — одна транзакция", async () => {
    const res = await call("GET", "/api/ops/data/usage?days=7");
    expect(res.status).toBe(200);
    expect(res.tx).toBe(1);
  });

  test("сдача прохождения — одна транзакция", async () => {
    /*
     * Пустое тело: отказ разбора (400) случается уже в обработчике, то
     * есть после обоих заслонов, — а ничего не записывается.
     */
    const res = await call("POST", `/api/surveys/${surveyInA}/responses`, {});
    expect(res.status).toBe(400);
    expect(res.tx).toBe(1);

    const draft = await call("PUT", `/api/surveys/${surveyInA}/draft`, { nope: true });
    expect(draft.status).toBeLessThan(500);
    expect(draft.tx).toBe(1);
  });

  test(
    "запросов больше, чем соединений в пуле, — и ни один не виснет",
    async () => {
      /*
       * Двадцать пять одновременных при пуле в десять. С двойной
       * авторизацией это верная взаимная блокировка: первые транзакции
       * заняли весь пул и ждут соединения для вторых. Срок — с запасом на
       * медленную машину CI, но меньше срока теста: зависание должно
       * читаться как «зависло», а не как таймаут сюиты.
       */
      const all = Promise.all(
        Array.from({ length: 25 }, () => call("GET", "/api/ops/data/usage?days=7").then((r) => r.status)),
      );
      const statuses = await Promise.race([
        all,
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000)),
      ]);
      expect(statuses, "конкурентные запросы исчерпали пул и встали").not.toBe("hung");
      expect((statuses as number[]).every((s) => s === 200)).toBe(true);
    },
    30_000,
  );
});
