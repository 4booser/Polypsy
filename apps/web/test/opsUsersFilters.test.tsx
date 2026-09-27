import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, createUserSchema, opsUserListQuery, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { CreateAccountForm } from "../src/pages/ops/Users";
import {
  USER_ROLES,
  USER_SORTS,
  USER_STATES,
  type AccountDraft,
  accountBody,
  accountProblems,
  accountReady,
  accountStep,
  applyPatch,
  newAccount,
  readUsersFilters,
  usersIdsQuery,
  usersPatch,
  usersQuery,
} from "../src/pages/ops/usersModel";

/**
 * Техпанель → «Користувачі»: поведение отбора и окна заведения учётки.
 *
 * Отбор живёт в адресе, и в адрес он попадает не только из полей: ссылки
 * пересылают, закладки живут годами, мессенджер обрезает хвост. Сервер
 * закрытые списки проверяет строго (opsUserListQuery), и прежде кривое
 * значение из адреса уходило к нему как есть — экран вместо реестра
 * показывал «Невірний запит». Проверки ниже подают адрес и смотрят, что
 * уйдёт на сервер, прогоняя это через САМУ схему сервера: так они ловят и
 * расхождение списков, когда сервер однажды выучит новую роль.
 */

const url = (s: string) => new URLSearchParams(s);

/** Что сервер скажет на такой запрос: пройдёт ли он схему */
const accepted = (q: Record<string, string | undefined>) => {
  const clean = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined));
  return opsUserListQuery.safeParse(clean);
};

