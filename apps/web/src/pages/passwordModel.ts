import type { UiKey } from "@quizzy/shared";

/**
 * Смена пароля без React: что мешает отправить и в каком порядке идут
 * запросы. Общая для двух экранов — «Змініть пароль» (временный пароль,
 * ForcePassword.tsx) и раздела «Пароль» учётной записи (Account.tsx).
 *
 * Проверяется без браузера: apps/web/test/passwordChange.test.tsx.
 */

/**
 * Граница changePasswordSchema (newPassword, min 10). Раньше её знал только
 * экран временного пароля; учётная запись просила «от 8» — и пароль в 8–9
 * знаков уходил на сервер, чтобы вернуться отказом схемы уже после нажатия.
 * Совпадение со схемой сервера держит тест.
 */
export const PASSWORD_MIN = 10;

export interface PasswordDraft {
  current: string;
  next: string;
  /** Повтор нового; у формы без повтора (учётная запись) — не задан */
  repeat?: string;
}

/**
 * Что не так с набранным — ключи словаря по полям.
 *
 * Говорит только о том, что уже набрано: пустое поле — не ошибка, форма
 * просто ещё не готова. «Совпадает с текущим» — отдельной строкой: раньше
 * экран временного пароля гасил кнопку, если новый пароль равен
 * временному, и молчал почему — человек видел верно набранные поля и
 * погашенную кнопку.
 */
export function passwordProblems(d: PasswordDraft): { next?: UiKey; repeat?: UiKey } {
  const out: { next?: UiKey; repeat?: UiKey } = {};
  if (d.next && d.next.length < PASSWORD_MIN) out.next = "ops.force.short";
  else if (d.next && d.current && d.next === d.current) out.next = "uit.password.same";
  if (d.repeat !== undefined && d.repeat && d.repeat !== d.next) out.repeat = "ops.force.mismatch";
  return out;
}

/** Можно ли отправлять: всё заполнено и ни одной ошибки */
export function passwordReady(d: PasswordDraft): boolean {
  const p = passwordProblems(d);
  return !!d.current && d.next.length >= PASSWORD_MIN && (d.repeat === undefined || d.repeat === d.next) && !p.next && !p.repeat;
}

/**
 * Смена пароля и вход заново — двумя шагами, и второй не повторяет первый.
 *
 * Сервер, сменив пароль, гасит все сессии, в том числе ту, из которой
 * меняли (routes/auth.ts, POST /password). Поэтому после смены экран сам
 * входит заново новым паролем. Раньше это была одна цепочка «сменить, потом
 * войти», и если вход не удался (обрыв, пятисотка), повторное нажатие
 * начинало её с начала: слало смену пароля со СТАРЫМ паролем, который
 * сервер уже не признаёт, — и человек читал «неверный текущий пароль» про
 * пароль, который только что сам поменял. Теперь принятый пароль
 * запоминается (`accepted`), и повтор только входит им.
 *
 * Учётная запись сотрудника (Account.tsx) раньше не входила заново вовсе:
 * показывала «Пароль змінено» — и первый же следующий запрос упирался в
 * погашенную сессию. Теперь там тот же путь.
 */
export interface PasswordCalls {
  change: (current: string, next: string) => Promise<unknown>;
  relogin: (password: string) => Promise<unknown>;
}

export async function changePassword(
  d: PasswordDraft,
  accepted: string | null,
  calls: PasswordCalls,
  onAccepted: (password: string) => void,
): Promise<void> {
  let password = accepted;
  if (password === null) {
    await calls.change(d.current, d.next);
    password = d.next;
    onAccepted(password);
  }
  await calls.relogin(password);
}
