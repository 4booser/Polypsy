import type { OpsUserRow, Role, UiKey } from "@quizzy/shared";
import { accountRefusal, accountStanding, createUserSchema } from "@quizzy/shared";
import { pageFrom, perFrom } from "../../ui/paging";
import { patchParams } from "../../ui/viewParams";

/**
 * «Користувачі» техпанели без React: отбор из адреса, что из него уходит на
 * сервер, и форма заведения учётки.
 *
 * Отдельный модуль, а не ops/model.ts: тот стоит в начальном куске консоли
 * (App.tsx берёт из него canOpenOps), а форма проверяет почту схемой сервера
 * — это zod, которому в начальном куске не место (test/bundle.test.ts).
 * Экран «Користувачі» грузится по требованию, и схема едет вместе с ним.
 *
 * Проверяется без браузера: apps/web/test/opsUsersFilters.test.tsx.
 */

/* ─────────── отбор из адреса ─────────── */

/*
 * Допустимые значения — ровно те, что принимает GET /api/ops/users
 * (opsUserListQuery). Сервер закрытые списки проверяет строго, и это
 * правильно: «?status=disabld» должно давать отказ, а не весь реестр. Но
 * отказ сервера — это отказ ЭКРАНА: ссылка из старой закладки, переписанная
 * руками или обрезанная мессенджером, открывала вместо списка «Невірний
 * запит» с кнопкой «повторити», которая повторяла тот же отказ. Адрес — не
 * запрос, а пожелание: незнакомое значение в нём значит «фильтра нет», и
 * поле фильтра показывает «усі», а не пустоту. Совпадение списков со схемой
 * сервера держит тест.
 */
export const USER_ROLES: readonly Role[] = ["superadmin", "admin", "user"];
export const USER_STATES = ["active", "disabled"] as const;
export type UserState = (typeof USER_STATES)[number];
export const USER_SORTS = ["name", "created", "lastSeen", "role"] as const;
export type UserSort = (typeof USER_SORTS)[number];

/** Предел поиска у сервера (opsUserListQuery, q ≤ 120): длиннее — отказ, а не «ничего не нашлось» */
export const USERS_SEARCH_MAX = 120;
/** Предел номера страницы у сервера (page ≤ 100 000) */
export const USERS_PAGE_MAX = 100_000;

export interface UsersFilters {
  /** Поиск как набран: поле показывает его целиком, на сервер уходит обрезанный (usersQuery) */
  q: string;
  role: Role | "";
  status: UserState | "";
  sort: UserSort;
  page: number;
  per: number;
}

const oneOf = <T extends string>(list: readonly T[], raw: string | null): T | "" =>
  raw && (list as readonly string[]).includes(raw) ? (raw as T) : "";

/** Отбор из адреса: всё незнакомое — умолчание, а не отказ сервера */
export function readUsersFilters(params: URLSearchParams): UsersFilters {
  return {
    q: params.get("q") ?? "",
    role: oneOf(USER_ROLES, params.get("role")),
    status: oneOf(USER_STATES, params.get("status")),
    sort: oneOf(USER_SORTS, params.get("sort")) || "name",
    page: Math.min(pageFrom(params.get("page")), USERS_PAGE_MAX),
    per: perFrom(params.get("per")),
  };
}

/** Поиск для сервера: без краевых пробелов и не длиннее предела */
function searchText(q: string): string {
  return q.trim().slice(0, USERS_SEARCH_MAX);
}

/**
 * Параметры GET /api/ops/users. `q` — отдельно: экран шлёт поиск, переставший
 * меняться (useDebounced), а не каждую букву, остальное — сразу.
 */
export function usersQuery(f: UsersFilters, q: string = f.q): Record<string, string | undefined> {
  return {
    q: searchText(q) || undefined,
    role: f.role || undefined,
    status: f.status || undefined,
    sort: f.sort,
    page: String(f.page),
    per: String(f.per),
  };
}

/**
 * «Вибрати всіх у відборі» — тот же отбор без порядка и страницы: выбор
 * обязан совпасть со списком строка в строку (сервер отбирает одной
 * функцией, matchRegistry), и кривое значение, отброшенное для списка, не
 * должно доехать до выбора.
 */
export function usersIdsQuery(f: UsersFilters, q: string = f.q): Record<string, string | undefined> {
  return { q: searchText(q) || undefined, role: f.role || undefined, status: f.status || undefined };
}

export type UsersFilterKey = "q" | "role" | "status" | "sort" | "per";

/**
 * Правка адреса от поля отбора.
 *
 * Любая смена отбора возвращает на первую страницу: третья страница другого
 * отбора — не место в списке, а случайное число, и чаще всего — «нікого не
 * знайдено» при живых совпадениях на первой. Умолчания (порядок «за ім’ям»,
 * «усі ролі») из адреса убираются: ссылка без лишнего — та же ссылка, и
 * сохранённая закладка не расходится с только что открытым экраном.
 */
export function usersPatch(key: UsersFilterKey, value: string): Record<string, string | null> {
  const clean = key === "sort" && value === "name" ? "" : value;
  return { [key]: clean || null, page: null };
}

/**
 * Правка адреса целиком: пустое значение снимает параметр, прочие параметры
 * остаются. Правило одно на все экраны со списками — ui/viewParams.ts
 * (patchParams); здесь имя, под которым его знает экран «Користувачі».
 */
export function applyPatch(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  return patchParams(prev, patch);
}

