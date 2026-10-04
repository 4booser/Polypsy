import { and, eq, isNotNull, lte } from "drizzle-orm";
import { serverText } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { asSystem, systemContext } from "../db/context";
import { appointments, slots } from "../db/schema";
import { log } from "./log";
import { createMeetLink, deleteMeetEvent, moveMeetEvent } from "./meet";
import { STAFF_OUTBOUND_LANG } from "./notify";

/**
 * Сведение события Google Calendar с приёмом (внешний разбор, #37).
 *
 * При записи на дистанционный приём создаётся событие в календаре
 * специалиста и из него берётся ссылка Meet. Дальше приём живёт своей
 * жизнью — его переносят, отдают другому специалисту, отменяют, — а событие
 * прежде оставалось как было: у врача в календаре стояла встреча на снятое
 * время, у нового врача её не было, отменённый приём висел живым.
 *
 * Здесь одно правило, которое приводит календарь к приёму по тому, что
 * записано в самом приёме (slot, specialist_id, status) и в его памяти о
 * событии (meeting_event_id, meeting_organizer_id):
 *
 *   — приём отменён → событие удаляется;
 *   — организатор тот же → событие переносится на время нового слота;
 *   — специалист другой → событие удаляется у прежнего и создаётся у нового
 *     (если тот подключил календарь; иначе ссылки нет, и специалист вписывает
 *     свою — как при записи).
 *
 * Операция повторяема. Приём помечается «ждёт сведения» (meeting_sync_at)
 * той же записью, что его меняет, — и это запись в базе, а не обещание в
 * памяти процесса. Попытка идёт сразу, из запроса; не вышло — метка
 * остаётся, и фоновый проход (syncDueMeetings, такт startNotifier) повторяет
 * с нарастающей паузой. Дубликатов повтор не создаёт: новое событие
 * создаётся только когда прежнее из строки уже убрано, а удаление
 * исчезнувшего события (404/410) считается сделанным.
 *
 * Ссылка, вписанная руками, события не имеет — её это правило не касается.
 */

/** Итог сведения — для журнала действия над приёмом */
export type MeetSyncOutcome = "moved" | "recreated" | "deleted" | "unlinked" | "nothing" | "failed";

/** Паузы между повторами: минута, пять, четверть часа, час, дальше — по часу */
const RETRY_MS = [60_000, 300_000, 900_000, 3_600_000];
const retryDelay = (attempts: number) => RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)]!;

/** Сколько приёмов берёт один фоновый проход: у каждого до трёх обращений к Google */
const BATCH = 50;

/**
 * Свести событие одного приёма с его текущим состоянием.
 *
 * Системной ролью: отменяет приём и пациент, а чужие строки календаря и
 * приём после смены специалиста ему под своей ролью не видны. Наружу —
 * только итог для журнала.
 */
