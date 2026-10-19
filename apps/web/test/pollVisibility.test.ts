import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryObserver, environmentManager, focusManager, isServer, type QueryClient } from "@tanstack/react-query";
import { connection } from "../src/connection";
import { createQueryClient, wireConnection } from "../src/query";
import { resourceQuery } from "../src/useResource";

/**
 * Живые загрузки и скрытая вкладка (волна 27, perf-day).
 *
 * Опрос (pollMs) встаёт, пока вкладка скрыта, и догоняет сразу, когда к ней
 * вернулись; опрашивать скрытую вкладку можно только явно (pollHidden) — так
 * живёт число тревог на значке вкладки. Проверяется то, что получает
 * TanStack (resourceQuery), на живом клиенте с умолчаниями консоли: вкладку
 * «прячет» focusManager, тот же, что слушает visibilitychange в браузере.
 *
 * И сторож того, кто чем опрашивает: бейдж «Сьогодні» — числом без людей и
 * не в скрытой вкладке; «Огляд» техпанели — одним запросом на такт.
 */

let client: QueryClient;

beforeAll(() => {
  environmentManager.setIsServer(() => false);
  wireConnection();
});

afterAll(() => {
  environmentManager.setIsServer(() => isServer);
  connection.resetForTest();
  focusManager.setFocused(undefined);
});

beforeEach(() => {
  connection.resetForTest({ probe: async () => true, delays: [60_000] });
  client = createQueryClient();
  client.mount();
  focusManager.setFocused(true);
});

afterEach(() => {
  client.unmount();
  client.clear();
  focusManager.setFocused(undefined);
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("не дождались");
    await tick(2);
  }
}

describe("опрос и скрытая вкладка", () => {
  test("скрытую вкладку не опрашивает, а вернувшись — перечитывает сразу", async () => {
    let loads = 0;
    const observer = new QueryObserver(client, resourceQuery(["бейдж"], async () => ++loads, { pollMs: 15 }));
    const off = observer.subscribe(() => {});
    await until(() => loads >= 2);

    focusManager.setFocused(false);
    await tick(20);
    const hidden = loads;
    await tick(80);
    // пять тактов опроса прошли — запросов нет
    expect(loads).toBe(hidden);

    focusManager.setFocused(true);
    await until(() => loads > hidden, 50);
    off();
  });

  test("pollHidden — опрос идёт и в скрытой вкладке (значок тревог)", async () => {
    let loads = 0;
    const observer = new QueryObserver(
      client,
      resourceQuery(["тревоги"], async () => ++loads, { pollMs: 15, pollHidden: true }),
    );
    const off = observer.subscribe(() => {});
    await until(() => loads >= 1);
    focusManager.setFocused(false);
    const hidden = loads;
    await until(() => loads >= hidden + 3, 1000);
    off();
  });
});

describe("кто чем опрашивает", () => {
  const src = (p: string) => readFileSync(resolve(import.meta.dir, "../src", p), "utf8");

  test("бейдж «Сьогодні» — числом без людей и только видимой вкладкой", () => {
    const app = src("App.tsx");
    expect(app).not.toMatch(/api\.today\(/);
    const line = app.split("\n").find((l) => l.includes("const todayRes"));
    expect(line).toContain("api.todayCount()");
    expect(line).toContain("shownTally");
    expect(app).toContain("const shownTally = { ...tally, pollHidden: false };");
  });

  test("скрытую вкладку опрашивает только число тревог (значок вкладки); очередь и направления — нет", () => {
    const app = src("App.tsx");
    const tallyOf = (name: string) => app.split("\n").find((l) => l.includes(`const ${name} = useResource`));
    expect(tallyOf("alertCount")).toMatch(/, tally\);$/);
    expect(tallyOf("referralCount")).toMatch(/shownTally\);$/);
    expect(tallyOf("worklistRes")).toMatch(/shownTally\);$/);
  });

  test("«Огляд» техпанели — сводка с рядами и ошибками одним опросом, сутки не берутся дважды", () => {
    const ov = src("pages/ops/Overview.tsx");
    expect(ov).not.toMatch(/api\.opsTraffic\(|api\.opsErrors\(/);
    expect(ov).toContain("api.opsOverview(win)");
    // опросов три: такт сводки (20 с), оповещения и состояние для людей (раз в минуту)
    expect(ov.match(/useOpsResource\(/g)).toHaveLength(3);
    expect(ov.match(/useOpsResource\([^\n]*POLL_MS\)/g)?.filter((m) => !m.includes("SLOW_POLL_MS"))).toHaveLength(1);
  });
});
