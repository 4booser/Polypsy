import { sql } from "drizzle-orm";
import { db } from "../db";
import { asSystem } from "../db/context";

/**
 * Ожидаемая от человека работа: сколько методик он должен сдать.
 *
 * Одно определение на все экраны, где нужна пометка «пришёл не со всем»
 * (приёмный день, список своих приёмов). Прежде счёт в routes/clinic.ts
 * складывал две выборки — строки survey_access и шаги назначений наборов, —
 * а назначение набора выдаёт доступ на каждый свой шаг, и один шаг считался
 * дважды. При этом любое завершённое прохождение методики исключало её из
 * обоих слагаемых — в том числе сданное за месяц до нового назначения,
 * которое это назначение не закрывает (внешний разбор, #39).
 *
 * Основания ожидать методику:
 *   — личная выдача (survey_access), действующая и выданная не набором:
 *     доступ, который выдало назначение набора, — это и есть его шаг, и
 *     считается там;
 *   — шаг открытого назначения набора (battery_assignment_items): не
 *     отменённого и не завершённого. Только обязательные: по ним назначение
 *     завершается, необязательный шаг человека не держит.
 *
 * Основание закрыто прохождением, сданным ПОСЛЕ его выдачи — так же, как
 * засчитывает шаги batteryProgress (lib/batteries.ts): точка отсчёта у
 * личной выдачи — granted_at (перевыдача сдвигает его), у шага — assigned_at.
 * Одна методика по двум основаниям — одна работа: человек сдаёт её один раз.
 *
 * Системной ролью: это счёт по людям, уже отобранным вызывающим, а не чтение
 * чужих назначений; под ролью приложения специалист видит назначения только
 * методик своих групп, и пометка молча теряла назначенное другой группой
 * (волна 13). Наружу уходит одно число на человека.
 */
export async function pendingWorkByUser(userIds: readonly string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await asSystem(() =>
    db.execute<{ user_id: string; n: number }>(sql`
      with expected as (
        select sa.user_id, sa.survey_id, sa.granted_at as since
        from survey_access sa
        where sa.user_id in ${userIds}
          and sa.via_assignment_id is null
          and (sa.expires_at is null or sa.expires_at > now())
        union
        select ba.user_id, bi.survey_id, ba.assigned_at
        from battery_assignments ba
        join battery_assignment_items bi on bi.assignment_id = ba.id
        where ba.user_id in ${userIds}
          and ba.cancelled_at is null
          and ba.completed_at is null
          and bi.required
      )
      select e.user_id, count(distinct e.survey_id)::int as n
      from expected e
      where not exists (
        select 1 from responses r
        where r.user_id = e.user_id and r.survey_id = e.survey_id
          and r.status = 'completed' and r.submitted_at >= e.since)
      group by e.user_id
    `),
  );
  return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
}
