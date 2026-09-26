import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpsCompareStats, OpsLogLine, OpsRelease, OpsRouteCompare, OpsStoreState } from "@quizzy/shared";
import { mergeFeed, parseErrorWindow, parseLogWindow, storeNote } from "../src/pages/ops/model";
import {
  defaultPair,
  enableSteps,
  filterCompare,
  fmtSignedMs,
  fmtSignedPct,
  fmtSignedPp,
  offsets,
  onlyWorse,
  p95Delta,
  p95Ratio,
  parseRequestId,
  parseStatementSort,
  shareDelta,
  statementMetric,
} from "../src/pages/ops/obs2a/model";

/**
 * Техпанель, вторая половина (участок obs2a): чистая логика истории, трассы,
 * сравнения выкаток и медленного SQL — и сторож оформления новых экранов.
 * Серверная половина — apps/api/test/opsObs2a.test.ts.
 */

const line = (instance: string, seq: number, sec: number): OpsLogLine => ({
  seq,
  at: new Date(Date.UTC(2026, 8, 26, 12, 0, sec)).toISOString(),
  level: "info",
  message: `m${instance}${seq}`,
  requestId: null,
  fields: {},
  instance,
});

describe("история в ленте", () => {
  test("строки разных процессов с одним номером — разные строки; порядок — по времени", () => {
    // после перезапуска номер снова 1: без экземпляра вторая строка съела бы первую
    const prev = [line("a", 1, 1)];
    const next = mergeFeed(prev, [line("b", 1, 5), line("a", 1, 1), line("a", 2, 3)]);
    expect(next.map((l) => `${l.instance}${l.seq}`)).toEqual(["b1", "a2", "a1"]);
  });

  test("старшая страница истории встаёт снизу, а не сверху", () => {
    const shown = [line("a", 9, 50), line("a", 8, 40)];
    const older = [line("a", 3, 10), line("a", 2, 5)];
    expect(mergeFeed(shown, older, 100).map((l) => l.seq)).toEqual([9, 8, 3, 2]);
  });

  test("период из адреса: неизвестное — умолчание", () => {
    expect(parseLogWindow("7d")).toBe("7d");
    expect(parseLogWindow("90d")).toBe("1h");
    expect(parseErrorWindow("90d")).toBe("90d");
    expect(parseErrorWindow("1h")).toBe("24h");
    expect(parseErrorWindow(null)).toBe("24h");
  });

  test("о записи истории молчат, только когда всё пишется", () => {
    const base: OpsStoreState = {
      running: true,
      lastFlushAt: "2026-09-26T12:00:10.000Z",
      lastError: null,
      lastErrorAt: null,
      pendingLogs: 0,
      droppedLogs: 0,
    };
    expect(storeNote(base)).toEqual({ kind: "ok" });
    expect(storeNote(undefined)).toEqual({ kind: "ok" });
    expect(storeNote({ ...base, running: false })).toEqual({ kind: "off" });
    // отказ после последней удачной записи — «не вдається»
    expect(
      storeNote({ ...base, lastError: "logs: x", lastErrorAt: "2026-09-26T12:00:20.000Z", pendingLogs: 40 }),
    ).toEqual({ kind: "failing", since: "2026-09-26T12:00:20.000Z", pending: 40 });
    // отказ был, но потом записалось — уже не «не вдається»
    expect(storeNote({ ...base, lastError: "logs: x", lastErrorAt: "2026-09-26T12:00:00.000Z" })).toEqual({ kind: "ok" });
    expect(storeNote({ ...base, droppedLogs: 3 })).toEqual({ kind: "dropped", n: 3 });
  });
});

describe("трасса", () => {
  test("номер из поля: тот же алфавит, что у сервера", () => {
    expect(parseRequestId("  3f1c2a9b-0000-4000-8000-000000000000 ")).toBe("3f1c2a9b-0000-4000-8000-000000000000");
    expect(parseRequestId("abc")).toBeNull();
    expect(parseRequestId("bad id")).toBeNull();
    expect(parseRequestId("x;drop")).toBeNull();
  });

  test("смещение строк — от первой строки запроса", () => {
    const at = (ms: number) => ({ ...line("a", 1, 0), at: new Date(Date.UTC(2026, 8, 26, 12) + ms).toISOString() });
    expect(offsets([at(0), at(12), at(340)])).toEqual([0, 12, 340]);
    expect(offsets([])).toEqual([]);
  });
});

