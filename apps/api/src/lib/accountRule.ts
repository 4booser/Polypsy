import { SUPERADMIN_RANK, type User } from "@quizzy/shared";

/**
 * Кто над чьей учётной записью вправе действовать — правило без базы.
 *
 * Одно на все действия над чужой учёткой: смена класса и «только чтения»,
 * сброс пароля, выключение и включение, удаление, обрыв сессий, сброс
 * второго фактора, вход «от имени», личные исключения прав, профиль приёма,
 * массовые действия техпанели и импорт (внешний разбор 2026-09-27, п. 1;
 * решение заказчика 2026-09-28: сброс пароля главному врачу заведующим —
 * тот же захват учётки выше себя, что и выдача себе суперадмина).
 *
 * Здесь — только расчёт, чтобы им пользовались и маршруты (через
 * lib/accountClass.ts, где к нему добавлены право, замок строки и журнал), и
 * чистые проверки пачек (lib/people.ts, bulkSkip), которые проверяются
 * тестом строка за строкой без базы.
 */

export type AccountClass = User["role"];

/**
 * Положение учётной записи — одна шкала для класса и лестницы должностей.
 *
 * Пациент 0; сотрудник 1 + ступень лестницы (вне лестницы — 1); суперадмин
 * выше всех. Ступень считается и у пациента, у которого должность осталась с
 * прежней службы: вернуть его в сотрудники — значит вернуть и должность.
 */
export function standingFromRank(role: AccountClass, ladderRank: number): number {
  if (role === "superadmin") return SUPERADMIN_RANK + 1;
  if (role === "user") return 0;
  return 1 + ladderRank;
}

export interface AccountSide {
  id: string;
  role: AccountClass;
  standing: number;
}

/**
 * Почему нельзя действовать над этой учёткой — или null.
 *
 *  - self: над собой — нет. Своё меняют своими маршрутами (смена пароля с
 *    текущим, выключение второго фактора кодом, выход): обходить их через
 *    действие «над чужой учёткой» значит, что угнанной сессии хватает, чтобы
 *    забрать учётку насовсем;
 *  - superadminOnly: над суперадмином действует только суперадмин;
 *  - aboveYours: цель — строго ниже своего положения. Равный не трогает
 *    равного, как на лестнице: заведующий, сбросивший пароль главному врачу,
 *    входит главным врачом.
 *
 * Суперадмин стоит над всеми и действует над кем угодно, кроме себя.
 */
export type AccountRefusal = "self" | "superadminOnly" | "aboveYours";

export function accountRefusal(actor: AccountSide, target: AccountSide): AccountRefusal | null {
  if (actor.id === target.id) return "self";
  if (actor.role === "superadmin") return null;
  if (target.role === "superadmin") return "superadminOnly";
  if (target.standing >= actor.standing) return "aboveYours";
  return null;
}

/**
 * Можно ли завести учётку (или выдать учётке) этот класс: только ниже своего
 * положения. `targetRank` — ступень лестницы, которая окажется у учётки
 * (у новой — 0).
 */
export function classGrantRefusal(
  actor: Pick<AccountSide, "role" | "standing">,
  next: AccountClass,
  targetRank = 0,
): "superadminOnly" | "roleAboveYours" | null {
  if (actor.role === "superadmin") return null;
  if (next === "superadmin") return "superadminOnly";
  return standingFromRank(next, targetRank) >= actor.standing ? "roleAboveYours" : null;
}
