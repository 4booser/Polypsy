import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { appointments, slots } from "../db/schema";
import { log } from "./log";

/**
 * Неявка — не строка статистики, а повод.
 *
 * Слот кончился, никто ничего не нажал — приём уходит в no_show и попадает в
 * очередь работы отдельной задачей. В психологическом отделе переставший
 * приходить — это чаще ухудшение, чем потеря интереса, и молчаливое
 * освобождение слота теряет ровно тот сигнал, ради которого отдел
 * существует.
 *
 * Никаких блокировок и упрёков пациенту: система обращается к специалисту.
 */

/**
 * Сколько ждать после конца приёма, прежде чем считать неявкой.
 *
 * Не ноль и не сутки. Ноль означал бы, что специалист, не успевший нажать
 * «пришёл» между двумя приёмами, получает неявку у человека, который сидит
 * перед ним. Сутки означали бы, что сигнал приходит завтра — то есть когда
 * позвонить уже поздно.
 *
 * Два часа: приём давно кончился, рабочий день ещё нет.
 */
export const NO_SHOW_GRACE_HOURS = 2;

/** Что делает приём неявкой: никто ничего не нажал, а его слот кончился до отсечки */
const PENDING = ["booked", "confirmed"] as const;

/**
 * Развести истёкшие приёмы по неявкам.
 *
 * Возвращает число разведённых — по факту записи, а не по выборке.
 * Идемпотентна: приём, уже переведённый в no_show, второй раз не берётся, а
 * отмеченный «пришёл» не берётся вовсе.
 *
 * Условие неявки проверяется в самом UPDATE, а не только в выборке.
 *
 * Прежде выборка находила booked/confirmed с истёкшим слотом, а запись шла
 * по списку идентификаторов — и всё, что случилось между ними, затиралось
 * (внешний разбор, решение заказчика 2026-09-26). Специалист отмечал
 * «пришёл» в ту секунду, когда проход уже выбрал приём, — и человеку,
 * сидевшему в кабинете, ставилась неявка; следом шло «вы пропустили приём».
 * Так же проход «доставал» приём, только что перенесённый на завтра: слот в
 * выборке был прежний, истёкший.
 *
 * Теперь запись повторяет оба условия — статус и истёкший слот, причём слот
 * нынешний, по slot_id строки в момент записи. Postgres, дождавшись замка
 * строки, перепроверяет WHERE на её свежей версии: отмеченный приход и
 * перенос выводят приём из-под условия, и запись его пропускает.
 */
export async function sweepNoShows(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NO_SHOW_GRACE_HOURS * 3600_000).toISOString();

  const stale = await db
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(and(inArray(appointments.status, [...PENDING]), lt(slots.endsAt, cutoff)))
    .limit(500);

  if (!stale.length) return 0;

  const swept = await db
    .update(appointments)
    .set({ status: "no_show" })
    .where(
      and(
        inArray(
          appointments.id,
          stale.map((r) => r.id),
        ),
        inArray(appointments.status, [...PENDING]),
        sql`exists (
          select 1 from slots s
          where s.id = ${appointments.slotId} and s.ends_at < ${cutoff}::timestamptz
        )`,
      ),
    )
    .returning({ id: appointments.id });

  if (swept.length) log.info("clinic.no_show_swept", { count: swept.length, skipped: stale.length - swept.length });
  return swept.length;
}

/**
 * Кому неявка важнее.
 *
 * Если у человека за последний месяц срабатывала тревога риска, его неявка
 * идёт выше остальных: это тот случай, когда «перестал приходить» и «стало
 * хуже» — одно и то же событие, увиденное с разных сторон.
 */
export async function recentAlertPatients(patientIds: string[]): Promise<Set<string>> {
  if (!patientIds.length) return new Set();
  const rows = await db
    .select({ userId: sql<string>`ra.user_id` })
    .from(sql`risk_alerts ra`)
    .where(
      sql`ra.user_id in ${patientIds} and ra.at > now() - interval '30 days'`,
    );
  return new Set(rows.map((r) => r.userId));
}
