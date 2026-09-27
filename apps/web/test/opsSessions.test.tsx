import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { type OpsSession, type OpsSessionPage, UI, type UiKey, opsSessionQuery } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { ListPlace } from "../src/pages/ops/controls";
import { SessionsList } from "../src/pages/ops/Sessions";
import {
  SESSIONS_PAGE_MAX,
  SESSIONS_SEARCH_MAX,
  readSessionsFilters,
  sessionsEmptyKey,
  sessionsQuery,
} from "../src/pages/ops/sessionsModel";
import type { Resource } from "../src/useResource";

/**
 * Техпанель: вкладка «Сесії» и место списка у «Користувачів» и «Аудиту»
 * (w14:webtails).
 *
 * Вкладка «Сесії» проверок поведения не имела вовсе, а место списка у трёх
 * вкладок было встроенной лесенкой «отказ → скелет → пусто → строки»,
 * которую без браузера не нарисовать. Здесь — отбор из адреса через схему
 * сервера, слова пустого списка, все состояния места списка (скелет, отказ,
 * обрыв, пусто, строки, отказ поверх строк) и погашенная на время
 * завершения кнопка.
 */

const url = (s: string) => new URLSearchParams(s);

/** Пройдёт ли запрос схему сервера (opsSessionQuery): иначе на месте списка — «Невірний запит» */
const accepted = (q: Record<string, string | undefined>) =>
  opsSessionQuery.safeParse(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined))).success;

const U1 = "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("«Сесії»: отбор из адреса", () => {
  test("человек, поиск, страница и размер восстанавливаются из адреса и принимаются сервером", () => {
    const f = readSessionsFilters(url(`user=${U1}&q=Коваль&page=3&per=50`));
    expect(f).toEqual({ q: "Коваль", userId: U1, page: 3, per: 50 });
    expect(sessionsQuery(f)).toEqual({ q: "Коваль", userId: U1, page: "3", per: "50" });
    expect(accepted(sessionsQuery(f))).toBe(true);
  });

  test("кривой адрес не превращается в отказ всего списка: условие просто не применяется", () => {
    /*
     * Было: адрес уходил на сервер как есть. Имя вместо идентификатора
     * человека, страница из далёкой закладки, абзац в поиске — каждый давал
     * 400 на месте списка, и «повторити» повторяло тот же отказ.
     */
    const raw = (s: string) => {
      const p = url(s);
      return { q: p.get("q") ?? "", userId: p.get("user") || undefined, page: p.get("page") ?? "1", per: p.get("per") ?? "10" };
    };
    const bad = [
      "user=Коваль",
      "user=0b8f6a3e",
      `page=${SESSIONS_PAGE_MAX + 1}`,
      `q=${encodeURIComponent("а".repeat(SESSIONS_SEARCH_MAX + 1))}`,
    ];
    for (const s of bad) {
      expect(accepted(raw(s)), `прежний путь: «${s}» сервер бы отверг`).toBe(false);
      expect(accepted(sessionsQuery(readSessionsFilters(url(s)))), s).toBe(true);
    }
    expect(readSessionsFilters(url("user=Коваль")).userId).toBe("");
    expect(readSessionsFilters(url(`page=${SESSIONS_PAGE_MAX + 5}`)).page).toBe(SESSIONS_PAGE_MAX);
  });

  test("поиск уходит без краевых пробелов, не длиннее предела, пустой — не уходит вовсе", () => {
    const long = readSessionsFilters(url(`q=${encodeURIComponent(` ${"К".repeat(200)} `)}`));
    // поле показывает набранное целиком, на сервер — обрезанное
    expect(long.q.length).toBe(202);
    expect(sessionsQuery(long).q).toBe("К".repeat(SESSIONS_SEARCH_MAX));
    expect(sessionsQuery(readSessionsFilters(url("q=%20%20"))).q).toBeUndefined();
    // уходит поиск, переставший меняться, а не последняя буква
    expect(sessionsQuery(readSessionsFilters(url("q=Кова")), "Ков").q).toBe("Ков");
  });

  test("пустой ответ называется по отбору: «сессий нет вообще» — только без отбора", () => {
    /*
     * Было: «Активних сесій немає» и на поиске, не нашедшем никого, — то
     * есть утверждение обо всей системе там, где не нашлось подходящих.
     */
    expect(sessionsEmptyKey({ q: "", userId: "" })).toBe("ops.sessions.none");
    expect(sessionsEmptyKey({ q: "коваль", userId: "" })).toBe("wt.sess.noneFound");
    expect(sessionsEmptyKey({ q: "коваль", userId: U1 })).toBe("wt.sess.noneFound");
    expect(sessionsEmptyKey({ q: "  ", userId: U1 })).toBe("wt.sess.noneOfUser");
  });

  test("вкладка читает отбор через разбор и шлёт на сервер разобранное", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/ops/Sessions.tsx"), "utf8");
    expect(src).toContain("readSessionsFilters(params)");
    expect(src).toMatch(/api\.opsSessions\(query\)/);
    expect(src).toMatch(/sessionsEmptyKey\(\{ q: settledQ, userId \}\)/);
    // сырой адрес на сервер больше не уходит
    expect(src).not.toContain('params.get("user")');
  });
});