export async function syncMeeting(appointmentId: string): Promise<MeetSyncOutcome> {
  return asSystem(async () => {
    const [found] = await db
      .select({ row: appointments, slot: slots })
      .from(appointments)
      .innerJoin(slots, eq(slots.id, appointments.slotId))
      .where(eq(appointments.id, appointmentId));
    if (!found) return "nothing";
    const { row, slot } = found;

    const settle = async (set: Partial<typeof appointments.$inferInsert>) => {
      await db
        .update(appointments)
        .set({ ...set, meetingSyncAt: null, meetingSyncAttempts: 0 })
        .where(eq(appointments.id, row.id));
    };
    const postpone = async () => {
      await db
        .update(appointments)
        .set({
          meetingSyncAt: new Date(Date.now() + retryDelay(row.meetingSyncAttempts)).toISOString(),
          meetingSyncAttempts: row.meetingSyncAttempts + 1,
        })
        .where(eq(appointments.id, row.id));
      return "failed" as const;
    };

    /** Новое событие у текущего специалиста — вторая половина пересоздания */
    const recreate = async (): Promise<MeetSyncOutcome> => {
      const created = await createMeetLink({
        specialistId: row.specialistId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        title: serverText("meet.eventTitle", STAFF_OUTBOUND_LANG),
      });
      if (created.outcome === "failed") return postpone();
      if (created.url) {
        await settle({ meetingUrl: created.url, meetingEventId: created.eventId, meetingOrganizerId: row.specialistId });
        return "recreated";
      }
      // у специалиста календаря нет: ссылки нет, он впишет свою
      await settle({});
      return "unlinked";
    };

    if (!row.meetingEventId || !row.meetingOrganizerId) {
      /*
       * События нет. Это либо ссылка, вписанная руками (или её не было
       * вовсе) — сводить нечего, — либо пересоздание, прерванное сбоем
       * после удаления прежнего события: приём дистанционный, ссылки нет,
       * сведение запрошено. Тогда доделывается вторая половина — создание.
       */
      if (row.status !== "cancelled" && row.mode === "remote" && !row.meetingUrl && row.meetingSyncAt) {
        return recreate();
      }
      await settle({});
      return "nothing";
    }

    /* отмена: событие убирается из календаря организатора */
    if (row.status === "cancelled") {
      const outcome = await deleteMeetEvent(row.meetingOrganizerId, row.meetingEventId);
      if (outcome === "failed") return postpone();
      await settle({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null });
      return "deleted";
    }

    /* тот же организатор: событие переезжает на время слота */
    if (row.meetingOrganizerId === row.specialistId) {
      const outcome = await moveMeetEvent(row.meetingOrganizerId, row.meetingEventId, slot.startsAt, slot.endsAt);
      if (outcome === "failed") return postpone();
      if (outcome === "done") {
        await settle({});
        return "moved";
      }
      /*
       * Событие исчезло из календаря или трогать его некому (разрешение
       * снято): ссылка ведёт в никуда — лучше пусто, чем закрытая дверь.
       */
      await settle({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null });
      return "unlinked";
    }

    /*
     * Другой специалист. Сначала убирается прежнее событие — и это
     * фиксируется в строке до создания нового: повтор после сбоя на создании
     * не удалит и не создаст второй раз.
     */
    const removed = await deleteMeetEvent(row.meetingOrganizerId, row.meetingEventId);
    if (removed === "failed") return postpone();
    await db
      .update(appointments)
      .set({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null })
      .where(eq(appointments.id, row.id));
    return recreate();
  });
}

/**
 * Пометить приём «календарь ждёт сведения» и свести сразу.
 *
 * Метка ставится первой и отдельной записью: если сведение упадёт
 * исключением, не дойдя до своих записей, строка всё равно останется в
 * очереди фонового прохода.
 */
export async function requestMeetSync(appointmentId: string): Promise<MeetSyncOutcome> {
  await asSystem(() =>
    db
      .update(appointments)
      .set({ meetingSyncAt: new Date().toISOString() })
      .where(and(eq(appointments.id, appointmentId), isNotNull(appointments.meetingEventId))),
  );
  return syncMeeting(appointmentId);
}

/** Фоновый проход: довести до конца то, что не удалось из запроса */
export async function syncDueMeetings(now = new Date()): Promise<{ attempted: number; settled: number }> {
  const due = await systemContext(baseDb, () =>
    baseDb
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(isNotNull(appointments.meetingSyncAt), lte(appointments.meetingSyncAt, now.toISOString())))
      .orderBy(appointments.meetingSyncAt, appointments.id)
      .limit(BATCH),
  );
  let settled = 0;
  for (const { id } of due) {
    try {
      const outcome = await systemContext(baseDb, () => syncMeeting(id));
      if (outcome !== "failed") settled++;
    } catch (error) {
      log.warn("meet.sync_failed", { appointmentId: id, error: String(error) });
    }
  }
  return { attempted: due.length, settled };
}
