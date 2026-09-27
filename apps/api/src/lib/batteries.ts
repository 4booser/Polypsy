import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { serverText, t, type Lang } from "@quizzy/shared";
import type { db as Db } from "../db";
import { db } from "../db";
import { batteries, batteryAssignments, batteryItems, responses, surveys } from "../db/schema";
import { badRequest } from "./http";
import { log } from "./log";
import { parseTs } from "./time";

/*
 * ─── пропуск: одно правило на три пути выдачи ───
 *
 * Назначение набора выдаётся тремя путями: расписанием (lib/scheduler.ts),
 * руками (routes/batteries.ts) и каскадом по результату скрининга
 * (lib/cascade.ts). Уникальный индекс держит одно активное назначение набора
 * на человека, и каждый путь решал сам, что делать, если такое уже висит.
 *
 * Расписание и ручное назначение в волне 12 договорились: открытое с
 * вышедшим сроком — не «занято», а пропуск. Оно закрывается с отметкой в
 * примечании (cancelledAt + «пропущено: …» — не молча, см. схему), и
 * выдаётся новое. Каскад остался на прежнем «незакрытое — значит занято»:
 * человек, не прошедший углублённый набор в срок, больше не получал его ни
 * при каком результате скрининга — тяжёлый повторный скрининг через месяц
 * молча ничего не назначал (внешний разбор, хвосты волны 12).
 *
 * Правило теперь записано здесь один раз, и все три пути зовут его.
 */

/** Открытое назначение с вышедшим сроком — пропуск. Без срока просрочки не бывает */
export function isOverdue(assignment: { dueAt: string | null }, now: Date): boolean {
  return assignment.dueAt !== null && parseTs(assignment.dueAt) < now.getTime();
}

/**
 * Закрыть пропущенные назначения — с отметкой, почему.
 *
 * Отметка дописывается к прежнему примечанию, а не заменяет его: «Каскад по
 * результату скрининга · пропущено: …» говорит и откуда назначение взялось,
 * и чем кончилось. Зовётся в той же транзакции, что и выдача нового:
 * уникальный индекс не пустит новое, пока старое открыто.
 *
 * `missed` — готовая пометка-код (noteCode, note.missed.*): у каждого пути
 * своя причина, а фразой её сделает показ, на языке смотрящего.
 */
export async function closeMissed(
  tx: Pick<typeof Db, "update">,
  ids: readonly string[],
  missed: string,
  now: Date,
): Promise<void> {
  if (!ids.length) return;
  await tx
    .update(batteryAssignments)
    .set({
      cancelledAt: now.toISOString(),
      note: sql`concat_ws(' · ', ${batteryAssignments.note}, ${missed}::text)`,
    })
    .where(inArray(batteryAssignments.id, [...ids]));
}

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
    log.error("battery.assignments_update_failed", { error: String(error) });
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
 *
 * `lang` — язык содержимого, на котором человек видит методики: на нём и
 * название той, что надо пройти раньше. Прежде название бралось русским
 * всегда, и украинский экран отказывал словами «сначала пройдите …» с
 * русским названием методики, которую человек только что видел по-украински.
 */
export async function assertBatteryOrder(
  userId: string | null,
  surveyId: string,
  filledBySelf: boolean,
  lang: Lang = "uk",
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
    // Очерёдность касается только самоотчёта: методика клинициста — не часть
    // последовательности респондента (утомление и прайминг между опросниками —
    // причина строгого порядка — к интервью специалиста не относятся), и
    // непройденное интервью не должно запирать поток — ни в киоске, ни в мобилке
    const ordered = items
      .filter((i) => i.item.batteryId === battery.id && i.administration === "self")
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
    // названия нет (строки не нашлось) — запасное слово на том же языке, что и название, которое оно заменяет
    const title = row ? t(row.title as never, lang) : serverText("battery.previousSurvey", lang);
    badRequest("err.batteryStrictOrder", { battery: battery.title, title });
  }
}