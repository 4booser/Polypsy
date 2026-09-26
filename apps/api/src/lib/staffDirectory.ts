import { eq, inArray } from "drizzle-orm";
import { t, type Lang, type StaffPlacement } from "@quizzy/shared";
import { db } from "../db";
import { departments, specialistProfiles } from "../db/schema";

/**
 * Справочник сотрудников — то, что раздел «Лікарі» добавляет к строке учётной
 * записи. Общее у двух маршрутов, которые его отдают (GET /api/users и
 * GET /api/permissions/staff, оба с `?directory=1`): правило «откуда берётся
 * відділення» записано один раз, иначе оно разошлось бы между суперадмином и
 * заведующим, и один и тот же человек стоял бы у них в разных группах.
 *
 * Відділення — из профиля приёма (specialist_profiles → departments), а не из
 * users.unit. У сотрудника users.unit — поле анкеты, карточка подписывает его
 * «Організація» (учреждение = экземпляр системы), и набрано оно от руки; а
 * отделение профиля выбрано из справочника, то есть у двух людей одного
 * отделения оно пишется одинаково и группа не рассыпается на «Психологічне
 * відділення» и «психол. відділення». Анкетное поле остаётся запасным — его
 * подставляет экран (apps/web/src/pages/people/model.ts, workplaceOf), когда
 * профиля нет: так учреждение, не ведущее расписание приёма, не получает
 * список, где все «без відділення».
 */
export async function placementsOf(ids: string[], lang: Lang): Promise<Map<string, StaffPlacement>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: specialistProfiles.userId, position: specialistProfiles.position, title: departments.title })
    .from(specialistProfiles)
    .innerJoin(departments, eq(departments.id, specialistProfiles.departmentId))
    .where(inArray(specialistProfiles.userId, ids));
  return new Map(
    rows.map((r) => [
      r.userId,
      /* пустая посада — не посада: «Психолог» и «» не должны стать двумя группами */
      { department: t(r.title as never, lang), position: r.position?.trim() || null },
    ]),
  );
}
