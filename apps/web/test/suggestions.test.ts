import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, ApiError } from "../src/api";
import { decideHit, suggestionsShown } from "../src/components/Suggestions";

/**
 * Предложения правил: решение, которое успел принять другой (#104, w19:ui).
 *
 * Сервер записывает решение только поверх «предложено», и второй из двух
 * одновременных получает 409 err.hitDecidedMeanwhile. Экран показывал это
 * всплывающим уведомлением и оставлял решённое предложение в списке с
 * живыми кнопками. Проверяется ход решения на подставном запросе: на 409 —
 * фраза сервера экрану и перечитанный список; на прочих отказах — отказ как
 * был (его показывает useAction), список не трогается.
 */

const PHRASE = "Рішення щодо цієї пропозиції щойно ухвалив інший співробітник. Оновіть список";

/** Подставное перечитывание: считает вызовы */
function reloader() {
  const calls = { n: 0 };
  return { calls, reload: () => void calls.n++ };
}

describe("ход решения", () => {
  test("принято — список перечитывается, сказать нечего", async () => {
    const r = reloader();
    expect(await decideHit(async () => ({ ok: true }), r.reload)).toEqual({ meanwhile: null });
    expect(r.calls.n).toBe(1);
  });

  test("409 — фраза сервера экрану и перечитанный список, а не отказ наружу", async () => {
    const r = reloader();
    const outcome = await decideHit(async () => {
      throw new ApiError(PHRASE, 409);
    }, r.reload);
    expect(outcome).toEqual({ meanwhile: PHRASE });
    expect(r.calls.n).toBe(1);
  });

  test("прочие отказы — наружу как были, список не перечитывается", async () => {
    for (const error of [
      new ApiError("Рішення вже ухвалено", 400),
      new ApiError("Помилка сервера", 500),
      new ApiError("Немає зв’язку", 0),
      new Error("щось"),
    ]) {
      const r = reloader();
      await expect(
        decideHit(async () => {
          throw error;
        }, r.reload),
      ).rejects.toBe(error);
      expect(r.calls.n, error.message).toBe(0);
    }
  });

  test("панель остаётся, пока есть что сказать: последнее предложение решил другой", () => {
    expect(suggestionsShown(0, PHRASE)).toBe(true);
    expect(suggestionsShown(0, null)).toBe(false);
    expect(suggestionsShown(2, null)).toBe(true);
  });
});

/** Хранилище в памяти: клиент читает токен из localStorage, которого в bun нет */
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

describe("на подставном сервере", () => {
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

  test("PATCH /api/decisions/hits/:id отвечает 409 — экран получает фразу сервера", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: PHRASE }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const r = reloader();
    const outcome = await decideHit(() => api.decideHit("hit-1", "declined", "Обговорили минулого тижня"), r.reload);
    expect(outcome.meanwhile).toBe(PHRASE);
    expect(r.calls.n).toBe(1);
    expect(calls.map((c) => [c.url, c.method, JSON.parse(c.body)])).toEqual([
      ["/api/decisions/hits/hit-1", "PATCH", { status: "declined", note: "Обговорили минулого тижня" }],
    ]);
  });

  test("обе кнопки панели идут через этот ход, а не зовут сервер мимо него", () => {
    /*
     * Нажатие без браузера не проверить, поэтому — по исходнику: запрос
     * решения в панели один, и он внутри decideHit. Прежде каждая кнопка
     * звала api.decideHit сама и перечитывала список только при успехе.
     */
    const src = readFileSync(resolve(import.meta.dir, "../src/components/Suggestions.tsx"), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src.match(/api\.decideHit\(/g)?.length).toBe(1);
    expect(src).toMatch(/decideHit\(\(\) => api\.decideHit\(/);
    expect(src).toContain('decide(hit, "accepted"');
    expect(src).toContain('decide(hit, "declined"');
  });
});
