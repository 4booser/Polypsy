import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { serverText, t, type BatteryProgressState, type Lang } from "@quizzy/shared";
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


/*
 * ─── исполнимые обязательные шаги: один расчёт на экран, допуск и завершение ───
 *
 * Прогресс по назначению считали три места, и каждое по-своему: экран
 * (routes/batteries.ts) — все шаги по порядку, допуск к сдаче
 * (assertBatteryOrder) — все предшествующие шаги самоотчёта, завершение
 * (closeCompletedBatteries) — обязательные. Ни одно не смотрело, можно ли
 * методику шага вообще пройти. Итог (внешний разбор 2026-09-28, P2): набор
 * [необязательный A, обязательный B] в строгом порядке не пускал к B, пока
 * не пройден A; снятая с использования A — пройти её нельзя — запирала B
 * навсегда, а назначение с ней не завершалось никогда.
 *
 * Теперь расчёт один — batteryProgress, — и все три зовут его:
 *   — шаг, методику которого пройти нельзя (снята с использования или не
 *     опубликована, isExecutable), — «знято» (retired): не запирает
 *     следующие и не входит в обязательные. Пройденный до снятия остаётся
 *     пройденным и засчитывается;
 *   — в строгом порядке следующие шаги запирает только непройденный
 *     ОБЯЗАТЕЛЬНЫЙ исполнимый шаг самоотчёта. Необязательный открыт, когда до
 *     него дошли, и никого не держит;
 *   — очерёдность — только у самоотчёта: методику заполняет специалист или
 *     информант — это параллельная дорожка, не часть последовательности
 *     обследуемого (утомление и настрой между опросниками — причина строгого
 *     порядка — к ней не относятся). Экран прежде ставил в очередь и
 *     информанта, допуск — нет; теперь оба — нет;
 *   — назначение завершено, когда пройдены все исполнимые обязательные шаги
 *     (и хотя бы один такой есть: набор без обязательных сам не закрывается —
 *     как и прежде).
 */

/**
 * Можно ли методику сейчас пройти: опубликована и не снята с использования.
 * Ровно те два условия, которыми сдача отказывает (routes/responses.ts:
 * status !== "published", archivedAt).
 */
export function isExecutable(survey: { status: string; archivedAt: string | null }): boolean {
  return survey.status === "published" && survey.archivedAt === null;
}

/** Шаг набора для расчёта: методика, место, обязательность, кто заполняет, можно ли пройти */
export interface StepInput {
  surveyId: string;
  position: number;
  required: boolean;
  administration: string;
  executable: boolean;
}

/** Завершённое прохождение человека */
export interface Completion {
  surveyId: string;
  responseId: string;
  submittedAt: string;
}

export interface BatteryProgress<T extends StepInput> {
  steps: (T & { state: BatteryProgressState; responseId: string | null; submittedAt: string | null })[];
  /** Пройденные обязательные: исполнимые и пройденные до снятия */
  doneRequired: number;
  /** Обязательные, которые можно пройти или уже пройдены */
  totalRequired: number;
  complete: boolean;
}

/**
 * Прогресс по назначению — чистая функция, одна на экран, допуск и завершение.
 *
 * Засчитываются только прохождения, завершённые после назначения: старое
 * обследование той же методикой не закрывает новое назначение, иначе
 * повторный замер закрывался бы сам собой в момент выдачи.
 */
export function batteryProgress<T extends StepInput>(
  items: readonly T[],
  strictOrder: boolean,
  assignedAt: string,
  completions: readonly Completion[],
): BatteryProgress<T> {
  const done = new Map<string, Completion>();
  for (const r of completions) {
    if (r.submittedAt < assignedAt) continue;
    const prev = done.get(r.surveyId);
    if (!prev || r.submittedAt > prev.submittedAt) done.set(r.surveyId, r);
  }

  let gateClosed = false;
  let nextFree = true;
  const steps = [...items]
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const hit = done.get(item.surveyId);
      let state: BatteryProgressState;
      if (hit) state = "done";
      else if (!item.executable) state = "retired";
      // параллельная дорожка специалиста или информанта: не занимает очередь и не держит её
      else if (item.administration !== "self") state = "available";
      else if (!strictOrder) state = "available";
      else if (gateClosed) state = "locked";
      else {
        state = nextFree ? "current" : "available";
        nextFree = false;
        if (item.required) gateClosed = true;
      }
      return { ...item, state, responseId: hit?.responseId ?? null, submittedAt: hit?.submittedAt ?? null };
    });

  const counted = steps.filter((s) => s.required && (s.state === "done" || s.executable));
  const doneRequired = counted.filter((s) => s.state === "done").length;
  return {
    steps,
    doneRequired,
    totalRequired: counted.length,
    complete: counted.length > 0 && doneRequired === counted.length,
  };
}

/** Шаги наборов для расчёта — одним запросом, по позиции */
async function stepsOf(batteryIds: readonly string[]): Promise<Map<string, StepInput[]>> {
  const result = new Map<string, StepInput[]>();
  if (!batteryIds.length) return result;
  const rows = await db
    .select({
      batteryId: batteryItems.batteryId,
      surveyId: batteryItems.surveyId,
      position: batteryItems.position,
      required: batteryItems.required,
      administration: surveys.administration,
      status: surveys.status,
      archivedAt: surveys.archivedAt,
    })
    .from(batteryItems)
    .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
    .where(inArray(batteryItems.batteryId, [...batteryIds]))
    .orderBy(batteryItems.batteryId, batteryItems.position);
  for (const r of rows) {
    const list = result.get(r.batteryId) ?? [];
    list.push({
      surveyId: r.surveyId,
      position: r.position,
      required: r.required,
      administration: r.administration,
      executable: isExecutable(r),
    });
    result.set(r.batteryId, list);
  }
  return result;
}

