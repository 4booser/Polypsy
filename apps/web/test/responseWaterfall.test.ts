import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Протокол, графики и лист заключения открываются в два захода, а не в три
 * (волна 27).
 *
 * Прежде обстановка (/api/response-context) и заключение ждали протокол,
 * прежняя попытка — обстановку, а хронология графика курса — динамику:
 * четыре последовательных ожидания на графиках. Здесь закреплено, что
 * зависит только от адреса, спрашивается вместе с протоколом, и что
 * параллельность не открывает ничего лишнего: без права patients.read
 * (без него не откроется и протокол) ранних запросов нет.
 */
const SRC = resolve(import.meta.dir, "../src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("обстановка, заключение и прежняя попытка — по адресу", () => {
  const data = read("pages/response/data.ts");

  test("обстановка и заключение — по идентификатору из адреса, с правом читать пациентов", () => {
    expect(data).toContain('const early = !!rid && (can("patients.read") || !!detail);');
    expect(data).toContain("api.responseContext(rid!), [rid], { enabled: early, keep: false }");
    expect(data).toContain("api.conclusion(rid!)");
    expect(data).toContain("[rid, unsubmitted],");
    // по несданному — без запроса, как прежде
    expect(data).toContain("unsubmitted ? Promise.resolve({ current: null, versions: [] })");
  });

  test("прежняя попытка ждёт только обстановку", () => {
    expect(data).toContain("previousComparable(ctx.data.attempts, rid)");
  });

  test("экраны передают прохождение из адреса", () => {
    expect(read("pages/response/index.tsx")).toContain("useResponseExtras(rid ?? null, detail,");
    expect(read("pages/response/charts.tsx")).toContain("useResponseExtras(rid ?? null, detail,");
    expect(read("pages/Conclusion.tsx")).toContain("useResponseExtras(responseId, detail,");
  });
});

describe("хронология графика курса — вместе с динамикой", () => {
  const charts = read("pages/response/charts.tsx");

  test("спрашивается по сдачам из обстановки, а не после ответа динамики", () => {
    expect(charts).toContain("x.wantsDynamics && (attempts > 1 || series)");
    const panel = charts.slice(charts.indexOf("export function DynamicsPanel"), charts.indexOf("function useCourseTimeline"));
    expect(panel).not.toContain("useResource(");
  });
});
