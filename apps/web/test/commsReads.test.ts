import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditPage } from "@quizzy/shared";
import { api, PERMISSION_CARDS_BATCH } from "../src/api";
import { ACCESS_LOG_ACTIONS, loadAccessLog } from "../src/pages/Access";
import { ASSIGN_LOG_ACTIONS, cardAsks, effectiveByAdmin, loadAdminCards, loadAssignLog } from "../src/pages/people/StaffList";

/**
 * Чтения переписки и администрирования — меньше запросов на тот же экран
 * (волна 27, perf-comms).
 *
 *  - счётчик «Листування» на рельсе — одно число (GET /api/messages/unread-count),
 *    а не весь список разговоров раз в минуту;
 *  - «Адміністратори»: журнал назначений — одно чтение по пяти действиям,
 *    «Що може кожен» — карточки прав пачкой, а не запросом на человека;
 *  - доступ методики: журнал — одно чтение по выдачам и отзывам, и только с
 *    правом audit.read.
 */

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
let sent: string[] = [];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

beforeEach(() => {
  sent = [];
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    sent.push(path);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/messages/unread-count") return reply({ unread: 7 });
    if (path.startsWith("/api/permissions/cards?ids=")) {
      const ids = decodeURIComponent(path.slice("/api/permissions/cards?ids=".length)).split(",");
      return reply({ items: ids.map((id) => ({ userId: id, effective: [`p.${id}`] })) });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

describe("счётчик «Листування»", () => {
  test("одно число одним запросом", async () => {
    expect(await api.unreadCount()).toEqual({ unread: 7 });
    expect(sent).toEqual(["/api/messages/unread-count"]);
  });

  test("рельса берёт число, а не сумму по списку разговоров", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/App.tsx"), "utf8");
    const block = src.slice(src.indexOf("const messagesRes = useResource("), src.indexOf("useLiveReload("));
    expect(block.includes(".unreadCount()"), "счётчик рельсы не зовёт unreadCount").toBe(true);
    expect(block.includes(".threads()"), "счётчик рельсы снова тянет весь список").toBe(false);
  });
});

describe("«Адміністратори»: журнал назначений", () => {
  test("одно чтение по всем пяти действиям — восемь последних", async () => {
    const calls: Record<string, string | undefined>[] = [];
    const entries = [{ id: "e1" }, { id: "e2" }] as AuditPage["entries"];
    const got = await loadAssignLog({
      auditPage: async (params) => {
        calls.push(params);
        return { entries, offset: 0, limit: 8, nextCursor: null } as AuditPage;
      },
    });
    expect(got).toBe(entries);
    expect(calls).toEqual([{ actions: ASSIGN_LOG_ACTIONS.join(","), limit: "8" }]);
    expect(ASSIGN_LOG_ACTIONS).toEqual([
      "user.roles_change",
      "permission.exception",
      "permission.exception_revoke",
      "user.role_change",
      "user.create",
    ]);
  });
});

describe("«Що може кожен»: карточки пачкой", () => {
  const head = { id: "me", role: "admin", ladderRank: 2 };
  // у строки реестра в учётке больше полей — правилу нужна одна ступень
  const admins = [
    { id: "root", role: "superadmin", account: { ladderRank: 0 } },
    { id: "chief", role: "admin", account: { ladderRank: 3 } },
    { id: "head2", role: "admin", account: { ladderRank: 2 } },
    { id: "spec", role: "admin", account: { ladderRank: 1 } },
    { id: "me", role: "admin", account: { ladderRank: 2 } },
  ] as unknown as Parameters<typeof cardAsks>[1];

  test("спрашивают только о тех, чью карточку сервер отдаст; суперадмина — нет", () => {
    expect(cardAsks(head, admins)).toEqual(["spec", "me"]);
    expect(cardAsks({ id: "root", role: "superadmin", ladderRank: 0 }, admins)).toEqual(["chief", "head2", "spec", "me"]);
  });

  test("одним запросом на всех; итог — по порядку реестра, не пришедшее — «не известно»", async () => {
    const asked: string[][] = [];
    const got = await loadAdminCards(head, admins, {
      permissionCards: async (ids) => {
        asked.push([...ids]);
        return [{ userId: "me", effective: ["a"] }, { userId: "spec", effective: ["b"] }] as never;
      },
    });
    expect(asked).toEqual([["spec", "me"]]);
    expect(got).toEqual([null, null, null, ["b"], ["a"]]);
  });

  test("отказ запроса — у всех «не известно», а не ошибка экрана; спрашивать некого — запроса нет", async () => {
    const failed = await loadAdminCards(head, admins, {
      permissionCards: async () => {
        throw new Error("503");
      },
    });
    expect(failed).toEqual([null, null, null, null, null]);

    let calls = 0;
    const onlySupers = await loadAdminCards(head, admins.slice(0, 1), {
      permissionCards: async () => {
        calls += 1;
        return [];
      },
    });
    expect(calls).toBe(0);
    expect(onlySupers).toEqual([null]);
    expect(effectiveByAdmin([{ id: "x" }], null)).toEqual([null]);
  });

  test("клиент делит длинный список на пачки по сотне и сводит ответы по порядку", async () => {
    const ids = Array.from({ length: PERMISSION_CARDS_BATCH * 2 + 50 }, (_, i) => `u${i}`);
    const cards = await api.permissionCards(ids);
    expect(sent.length).toBe(3);
    expect(cards.map((c) => c.userId)).toEqual(ids);
    expect(await api.permissionCards([])).toEqual([]);
    expect(sent.length, "пустой список ушёл запросом").toBe(3);
  });
});

describe("доступ методики: журнал", () => {
  test("одно чтение по выдачам и отзывам этой методики", async () => {
    const calls: Record<string, string | undefined>[] = [];
    await loadAccessLog("survey-1", {
      auditPage: async (params) => {
        calls.push(params);
        return { entries: [], offset: 0, limit: 8, nextCursor: null } as AuditPage;
      },
    });
    expect(calls).toEqual([{ actions: ACCESS_LOG_ACTIONS.join(","), resourceType: "survey", q: "survey-1", limit: "8" }]);
    expect(ACCESS_LOG_ACTIONS).toEqual(["access.grant", "access.revoke"]);
  });

  test("без права audit.read запрос не уходит: отказ лёг бы в журнал на каждом открытии", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Access.tsx"), "utf8");
    const block = src.slice(src.indexOf("function AccessLog("), src.indexOf("const names = new Map"));
    expect(block).toContain('can("audit.read")');
    expect(block).toContain("enabled: canAudit");
  });
});
