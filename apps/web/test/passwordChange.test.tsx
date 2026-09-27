import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, changePasswordSchema, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { ForcePasswordView } from "../src/pages/ForcePassword";
import { PASSWORD_MIN, changePassword, passwordProblems, passwordReady } from "../src/pages/passwordModel";

/**
 * Смена пароля: экран временного пароля и раздел «Пароль» учётной записи.
 *
 * Здесь закреплены три вещи, которые на живом экране проверяются только
 * руками и только в неудачный день:
 *  - граница длины одна с сервером (учётная запись просила «от 8», сервер
 *    — от 10, и пароль в 9 знаков уходил, чтобы вернуться отказом схемы);
 *  - погашенная кнопка всегда объяснена словами у поля;
 *  - повтор после неудачного входа не шлёт смену второй раз: сервер,
 *    сменив пароль, гасит сессию, и вторая смена со старым паролем
 *    возвращала «неверный текущий пароль» про только что изменённый.
 */

describe("что мешает отправить", () => {
  test("граница длины — та же, что у схемы сервера", () => {
    const ok = (n: number) => changePasswordSchema.safeParse({ currentPassword: "x", newPassword: "a".repeat(n) }).success;
    expect(ok(PASSWORD_MIN - 1)).toBe(false);
    expect(ok(PASSWORD_MIN)).toBe(true);
  });

  test("пустая форма не готова и ни о чём не кричит", () => {
    expect(passwordProblems({ current: "", next: "", repeat: "" })).toEqual({});
    expect(passwordReady({ current: "", next: "", repeat: "" })).toBe(false);
  });

  test("короткий пароль — словами у поля", () => {
    const d = { current: "temp-pass-1", next: "short", repeat: "short" };
    expect(passwordProblems(d).next).toBe("ops.force.short");
    expect(passwordReady(d)).toBe(false);
    // 9 знаков — всё ещё коротко: учётная запись раньше пропускала их к серверу
    expect(passwordReady({ current: "old", next: "123456789" })).toBe(false);
  });

  test("новый равен текущему — не молча погашенная кнопка, а слова у поля", () => {
    const d = { current: "abcd-efgh-jkmn", next: "abcd-efgh-jkmn", repeat: "abcd-efgh-jkmn" };
    expect(passwordProblems(d).next).toBe("uit.password.same");
    expect(passwordReady(d)).toBe(false);
  });

  test("повтор не совпал — словами у повтора; пока повтор пуст, о нём молчим", () => {
    expect(passwordProblems({ current: "t", next: "0123456789", repeat: "0123456780" }).repeat).toBe("ops.force.mismatch");
    expect(passwordProblems({ current: "t", next: "0123456789", repeat: "" }).repeat).toBeUndefined();
    expect(passwordReady({ current: "t", next: "0123456789", repeat: "" })).toBe(false);
  });

  test("всё верно — готово; у формы без повтора повтор не спрашивается", () => {
    expect(passwordReady({ current: "t", next: "0123456789", repeat: "0123456789" })).toBe(true);
    expect(passwordReady({ current: "t", next: "0123456789" })).toBe(true);
  });
});

