import { accountRefusal, accountStanding, type AccountRefusal, type AccountSide, type User } from "@quizzy/shared";

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

/*
 * Положение учётной записи и «кто над кем» живут в общем пакете
 * (packages/shared/src/permissions.ts: accountStanding, accountRefusal) с
 * волны 19: тем же правилом меню «Користувачів» решает, каких действий не
 * показывать. Здесь — прежние имена для маршрутов и чистых проверок пачек.
 */
export { accountRefusal, type AccountRefusal, type AccountSide };

/** Положение учётной записи (packages/shared, accountStanding) — прежним именем */
export const standingFromRank: (role: AccountClass, ladderRank: number) => number = accountStanding;

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
