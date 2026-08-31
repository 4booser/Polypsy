import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  appointments,
  batteryAssignments,
  batteryItems,
  departments,
  slots,
  surveyAccess,
} from "../db/schema";

/**
 * Откуда взялось прохождение.
 *
 * Выводится сервером, а не приходит с клиентом. Клиент мог бы объявить своё
 * прохождение назначенным — и «самообращение», которое само по себе сведение
 * о человеке, растворилось бы среди плановых замеров. Источник — это факт об
 * обстоятельствах, а не поле формы.
 *
 * Порядок проверок — от более определённого к менее: заполнил специалист →
 * скрининг при записи → назначено → пришёл сам.
 */
export async function responseSource(
  userId: string,
  surveyId: string,
  onBehalfOf: string | null,
): Promise<"clinician" | "intake" | "assigned" | "self"> {
  if (onBehalfOf) return "clinician";

  /*
   * Скрининг при записи: методика отделения, куда человек записан на
   * ближайший первичный приём. Проверяется по будущему приёму, а не по
   * прикреплению: прикрепление остаётся навсегда, и через год та же методика
   * снова считалась бы скринингом при записи.
   */
  const [intake] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(departments, eq(departments.id, slots.departmentId))
    .where(
      and(
        eq(appointments.patientId, userId),
        eq(appointments.kind, "primary"),
        inArray(appointments.status, ["booked", "confirmed"]),
        eq(departments.screeningSurveyId, surveyId),
        gt(slots.startsAt, sql`now()`),
      ),
    )
    .limit(1);
  if (intake) return "intake";

  const [granted] = await db
    .select({ userId: surveyAccess.userId })
    .from(surveyAccess)
    .where(
      and(
        eq(surveyAccess.userId, userId),
        eq(surveyAccess.surveyId, surveyId),
        or(isNull(surveyAccess.expiresAt), gt(surveyAccess.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  if (granted) return "assigned";

  const [inBattery] = await db
    .select({ id: batteryAssignments.id })
    .from(batteryAssignments)
    .innerJoin(batteryItems, eq(batteryItems.batteryId, batteryAssignments.batteryId))
    .where(
      and(
        eq(batteryAssignments.userId, userId),
        eq(batteryItems.surveyId, surveyId),
        isNull(batteryAssignments.cancelledAt),
      ),
    )
    .limit(1);
  if (inBattery) return "assigned";

  return "self";
}
