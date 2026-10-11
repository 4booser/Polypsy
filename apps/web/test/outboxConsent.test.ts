import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api } from "../src/api";
import { createOutbox, type OutboxItem, type OutboxStorage } from "../src/patient/outbox";
import { cabinetIo, sendAnswers, type SubmitBody } from "../src/patient/sendAnswers";

/**
 * Очередь кабинета упёрлась в новую редакцию согласия (#201).
 *
 * Сдача из очереди, упавшая на 403 «спершу прийміть згоду», становилась
 * отвергнутой, а экран согласия открытой вкладки статус заново не
 * спрашивал — повтор падал до перезагрузки. Теперь 403 несёт код
 * err.consentRequired (app.ts, onError); очередь по нему встаёт, не
 * помечая запись, кабинет перепроверяет согласие и показывает его экран, а
 * после принятия уходит та же запись — то же тело, тот же clientRequestId.
 *
 * Через настоящий клиент API (api.ts) с подменённым fetch, как в
 * runnerConsent.test.tsx.
 */

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

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
beforeEach(() => {
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

type Call = { url: string; method: string; body: string };
type Reply = { status: number; body: unknown };

/** Сервер по маршрутам: каждому — очередь ответов по порядку */
function server(routes: Record<string, Reply[]>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: String(init?.body ?? "") });
    const reply = routes[`${method} ${url}`]?.shift();
    if (!reply) throw new Error(`нет ответа на ${method} ${url}`);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const SUBMIT = "POST /api/surveys/s1/responses";
const STATUS = "GET /api/consents/me";
const consentRefused: Reply = {
  status: 403,
  body: { error: "Спершу прийміть інформовану згоду", code: "err.consentRequired", requestId: "a1b2c3d4" },
};

const memory = (): OutboxStorage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

const submit = (item: OutboxItem) => api.submitResponse(item.surveyId, item.payload as never);
const submits = (calls: Call[]) => calls.filter((c) => `${c.method} ${c.url}` === SUBMIT).map((c) => c.body);

describe("очередь кабинета и 403 «нужно согласие»", () => {
  test("запись не отвергается: проход встаёт с пометкой consent, после принятия уходит та же сдача", async () => {
    const calls = server({ [SUBMIT]: [consentRefused, { status: 201, body: { id: "r1", safetyPlan: null } }] });
    const box = createOutbox(memory(), () => "u");
    const item = box.enqueue("u", "s1", { answers: [{ questionId: "q1", optionIds: ["o2"] }] }, "PHQ-9");

    const stopped = await box.flush("u", submit);
    expect(stopped).toEqual({ sent: 0, left: 1, rejected: 0, consent: true });
    expect(box.rejected("u")).toHaveLength(0);
    // попытка не засчитана: согласие — не сбой сервера
    expect(box.waiting("u")[0]!.attempts).toBe(0);

    // согласие принято (экран ворот) — следующий проход отправляет ту же запись
    const sent = await box.flush("u", submit);
    expect(sent).toEqual({ sent: 1, left: 0, rejected: 0 });
    const bodies = submits(calls);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]!);
    expect(JSON.parse(bodies[1]!).clientRequestId).toBe(item.payload.clientRequestId);
  });

  test("следующие записи за ней не уходят: они упрутся в то же согласие", async () => {
    const calls = server({ [SUBMIT]: [consentRefused] });
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", {});
    box.enqueue("u", "s1", {});
    await box.flush("u", submit);
    expect(submits(calls)).toHaveLength(1);
    expect(box.waiting("u")).toHaveLength(2);
  });

  test("положительный контроль: 403 не о согласии (без кода) — отвергнута, как и прежде", async () => {
    server({ [SUBMIT]: [{ status: 403, body: { error: "Методика вам не призначена" } }] });
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", {});
    const res = await box.flush("u", submit);
    expect(res).toEqual({ sent: 0, left: 0, rejected: 1 });
  });
});

describe("сдача из прохождения: причина 403 — по коду", () => {
  const body = (): SubmitBody => ({
    versionId: "v1",
    startedAt: "2026-10-11T09:00:00.000Z",
    durationMs: 60_000,
    answers: [],
    events: [],
    clientRequestId: "req-1",
  });

  test("403 без кода согласия — отказ как есть, без лишнего вопроса о статусе", async () => {
    const calls = server({ [SUBMIT]: [{ status: 403, body: { error: "Методика вам не призначена" } }] });
    const error = await sendAnswers(cabinetIo(null), "s1", body()).catch((e: unknown) => e);
    expect((error as { status?: number }).status).toBe(403);
    expect(calls.filter((c) => `${c.method} ${c.url}` === STATUS)).toHaveLength(0);
  });

  test("положительный контроль: 403 с кодом — статус спрошен, сдача держится до согласия", async () => {
    server({
      [SUBMIT]: [consentRefused],
      [STATUS]: [{ status: 200, body: { required: true, accepted: false, version: 2, textId: "t2", text: "Нова редакція" } }],
    });
    const outcome = await sendAnswers(cabinetIo(null), "s1", body());
    expect(outcome.kind).toBe("consent");
  });
});

describe("кабинет: проход, вставший на согласии, ведёт к экрану согласия", () => {
  const strip = (f: string) =>
    readFileSync(resolve(import.meta.dir, "../src/patient", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  test("useOutbox по итогу consent перепроверяет согласие у ворот", () => {
    const shell = strip("PatientApp.tsx");
    expect(shell).toContain("const recheckConsent = useRecheckConsent();");
    expect(shell).toContain("if (result.consent) recheckConsent();");
  });

  test("ворота дают перепроверку кабинету и перечитывают статус, снимая прежнее «принято»", () => {
    const gate = strip("ConsentGate.tsx");
    expect(gate).toContain("<RecheckConsent.Provider value={recheck}>{children}</RecheckConsent.Provider>");
    expect(gate).toMatch(/const recheck = useCallback\(\(\) => \{\s*rechecking\.current = true;\s*reload\(\);/);
    expect(gate).toMatch(/if \(!rechecking\.current\) return;\s*rechecking\.current = false;\s*setError\(null\);\s*setOverride\(null\);/);
  });
});
