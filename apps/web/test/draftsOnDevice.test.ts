import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { tokenStore } from "../src/api";
import { dropTabSession } from "../src/auth";

/**
 * Черновики прохождений кабинета на общем компьютере (ревью волны 26).
 *
 * Пациенты входят с компьютера палаты. Черновик — ответы как есть, со
 * словами человека в текстовых пунктах, — лежал в браузере после выхода, после
 * конца сессии и после входа следующего человека, без срока. Теперь он живёт,
 * только пока его хозяин внутри (patient/drafts.ts): здесь — что вход
 * (auth.tsx) зовёт чистку во всех местах, где хозяин уходит.
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

/** JWT без подписи: клиенту важен только `sub` (api.ts, ownerOfToken) */
function jwt(sub: string): string {
  const body = btoa(JSON.stringify({ sub })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage };

const draftOf = (surveyId: string) => JSON.stringify({ [surveyId]: { surveyId, savedAt: new Date().toISOString() } });
const draftKeys = () =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "")
    .filter((k) => k.startsWith("quizzy.drafts."))
    .sort();
const tab = () => ({ user: () => {}, perms: () => {}, mfa: () => {} });

beforeEach(() => {
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  localStorage.setItem("quizzy.drafts.patient-a", draftOf("phq9"));
  localStorage.setItem("quizzy.drafts.patient-b", draftOf("gad7"));
});

afterEach(() => {
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

describe("вкладку сбросили — черновики остаются только у того, чей токен в браузере", () => {
  test("в соседней вкладке вошёл B: черновики A стёрты, черновики B целы", () => {
    tokenStore.set(jwt("patient-b"));
    dropTabSession(tab(), new QueryClient());
    expect(draftKeys(), "черновик прежнего человека пережил вход следующего").toEqual(["quizzy.drafts.patient-b"]);
  });

  test("сессии нет (окончательный 401, выход в соседней вкладке): стёрты все", () => {
    tokenStore.clear();
    dropTabSession(tab(), new QueryClient());
    expect(draftKeys()).toEqual([]);
  });
});

describe("вход зовёт чистку там, где хозяин уходит или приходит другой", () => {
  const src = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");

  test("выход стирает черновики — вместе с токенами", () => {
    expect(src).toMatch(/function logout\(\) \{[\s\S]{0,400}?tokenStore\.clear\(\);[\s\S]{0,200}?forgetDrafts\(null\);/);
  });

  test("сессия не восстановилась при открытии — тоже", () => {
    expect(src).toMatch(/else if \(boot\.error\) \{[\s\S]{0,200}?tokenStore\.clear\(\);[\s\S]{0,200}?forgetDrafts\(null\);/);
  });

  test("вошёл или восстановился человек — черновики остальных стёрты, его целы", () => {
    // accept — общий путь входа паролем, вторым фактором, после регистрации и возврата от Google (refreshUser)
    expect(src).toMatch(/async function accept\(next: User\) \{[\s\S]{0,300}?forgetDrafts\(next\.id\);/);
    expect(src).toMatch(/if \(boot\.data\) \{[\s\S]{0,300}?forgetDrafts\(boot\.data\.me\.id\);/);
  });
});
