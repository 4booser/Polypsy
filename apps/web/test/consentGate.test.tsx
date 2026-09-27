import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, consentActionsOf, consentViewOfLoadError, type ConsentView } from "@quizzy/shared";
import { api, ApiError } from "../src/api";
import { LangProvider } from "../src/lang";
import { ConsentScreen, acceptFailure } from "../src/patient/ConsentGate";

/**
 * Согласие в веб-кабинете: отказ — не выход.
 *
 * «Не погоджуюся» кабинета просто выводило из учётной записи: сервер не
 * узнавал об отказе, человек не узнавал, что из него следует. Приложение
 * это исправило в волне 12 (apps/mobile/src/consent/model.ts); модель
 * состояний теперь общая (packages/shared/src/consentFlow.ts), и здесь
 * проверяется, что кабинет рисует её целиком и зовёт сервер.
 */

const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

/** Текст ключа на любом из языков — проверка не зависит от языка окружения */
const has = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const screen = (view: Exclude<ConsentView, { kind: "pass" }>) =>
  draw(<ConsentScreen view={view} busy={false} error={null} onAction={() => {}} />);

describe("экран согласия кабинета", () => {
  test("текст — с «погоджуюся» и «не погоджуюся», последствие отказа — до выбора", () => {
    const html = screen({ kind: "read", text: "Я погоджуюся на обстеження." });
    expect(html).toContain("Я погоджуюся на обстеження.");
    expect(has(html, "consent.accept")).toBe(true);
    expect(has(html, "consent.decline")).toBe(true);
    expect(has(html, "consent.hint")).toBe(true);
  });

  test("отказ — своё состояние: что недоступно, что дальше, выйти или вернуться к тексту", () => {
    const html = screen({ kind: "declined" });
    expect(has(html, "consent.declinedTitle")).toBe(true);
    expect(has(html, "consent.declinedWhatWeb")).toBe(true);
    expect(has(html, "consent.declinedNext")).toBe(true);
    expect(has(html, "consent.signOut")).toBe(true);
    expect(has(html, "consent.reconsider")).toBe(true);
    // согласиться с экрана отказа нельзя — только вернуться к тексту
    expect(html.match(/<button/g)?.length).toBe(2);
    expect(has(html, "consent.accept")).toBe(false);
  });

  test("текст не получен — принимать нечего: повторить или выйти", () => {
    const html = screen({ kind: "failed" });
    expect(has(html, "consent.loadFailed")).toBe(true);
    expect(has(html, "common.retry")).toBe(true);
    expect(has(html, "consent.signOut")).toBe(true);
    expect(html.match(/<button/g)?.length).toBe(2);
  });

  test("экран — зона пальца: он открывается с телефона до оболочки кабинета", () => {
    expect(screen({ kind: "declined" })).toContain("data-touch");
  });

  test("кнопки — из общей модели: у каждого состояния есть выход без согласия", () => {
    for (const view of [{ kind: "read", text: "т" }, { kind: "failed" }, { kind: "declined" }] as const) {
      const actions = consentActionsOf(view);
      expect(actions.some((a) => a === "decline" || a === "signOut"), view.kind).toBe(true);
    }
  });

  test("без связи и на время работ сервера кабинет не запирается; иной отказ — «текст не получен»", () => {
    expect(consentViewOfLoadError(0)).toEqual({ kind: "pass" });
    // 503 — обслуживание: кабинет откладывает сдачи и досылает их после работ
    expect(consentViewOfLoadError(503)).toEqual({ kind: "pass" });
    expect(consentViewOfLoadError(500)).toEqual({ kind: "failed" });
    expect(consentViewOfLoadError(403)).toEqual({ kind: "failed" });
  });
});

describe("«Погоджуюся» как состояние формы (w13:uitests)", () => {
  test("409 — редакция сменилась: сказать почему и перечитать текст", () => {
    const f = acceptFailure(new ApiError("Текст згоди оновився — прочитайте нову редакцію", 409), "запасний");
    expect(f).toEqual({ error: "Текст згоди оновився — прочитайте нову редакцію", reread: true });
  });

  test("обрыв и пятисотка — текст остаётся, перечитывать нечего, повтор той же кнопкой", () => {
    expect(acceptFailure(new ApiError("Немає зв’язку", 0), "x")).toEqual({ error: "Немає зв’язку", reread: false });
    expect(acceptFailure(new ApiError("Помилка сервера", 500), "x").reread).toBe(false);
    // отказ без текста — запасная строка, а не пустая красная полоса
    expect(acceptFailure(new ApiError("", 500), "Помилка").error).toBe("Помилка");
    expect(acceptFailure("щось", "Помилка").error).toBe("Помилка");
  });

  const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>/g)].map((m) => /\sdisabled=""/.test(m[1]!));

  test("пока решение уходит, обе кнопки выключены; ошибка видна над ними", () => {
    const html = draw(
      <ConsentScreen view={{ kind: "read", text: "Текст" }} busy error="Немає зв’язку" onAction={() => {}} />,
    );
    expect(buttons(html)).toEqual([true, true]);
    expect(html).toMatch(/role="alert"[^>]*>Немає зв’язку</);
  });

  test("ошибки нет — нет и полосы; кнопки живые", () => {
    const html = screen({ kind: "read", text: "Текст" });
    expect(html).not.toContain('role="alert"');
    expect(buttons(html)).toEqual([false, false]);
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

describe("отказ доходит до сервера", () => {
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

  function capture(): { url: string; method: string; body: string }[] {
    const calls: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true, withdrawn: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return calls;
  }

  test("«не погоджуюся» — POST /api/consents/me/decline", async () => {
    const calls = capture();
    await api.declineConsent();
    expect(calls).toEqual([{ url: "/api/consents/me/decline", method: "POST", body: "{}" }]);
  });

  test("«погоджуюся» — с редакцией, которую показали", async () => {
    const calls = capture();
    await api.acceptConsent("text-7");
    expect(calls[0]!.url).toBe("/api/consents/me/accept");
    expect(JSON.parse(calls[0]!.body)).toEqual({ textId: "text-7" });
  });

  test("кнопка отказа зовёт сервер, а не выход из учётной записи", () => {
    /*
     * Нажатие без браузера не проверить, поэтому — по исходнику: ветка
     * decline обязана звать api.declineConsent и не звать logout. Прежде
     * она была ровно `onClick={logout}`.
     */
    const src = readFileSync(join(resolve(import.meta.dir, ".."), "src/patient/ConsentGate.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const branch = /decline: \(\) => \{([\s\S]*?)\n {4}\},/.exec(src)?.[1] ?? "";
    expect(branch, "ветка decline не найдена — проверка смотрит не туда").not.toBe("");
    expect(branch).toContain("api.declineConsent()");
    expect(branch).toContain('kind: "declined"');
    expect(branch).not.toContain("logout");
  });
});
