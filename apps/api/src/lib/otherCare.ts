import { sql } from "drizzle-orm";
import type { ErrorKey } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { forbidden } from "./http";

/**
 * Ввести человека в свою зону можно, только если его не ведёт никто другой (#139).
 *
 * Запись на приём, выдача методики и выдача набора — штатные способы, которыми
 * новый человек попадает к сотруднику: каждый из них сам по себе основание
 * видеть человека (lib/scope.ts, accessiblePatientIds; политика
 * rls_admin_sees_patient). Запрещать их вне зоны целиком нельзя —
 * самозаписавшегося, которого ещё не видит никто, иначе некому было бы ни
 * записать, ни назначить. Но тот же путь открывал сотруднику чужого пациента
 * по одному идентификатору: запись к себе или выдача методики своей группы —
 * и карта с хронологией и заметками чужого автора открыта. Прежде запись
 * отказывала только прикреплённому к чужому отделению, а выдача методики и
 * набора не отказывала вовсе (первая лишь помечала журнал widenedOwnScope).
 *
 * «Ведёт кто-то другой» — те же основания, что у зоны видимости, увиденные
 * со стороны человека: прикрепление к отделению, приём у специалиста,
 * соприкосновение с группой методик (выдача, прохождение, набор). Сотрудник,
 * который его ещё не видит, ни одним из этих оснований не обладает — значит,
 * обладает кто-то другой.
 *
 * Системной ролью: под ролью приложения чужие прикрепления, приёмы и выдачи
 * сотруднику не видны — ровно потому, что человек чужой, — и проверка
 * ослепла бы, пропуская его как «ничьего». Наружу уходит одно основание, не
 * отделение, не специалист и не группа.
 */
export type OtherCare = "department" | "specialist" | "group";

export async function otherCareOf(patientId: string): Promise<OtherCare | null> {
  const [row] = await asSystem(() =>
    db.execute<{ department: boolean; specialist: boolean; grp: boolean }>(sql`
      select
        exists (select 1 from department_patients dp where dp.patient_id = ${patientId}) as department,
        exists (select 1 from appointments a where a.patient_id = ${patientId}) as specialist,
        (
          exists (select 1 from survey_access sa join surveys s on s.id = sa.survey_id
            where sa.user_id = ${patientId} and s.group_id is not null)
          or exists (select 1 from responses r join surveys s on s.id = r.survey_id
            where r.user_id = ${patientId} and s.group_id is not null)
          or exists (select 1 from battery_assignments ba join batteries b on b.id = ba.battery_id
            where ba.user_id = ${patientId} and b.group_id is not null)
        ) as grp
    `),
  );
  if (row?.department) return "department";
  if (row?.specialist) return "specialist";
  if (row?.grp) return "group";
  return null;
}

/**
 * Отказать, если человек вне зоны сотрудника и его уже ведёт кто-то другой.
 *
 * `seen` — зона сотрудника ДО действия (accessiblePatientIds; null —
 * суперадмин, ему ограничений нет). Посчитанная после, она уже включала бы
 * человека благодаря самому действию. Возвращает истину, если человек был
 * вне зоны и «ничей» — действие расширяет зону, и это пишется в журнал
 * пометкой widenedOwnScope.
 *
 * Отказ — 403, как и прежний отказ записи за прикреплённого к чужому
 * отделению: существование человека персоналу и так известно (политика
 * users_read открывает персоналу все строки users). `departmentRefusal` —
 * для записи на приём, у которой для чужого отделения своя фраза.
 */
export async function assertNotInOtherCare(
  seen: Set<string> | null,
  patientId: string,
  departmentRefusal: ErrorKey = "err.patientInOtherCare",
): Promise<boolean> {
  if (seen === null || seen.has(patientId)) return false;
  const elsewhere = await otherCareOf(patientId);
  if (elsewhere === "department") forbidden(departmentRefusal);
  if (elsewhere) forbidden("err.patientInOtherCare");
  return true;
}
