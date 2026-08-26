import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { batteries, batteryAssignments, batteryItems, responses, surveys } from "../db/schema";
import { badRequest } from "./http";

/**
 * Закрытие назначений батареи после сдачи очередной методики.
 *
 * Отметка о завершении нужна отдельно от вычисляемого прогресса: по ней
 * работает частичный уникальный индекс (одно активное назначение на человека)
 * и по ней же считается, сколько батарей висит незакрытыми. Считать это каждый
 * раз заново означало бы, что «активность» назначения зависит от того, кто и
 * когда открыл экран.
 *
 * Вызывается после успешной сдачи; ошибки не пробрасываются — сданное
 * прохождение не должно откатываться из-за учёта батарей.
 */
export async function closeCompletedBatteries(userId: string | null, surveyId: string): Promise<void> {
  if (!userId) return;
  try {
    const active = await db
      .select({ assignment: batteryAssignments, strictOrder: batteries.strictOrder })
      .from(batteryAssignments)
      .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
      .where(
        and(
          eq(batteryAssignments.userId, userId),
          isNull(batteryAssignments.completedAt),
          isNull(batteryAssignments.cancelledAt),
        ),
      );
    if (!active.length) return;

    // сданная методика может входить в несколько батарей сразу
    const relevant = await db
      .select()
      .from(batteryItems)
      .where(
        and(
          inArray(batteryItems.batteryId, active.map((a) => a.assignment.batteryId)),
          eq(batteryItems.required, true),
        ),
      );

    const touched = active.filter((a) =>
      relevant.some((i) => i.batteryId === a.assignment.batteryId && i.surveyId === surveyId),
    );
    if (!touched.length) return;

    const done = await db
      .select({ surveyId: responses.surveyId, submittedAt: responses.submittedAt })
      .from(responses)
      .where(and(eq(responses.userId, userId), eq(responses.status, "completed")));

    const now = new Date().toISOString();
    for (const a of touched) {
      const required = relevant.filter((i) => i.batteryId === a.assignment.batteryId);
      // засчитываем только то, что сдано после назначения: старое прохождение
      // не закрывает новое назначение
      const complete = required.every((i) =>
        done.some((d) => d.surveyId === i.surveyId && d.submittedAt && d.submittedAt >= a.assignment.assignedAt),
      );
      if (!complete) continue;
      await db
        .update(batteryAssignments)
        .set({ completedAt: now })
        .where(eq(batteryAssignments.id, a.assignment.id));
    }
  } catch (error) {
    console.error("Не удалось обновить назначения батарей", error);
  }
}


/**
 * Проверка очерёдности перед сдачей.
 *
 * Порядок в батарее — не подсказка интерфейса: методики влияют друг на друга
 * через утомление и через настрой, заданный предыдущим опросником. Пока это
 * держалось только экраном, порядок обходился прямым запросом, и данные
 * выглядели корректными, будучи собранными не по протоколу.
 *
 * Проверяются только методики, которые обследуемый заполняет сам. Специалист
 * не ограничивается: у него бывают причины идти не по порядку, и он отвечает
 * за это осознанно.
 */
export async function assertBatteryOrder(
  userId: string | null,
  surveyId: string,
  filledBySelf: boolean,
): Promise<void> {
  if (!userId || !filledBySelf) return;

  const active = await db
    .select({ assignment: batteryAssignments, battery: batteries })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .where(
      and(
        eq(batteryAssignments.userId, userId),
        eq(batteries.strictOrder, true),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  if (!active.length) return;

  const items = await db
    .select({ item: batteryItems, administration: surveys.administration })
    .from(batteryItems)
    .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
    .where(inArray(batteryItems.batteryId, active.map((a) => a.battery.id)));

  const done = await db
    .select({ surveyId: responses.surveyId, submittedAt: responses.submittedAt })
    .from(responses)
    .where(and(eq(responses.userId, userId), eq(responses.status, "completed")));

  for (const { assignment, battery } of active) {
    const ordered = items
      .filter((i) => i.item.batteryId === battery.id)
      .sort((a, b) => a.item.position - b.item.position);
    const index = ordered.findIndex((i) => i.item.surveyId === surveyId);
    if (index <= 0) continue;

    const blocking = ordered.slice(0, index).find(
      (earlier) =>
        !done.some(
          (d) =>
            d.surveyId === earlier.item.surveyId &&
            d.submittedAt &&
            d.submittedAt >= assignment.assignedAt,
        ),
    );
    if (!blocking) continue;

    const [row] = await db
      .select({ title: surveys.title })
      .from(surveys)
      .where(eq(surveys.id, blocking.item.surveyId));
    const title =
      typeof row?.title === "string" ? row.title : ((row?.title as { ru?: string })?.ru ?? "предыдущая методика");
    badRequest(
      `В батарее «${battery.title}» задан строгий порядок: сначала нужно пройти «${title}»`,
    );
  }
}