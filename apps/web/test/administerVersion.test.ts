import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Answer } from "@quizzy/shared";
import { api } from "../src/api";
import { administerPayload, blankVersion, loadAdminister } from "../src/pages/administerModel";
import { answerYesNo, makeSurvey, yesNoQuestion } from "../../../packages/shared/test/fixtures";

/**
 * Бумажный бланк вводится по своей версии (#169).
 *
 * Код бланка ведёт на `/surveys/:id/administer?v=N` (BlankForm.tsx), а экран
 * ввода номер не читал: грузилась и сдавалась действующая версия. Бланки
 * печатают заранее, методику потом правят — и ответы бланка v3 ложились на
 * пункты v4 и считались по её ключу.
 */

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };

/** Что ушло в сеть: адрес и тело */
let sent: { path: string; body: unknown }[] = [];

/** Методика на сервере: третья версия — с бланка, четвёртая — действующая */
const v3 = { ...makeSurvey([yesNoQuestion(0)], []), id: "survey-1", versionId: "version-3-id", versionNumber: 3 };
const v4 = { ...makeSurvey([yesNoQuestion(0)], []), id: "survey-1", versionId: "version-4-id", versionNumber: 4 };

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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/api/surveys/survey-1?version=3") return reply(v3);
    if (path === "/api/surveys/survey-1") return reply(v4);
    if (path.startsWith("/api/access/patients")) return reply({ items: [], total: 0, truncated: false });
    if (path === "/api/surveys/survey-1/responses") return reply({ id: "r1", scores: [], reliable: true, warnings: [] });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

describe("версия бланка", () => {
  test("?v — целое от единицы; нет или мусор — действующая", () => {
    expect(blankVersion("3")).toBe(3);
    expect(blankVersion("12")).toBe(12);
    for (const raw of [null, "", "0", "-1", "2.5", "abc", "3abc"]) expect(blankVersion(raw), String(raw)).toBeUndefined();
  });

  test("?v=3 → запрос ?version=3 и versionId третьей версии в теле сдачи", async () => {
    const { survey } = await loadAdminister("survey-1", blankVersion(new URLSearchParams("?v=3").get("v")));
    expect(sent.map((s) => s.path)).toContain("/api/surveys/survey-1?version=3");
    expect(survey.versionId).toBe("version-3-id");

    const answers = new Map<string, Answer>([[survey.questions[0]!.id, answerYesNo(survey.questions[0]!, true)]]);
    await api.submitFor(
      "survey-1",
      administerPayload(survey, { subject: "patient-1", startedAt: "2026-10-11T10:00:00+03:00", answers }),
    );
    const submitted = sent.find((s) => s.path === "/api/surveys/survey-1/responses")!.body as { versionId: string; onBehalfOf: string; answers: Answer[] };
    expect(submitted.versionId, "сдана действующая версия вместо версии бланка").toBe("version-3-id");
    expect(submitted.onBehalfOf).toBe("patient-1");
    expect(submitted.answers).toHaveLength(1);
  });

  test("положительный контроль: без ?v — действующая версия", async () => {
    const { survey } = await loadAdminister("survey-1", blankVersion(new URLSearchParams("").get("v")));
    expect(sent.map((s) => s.path)).toContain("/api/surveys/survey-1");
    expect(survey.versionId).toBe("version-4-id");
  });

  test("экран ввода берёт версию из адреса", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Administer.tsx"), "utf8");
    expect(src.includes('blankVersion(params.get("v"))'), "Administer не читает ?v").toBe(true);
    expect(src.includes("loadAdminister(id!, version)"), "Administer грузит методику без версии").toBe(true);
  });
});
