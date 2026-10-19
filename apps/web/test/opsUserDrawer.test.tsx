import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { type OpsUserRow, UI, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { SESSIONS_PEEK_DELAY_MS, SESSIONS_PEEK_FRESH_MS } from "../src/pages/ops/users/parts";
import { RecordBody } from "../src/pages/ops/users/UserDrawer";

/**
 * Панель записи «Користувачів» (Polypsy 2.0): что в ней видно смотрящему.
 *
 * Панель открывает тот, у кого есть users.manage, — а «Останні дії» читают
 * журнал (GET /api/audit), закрытый без audit.read. Раздел без права
 * рисовался всё равно: каждое открытие записи заведующим без права журнала
 * кончалось отказом сервера, строкой access.denied в журнале доступа и
 * ошибкой на месте раздела.
 */

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

const ROW: OpsUserRow = {
  id: "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  email: "koval@clinic.ua",
  fullName: "Коваль Марія Іванівна",
  role: "admin",
  anonymous: false,
  roleTitles: [],
  ladderRank: 1,
  exceptions: 0,
  createdAt: "2026-09-01T09:00:00.000Z",
  lastSeenAt: "2026-10-08T09:00:00.000Z",
  disabledAt: null,
  disabledReason: null,
  disabledByEmail: null,
  mustChangePassword: false,
  sessions: 1,
  trace: {
    responses: 0,
    conclusions: 0,
    notes: 0,
    cases: 0,
    surveys: 0,
    referrals: 0,
    appointments: 0,
    episodes: 0,
    safetyPlans: 0,
    recordings: 0,
    consents: 0,
    threads: 0,
    dispensary: 0,
  },
  journalEntries: 12,
  secondFactor: { enabled: false, required: null },
  lock: null,
};

const body = (canAudit: boolean) =>
  draw(<RecordBody row={ROW} name={ROW.fullName} isSuper={false} canAudit={canAudit} canEnd onEndAll={() => {}} />);

describe("панель записи: «Останні дії» — только с правом журнала", () => {
  test("без audit.read раздела нет — ни заголовка, ни ссылок в журнал; остальное на месте", () => {
    const html = body(false);
    expect(has(html, "oppu.recent")).toBe(false);
    expect(has(html, "oppu.allJournal")).toBe(false);
    expect(html).not.toContain("/ops/audit?");
    // факты, сессии и след — разделы users.manage, они остаются
    expect(has(html, "oppu.facts")).toBe(true);
    expect(has(html, "oppu.sessionsTitle")).toBe(true);
    expect(has(html, "oppu.trace")).toBe(true);
  });

  test("положительный контроль: с audit.read — раздел и переходы в журнал по человеку", () => {
    const html = body(true);
    expect(has(html, "oppu.recent")).toBe(true);
    expect(html).toContain(`/ops/audit?actor=${ROW.id}`);
    expect(html).toContain(`/ops/audit?subject=${ROW.id}`);
  });

  test("панель берёт право смотрящего, а не рисует раздел всегда", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/ops/users/UserDrawer.tsx"), "utf8");
    expect(src).toContain('canAudit={can("audit.read")}');
    expect(src).toMatch(/\{canAudit \? <RecentSection row=\{row\} \/> : null\}/);
  });
});

describe("подсказка «Сесії» в таблице: чтение — строка журнала, и наведение его не множит", () => {
  /*
   * Подсказка открывалась через 120 мс наведения и каждый раз читала сессии
   * заново (свой кэш у каждого показа): проведённый по таблице указатель
   * оставлял в журнале session.list о каждом, над чьим числом прошёл.
   */
  test("открывается по намеренному наведению, а прочитанное берёт из общего кэша на человека", () => {
    expect(SESSIONS_PEEK_DELAY_MS).toBeGreaterThanOrEqual(400);
    expect(SESSIONS_PEEK_FRESH_MS).toBeGreaterThanOrEqual(30_000);
    const parts = readFileSync(resolve(import.meta.dir, "../src/pages/ops/users/parts.tsx"), "utf8");
    expect(parts).toContain("delay={SESSIONS_PEEK_DELAY_MS}");
    expect(parts).toMatch(
      /api\.opsSessions\(\{ userId, per: "10" \}\), \[userId, count\], \{\s*key: "ops\.users\.sessionsPeek",\s*staleMs: SESSIONS_PEEK_FRESH_MS,/,
    );
  });
});

describe("панель записи: J/K не меняют запись под окном действия", () => {
  test("«Користувачі» гасят J/K панели, пока открыто окно (подтверждение, пароль)", () => {
    const users = readFileSync(resolve(import.meta.dir, "../src/pages/ops/Users.tsx"), "utf8");
    expect(users).toContain("keys={!dialog}");
    const drawer = readFileSync(resolve(import.meta.dir, "../src/pages/ops/users/UserDrawer.tsx"), "utf8");
    expect(drawer).toContain("useHotkeys({ j: () => onStep(1), k: () => onStep(-1) }, open && keys);");
  });

  test("окно стирания устройства не переживает смену записи: раздел устройств — с ключом записи", () => {
    const drawer = readFileSync(resolve(import.meta.dir, "../src/pages/ops/users/UserDrawer.tsx"), "utf8");
    expect(drawer).toContain("<DevicesSection key={row.id} userId={row.id} name={name} />");
  });
});
