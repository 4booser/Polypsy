import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { noteCode, renderPush } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import {
  batteries,
  batteryAssignments,
  batteryItems,
  scheduleRuns,
  scheduleTargets,
  schedules,
  users,
} from "../db/schema";
import { auditSystem } from "./audit";
import { dayOf, endOfDayAfter } from "./day";
import { openFollowUps } from "./followup";
import { grantAccess } from "./grantAccess";
import { publish } from "./events";
import { sweepPresence } from "../routes/presence";
import { sweepNoShows } from "./noShow";
import { securityTick } from "./integrity";
import { batterySurveysInUse } from "./scope";
import { closeMissed, isOverdue, lockBatteryForAssign, snapshotAssignment } from "./batteries";
import { log } from "./log";
import { JobLocked, withJobLock } from "./jobLock";
import { registerJob, trackJob } from "./opsJobs";
import { SLOT_HORIZON_JOB, extendSlotHorizon } from "./schedule";
import { checkPushReceipts, pushToUser } from "./push";
import { langsOfPatients } from "./remind";

const DAY_MS = 86_400_000;

/**
 * Кого охватит срабатывание расписания.
 *
 * Список считается в момент срабатывания, а не при создании: состав
 * подразделения меняется, и расписание должно догонять тех, кто пришёл после
 * его заведения.
 */
export async function scheduleReach(schedule: {
  id: string;
  scope: string;
  unit: string | null;
}): Promise<string[]> {
  /*
   * Выключенная учётка (0088) не охватывается. Человека выключают, когда он
   * ушёл из учреждения: войти он не может, пройти назначенное — тоже, и
   * назначение ему висело бы вечным «не пройдено», а пуш уходил бы на
   * телефон человека, которого здесь больше нет.
   */
  if (schedule.scope === "unit") {
    if (!schedule.unit) return [];
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "user"), eq(users.unit, schedule.unit), isNull(users.disabledAt)));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: scheduleTargets.userId })
    .from(scheduleTargets)
    .innerJoin(users, eq(users.id, scheduleTargets.userId))
    .where(and(eq(scheduleTargets.scheduleId, schedule.id), isNull(users.disabledAt)));
  return rows.map((r) => r.id);
}

/**
 * Следующее срабатывание.
 *
 * Считается от предыдущего планового времени, а не от «сейчас»: иначе каждая
 * задержка запуска сдвигала бы всю сетку вперёд, и ежемесячный замер за год
 * уползал бы на недели.
 */
function nextRun(previous: Date, intervalDays: number, now: Date): Date {
  const step = intervalDays * DAY_MS;
  let next = previous.getTime() + step;
  // если сервер стоял долго, догоняем сетку, а не выдаём пропущенные повторы
  // задним числом: смысл имеет только ближайший
  while (next <= now.getTime()) next += step;
  return new Date(next);
}