/* ─────────── место списка ─────────── */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const has = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const OOPS = "Сервер тимчасово недоступний";
const skeleton = (html: string) => html.includes('aria-busy="true"');
const retry = (html: string) => has(html, "common.retry");

function res<T>(over: Partial<Resource<T>> = {}): Resource<T> {
  return {
    data: null,
    loading: false,
    refreshing: false,
    error: null,
    offline: false,
    updatedAt: null,
    reload: () => {},
    patch: () => {},
    ...over,
  };
}

const session = (n: number): OpsSession => ({
  id: `fam-${n}`,
  userId: `u-${n}`,
  fullName: `Коваль ${n}`,
  email: `koval${n}@clinic.ua`,
  role: "admin",
  startedAt: "2026-09-27T08:00:00.000Z",
  lastUsedAt: "2026-09-27T09:00:00.000Z",
  expiresAt: "2026-10-27T09:00:00.000Z",
});
const pageOf = (items: OpsSession[]): OpsSessionPage => ({ items, total: items.length, page: 1, per: 10 });

const EMPTY = "Сесій за цим відбором немає — перевірка";
const list = (r: Resource<OpsSessionPage>, busy = false) => draw(<SessionsList res={r} empty={EMPTY} busy={busy} onEnd={() => {}} />);

/** Кнопки «Завершити»: погашена ли каждая — по атрибуту, а не по классам (в них есть утилиты `disabled:`) */
const endButtons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>/g)]
    .map((m) => m[1]!)
    .filter((attrs) => /aria-label="[^"]*: Коваль/.test(attrs))
    .map((attrs) => /\sdisabled=""/.test(attrs));

