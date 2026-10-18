import { type SessionAgeBucket, type UiKey, opsSessionQuery } from "@quizzy/shared";
import { pageFrom, perFrom } from "../../ui/paging";

/**
 * «Сесії» техпанели без React: отбор из адреса, что из него уходит на
 * сервер, и что писать на месте пустого списка (w14:webtails).
 *
 * Отдельный модуль по той же причине, что usersModel.ts: человек из адреса
 * проверяется схемой сервера (zod), а ей не место в начальном куске консоли
 * (test/bundle.test.ts). Вкладка грузится по требованию, схема — с ней.
 *
 * Проверяется без браузера: apps/web/test/opsSessions.test.tsx.
 */

/*
 * Сервер проверяет отбор строго (opsSessionQuery): человек — только
 * идентификатором, поиск — до 120 знаков, страница — до ста тысяч. Прежде
 * вкладка отдавала адрес как есть, и «?user=Коваль» (человек вписал имя
 * вместо идентификатора), «?page=999999» из закладки или вставленный в
 * поиск абзац давали отказ «Невірний запит» на месте всего списка — с
 * «повторити», которое повторяло тот же отказ. Так же, как у
 * «Користувачів» (usersModel.ts): адрес — пожелание, незнакомое в нём значит
 * «условия нет», а не отказ экрана.
 */

/** Предел поиска у сервера: длиннее — отказ, а не «ничего не нашлось» */
export const SESSIONS_SEARCH_MAX = 120;
/** Предел номера страницы у сервера */
export const SESSIONS_PAGE_MAX = 100_000;

export interface SessionsFilters {
  /** Поиск как набран: поле показывает его целиком, на сервер уходит обрезанный */
  q: string;
  /** Человек из адреса (меню строки «Користувачів»); незнакомое — пусто */
  userId: string;
  /** Роль владельца: роль учётки или «staff» — весь персонал; незнакомое — пусто */
  role: "" | "superadmin" | "admin" | "user" | "staff";
  /** Возраст сессии от входа — корзины сводки; незнакомое — пусто */
  age: "" | SessionAgeBucket;
  page: number;
  per: number;
}

/** Идентификатор человека — тем же правилом, что у сервера */
const userIdRule = opsSessionQuery.shape.userId;
const roleRule = opsSessionQuery.shape.role;
const ageRule = opsSessionQuery.shape.age;

/** Значение из закрытого списка схемы сервера или «условия нет» */
function closed<T extends string>(rule: { safeParse: (v: unknown) => { success: boolean } }, raw: string | null): T | "" {
  return raw && rule.safeParse(raw).success ? (raw as T) : "";
}

export function readSessionsFilters(params: URLSearchParams): SessionsFilters {
  const userId = params.get("user") ?? "";
  return {
    q: params.get("q") ?? "",
    userId: userId && userIdRule.safeParse(userId).success ? userId : "",
    role: closed<SessionsFilters["role"] & string>(roleRule, params.get("role")),
    age: closed<SessionAgeBucket>(ageRule, params.get("age")),
    page: Math.min(pageFrom(params.get("page")), SESSIONS_PAGE_MAX),
    per: perFrom(params.get("per")),
  };
}

/**
 * Параметры GET /api/ops/sessions. `q` — отдельно: экран шлёт поиск,
 * переставший меняться (useDebounced), а не каждую букву.
 */
export function sessionsQuery(f: SessionsFilters, q: string = f.q): Record<string, string | undefined> {
  return {
    q: q.trim().slice(0, SESSIONS_SEARCH_MAX).trim() || undefined,
    userId: f.userId || undefined,
    role: f.role || undefined,
    age: f.age || undefined,
    page: String(f.page),
    per: String(f.per),
  };
}

/**
 * Что писать, когда сервер ответил пустым списком.
 *
 * «Активних сесій немає» — утверждение обо всей системе. На поиске, не
 * нашедшем никого, оно неправда: сессии есть, не нашлось подходящих, — и
 * администратор, проверявший «не вошёл ли кто под этой почтой», читал
 * «сессий нет вообще». По одному человеку — про него: у него сессий нет.
 */
export function sessionsEmptyKey(f: Pick<SessionsFilters, "q" | "userId"> & Partial<Pick<SessionsFilters, "role" | "age">>): UiKey {
  if (f.q.trim()) return "wt.sess.noneFound";
  if (f.role || f.age) return "oppa.noneFiltered";
  if (f.userId) return "wt.sess.noneOfUser";
  return "ops.sessions.none";
}