/** Одно срабатывание расписания. Возвращает, сколько назначено, пропущено и закрыто пропусками. */
async function runSchedule(
  schedule: typeof schedules.$inferSelect,
  now: Date,
): Promise<{
  assigned: number;
  skipped: number;
  missed: number;
  note?: string;
  /** Кому и с каким сроком сообщить — после коммита выдачи */
  notify?: { userIds: string[]; dueAt: string };
}> {
  /*
   * Батарея в архиве — расписание не выдаёт ничего. Ручное назначение
   * архивной батареи запрещено (routes/batteries.ts, err.batteryArchived), а
   * расписание обходило этот запрет: архивировали набор — и он продолжал
   * приходить людям по графику.
   */
  const [battery] = await db
    .select({ archived: batteries.archived })
    .from(batteries)
    .where(eq(batteries.id, schedule.batteryId));
  if (!battery || battery.archived) {
    return { assigned: 0, skipped: 0, missed: 0, note: noteCode("note.run.archived") };
  }

  const targets = await scheduleReach(schedule);
  if (!targets.length) return { assigned: 0, skipped: 0, missed: 0 };

  /*
   * У кого висит незакрытое назначение этой батареи — тем повторно не
   * выдаём: два одинаковых задания подряд человек читает как ошибку.
   *
   * Но только если срок у него ещё не вышел. Прежде «незакрытое» значило
   * и «просроченное»: человек, пропустивший один замер, оставался занятым
   * навсегда — его назначение не закрывалось, и расписание больше не
   * выдавало ему ничего ни через месяц, ни через год. Один пропуск
   * выбрасывал человека из наблюдения молча.
   *
   * Просроченное назначение закрывается как пропущенное — с отметкой в
   * примечании, не молча (см. комментарий к cancelledAt), — и вместо него
   * выдаётся новое. Одно активное назначение на человека (уникальный
   * индекс) при этом сохраняется.
   */
  const open = await db
    .select({ id: batteryAssignments.id, userId: batteryAssignments.userId, dueAt: batteryAssignments.dueAt })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, schedule.batteryId),
        inArray(batteryAssignments.userId, targets),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  const overdue = open.filter((a) => isOverdue(a, now));
  const busyIds = new Set(open.filter((a) => !overdue.includes(a)).map((b) => b.userId));
  const fresh = targets.filter((id) => !busyIds.has(id));
  if (!fresh.length) return { assigned: 0, skipped: targets.length, missed: 0 };

  const items = await db
    .select()
    .from(batteryItems)
    .where(eq(batteryItems.batteryId, schedule.batteryId));
  if (!items.length) return { assigned: 0, skipped: targets.length, missed: 0 };

  // снятая методика не выдаётся даже автоматически; остальные — выдаются
  const inUse = new Set(await batterySurveysInUse(schedule.batteryId));
  const grantable = items.filter((i) => inUse.has(i.surveyId));
  if (grantable.length < items.length) {
    log.warn("schedule.archived_skipped", {
      scheduleId: schedule.id,
      skipped: items.length - grantable.length,
    });
  }
  if (!grantable.length) return { assigned: 0, skipped: targets.length, missed: 0 };

  /*
   * Срок — конец дня по поясу учреждения, а не «ровно через N суток от
   * минуты прохода»: иначе в сам день срока назначение с утра уже числилось
   * бы просроченным (см. lib/day.ts, endOfDay). От `now` прохода, а не от
   * часов сервера: проход, запущенный с чужим `now`, иначе ставил бы сроки
   * из другого времени, чем проверял просрочку.
   */
  const dueAt = endOfDayAfter(now, schedule.dueDays);
  const missed = overdue.filter((a) => fresh.includes(a.userId));

  const done = await db.transaction(async (tx) => {
    // набор под замком: архивированный за время проверок — не выдаётся (lib/batteries.ts)
    if (!(await lockBatteryForAssign(tx, schedule.batteryId))) return false;
    await closeMissed(
      tx,
      missed.map((a) => a.id),
      noteCode("note.missed.schedule", { title: schedule.title }),
      now,
    );
    const issued = fresh.map((userId) => ({ id: crypto.randomUUID(), userId }));
    await tx.insert(batteryAssignments).values(
      issued.map(({ id, userId }) => ({
        id,
        batteryId: schedule.batteryId,
        userId,
        assignedBy: schedule.createdBy,
        dueAt,
        note: noteCode("note.schedule", { title: schedule.title }),
      })),
    );
    // состав каждого назначения — то, что выдано: снятые методики в него не входят (lib/batteries.ts)
    for (const { id } of issued) await snapshotAssignment(tx, id, grantable);
    await grantAccess(
      tx as never,
      issued.flatMap(({ id, userId }) =>
        grantable.map((item) => ({
          surveyId: item.surveyId,
          userId,
          grantedBy: schedule.createdBy,
          expiresAt: dueAt,
          note: noteCode("note.schedule", { title: schedule.title }),
          viaAssignmentId: id,
        })),
      ),
      // назначение поверх более долгого доступа его не укорачивает — см. grantAccess
      { term: "extend" },
    );
    return true;
  });
  if (!done) return { assigned: 0, skipped: 0, missed: 0, note: noteCode("note.run.archived") };

  return {
    assigned: fresh.length,
    skipped: targets.length - fresh.length,
    missed: missed.length,
    notify: { userIds: fresh, dueAt },
  };
}