/** Завершённые прохождения людей */
async function completionsOf(userIds: readonly string[]): Promise<Map<string, Completion[]>> {
  const result = new Map<string, Completion[]>();
  if (!userIds.length) return result;
  const rows = await db
    .select({
      userId: responses.userId,
      surveyId: responses.surveyId,
      responseId: responses.id,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .where(and(inArray(responses.userId, [...userIds]), eq(responses.status, "completed")));
  for (const r of rows) {
    if (!r.userId || !r.submittedAt) continue;
    const list = result.get(r.userId) ?? [];
    list.push({ surveyId: r.surveyId, responseId: r.responseId, submittedAt: r.submittedAt });
    result.set(r.userId, list);
  }
  return result;
}

/**
 * Отметить завершёнными назначения, у которых пройдены все исполнимые
 * обязательные шаги. Отметка — условием самого UPDATE (ещё не завершено и
 * не снято): назначение, снятое специалистом в ту же минуту, завершённым
 * не станет.
 */
async function closeIfComplete(
  active: { assignment: typeof batteryAssignments.$inferSelect; strictOrder: boolean }[],
): Promise<number> {
  if (!active.length) return 0;
  const steps = await stepsOf([...new Set(active.map((a) => a.assignment.batteryId))]);
  const completions = await completionsOf([...new Set(active.map((a) => a.assignment.userId))]);
  const now = new Date().toISOString();
  let closed = 0;
  for (const { assignment, strictOrder } of active) {
    const progress = batteryProgress(
      steps.get(assignment.batteryId) ?? [],
      strictOrder,
      assignment.assignedAt,
      completions.get(assignment.userId) ?? [],
    );
    if (!progress.complete) continue;
    const won = await db
      .update(batteryAssignments)
      .set({ completedAt: now })
      .where(
        and(
          eq(batteryAssignments.id, assignment.id),
          isNull(batteryAssignments.completedAt),
          isNull(batteryAssignments.cancelledAt),
        ),
      )
      .returning({ id: batteryAssignments.id });
    closed += won.length;
  }
  return closed;
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
          sql`exists (select 1 from battery_items bi
                      where bi.battery_id = ${batteryAssignments.batteryId} and bi.survey_id = ${surveyId})`,
        ),
      );
    await closeIfComplete(active);
  } catch (error) {
    log.error("battery.assignments_update_failed", { error: String(error) });
  }
}

/**
 * Методика перестала быть исполнимой (снята с использования или с
 * публикации) — пересчитать назначения наборов, где она шаг.
 *
 * Без этого назначение, у которого снят последний непройденный
 * обязательный шаг, висело бы открытым до следующей сдачи — а её может не
 * быть вовсе: экран уже показывает «пройдено», а очередь работы по
 * наступлении срока — «просрочено», и повторно этот набор человеку не
 * назначить (одно активное назначение на человека). Вернули методику в
 * работу — закрытые назначения не открываются: на момент снятия набор был
 * пройден по тем шагам, что можно было пройти.
 *
 * Зовётся под системной ролью (asSystem) из того же запроса, что снимает
 * методику.
 */
export async function closeCompletedForSurvey(surveyId: string): Promise<number> {
  const active = await db
    .select({ assignment: batteryAssignments, strictOrder: batteries.strictOrder })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .where(
      and(
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
        sql`exists (select 1 from battery_items bi
                    where bi.battery_id = ${batteryAssignments.batteryId} and bi.survey_id = ${surveyId})`,
      ),
    );
  const closed = await closeIfComplete(active);
  if (closed) log.info("battery.closed_on_retire", { surveyId, closed });
  return closed;
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
 * Что запирает шаг — решает batteryProgress, тот же расчёт, что у экрана и
 * завершения: шаг заперт («locked»), если перед ним есть непройденный
 * обязательный исполнимый шаг самоотчёта. Его и называет отказ.
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

  const steps = await stepsOf(active.map((a) => a.battery.id));
  const completions = (await completionsOf([userId])).get(userId) ?? [];

  for (const { assignment, battery } of active) {
    const { steps: progress } = batteryProgress(steps.get(battery.id) ?? [], true, assignment.assignedAt, completions);
    const step = progress.find((s) => s.surveyId === surveyId);
    if (!step || step.state !== "locked") continue;

    const blocking = progress.find(
      (s) =>
        s.position < step.position &&
        s.administration === "self" &&
        s.required &&
        s.executable &&
        s.state !== "done",
    );
    const [row] = blocking
      ? await db.select({ title: surveys.title }).from(surveys).where(eq(surveys.id, blocking.surveyId))
      : [];
    // названия нет (строки не нашлось) — запасное слово на том же языке, что и название, которое оно заменяет
    const title = row ? t(row.title as never, lang) : serverText("battery.previousSurvey", lang);
    badRequest("err.batteryStrictOrder", { battery: battery.title, title });
  }
}
