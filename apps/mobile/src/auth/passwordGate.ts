/**
 * Временный пароль — сначала свой, потом всё остальное.
 *
 * Пароль, выданный администратором при заведении или сбросе, видел тот, кто
 * его выдал. Сервер (участок auth) теперь отвечает на всё, кроме
 * `GET /api/auth/me`, смены пароля, рабочего места и выхода, отказом
 * 403 `{ code: "password_change_required" }`. В мобилке шага смены не было:
 * пациент с временным паролем упирался бы в отказ на каждом экране и не
 * понимал бы, почему.
 *
 * Сюда ведут два пути: признак `mustChangePassword` у вошедшего (после входа,
 * регистрации, восстановления сессии) и этот код из любого запроса — если
 * пароль сбросили, пока приложение было открыто. Выход с экрана смены есть
 * всегда: выйти из учётной записи — не ловушка, а запасной путь.
 *
 * Без react-native — проверяется тестом.
 */

/*
 * TODO(w12:auth): заменить на PASSWORD_CHANGE_CODE из packages/shared/src/types.ts,
 * когда участок auth будет слит, — строка должна совпадать с серверной.
 */
export const PASSWORD_CHANGE_CODE = "password_change_required";

/** Отказ сервера значит «сначала смените пароль», а не «нельзя вообще» */
export function isPasswordChangeRequired(status: number, body: unknown): boolean {
  return status === 403 && (body as { code?: unknown } | null)?.code === PASSWORD_CHANGE_CODE;
}

/** То же по уже брошенной ошибке клиента (ApiError несёт code) */
export function isPasswordGate(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  return e?.status === 403 && e.code === PASSWORD_CHANGE_CODE;
}

/**
 * Куда после входа. Смена пароля — раньше согласия: с временным паролем
 * сервер не отдаст и текст согласия.
 */
export function routeAfterSignIn(user: { mustChangePassword?: boolean } | null): "/password" | "/consent" | "/login" {
  if (!user) return "/login";
  return user.mustChangePassword ? "/password" : "/consent";
}

/** Граница changePasswordSchema: короче сервер отвергнет уже после нажатия */
export const MIN_PASSWORD = 10;

export function passwordForm(input: { current: string; next: string; repeat: string }) {
  const tooShort = input.next.length > 0 && input.next.length < MIN_PASSWORD;
  const mismatch = input.repeat.length > 0 && input.repeat !== input.next;
  // тот же пароль сервер отвергнет (err.samePassword) — кнопка не обещает того, что не выйдет
  const same = input.next.length > 0 && input.next === input.current;
  const ready = input.current.length > 0 && input.next.length >= MIN_PASSWORD && input.next === input.repeat && !same;
  return { tooShort, mismatch, same, ready };
}

/**
 * Действия на экране смены — «змінити» и «вийти». Выход есть в любом
 * состоянии, в том числе пока идёт смена: экран без выхода — та же ловушка,
 * что была у согласия.
 */
export function passwordActions(state: { ready: boolean; busy: boolean }): { change: boolean; signOut: true } {
  return { change: state.ready && !state.busy, signOut: true };
}