/**
 * Пуш «вам назначено обследование» — после того, как выдача
 * закоммичена, каждому своей короткой транзакцией.
 *
 * Прежде пуш уходил изнутри транзакции прохода по расписанию: если потом
 * падала отметка о прогоне, выдача откатывалась, а уведомление уже было на
 * экране — обещание, которого система не выполнила. Пуш нельзя откатить,
 * поэтому порядок «сначала запись, потом сообщение» здесь важнее скорости.
 *
 * В тексте нет ни методики, ни диагноза: экран блокировки видят
 * посторонние — в казарме, в транспорте, на построении. Текст — из словаря
 * уведомлений и на языке устройства (pushToUser).
 *
 * Дата — день срока по поясу учреждения, а не `dueAt.slice(0, 10)`: это
 * день по Гринвичу, и срок «до конца 12-го» по Киеву в ночные часы
 * превращался в уведомлении в «до 11-го».
 */
async function notifyAssigned(scheduleId: string, userIds: string[], dueAt: string): Promise<void> {
  const langs = await systemContext(baseDb, () => langsOfPatients(userIds));
  const date = dayOf(dueAt)!;
  for (const userId of userIds) {
    try {
      await systemContext(baseDb, () =>
        pushToUser(
          userId,
          {
            eventKey: `schedule:${scheduleId}:${dueAt}`,
            kind: "assignment",
            title: (lang) => renderPush("push.assignmentTitle", lang),
            body: (lang) => renderPush("push.assignmentBody", lang, { date }),
            path: "/(app)/surveys",
          },
          langs.get(userId) ?? "uk",
        ),
      );
    } catch (error) {
      log.warn("schedule.push_failed", { scheduleId, error: String(error) });
    }
  }
}

/**
 * Проход по всем расписаниям, которым пора сработать.
 *
 * Идемпотентен по времени: срабатывание отмечается в самой строке расписания,
 * поэтому повторный вызов в ту же минуту ничего не продублирует. Ошибка одного
 * расписания не останавливает остальные — иначе одно кривое перекрыло бы
 * работу всей больницы.
 */
/** Ключ advisory-лока: произвольная константа, одна на всё приложение */
const SCHEDULER_LOCK_KEY = 7_154_202;

