import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import {
  batteryAssignments,
  batteryItems,
  scheduleRuns,
  scheduleTargets,
  schedules,
  surveyAccess,
  users,
} from "../db/schema";
import { auditSystem } from "./audit";
import { publish } from "./events";
import { currentCrisis } from "./crisis";
import { sweepPresence } from "../routes/presence";
import { sweepNoShows } from "./noShow";
import { transcribeNext } from "./recordings";
import { batterySurveysInUse } from "./scope";
import { log } from "./log";
import { pushToUser } from "./push";

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
  if (schedule.scope === "unit") {
    if (!schedule.unit) return [];
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "user"), eq(users.unit, schedule.unit)));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: scheduleTargets.userId })
    .from(scheduleTargets)
    .where(eq(scheduleTargets.scheduleId, schedule.id));
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

/** Одно срабатывание расписания. Возвращает, сколько назначено и пропущено. */
async function runSchedule(schedule: typeof schedules.$inferSelect): Promise<{
  assigned: number;
  skipped: number;
}> {
  const targets = await scheduleReach(schedule);
  if (!targets.length) return { assigned: 0, skipped: 0 };

  // у кого уже висит незакрытое назначение этой батареи — тем не выдаём
  // повторно: два одинаковых задания подряд человек читает как ошибку
  const busy = await db
    .select({ userId: batteryAssignments.userId })
    .from(batteryAssignments)
    .where(
      and(
        eq(batteryAssignments.batteryId, schedule.batteryId),
        inArray(batteryAssignments.userId, targets),
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
      ),
    );
  const busyIds = new Set(busy.map((b) => b.userId));
  const fresh = targets.filter((id) => !busyIds.has(id));
  if (!fresh.length) return { assigned: 0, skipped: targets.length };

  const items = await db
    .select()
    .from(batteryItems)
    .where(eq(batteryItems.batteryId, schedule.batteryId));
  if (!items.length) return { assigned: 0, skipped: targets.length };

  // снятая методика не выдаётся даже автоматически; остальные — выдаются
  const inUse = new Set(await batterySurveysInUse(schedule.batteryId));
  const grantable = items.filter((i) => inUse.has(i.surveyId));
  if (grantable.length < items.length) {
    log.warn("schedule.archived_skipped", {
      scheduleId: schedule.id,
      skipped: items.length - grantable.length,
    });
  }
  if (!grantable.length) return { assigned: 0, skipped: targets.length };

  const dueAt = new Date(Date.now() + schedule.dueDays * DAY_MS).toISOString();

  await db.transaction(async (tx) => {
    await tx.insert(batteryAssignments).values(
      fresh.map((userId) => ({
        id: crypto.randomUUID(),
        batteryId: schedule.batteryId,
        userId,
        assignedBy: schedule.createdBy,
        dueAt,
        note: `Расписание «${schedule.title}»`,
      })),
    );
    await tx
      .insert(surveyAccess)
      .values(
        fresh.flatMap((userId) =>
          grantable.map((item) => ({
            surveyId: item.surveyId,
            userId,
            grantedBy: schedule.createdBy,
            expiresAt: dueAt,
            note: `Расписание «${schedule.title}»`,
          })),
        ),
      )
      .onConflictDoNothing();
  });

  /*
   * Уведомление — после транзакции, а не внутри: пуш нельзя откатить, и
   * отправленное «вам назначено обследование» при откате выдачи было бы
   * обещанием, которого система не выполнит. Порядок «сначала запись, потом
   * сообщение» здесь важнее скорости.
   *
   * В тексте нет ни методики, ни диагноза: экран блокировки видят
   * посторонние — в казарме, в транспорте, на построении.
   */
  for (const userId of fresh) {
    await pushToUser(userId, {
      eventKey: `schedule:${schedule.id}:${dueAt}`,
      kind: "assignment",
      title: "Назначено обследование",
      body: `Срок — до ${dueAt.slice(0, 10)}`,
      path: "/(app)/surveys",
    });
  }

  return { assigned: fresh.length, skipped: targets.length - fresh.length };
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
  // фоновый процесс работает в явном системном контексте RLS
  return systemContext(baseDb, () => runDueSchedulesInner(now));
}

