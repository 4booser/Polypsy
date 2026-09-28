import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
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

/*
 * ─── завершение: проверка под замком строки назначения ───
 *
 * Завершённость считалась в транзакции сдачи, до её коммита. Две сдачи
 * последних методик набора, ушедшие одновременно, — офлайн-очередь,
 * досылающая пачку, два устройства, — видели каждая своё прохождение и не
 * видели соседнее: оно ещё не зафиксировано. Обе решали «пройдено не всё»,
 * обе коммитились, и пересчитывать было уже некому: «2 из 2», а назначение
 * открыто, после срока — «просрочено» в очереди работы, и повторно этот
 * набор человеку не назначить (внешний разбор 2026-09-28, P2). Условие на
 * итоговом UPDATE тут не помогает: до UPDATE не доходит ни одна.
 *
 * Выбрана сериализация, а не пересчёт после коммита. Пересчёт «после»
 * требует крючка на коммит у каждого входа сдачи (обычная, киоск, заполнение
 * специалистом) и всё равно теряет завершение, если процесс упал между
 * коммитом и пересчётом, — пришлось бы добавлять ещё и подметание.
 * Блокировка же решает дело внутри той транзакции, что пишет прохождение:
 *
 *   — сдача ДО первой записи берёт замок строк открытых назначений человека,
 *     в которые входит методика (holdCompletable), по порядку id;
 *   — вторая сдача того же набора ждёт на этом замке, пока первая не
 *     зафиксируется, и проверяет завершение уже новым снимком (READ
 *     COMMITTED: каждый оператор видит всё, что зафиксировано к его началу),
 *     где прохождение первой есть. Последняя из сдач видит все.
 *
 * Почему замок берётся до первой записи, а не перед проверкой: сдача
 * списывает попытку (строка survey_access) раньше, чем доходит до
 * завершения, а отмена назначения и расписание идут в обратном порядке —
 * сначала строка назначения, потом доступы по нему. Взятый позже, замок
 * назначения замкнул бы круг «сдача держит доступ и ждёт назначение, отмена
 * держит назначение и ждёт доступ». Порядок «назначение → его доступы»
 * теперь один у всех, кто их трогает.
 *
 * Назначения, выданные уже во время сдачи (каскад по её же результату),
 * она не закрывает: проверяется ровно то, что было взято под замок, — как и
 * прежде требовал порядок «сначала закрытие, потом каскады».
 */

/**
 * Открытые назначения человека, которые может завершить сдача этой
 * методики, — под замком строки до конца транзакции сдачи. Зовётся до
 * первой записи сдачи; возвращает то, что потом проверит
 * closeCompletedBatteries.
 */
export async function holdCompletable(userId: string | null, surveyId: string): Promise<string[]> {
  if (!userId) return [];
  const rows = await db
    .select({ id: batteryAssignments.id })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.userId, userId),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
        sql`exists (select 1 from battery_items bi
                    where bi.battery_id = ${batteryAssignments.batteryId} and bi.survey_id = ${surveyId})`,
      ),
    )
    // один порядок у всех, кто берёт несколько строк назначений, — иначе две сдачи замкнули бы круг
    .orderBy(batteryAssignments.id)
    .for("update");
  return rows.map((r) => r.id);
}

/**
 * Назначения по id — открытые, под замком строки, по порядку id.
 *
 * Замок, а не просто чтение: проверку завершённости делает тот, кто держит
 * строку, и следующий ждёт, пока он зафиксируется (см. выше). Строка,
 * которую за время ожидания завершили или сняли, в выборку не попадёт —
 * PostgreSQL перепроверяет условие по её новой версии.
 */
async function lockOpen(where: SQL) {
  return db
    .select({ assignment: batteryAssignments, strictOrder: batteries.strictOrder })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .where(and(where, isNull(batteryAssignments.completedAt), isNull(batteryAssignments.cancelledAt)))
    .orderBy(batteryAssignments.id)
    .for("update", { of: batteryAssignments });
}

/**
 * Отметить завершёнными назначения, у которых пройдены все исполнимые
 * обязательные шаги. Строки назначений уже под замком вызывающего (lockOpen),
 * прохождения читаются после него — новым снимком. Отметка — ещё и условием
 * самого UPDATE (не завершено и не снято).
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
 * Вызывается после записи сдачи с тем, что сдача взяла под замок до
 * записи (holdCompletable). Ошибки не пробрасываются — сданное прохождение
 * не должно откатываться из-за учёта батарей; и чтобы это было правдой, а
 * не пожеланием, учёт идёт точкой сохранения: сбой оператора в PostgreSQL
 * обрывает всю транзакцию, и перехваченное исключение без точки сохранения
 * всё равно уносило бы прохождение.
 */
export async function closeCompletedBatteries(assignmentIds: readonly string[]): Promise<void> {
  if (!assignmentIds.length) return;
  try {
    await db.transaction(async () => {
      await closeIfComplete(await lockOpen(inArray(batteryAssignments.id, [...assignmentIds])));
    });
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
  // под тем же замком строки, что и сдача: снятие шага и сдача последнего шага одновременно — та же гонка
  const active = await lockOpen(
    sql`exists (select 1 from battery_items bi
                where bi.battery_id = ${batteryAssignments.batteryId} and bi.survey_id = ${surveyId})`,
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