describe("смена и вход заново", () => {
  function fakes(fail: { change?: number; relogin?: number } = {}) {
    const calls: string[] = [];
    let changeFails = fail.change ?? 0;
    let reloginFails = fail.relogin ?? 0;
    return {
      calls,
      api: {
        change: async (current: string, next: string) => {
          calls.push(`change ${current}→${next}`);
          if (changeFails-- > 0) throw new Error("Невірний поточний пароль");
        },
        relogin: async (password: string) => {
          calls.push(`login ${password}`);
          if (reloginFails-- > 0) throw new Error("Немає зв’язку");
        },
      },
    };
  }

  test("удача: смена один раз, вход новым паролем", async () => {
    const f = fakes();
    let accepted: string | null = null;
    await changePassword({ current: "temp", next: "new-password" }, null, f.api, (p) => {
      accepted = p;
    });
    expect(f.calls).toEqual(["change temp→new-password", "login new-password"]);
    expect(accepted as string | null).toBe("new-password");
  });

  test("вход после смены не удался — повтор только входит, смены со старым паролем нет", async () => {
    const f = fakes({ relogin: 1 });
    let accepted: string | null = null;
    const draft = { current: "temp", next: "new-password" };
    await expect(
      changePassword(draft, accepted, f.api, (p) => {
        accepted = p;
      }),
    ).rejects.toThrow("Немає зв’язку");
    // сервер пароль принял — экран это помнит
    expect(accepted as string | null).toBe("new-password");

    /* человек мог и поправить поле, пока читал отказ: входить надо тем, что принято */
    await changePassword({ ...draft, next: "typo-after" }, accepted, f.api, () => {});
    expect(f.calls).toEqual(["change temp→new-password", "login new-password", "login new-password"]);
  });

  test("смена не удалась — вход не пробуется, повтор снова меняет", async () => {
    const f = fakes({ change: 1 });
    let accepted: string | null = null;
    const onAccepted = (p: string) => {
      accepted = p;
    };
    await expect(changePassword({ current: "wrong", next: "new-password" }, null, f.api, onAccepted)).rejects.toThrow();
    expect(accepted as string | null).toBeNull();
    await changePassword({ current: "temp", next: "new-password" }, accepted, f.api, onAccepted);
    expect(f.calls).toEqual(["change wrong→new-password", "change temp→new-password", "login new-password"]);
  });
});

describe("разметка экрана «Змініть пароль»", () => {
  const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
  const has = (html: string, key: UiKey) => {
    const e = UI[key] as { uk: string; ru: string };
    return html.includes(e.uk) || html.includes(e.ru);
  };
  const view = (over: Partial<Parameters<typeof ForcePasswordView>[0]> = {}) =>
    draw(
      <ForcePasswordView
        email="iryna@clinic.ua"
        draft={{ current: "temp-pass-1", next: "0123456789", repeat: "0123456789" }}
        busy={false}
        error={null}
        accepted={false}
        onEdit={() => {}}
        onSubmit={() => {}}
        onLogout={() => {}}
        {...over}
      />,
    );
  const submitOff = (html: string) => /\sdisabled=""/.test(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "");

  test("готово — кнопка активна; идёт отправка — погашена", () => {
    expect(submitOff(view())).toBe(false);
    expect(submitOff(view({ busy: true }))).toBe(true);
  });

  test("новый равен временному — объяснено у поля", () => {
    const html = view({ draft: { current: "abcd-efgh-jkmn", next: "abcd-efgh-jkmn", repeat: "abcd-efgh-jkmn" } });
    expect(has(html, "uit.password.same")).toBe(true);
    expect(submitOff(html)).toBe(true);
  });

  test("отказ сервера — строкой с role=alert", () => {
    expect(view({ error: "Невірний поточний пароль" })).toMatch(/role="alert"[^>]*>Невірний поточний пароль</);
  });

  test("пароль уже принят, не удался вход — поля закрыты, кнопка повторяет вход", () => {
    const html = view({ accepted: true, draft: { current: "", next: "", repeat: "" }, error: "Немає зв’язку" });
    expect(submitOff(html)).toBe(false);
    expect(html.match(/<input[^>]*type="password"[^>]*disabled=""/g)?.length).toBe(3);
  });
});

test("учётная запись после смены входит заново — тем же путём, что и экран временного пароля", () => {
  /*
   * Сервер гасит все сессии пользователя, сменившего пароль, и эту тоже.
   * Раздел «Пароль» учётной записи показывал «Пароль змінено» и оставлял
   * консоль с погашенной сессией: первый же следующий запрос упирался в
   * отказ. Разметку этого раздела без провайдера входа не нарисовать,
   * поэтому проверяется, что он зовёт общий путь и общую границу.
   */
  const src = readFileSync(resolve(import.meta.dir, "../src/pages/Account.tsx"), "utf8");
  expect(src).toContain("changePassword(");
  expect(src).toContain("relogin:");
  expect(src).toContain("passwordReady(");
  expect(src).not.toMatch(/next\.length\s*<\s*8/);
});
