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

/**
 * Развести истёкшие приёмы по неявкам.
 *
 * Возвращает число разведённых. Идемпотентна: приём, уже переведённый в
 * no_show, второй раз не берётся, а отмеченный «пришёл» не берётся вовсе.
 */
export async function sweepNoShows(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - NO_SHOW_GRACE_HOURS * 3600_000).toISOString();

  const stale = await db
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(
      and(
        inArray(appointments.status, ["booked", "confirmed"]),
        lt(slots.endsAt, cutoff),
      ),
    )
    .limit(500);

  if (!stale.length) return 0;

  await db
    .update(appointments)
    .set({ status: "no_show" })
    .where(inArray(appointments.id, stale.map((r) => r.id)));

  log.info("clinic.no_show_swept", { count: stale.length });
  return stale.length;
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