describe("выкатки", () => {
  const stats = (p95: number | null, share: number | null, requests = 100): OpsCompareStats => ({
    requests,
    errors5xx: share === null ? 0 : Math.round(share * requests),
    share5xx: share,
    p50: p95,
    p95,
  });
  const row = (route: string, latency: OpsRouteCompare["latency"], errors: OpsRouteCompare["errors"]): OpsRouteCompare => ({
    method: "GET",
    route,
    before: stats(10, 0),
    after: stats(10, 0),
    latency,
    errors,
  });

  test("«лише погіршення» — любая из двух величин хуже", () => {
    const items = [row("/a", "worse", "same"), row("/b", "same", "worse"), row("/c", "better", "few"), row("/d", "few", "few")];
    expect(onlyWorse(items).map((i) => i.route)).toEqual(["/a", "/b"]);
    expect(filterCompare(items, "get /C").map((i) => i.route)).toEqual(["/c"]);
  });

  test("пара по умолчанию: версия процесса и предыдущая по времени появления", () => {
    const r = (version: string, day: number): OpsRelease => ({
      version,
      firstAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
      lastAt: new Date(Date.UTC(2026, 8, day + 1)).toISOString(),
      requests: 10,
    });
    const items = [r("v1", 1), r("v3", 20), r("v2", 10)];
    expect(defaultPair(items, "v2")).toEqual({ before: "v1", after: "v2" });
    // версии процесса в суммах ещё нет — самая новая
    expect(defaultPair(items, "v9")).toEqual({ before: "v2", after: "v3" });
    expect(defaultPair([r("v1", 1)], "v1")).toEqual({ before: null, after: "v1" });
    expect(defaultPair([], "v1")).toEqual({ before: null, after: null });
  });

  test("разница: мс и доля, без деления на ноль", () => {
    expect(p95Delta(stats(100, 0), stats(250, 0))).toBe(150);
    expect(p95Ratio(stats(100, 0), stats(250, 0))).toBe(1.5);
    expect(p95Ratio(stats(0, 0), stats(250, 0))).toBeNull();
    expect(p95Delta(null, stats(250, 0))).toBeNull();
    expect(shareDelta(stats(10, 0.01), stats(10, 0.05))).toBeCloseTo(0.04);
    expect(shareDelta(stats(10, null), stats(10, 0.05))).toBeNull();
  });

  test("числа со знаком: мс, проценты, процентные пункты", () => {
    expect(fmtSignedMs(150, "en-GB")).toBe("+150 ms");
    expect(fmtSignedMs(-4.5, "en-GB")).toBe("-4.5 ms");
    expect(fmtSignedMs(0, "en-GB")).toBe("0 ms");
    expect(fmtSignedPct(1.5, "en-GB")).toBe("+150%");
    expect(fmtSignedPp(0.04, "en-GB")).toBe("+4");
    expect(fmtSignedPp(-0.005, "en-GB")).toBe("-0.5");
  });
});

describe("медленные SQL", () => {
  test("порядок из адреса и шаги включения по состоянию", () => {
    expect(parseStatementSort("calls")).toBe("calls");
    expect(parseStatementSort("rows")).toBe("total");
    expect(enableSteps("notInstalled")).toEqual(["preload", "create"]);
    // расширение уже создано миграцией — осталось загрузить
    expect(enableSteps("notLoaded")).toEqual(["preload"]);
    expect(enableSteps("denied")).toEqual(["grant"]);
    expect(enableSteps("ok")).toEqual([]);
    expect(enableSteps("failed")).toEqual([]);
  });

  test("полоска — той величиной, по которой отсортировано", () => {
    const s = { calls: 7, totalMs: 900, meanMs: 128.6 };
    expect(statementMetric(s, "total")).toBe(900);
    expect(statementMetric(s, "calls")).toBe(7);
    expect(statementMetric(s, "mean")).toBe(128.6);
  });
});

/**
 * Сторож оформления новых экранов — то же правило, что у первой половины
 * (ops.test.ts): ни одного класса наследия, инлайновый стиль — только
 * ширина из данных, ни одного хекса в разметке.
 */
describe("экраны obs2a без наследия", () => {
  const FILES = ["Trace", "Releases", "Statements", "parts"].map((n) => resolve(import.meta.dir, `../src/pages/ops/obs2a/${n}.tsx`));
  const LEGACY = new Set(["card", "tile", "row", "chip", "btn", "hint", "muted", "tabs", "grid-cols-2", "cols-2", "cols-3", "cols-4"]);

  test("нет классов наследия и хексов", () => {
    const found: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
        for (const token of m[1]!.split(/\s+/)) if (LEGACY.has(token)) found.push(`${file}: ${token}`);
      }
      for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(`${file}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });

  test("инлайновый стиль — только ширина из данных", () => {
    const styles = FILES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/style=\{\{([^}]*)\}\}/g)].map((m) => m[1]!.trim()));
    expect(styles.every((s) => s.startsWith("width:"))).toBe(true);
  });

  test("голых <table> и <button> нет", () => {
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/<table[\s>]/);
      expect(src, file).not.toMatch(/<button[\s>]/);
    }
  });
});
