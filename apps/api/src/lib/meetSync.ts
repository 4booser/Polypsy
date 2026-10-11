import { and, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
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
 * Сколько фоновое сведение держит приём за собой, пока ходит в Google
 * (#204). Самое длинное сведение — пересоздание: два обмена токена, удаление
 * и создание, по 8 с на вызов (meet.ts) — полминуты; две минуты — с запасом.
 * Процесс, умерший посреди сведения, отпускает приём сам: по истечении
 * захвата строка снова «ждёт сведения», как после неудачи.
 */
const LEASE_MS = 2 * 60_000;

type Found = { row: typeof appointments.$inferSelect; slot: typeof slots.$inferSelect };
type AppointmentSet = Partial<typeof appointments.$inferInsert>;

/** Что сведение уже сделало в Google к моменту, когда записать итог не вышло */
interface Effect {
  /** Событие создано — а приём на него не ссылается */
  created?: { eventId: string; url: string; organizerId: string };
  /** Событие перенесено или удалено */
  touched?: boolean;
}

/**
 * Куда сведение пишет итог. `write` — false, если приём за время похода в
 * Google изменился и итог, посчитанный по прежнему состоянию, не записан;
 * тогда `lost` разбирается с тем, что в Google уже сделано.
 */
interface Sink {
  write(set: AppointmentSet): Promise<boolean>;
  lost(effect: Effect): Promise<void>;
}

/**
 * Приём со слотом — под замком строки приёма до конца транзакции (#152).
 *
 * Прежде сведение читало приём без замка, ходило в Google и записывало итог
 * по id. Два фоновых прохода над приёмом, ждущим пересоздания встречи,
 * создавали два события — приём ссылался на одно, второе оставалось сиротой
 * в календаре врача; проход, наложившийся на перенос, записывал итог,
 * посчитанный по прежнему состоянию, поверх события, только что созданного
 * запросом.
 *
 * Запрос (dueBy не задан) строку уже держит — её только что изменил
 * moveAppointment, — замок тут лишь подтверждается, и сводит запрос в своей
 * транзакции. Фоновый проход (dueBy задан) занятую строку пропускает (SKIP
 * LOCKED): её сводит тот, кто держит. Условие «всё ещё ждёт к сроку»
 * PostgreSQL проверяет по последней версии строки: проход, прочитавший
 * очередь до чужой фиксации, сведённый приём не трогает. Дальше фоновый
 * проход держит приём не замком, а захватом (claimDue).
 */
async function claim(appointmentId: string, dueBy: Date | null) {
  const query = db
    .select({ row: appointments, slot: slots })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(
      dueBy
        ? and(
            eq(appointments.id, appointmentId),
            isNotNull(appointments.meetingSyncAt),
            lte(appointments.meetingSyncAt, dueBy.toISOString()),
          )
        : eq(appointments.id, appointmentId),
    );
  const [found] = dueBy
    ? await query.for("update", { of: appointments, skipLocked: true })
    : await query.for("update", { of: appointments });
  return found;
}

/**
 * Свести событие одного приёма с его текущим состоянием — из запроса.
 *
 * Системной ролью: отменяет приём и пациент, а чужие строки календаря и
 * приём после смены специалиста ему под своей ролью не видны. Наружу —
 * только итог для журнала.
 *
 * Здесь Google по-прежнему зовётся внутри транзакции запроса, под замком
 * строки приёма (#204 оставил так намеренно): итог сведения пишется в
 * журнал действия той же транзакцией, а перенос и отмена должны отвечать
 * человеку уже сведённым календарём. Вынести сеть из запроса — значит
 * отвечать раньше, чем календарь сведён, и журналировать итог, которого
 * ещё нет. Предел — по 8 с на вызов (meet.ts), и держится одна строка.
 */
export async function syncMeeting(appointmentId: string): Promise<MeetSyncOutcome> {
  return asSystem(async () => {
    const found = await claim(appointmentId, null);
    if (!found) return "nothing";
    return reconcile(found, inPlace(appointmentId));
  });
}

/** Итог — прямо в строку, которую держит транзакция запроса */
function inPlace(appointmentId: string): Sink {
  return {
    write: async (set) => {
      await db.update(appointments).set(set).where(eq(appointments.id, appointmentId));
      return true;
    },
    lost: async () => {},
  };
}

/** Свести приём по прочитанному состоянию; итоги — через sink */
async function reconcile(found: Found, sink: Sink): Promise<MeetSyncOutcome> {
  const { row, slot } = found;

  const settle = async (set: AppointmentSet, outcome: MeetSyncOutcome, effect: Effect = {}) => {
    if (!(await sink.write({ ...set, meetingSyncAt: null, meetingSyncAttempts: 0 }))) await sink.lost(effect);
    return outcome;
  };
  const postpone = async () => {
    const written = await sink.write({
      meetingSyncAt: new Date(Date.now() + retryDelay(row.meetingSyncAttempts)).toISOString(),
      meetingSyncAttempts: row.meetingSyncAttempts + 1,
    });
    if (!written) await sink.lost({});
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
      return settle(
        { meetingUrl: created.url, meetingEventId: created.eventId, meetingOrganizerId: row.specialistId },
        "recreated",
        created.eventId ? { created: { eventId: created.eventId, url: created.url, organizerId: row.specialistId } } : {},
      );
    }
    // у специалиста календаря нет: ссылки нет, он впишет свою
    return settle({}, "unlinked");
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
    return settle({}, "nothing");
  }

  /* отмена: событие убирается из календаря организатора */
  if (row.status === "cancelled") {
    const outcome = await deleteMeetEvent(row.meetingOrganizerId, row.meetingEventId);
    if (outcome === "failed") return postpone();
    return settle({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null }, "deleted", {
      touched: outcome === "done",
    });
  }

  /* тот же организатор: событие переезжает на время слота */
  if (row.meetingOrganizerId === row.specialistId) {
    const outcome = await moveMeetEvent(row.meetingOrganizerId, row.meetingEventId, slot.startsAt, slot.endsAt);
    if (outcome === "failed") return postpone();
    if (outcome === "done") return settle({}, "moved", { touched: true });
    /*
     * Событие исчезло из календаря или трогать его некому (разрешение
     * снято): ссылка ведёт в никуда — лучше пусто, чем закрытая дверь.
     */
    return settle({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null }, "unlinked");
  }

  /*
   * Другой специалист. Сначала убирается прежнее событие — и это
   * фиксируется в строке до создания нового: повтор после сбоя на создании
   * не удалит и не создаст второй раз.
   */
  const removed = await deleteMeetEvent(row.meetingOrganizerId, row.meetingEventId);
  if (removed === "failed") return postpone();
  if (!(await sink.write({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null }))) {
    await sink.lost({ touched: removed === "done" });
    return "failed";
  }
  return recreate();
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

/* ─────────── фоновый проход: захват вместо замка (#204) ─────────── */

/**
 * Захватить приём, ждущий сведения, — короткой транзакцией.
 *
 * Прежде фоновый проход держал строку приёма замком всё время своих
 * обращений к Google (#152): до 8 с на вызов, до четырёх вызовов на
 * пересоздание, — с открытой транзакцией и соединением пула. Перенос или
 * отмена того же приёма стояли за этим замком, а проходы, наложившиеся друг
 * на друга, держали по соединению каждый. Теперь замок — только на время
 * захвата: метка «ждёт сведения» сдвигается на срок захвата (LEASE_MS), и
 * захваченный приём не попадает в очередь соседнего прохода, пока захват
 * не истёк. Срок — он же отметка захвата: итог записывается, только пока
 * метка равна ему (leased).
 */
async function claimDue(appointmentId: string, now: Date): Promise<{ found: Found; lease: string } | null> {
  return systemContext(baseDb, async () => {
    const found = await claim(appointmentId, now);
    if (!found) return null;
    const lease = new Date(now.getTime() + LEASE_MS).toISOString();
    await db.update(appointments).set({ meetingSyncAt: lease }).where(eq(appointments.id, appointmentId));
    return { found, lease };
  });
}

/**
 * Итоги фонового сведения — каждый своей короткой транзакцией и только
 * пока приём всё ещё наш.
 *
 * «Наш» — метка «ждёт сведения» равна сроку нашего захвата (её
 * перебивает запрос, изменивший приём: перенос и отмена ставят метку
 * заново и сводят сами), а слот, специалист и отмена — те, по которым
 * считалось сведение (запрос мог сменить их, не трогая метку, — у приёма
 * без события). Иначе итог посчитан по прежнему состоянию, и записать его
 * значило бы вернуть гонку #152; тогда `lost`:
 *
 *   — событие создано, а приём на него не ссылается: если у приёма события
 *     нет — берём это (и просим сведения: оно приведёт событие к нынешнему
 *     слоту и специалисту), иначе — удаляем, чтобы в календаре врача не
 *     осталось сироты;
 *   — событие перенесено или удалено: его мог успеть свести запрос, и наш
 *     вызов, пришедший в Google позже, перебил бы его, — просим сведения
 *     заново, если никто другой его уже не ждёт; оно повторяемо;
 *   — ничего не сделано, а захват ещё наш (сменился слот или специалист) —
 *     отпускаем приём к сведению сразу, не дожидаясь срока захвата.
 */
function leased(found: Found, lease: string): Sink & { superseded: boolean } {
  const { row } = found;
  const sink = {
    superseded: false,
    write: (set: AppointmentSet) =>
      systemContext(baseDb, async () => {
        const written = await db
          .update(appointments)
          .set(set)
          .where(
            and(
              eq(appointments.id, row.id),
              eq(appointments.meetingSyncAt, lease),
              eq(appointments.slotId, row.slotId),
              eq(appointments.specialistId, row.specialistId),
              row.status === "cancelled" ? eq(appointments.status, "cancelled") : ne(appointments.status, "cancelled"),
            ),
          )
          .returning({ id: appointments.id });
        if (!written.length) sink.superseded = true;
        return written.length > 0;
      }),
    lost: async (effect: Effect) => {
      const now = new Date().toISOString();
      const { created } = effect;
      if (created) {
        const adopted = await systemContext(baseDb, () =>
          db
            .update(appointments)
            .set({
              meetingEventId: created.eventId,
              meetingOrganizerId: created.organizerId,
              meetingUrl: created.url,
              meetingSyncAt: now,
            })
            .where(
              and(
                eq(appointments.id, row.id),
                isNull(appointments.meetingEventId),
                isNull(appointments.meetingUrl),
                ne(appointments.status, "cancelled"),
              ),
            )
            .returning({ id: appointments.id }),
        );
        if (adopted.length) return;
        const removed = await deleteMeetEvent(created.organizerId, created.eventId);
        if (removed === "failed") {
          log.warn("meet.orphan_event", { appointmentId: row.id, organizerId: created.organizerId, eventId: created.eventId });
        }
      }
      const changedGoogle = Boolean(created) || Boolean(effect.touched);
      await systemContext(baseDb, () =>
        db
          .update(appointments)
          .set({ meetingSyncAt: now })
          .where(
            and(
              eq(appointments.id, row.id),
              changedGoogle
                ? or(eq(appointments.meetingSyncAt, lease), isNull(appointments.meetingSyncAt))
                : eq(appointments.meetingSyncAt, lease),
            ),
          ),
      );
    },
  };
  return sink;
}

/**
 * Фоновый проход: довести до конца то, что не удалось из запроса.
 *
 * Сеть — вне транзакций (#204): захват приёма, промежуточная запись и итог
 * — короткими транзакциями, а Google зовётся между ними, без открытой
 * транзакции и без соединения пула. Перенос или отмена приёма, пришедшие,
 * пока проход ждёт Google, не ждут его: они сводят календарь сами, а итог
 * прохода, посчитанный по прежнему состоянию, не записывается (leased).
 *
 * Очередь читается в системном контексте через db, а не мимо него через
 * baseDb: прежде чтение шло пулом без контекста, и под ролью приложения
 * политика приёмов не отдавала ни одной строки — проход в бою не видел
 * очереди вовсе (сюита ходила владельцем и этого не замечала).
 */
export async function syncDueMeetings(now = new Date()): Promise<{ attempted: number; settled: number }> {
  const due = await systemContext(baseDb, () =>
    db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(isNotNull(appointments.meetingSyncAt), lte(appointments.meetingSyncAt, now.toISOString())))
      .orderBy(appointments.meetingSyncAt, appointments.id)
      .limit(BATCH),
  );
  let settled = 0;
  for (const { id } of due) {
    try {
      // занятую строку сводит тот, кто её держит; сведённую или захваченную за время прохода — уже некому (см. claim)
      const claimed = await claimDue(id, now);
      if (!claimed) continue;
      const sink = leased(claimed.found, claimed.lease);
      const outcome = await reconcile(claimed.found, sink);
      if (outcome !== "failed" && !sink.superseded) settled++;
    } catch (error) {
      log.warn("meet.sync_failed", { appointmentId: id, error: String(error) });
    }
  }
  return { attempted: due.length, settled };
}