/* ─────────── форма «Новий обліковий запис» ─────────── */

export interface AccountForm {
  lastName: string;
  firstName: string;
  middleName: string;
  email: string;
  role: Role;
  /** Временный пароль: генерирует экран, показывает до и один раз после заведения */
  password: string;
}

/*
 * Почта проверяется схемой сервера (createUserSchema), а не своей регуляркой.
 * Здесь стояло `/\S+@\S+/`: «ivan@clinic» кнопку включало, а сервер отвечал
 * отказом схемы — после нажатия и строкой разработчика. Два правила об одном
 * и том же расходятся всегда; одно — не может.
 */
const emailRule = createUserSchema.shape.email;

export function accountEmailOk(email: string): boolean {
  return emailRule.safeParse(email.trim()).success;
}

/**
 * Что мешает завести учётку — ключи словаря по полям.
 *
 * Пустые обязательные поля — не ошибка, пока человек их не трогал: форма
 * только что открылась, и красное «обов’язково» под каждым полем читалось
 * бы упрёком. Их кнопка просто ждёт (accountReady). А вот почта, набранная
 * с ошибкой, называется сразу: иначе погашенная кнопка — загадка, «чого їй
 * бракує», и человек перепечатывает имя, которое набрано верно.
 */
export function accountProblems(form: AccountForm): { email?: UiKey } {
  const email = form.email.trim();
  return email && !accountEmailOk(email) ? { email: "uit.users.emailInvalid" } : {};
}

/** Можно ли отправлять: обязательные поля заполнены, почта годная */
export function accountReady(form: AccountForm): boolean {
  return !!form.lastName.trim() && !!form.firstName.trim() && accountEmailOk(form.email);
}

/** Тело POST /api/users: без краевых пробелов, пустое отчество — null, пароль — временный */
export function accountBody(form: AccountForm) {
  return {
    lastName: form.lastName.trim(),
    firstName: form.firstName.trim(),
    middleName: form.middleName.trim() || null,
    email: form.email.trim(),
    password: form.password,
    role: form.role,
    mustChangePassword: true,
  };
}

/**
 * Окно заведения целиком: поля, отправка, ответ сервера.
 *
 * Шагами, а не четырьмя useState, ради двух правил, которые иначе живут в
 * обработчиках и проверяются только руками:
 *
 *  - отказ сервера относится к тому, что было отправлено. Поправил человек
 *    поле (или роль, или пароль) — отказ больше не про то, что на экране:
 *    «пошта вже зайнята» над исправленной почтой читается как отказ и
 *    новой. Здесь стояло «сбросить при следующей отправке», и отказ висел
 *    над исправленным до нажатия;
 *  - отправка не начинается, пока идёт предыдущая или форма не готова:
 *    шаг «send» тогда возвращает то же состояние, и экран по этому знает,
 *    что запроса не будет. Enter в поле жмёт не кнопку, и погашенная кнопка
 *    сама второй отправки не остановит.
 */
export interface AccountDraft {
  form: AccountForm;
  busy: boolean;
  error: string | null;
  /** Почта заведённой учётки: окно показывает «створено» и пароль в последний раз */
  created: string | null;
}

export type AccountEvent =
  | { type: "edit"; patch: Partial<AccountForm> }
  | { type: "send" }
  | { type: "failed"; message: string }
  | { type: "created"; email: string };

export function newAccount(password: string, role: Role = "admin"): AccountDraft {
  return {
    form: { lastName: "", firstName: "", middleName: "", email: "", role, password },
    busy: false,
    error: null,
    created: null,
  };
}

export function accountStep(s: AccountDraft, e: AccountEvent): AccountDraft {
  switch (e.type) {
    case "edit":
      return { ...s, form: { ...s.form, ...e.patch }, error: null };
    case "send":
      return s.busy || s.created || !accountReady(s.form) ? s : { ...s, busy: true, error: null };
    case "failed":
      return { ...s, busy: false, error: e.message };
    case "created":
      return { ...s, busy: false, error: null, created: e.email };
  }
}

/* ─────────── меню строки: чьи учётки трогать ─────────── */

/**
 * Учётка вне досягаемости смотрящего: на его ступени или выше.
 *
 * Правило сервера (packages/shared, accountRefusal): действовать над чужой
 * учёткой можно только строго ниже своего положения, над суперадмином — лишь
 * суперадмину; иначе 403 err.accountAtOrAboveYours (или err.superadminOnly).
 * Меню строки таких действий не показывает вовсе (w19:ui): погашенный пункт
 * с подсказкой «лише вище за посадою» на каждой строке коллег и начальства
 * — это половина меню, которая ничего не обещает, а заведующему среди
 * восьми погашенных пунктов не найти двух, которые ему доступны.
 *
 * Своя строка — не здесь: «над собой» — другая причина отказа, и пункты на
 * ней остаются погашенными с объяснением, как были. Суперадмину вне
 * досягаемости только он сам — и это тоже «над собой».
 */
export function accountOutOfReach(
  me: { id: string; role: Role; ladderRank?: number | null } | null | undefined,
  row: Pick<OpsUserRow, "id" | "role" | "ladderRank">,
): boolean {
  if (!me) return false;
  const refusal = accountRefusal(
    { id: me.id, role: me.role, standing: accountStanding(me.role, me.ladderRank ?? 0) },
    { id: row.id, role: row.role, standing: accountStanding(row.role, row.ladderRank) },
  );
  return refusal === "aboveYours" || refusal === "superadminOnly";
}
