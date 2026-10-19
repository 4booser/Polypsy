import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../src/lang";
import { CrashHelp } from "../src/shell/CrashHelp";
import { ErrorBoundary } from "../src/telemetry/ErrorBoundary";

/**
 * Лист падения кабинета пациента — сетка безопасности.
 *
 * Экран упал у человека, который, возможно, проходил опросник потому, что ему
 * плохо. Лист «щось пішло не так» без номера помощи был бы тупиком: на нём
 * обязаны стоять линия доверия 7333 и 103 — настоящими ссылками tel:. У
 * консоли сотрудника лист прежний.
 *
 * Отрисовка без браузера границу не роняет (renderToStaticMarkup не ловит
 * ошибки), поэтому граница рисуется в состоянии «упало» напрямую.
 */
const crashed = (extra?: ReactNode) => {
  const boundary = new ErrorBoundary({ children: <p data-child="screen" />, extra });
  boundary.state = { failed: true };
  return renderToStaticMarkup(<LangProvider>{boundary.render()}</LangProvider>);
};

describe("лист падения", () => {
  test("кабинет пациента: номера помощи звонком — 7333 и 103", () => {
    const html = crashed(<CrashHelp />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="tel:7333"');
    expect(html).toContain('href="tel:103"');
    expect(html).not.toContain("data-child");
  });

  test("консоль сотрудника: лист прежний, без номеров", () => {
    const html = crashed();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("tel:");
  });
});
