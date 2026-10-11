import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type AuditEntry, type AuditPage } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { SearchPeriodNote } from "../src/pages/ops/AuditLog";
import { type Page, pagedState } from "../src/useResource";

/**
 * Журнал техпанели после #190: ответ сервера поменял форму.
 *
 * Свободный текст сервер ищет не дальше 31 дня и называет окно в ответе
 * (searchPeriod) — экран обязан его показать: «не найдено за месяц» без этой
 * строки читалось бы как «не найдено во всём журнале». А счёт сервер кладёт
 * только на первую страницу — число «Знайдено» берётся с неё и не пропадает,
 * когда «Показати ще» приносит страницу без счёта.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

describe("журнал: окно поиска по тексту и счёт с первой страницы (#190)", () => {
  test("окно поиска показано словами и датами", () => {
    const html = draw(<SearchPeriodNote period={{ from: "2026-09-11", to: "2026-10-11" }} />);
    const said = [UI["ops.audit.searchPeriod"].uk, UI["ops.audit.searchPeriod"].ru, UI["ops.audit.searchPeriod"].en];
    expect(said.some((s) => html.includes(s))).toBe(true);
    expect(html).toMatch(/11.*–.*11/);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Invalid");
  });

  test("без текста окна нет — и строки нет", () => {
    expect(draw(<SearchPeriodNote period={undefined} />)).toBe("");
  });

  test("счёт — с первой страницы, даже когда следующая пришла без него", () => {
    type P = AuditPage & Page<AuditEntry>;
    const first: P = { entries: [], items: [], total: 1234, offset: 0, limit: 50, nextCursor: "c1" };
    const second: P = { entries: [], items: [], offset: 0, limit: 50, nextCursor: null };
    const result = {
      data: { pages: [first, second], pageParams: [null, "c1"] },
      fetchStatus: "idle",
      isFetchingNextPage: false,
      isPlaceholderData: false,
      hasNextPage: false,
      error: null,
    } as unknown as Parameters<typeof pagedState<AuditEntry, P>>[0];
    expect(pagedState<AuditEntry, P>(result, []).total).toBe(1234);
  });
});
