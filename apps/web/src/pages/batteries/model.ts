import type { BatteryAssignment } from "@quizzy/shared";

/**
 * Назначение набора человеку — кого предлагать в строке «+ ПІБ».
 *
 * Сервер держит одно ОТКРЫТОЕ назначение набора на человека, но открытое и
 * просроченное для него — пропуск, а не «уже назначено»: такое он закрывает
 * с отметкой и выдаёт назначение заново (routes/batteries.ts, isOverdue и
 * closeMissed). Экран же исключал из предложений всех с открытым
 * назначением, просроченных тоже, — и единственный способ переназначить
 * пропустившего был недостижим: человек с красной строкой «прострочено»
 * в таблице выше просто не находился поиском.
 */

/** Кому набор уже назначен и назначать снова нельзя: открыто и срок не прошёл */
export function busyAssignees(rows: readonly Pick<BatteryAssignment, "userId" | "cancelledAt" | "completedAt" | "overdue">[]): Set<string> {
  return new Set(rows.filter((r) => !r.cancelledAt && !r.completedAt && !r.overdue).map((r) => r.userId));
}

/** Предложения поиска: не занятые, по вхождению в ФИО или почту, не больше `limit` */
export function assignCandidates<P extends { id: string; fullName: string; email: string }>(
  patients: readonly P[],
  rows: Parameters<typeof busyAssignees>[0],
  query: string,
  limit = 8,
): P[] {
  const busy = busyAssignees(rows);
  const q = query.trim().toLowerCase();
  return patients
    .filter((p) => !busy.has(p.id))
    .filter((p) => `${p.fullName} ${p.email}`.toLowerCase().includes(q))
    .slice(0, limit);
}

/**
 * Предложения из найденного сервером и признак «показаны не все» (#174).
 *
 * Список пациентов сервер отдаёт поиском с потолком в сто человек; прежде
 * экран брал первую сотню без поиска и искал в ней сам — сто первого найти
 * было нельзя, а «никого не найдено» выглядело как «его нет в зоне». Теперь
 * набранное уходит серверу, а здесь отсеиваются занятые и считается,
 * обрезано ли что-то: сервером (truncated) или строкой предложений (limit).
 */
export function assignChoices<P extends { id: string; fullName: string; email: string }>(
  found: { items: readonly P[]; truncated: boolean },
  rows: Parameters<typeof busyAssignees>[0],
  query: string,
  limit = 8,
): { list: P[]; cut: boolean } {
  const all = assignCandidates(found.items, rows, query, found.items.length);
  return { list: all.slice(0, limit), cut: found.truncated || all.length > limit };
}