export async function runDueSchedules(now = new Date()): Promise<number> {
  /*
   * Две реплики не должны выдать задания дважды: идемпотентность через
   * schedule_runs — первый пояс, лок на время прохода — второй.
   *
   * Лок именно транзакционный (pg_try_advisory_xact_lock): сессионный вариант
   * в пуле соединений ломается — захват и освобождение могут уйти в разные
   * соединения, и лок либо повисает, либо снимается с предупреждением.
   * Транзакция-обёртка держит одно соединение и не делает записей: вся работа
   * внутри идёт обычным пулом, а лок отпускается сам при выходе — в том числе
   * при ошибке.
   *
   * Обёртка берётся от baseDb НАПРЯМУЮ и не открывает системного контекста.
   * Это существенно: контекст кладёт свою транзакцию в AsyncLocalStorage, и
   * тогда каждый db.* внутри прохода уходил бы в неё же — то есть весь
   * проход шёл бы одной транзакцией, ровно вопреки написанному здесь. Цена
   * ошибки была не в производительности: первое же расписание, упавшее с
   * ошибкой postgres, переводило транзакцию в aborted, и дальше не проходило
   * ничего — ни запись о неудаче, ни сдвиг срока (обе гасят исключение
   * через .catch), ни одно из следующих расписаний. Одно кривое расписание
   * останавливало работу всей больницы и крутилось каждый тик, потому что
   * его срок сдвинуть не удавалось.
   *
   * Из пула при этом занято на одно соединение больше обычного: обёртка
   * ждёт, пока работа внутри берёт свои. При max = 10 это несущественно.
   */
  return baseDb.transaction(async (tx) => {
    const [lock] = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) as ok`,
    );
    if (!(lock as { ok: boolean }).ok) return 0;
    return runDueSchedulesLocked(now);
  });
}

async function runDueSchedulesLocked(now: Date): Promise<number> {
  const due = await systemContext(baseDb, () =>
    db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.active, true),
          lte(schedules.nextRunAt, now.toISOString()),
          lte(schedules.startsAt, now.toISOString()),
          or(
            isNull(schedules.endsAt),
            sql`${schedules.endsAt} > ${now.toISOString()}`,
          ),
          // после сбоя — не раньше срока повторной попытки (см. catch ниже)
          or(isNull(schedules.retryAt), lte(schedules.retryAt, now.toISOString())),
        ),
      )
      .orderBy(asc(schedules.nextRunAt)),
  );

  let handled = 0;
  for (const schedule of due) {
    /*
     * Каждое расписание — своя транзакция. Так «ошибка одного не
     * останавливает остальные» перестаёт быть пожеланием: упавшее
     * откатывается целиком (не остаётся наполовину розданных назначений с
     * отметкой о прогоне), а следующее начинает с чистого соединения.
     */
    try {
      const notify = await systemContext(baseDb, async () => {
        const { assigned, skipped, missed, note, notify } = await runSchedule(schedule, now);
        const planned = new Date(schedule.nextRunAt);
        await db
          .update(schedules)
          .set({
            lastRunAt: now.toISOString(),
            nextRunAt: nextRun(
              planned,
              schedule.intervalDays,
              now,
            ).toISOString(),
            retryAt: null,
            failures: 0,
          })
          .where(eq(schedules.id, schedule.id));
        await db.insert(scheduleRuns).values({
          id: crypto.randomUUID(),
          scheduleId: schedule.id,
          ranAt: now.toISOString(),
          assigned,
          skipped,
          note:
            note ??
            (missed > 0
              ? noteCode("note.run.missedClosed", { n: missed })
              : assigned === 0 && skipped === 0
                ? noteCode("note.run.nobody")
                : null),
        });
        if (assigned > 0) {
          /*
           * Только когда что-то реально назначено: тик расписания случается
           * каждые несколько минут, и пустой прогон не новость для консоли.
           */
          await publish(db, {
            kind: "schedule.run",
            surveyIds: null,
            userId: null,
            at: now.toISOString(),
          });
        }

        await auditSystem({
          action: "schedule.run",
          resourceType: "schedule",
          resourceId: schedule.id,
          details: { title: schedule.title, assigned, skipped, ...(missed ? { missed } : {}) },
        });
        return notify;
      });
      handled++;
      if (notify) await notifyAssigned(schedule.id, notify.userIds, notify.dueAt);
    } catch (error) {
      log.error("schedule.failed", {
        scheduleId: schedule.id,
        error: String(error),
      });
      // отдельной транзакцией: та, в которой упало, откачена целиком
      await systemContext(baseDb, async () => {
        await db.insert(scheduleRuns).values({
          id: crypto.randomUUID(),
          scheduleId: schedule.id,
          ranAt: now.toISOString(),
          assigned: 0,
          skipped: 0,
          note:
            error instanceof Error
              ? error.message.slice(0, 300)
              : noteCode("note.run.unknownError"),
        });
        /*
         * Плановый срок НЕ сдвигается — назначается отдельный срок
         * повторной попытки.
         *
         * Прежде сбой сдвигал nextRunAt на следующий регулярный срок: база
         * моргнула в минуту прохода — и ежемесячный замер не выдавался
         * месяц. Теперь попытка повторяется через 15 минут, потом через 30,
         * час и так далее до шести часов между попытками (тик планировщика
         * часовой, так что на деле — со следующим тиком и реже). Сломанное
         * всерьёз расписание не крутится каждый тик, а временный сбой стоит
         * час, а не период. Плановая сетка при этом не уползает: успешная
         * попытка считает следующий срок от ПЛАНОВОГО, а не от момента
         * успеха.
         */
        const failures = schedule.failures + 1;
        await db
          .update(schedules)
          .set({
            failures,
            retryAt: new Date(now.getTime() + retryDelay(failures)).toISOString(),
          })
          .where(eq(schedules.id, schedule.id));
      }).catch((e) =>
        log.error("schedule.failure_record_failed", {
          scheduleId: schedule.id,
          error: String(e),
        }),
      );
    }
  }
  return handled;
}

/** Пауза перед повторной попыткой после n-го сбоя подряд: 15 мин, 30, час… не больше шести часов */
function retryDelay(failures: number): number {
  return Math.min(15 * 60_000 * 2 ** (failures - 1), 6 * 3_600_000);
}

/** Периодический запуск. Часа достаточно: расписания меряются днями. */
export function startScheduler(intervalMs = 3_600_000): () => void {
  /*
   * Каждый проход отмечается в реестре техпанели (opsJobs.ts): когда шёл,
   * сколько занял, чем кончился. Без этого «планировщик встал» и «сегодня
   * никому не пора» выглядели одинаково — schedule_runs пишет строку, только
   * когда расписание сработало.
   */
  registerJob("schedules", intervalMs);
  registerJob("presence.sweep", intervalMs);
  registerJob("clinic.noShows", intervalMs);
  registerJob("push.receipts", intervalMs);
  registerJob("security", intervalMs);
  registerJob("followups.open", intervalMs);
  registerJob(SLOT_HORIZON_JOB, DAY_MS);
  const tick = () => {
    trackJob("schedules", () => runDueSchedules()).catch((error) =>
      log.error("scheduler.tick_failed", { error: String(error) }),
    );
    /*
     * Окна повторных замеров протокола наблюдения (lib/followup.ts). Часа
     * хватает: окно — это дни, и открыть его в 00:40 вместо 00:00 никому не
     * мешает. Каждое окно — своей транзакцией внутри openFollowUps.
     */
    void trackJob("followups.open", () => openFollowUps()).catch((error) =>
      log.warn("followup.tick_failed", { error: String(error) }),
    );
    /*
     * Заодно вычищаем протухшее присутствие. Отдельного таймера оно не
     * заслуживает: строки безвредны, а раз в час их не наберётся столько,
     * чтобы это кого-то беспокоило.
     */
    void trackJob("presence.sweep", () => systemContext(baseDb, () => sweepPresence())).catch((error) =>
      log.warn("presence.sweep_failed", { error: String(error) }),
    );
    /*
     * И разводим истёкшие приёмы по неявкам. Раз в час — подходящий шаг:
     * задержка сигнала выходит меньше половины рабочего дня, а чаще незачем.
     */
    void trackJob("clinic.noShows", () => systemContext(baseDb, () => sweepNoShows())).catch((error) =>
      log.warn("clinic.no_show_sweep_failed", { error: String(error) }),
    );
    /*
     * Квитанции пуш-уведомлений (lib/push.ts). Раз в час хватает с запасом:
     * Expo хранит их сутки, а вопрос «дошло ли» задают на следующий день, а
     * не в ту же минуту. Заодно чистятся исходы старше полугода.
     */
    void trackJob("push.receipts", () => systemContext(baseDb, () => checkPushReceipts())).catch((error) =>
      log.warn("push.receipts_failed", { error: String(error) }),
    );
    /*
     * Безопасность (техпанель, lib/integrity.ts): отметка смены секретов —
     * каждый тик, сверка цепочки журнала — раз в сутки. Сутки отмеряет сама
     * задача по последней плановой сверке в базе, а не счётчик тиков:
     * счётчик обнулялся бы каждым перезапуском. Разрыв цепочки — log.error и
     * запись sec.audit_chain_broken в журнал.
     */
    void trackJob("security", () => securityTick()).catch((error) =>
      log.warn("sec.tick_failed", { error: String(error) }),
    );
    /*
     * Расшифровка записей приёма здесь больше не идёт — она вынесена в
     * отдельный процесс (`transcriber.ts`).
     *
     * Здесь она занимала процессор минутами рядом с обслуживанием запросов
     * («консоль подтормаживает после обеда» — это и есть очередь
     * расшифровок изнутри кабинета) и шла раз в час по одной записи: восемь
     * приёмов за день разгребались бы восемь часов, и стенограмма первого
     * утреннего приезжала бы к вечеру.
     */
  };
  tick();
  const timer = setInterval(tick, intervalMs);

  /*
   * Горизонт сетки слотов (lib/schedule.ts, extendSlotHorizon): раз в
   * сутки, своим таймером, а не часовым тиком — окно сдвигается на день в
   * сутки, и чаще пересобирать нечего. Первый проход — сразу при запуске:
   * он же пересобирает сетку после выкатки (так миграция 0105 и доходит до
   * тех, чьё расписание с тех пор никто не трогал). Несколько реплик — один
   * проход (замок в базе, jobLock.ts); проигравшая реплика не считает это
   * сбоем: сетку в эти минуты продлевает соседняя.
   */
  const horizon = () => {
    void trackJob(SLOT_HORIZON_JOB, async () => {
      try {
        return await withJobLock(SLOT_HORIZON_JOB, () => extendSlotHorizon());
      } catch (error) {
        if (error instanceof JobLocked) return null;
        throw error;
      }
    }).catch((error) => log.warn("slots.horizon_tick_failed", { error: String(error) }));
  };
  horizon();
  const horizonTimer = setInterval(horizon, DAY_MS);

  return () => {
    clearInterval(timer);
    clearInterval(horizonTimer);
  };
}
