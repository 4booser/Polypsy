import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, PATIENT_GROUP_BATCH, tokenStore } from "../src/api";

/**
 * «Додати до групи» выборке — списком, а не запросом на человека.
 *
 * Маршрут принимает `userIds` (до двухсот) и проверяет пачку целиком до
 * первой записи. «Добір людей» и «До іншої групи» в карточке группы всё равно
 * слали по запросу на человека: сто двадцать человек когорты — сто двадцать
 * запросов подряд, и отказ посередине оставлял группу добавленной наполовину.
 */

const g = globalThis as { fetch: typeof fetch; localStorage?: Storage };
const saved = { fetch: g.fetch, localStorage: g.localStorage };
let sent: { url: string; method: string; body: { userIds?: string[]; userId?: string } }[] = [];

beforeEach(() => {
  const data = new Map<string, string>();
  g.localStorage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
  tokenStore.set("t");
  sent = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ groupId: "g1", userIds: [] }), { status: 201 });
  }) as typeof fetch;
});

afterEach(() => {
  g.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
});

describe("«Додати до групи» выборке", () => {
  test("одна пачка на двести человек, а не запрос на каждого", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`);
    await api.addPatientGroupMembers("g1", ids);
    expect(PATIENT_GROUP_BATCH).toBe(200);
    expect(sent.map((r) => [r.method, r.url, r.body.userIds?.length])).toEqual([
      ["POST", "/api/patient-groups/g1/members", 200],
      ["POST", "/api/patient-groups/g1/members", 200],
      ["POST", "/api/patient-groups/g1/members", 50],
    ]);
    expect(sent.flatMap((r) => r.body.userIds ?? [])).toEqual(ids);
  });

  test("пустая выборка — ни одного запроса", async () => {
    await api.addPatientGroupMembers("g1", []);
    expect(sent).toEqual([]);
  });

  /* мутация: вернуть цикл по addPatientGroupMember — падает своя строка */
  test("«Добір людей» и карточка группы добавляют списком", () => {
    for (const file of ["../src/pages/Cohorts.tsx", "../src/pages/patientGroups/PatientGroupCard.tsx"]) {
      const src = readFileSync(resolve(import.meta.dir, file), "utf8");
      expect(src, `${file}: выборка добавляется по одному`).not.toMatch(/for \(const \w+ of selected\) await api\.addPatientGroupMember\(/);
      expect(src).toContain("await api.addPatientGroupMembers(");
    }
  });
});