describe("«Сесії»: что стоит на месте списка", () => {
  test("пока ответа нет или пропала связь — скелет, а не «сесій немає»", () => {
    for (const r of [res<OpsSessionPage>({ loading: true }), res<OpsSessionPage>({ offline: true })]) {
      const html = list(r);
      expect(skeleton(html)).toBe(true);
      expect(html).not.toContain(EMPTY);
    }
  });

  test("отказ до первого ответа — отказ с «повторити», а не пустота", () => {
    const html = list(res({ error: OOPS }));
    expect(html).toContain(OOPS);
    expect(retry(html)).toBe(true);
    expect(html).not.toContain(EMPTY);
  });

  test("сервер ответил пустым — слова пустого списка, и только тогда", () => {
    const html = list(res({ data: pageOf([]), updatedAt: 1 }));
    expect(html).toContain(EMPTY);
    expect(skeleton(html)).toBe(false);
  });

  test("отказ перечитывания после «Завершити» строки не стирает: отказ — строкой над ними", () => {
    /*
     * Было: `res.error ? отказ : …` — при показанных строках отказ
     * перечитывания вставал на место всего списка.
     */
    const html = list(res({ data: pageOf([session(1), session(2)]), error: OOPS, updatedAt: 1 }));
    expect(html).toContain("koval1@clinic.ua");
    expect(html).toContain("koval2@clinic.ua");
    expect(html).toMatch(new RegExp(`role="alert"[\\s\\S]*${OOPS}`));
    expect(retry(html)).toBe(true);
  });

  test("«Завершити» погашена у всех строк, пока идёт завершение, и жива, когда ничего не идёт", () => {
    const rows = res({ data: pageOf([session(1), session(2)]), updatedAt: 1 });
    expect(endButtons(list(rows))).toEqual([false, false]);
    expect(endButtons(list(rows, true))).toEqual([true, true]);
  });
});

describe("место списка у «Користувачів» и «Аудиту»", () => {
  const place = (items: string[] | null, error: string | null) =>
    draw(
      <ListPlace items={items} error={error} onRetry={() => {}} empty={EMPTY}>
        {() => (
          <ul>
            {items!.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </ListPlace>,
    );

  test("четыре состояния: скелет, отказ с «повторити», пусто по ответу, строки", () => {
    expect(skeleton(place(null, null))).toBe(true);
    const failed = place(null, OOPS);
    expect(failed).toContain(OOPS);
    expect(retry(failed)).toBe(true);
    expect(failed).not.toContain(EMPTY);
    expect(place([], null)).toContain(EMPTY);
    expect(place(["запис-1"], null)).toContain("запис-1");
  });

  test("отказ «Показати ще» или перечитывания — строкой над записями, записи остаются", () => {
    const html = place(["запис-1", "запис-2"], OOPS);
    expect(html).toContain("запис-1");
    expect(html).toContain("запис-2");
    expect(html).toContain(OOPS);
    expect(retry(html)).toBe(true);
    // и над пустым ответом — тоже строкой, а не вместо него
    const empty = place([], OOPS);
    expect(empty).toContain(EMPTY);
    expect(empty).toContain(OOPS);
  });

  test("вкладки рисуют список через общее место, а не своей лесенкой", () => {
    /*
     * Было: у «Користувачів» и «Аудиту» `res.error ? <Loading/> : …` — отказ
     * перечитывания стирал показанный реестр, неудачное «Показати ще» —
     * весь долистанный журнал.
     */
    const users = readFileSync(resolve(import.meta.dir, "../src/pages/ops/Users.tsx"), "utf8");
    expect(users).toMatch(
      /<ListPlace items=\{res\.data\?\.items \?\? null\} error=\{res\.error\} onRetry=\{res\.reload\} empty=\{ut\("pt\.nobodyFound"\)\}>/,
    );
    const audit = readFileSync(resolve(import.meta.dir, "../src/pages/ops/AuditLog.tsx"), "utf8");
    expect(audit).toMatch(/<ListPlace items=\{list\.items\} error=\{error\} onRetry=\{list\.reload\} empty=\{ut\("ops\.audit\.none"\)\}/);
    for (const src of [users, audit]) expect(src).not.toMatch(/\{(res\.)?error \? \(\s*<Loading/);
  });

  test("«вибрати всіх у відборі» не глотает отказ: он идёт через действие и показывается", () => {
    /* было: `.catch(() => {})` — выбор молча оставался страницей */
    const users = readFileSync(resolve(import.meta.dir, "../src/pages/ops/Users.tsx"), "utf8");
    expect(users).not.toContain(".catch(() => {})");
    expect(users).toMatch(/onAll=\{\(\) =>\s*void run\(async \(\) => \{\s*const r = await api\.opsUserIds\(/);
  });
});