describe("отбор из адреса", () => {
  test("роль, состояние, порядок, поиск и страница восстанавливаются из адреса", () => {
    const f = readUsersFilters(url("q=Коваль&role=admin&status=disabled&sort=lastSeen&page=3&per=50"));
    expect(f).toEqual({ q: "Коваль", role: "admin", status: "disabled", sort: "lastSeen", page: 3, per: 50 });
  });

  test("отбор уходит на сервер теми же значениями, пустое не уходит вовсе", () => {
    const q = usersQuery(readUsersFilters(url("role=user&status=active&page=2")));
    expect(q).toEqual({ q: undefined, role: "user", status: "active", sort: "name", page: "2", per: "10" });
    expect(accepted(q).success).toBe(true);
  });

  test("поиск на сервер — успокоившийся, без краевых пробелов", () => {
    const f = readUsersFilters(url("q=Кова"));
    expect(usersQuery(f, "  Коваль  ").q).toBe("Коваль");
    // пробелы — не поиск: сервер не должен получать `?q=%20`
    expect(usersQuery(f, "   ").q).toBeUndefined();
  });

  test("кривое значение в адресе — «фильтра нет», а не отказ сервера на весь экран", () => {
    /*
     * До правки роль, состояние и порядок уходили на сервер как есть, и
     * ссылка «?role=doctor» открывала вместо реестра 400. Каждый случай
     * проверяется схемой сервера — той, что ответила бы отказом.
     */
    const garbage = [
      "role=doctor",
      "status=blocked",
      "sort=age",
      "role=ADMIN",
      "page=999999999",
      `q=${"я".repeat(300)}`,
      "per=7",
      "page=-2",
    ];
    for (const raw of garbage) {
      const f = readUsersFilters(url(raw));
      const verdict = accepted(usersQuery(f));
      expect(verdict.success, `${raw}: ${verdict.error?.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
    const f = readUsersFilters(url("role=doctor&status=blocked&sort=age"));
    // поле фильтра показывает «усі», а не пустоту: значение, которого нет среди вариантов
    expect([f.role, f.status, f.sort]).toEqual(["", "", "name"]);
  });

  test("«вибрати всіх у відборі» — тот же отбор, что у списка, без порядка и страницы", () => {
    const f = readUsersFilters(url("q=%20Коваль&role=superhero&status=disabled&sort=role&page=4"));
    expect(usersIdsQuery(f)).toEqual({ q: "Коваль", role: undefined, status: "disabled" });
  });

  test("списки допустимых значений совпадают со схемой сервера", () => {
    /* сервер выучит новую роль — экран должен узнать о ней не из жалобы «фильтр не работает» */
    expect([...USER_ROLES].sort()).toEqual([...opsUserListQuery.shape.role.unwrap().options].sort());
    expect([...USER_STATES].sort()).toEqual([...opsUserListQuery.shape.status.unwrap().options].sort());
    expect([...USER_SORTS].sort()).toEqual([...opsUserListQuery.shape.sort.removeDefault().unwrap().options].sort());
  });
});

describe("смена отбора в адресе", () => {
  test("смена роли, состояния, порядка, поиска и размера страницы возвращает на первую страницу", () => {
    const at3 = url("role=admin&page=3&per=20");
    for (const key of ["q", "role", "status", "sort", "per"] as const) {
      const next = applyPatch(at3, usersPatch(key, key === "per" ? "50" : key === "sort" ? "created" : "x"));
      expect(next.get("page"), key).toBeNull();
    }
  });

  test("сброс фильтра убирает параметр, а не пишет пустой; умолчание порядка из адреса уходит", () => {
    const now = url("role=admin&status=disabled&sort=created&page=2");
    expect(applyPatch(now, usersPatch("role", "")).toString()).toBe("status=disabled&sort=created");
    expect(applyPatch(now, usersPatch("sort", "name")).toString()).toBe("role=admin&status=disabled");
  });

  test("чужие параметры адреса правка отбора не трогает", () => {
    expect(applyPatch(url("tab=x&role=user"), usersPatch("status", "active")).toString()).toBe(
      "tab=x&role=user&status=active",
    );
  });
});

describe("окно «Новий обліковий запис»", () => {
  const filled = (over: Partial<AccountDraft["form"]> = {}): AccountDraft => {
    const s = newAccount("abcd-efgh-jkmn-pqrs");
    return accountStep(s, {
      type: "edit",
      patch: { lastName: "Коваль", firstName: "Ірина", email: "iryna@clinic.ua", ...over },
    });
  };

  test("пустые обязательные поля — не отправляются, но и не кричат, пока их не трогали", () => {
    const s = newAccount("p");
    expect(accountReady(s.form)).toBe(false);
    expect(accountProblems(s.form)).toEqual({});
    expect(accountStep(s, { type: "send" })).toBe(s);
  });

  test("имя из одних пробелов — пустое имя", () => {
    expect(accountReady(filled({ lastName: "   " }).form)).toBe(false);
  });

  test("почта с ошибкой называется у поля и не отправляется — по правилу сервера, а не своей регулярке", () => {
    /*
     * До правки проверка была `/\S+@\S+/`: «ivan@clinic» включало кнопку,
     * и сервер отвечал отказом схемы уже после нажатия.
     */
    for (const email of ["ivan@clinic", "ivan", "ivan@", "@clinic.ua", "iv an@clinic.ua"]) {
      const s = filled({ email });
      expect(accountProblems(s.form).email, email).toBe("uit.users.emailInvalid");
      expect(accountReady(s.form), email).toBe(false);
      expect(accountStep(s, { type: "send" }), email).toBe(s);
      // и сервер согласен, что это не почта
      expect(createUserSchema.shape.email.safeParse(email).success, email).toBe(false);
    }
    expect(accountProblems(filled({ email: " iryna@clinic.ua " }).form)).toEqual({});
  });

  test("тело запроса: без краевых пробелов, пустое отчество — null, пароль временный", () => {
    const s = filled({ lastName: " Коваль ", middleName: "  ", email: " iryna@clinic.ua " });
    expect(accountBody(s.form)).toEqual({
      lastName: "Коваль",
      firstName: "Ірина",
      middleName: null,
      email: "iryna@clinic.ua",
      password: "abcd-efgh-jkmn-pqrs",
      role: "admin",
      mustChangePassword: true,
    });
    expect(createUserSchema.safeParse(accountBody(s.form)).success).toBe(true);
  });

  test("пока идёт отправка, второй не будет", () => {
    const sending = accountStep(filled(), { type: "send" });
    expect(sending.busy).toBe(true);
    expect(accountStep(sending, { type: "send" })).toBe(sending);
  });

  test("отказ сервера показывается, снимается правкой поля и не мешает повторной отправке", () => {
    const failed = accountStep(accountStep(filled(), { type: "send" }), { type: "failed", message: "Пошта вже зайнята" });
    expect(failed).toMatchObject({ busy: false, error: "Пошта вже зайнята" });

    /* до правки отказ висел над исправленной почтой до следующего нажатия */
    const fixed = accountStep(failed, { type: "edit", patch: { email: "iryna.k@clinic.ua" } });
    expect(fixed.error).toBeNull();

    /* повтор без правки тоже снимает прежний отказ на время отправки */
    const retry = accountStep(failed, { type: "send" });
    expect(retry).toMatchObject({ busy: true, error: null });
  });

  test("смена роли и нового пароля — тоже правка: отказ про прежние значения снимается", () => {
    const failed = accountStep(filled(), { type: "failed", message: "Суперадміна заводить лише суперадмін" });
    expect(accountStep(failed, { type: "edit", patch: { role: "admin" } }).error).toBeNull();
    expect(accountStep(failed, { type: "edit", patch: { password: "zzzz-zzzz-zzzz-zzzz" } }).error).toBeNull();
  });

  test("после заведения окно помнит почту и больше не отправляет", () => {
    const done = accountStep(accountStep(filled(), { type: "send" }), { type: "created", email: "iryna@clinic.ua" });
    expect(done).toMatchObject({ busy: false, created: "iryna@clinic.ua" });
    expect(accountStep(done, { type: "send" })).toBe(done);
  });
});

describe("разметка окна заведения", () => {
  const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
  const text = (key: UiKey) => {
    const e = UI[key] as { uk: string; ru: string };
    return [e.uk, e.ru];
  };
  const has = (html: string, key: UiKey) => text(key).some((t) => html.includes(t));
  const view = (state: AccountDraft) =>
    draw(
      <CreateAccountForm
        state={state}
        isSuper={false}
        onEvent={() => {}}
        onRegenerate={() => {}}
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );
  /* погашена ли кнопка отправки — по атрибуту, а не по классам (в них есть утилиты `disabled:`) */
  const submitOff = (html: string) => /\sdisabled=""/.test(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? "");

  const ready = accountStep(newAccount("abcd-efgh-jkmn-pqrs"), {
    type: "edit",
    patch: { lastName: "Коваль", firstName: "Ірина", email: "iryna@clinic.ua" },
  });

  test("готовая форма — кнопка активна; во время отправки — погашена", () => {
    expect(submitOff(view(ready))).toBe(false);
    expect(submitOff(view(accountStep(ready, { type: "send" })))).toBe(true);
  });

  test("почта с ошибкой — слова у поля и погашенная кнопка", () => {
    const html = view(accountStep(ready, { type: "edit", patch: { email: "iryna@clinic" } }));
    expect(has(html, "uit.users.emailInvalid")).toBe(true);
    expect(html).toContain('aria-invalid="true"');
    expect(submitOff(html)).toBe(true);
  });

  test("отказ сервера — строкой с role=alert; после правки его нет", () => {
    const failed = accountStep(ready, { type: "failed", message: "Пошта вже зайнята" });
    expect(view(failed)).toMatch(/role="alert"[^>]*>Пошта вже зайнята</);
    expect(view(accountStep(failed, { type: "edit", patch: { firstName: "Ірина" } }))).not.toContain("Пошта вже зайнята");
  });

  test("суперадмина в выборе нет у того, кто сам не суперадмин", () => {
    expect(view(ready)).not.toContain('value="superadmin"');
  });
});