async function runDueSchedulesInner(now: Date): Promise<number> {
  // Две реплики не должны выдать задания дважды: идемпотентность через
  // schedule_runs — первый пояс, лок на время прохода — второй.
  //
  // Лок именно транзакционный (pg_try_advisory_xact_lock): сессионный вариант
  // в пуле соединений ломается — захват и освобождение могут уйти в разные
  // соединения, и лок либо повисает, либо снимается с предупреждением.
  // Транзакция-обёртка держит одно соединение и не делает записей: вся работа
  // внутри идёт обычным пулом, а лок отпускается сам при выходе — в том числе
  // при ошибке.
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) as ok`,
    );
    if (!(lock as { ok: boolean }).ok) return 0;
    return runDueSchedulesLocked(now);
  });
}

async function runDueSchedulesLocked(now: Date): Promise<number> {
  /*
   * В кризисном режиме плановые замеры не запускаются.
   *
   * В массовое поступление очередь работы должна наполняться поступившими, а
   * не напоминаниями трёхмесячной давности. Сроки не сдвигаются: расписание
   * догонит себя, когда режим выключат, — пропущенный тик это отложенный, а
   * не отменённый замер.
   */
  const crisis = await currentCrisis();
  if (crisis.active) {
    log.info("scheduler.skipped_crisis", { reason: crisis.reason });
    return 0;
  }

  const due = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.active, true),
        lte(schedules.nextRunAt, now.toISOString()),
        lte(schedules.startsAt, now.toISOString()),
        or(isNull(schedules.endsAt), sql`${schedules.endsAt} > ${now.toISOString()}`),
      ),
    )
    .orderBy(asc(schedules.nextRunAt));

  let handled = 0;
  for (const schedule of due) {
    try {
      const { assigned, skipped } = await runSchedule(schedule);
      const planned = new Date(schedule.nextRunAt);
      await db
        .update(schedules)
        .set({
          lastRunAt: now.toISOString(),
          nextRunAt: nextRun(planned, schedule.intervalDays, now).toISOString(),
        })
        .where(eq(schedules.id, schedule.id));
      await db.insert(scheduleRuns).values({
        id: crypto.randomUUID(),
        scheduleId: schedule.id,
        ranAt: now.toISOString(),
        assigned,
        skipped,
        note: assigned === 0 && skipped === 0 ? "Некого охватить" : null,
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
        details: { title: schedule.title, assigned, skipped },
      });
      handled++;
    } catch (error) {
      log.error("schedule.failed", { scheduleId: schedule.id, error: String(error) });
      await db
        .insert(scheduleRuns)
        .values({
          id: crypto.randomUUID(),
          scheduleId: schedule.id,
          ranAt: now.toISOString(),
          assigned: 0,
          skipped: 0,
          note: error instanceof Error ? error.message.slice(0, 300) : "Неизвестная ошибка",
        })
        .catch(() => {});
      // сдвигаем срок, иначе сломанное расписание будет крутиться каждый тик
      await db
        .update(schedules)
        .set({ nextRunAt: nextRun(new Date(schedule.nextRunAt), schedule.intervalDays, now).toISOString() })
        .where(eq(schedules.id, schedule.id))
        .catch(() => {});
    }
  }
  return handled;
}

/** Периодический запуск. Часа достаточно: расписания меряются днями. */
export function startScheduler(intervalMs = 3_600_000): () => void {
  const tick = () => {
    runDueSchedules().catch((error) => log.error("scheduler.tick_failed", { error: String(error) }));
    /*
     * Заодно вычищаем протухшее присутствие. Отдельного таймера оно не
     * заслуживает: строки безвредны, а раз в час их не наберётся столько,
     * чтобы это кого-то беспокоило.
     */
    void systemContext(baseDb, () => sweepPresence()).catch((error) =>
      log.warn("presence.sweep_failed", { error: String(error) }),
    );
    /*
     * И разводим истёкшие приёмы по неявкам. Раз в час — подходящий шаг:
     * задержка сигнала выходит меньше половины рабочего дня, а чаще незачем.
     */
    void systemContext(baseDb, () => sweepNoShows()).catch((error) =>
      log.warn("clinic.no_show_sweep_failed", { error: String(error) }),
    );
    /*
     * И расшифровываем одну запись приёма. По одной, а не пачкой:
     * расшифровка часового приёма занимает минуты, и очередь из пяти,
     * взятая разом, заняла бы процессор на полчаса — а рядом работает
     * приложение, которым в это время пользуются.
     */
    void systemContext(baseDb, () => transcribeNext()).catch((error) =>
      log.warn("recording.transcribe_tick_failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
