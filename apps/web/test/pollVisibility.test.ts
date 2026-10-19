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

  /** Объявление счётчика рельсы целиком: от `const имя = useResource(` до следующего объявления */
  const counter = (app: string, name: string): string => {
    const start = app.indexOf(`const ${name} = useResource(`);
    expect(start, `счётчик ${name} не найден`).toBeGreaterThan(-1);
    const rest = app.slice(start + 1);
    const end = rest.search(/\n {2}(const |useLiveReload\()/);
    return app.slice(start, start + 1 + end);
  };

  test("числа рельсы — маршрутами чисел: без имён и без строки журнала, только тому, кому их отдадут", () => {
    const app = src("App.tsx");
    // списки с людьми ради числа больше не опрашиваются
    expect(app).not.toMatch(/api\.(today|alertCases|referrals|worklist)\(/);
    const expectations: [string, string, string | null][] = [
      ["alertCount", "api.alertCaseCount()", '"alerts.review"'],
      ["referralCount", "api.referralCount()", '"referrals.manage"'],
      ["worklistRes", "api.worklistCount()", '"patients.read"'],
      ["todayRes", "api.todayCount()", '"patients.read"'],
      ["messagesRes", ".unreadCount()", null],
    ];
    for (const [name, call, permission] of expectations) {
      const block = counter(app, name);
      expect(block, name).toContain(call);
      if (permission) expect(block, name).toContain(`enabled: allowed(${permission})`);
    }
    expect(app).toContain("const allowed = (permission: Permission) => counting && can(permission);");
  });

  test("скрытую вкладку опрашивает только число тревог (значок вкладки); остальные числа встают", () => {
    const app = src("App.tsx");
    expect(app).toContain("const shownTally = { ...tally, pollHidden: false };");
    expect(app).toMatch(/const tally = \{[^}]*pollHidden: true/);
    expect(counter(app, "alertCount")).toContain("...tally,");
    for (const name of ["referralCount", "worklistRes", "todayRes", "messagesRes"]) {
      expect(counter(app, name), name).toContain("...shownTally");
      expect(counter(app, name), name).not.toMatch(/\.\.\.tally\b/);
    }
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
