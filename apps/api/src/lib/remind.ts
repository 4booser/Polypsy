import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { renderPush, type Lang } from "@quizzy/shared";
import { db } from "../db";
import { appointments, responses, slots, specialistProfiles, users } from "../db/schema";
import { log } from "./log";
import { pushToUser } from "./push";

/**
 * Напоминания о приёме.
 *
 * Только push: внешних шлюзов нет, номера телефонов наружу не уходят, и
 * анонимный аккаунт получает напоминания наравне со всеми.
 *
 * Цена решения признана вслух: у кого приложение не стоит или уведомления
 * запрещены — напоминания нет. Гасится это не вторым каналом, а
 * подтверждением: пациент подтверждает приём одним нажатием, и в «Сегодня»
 * неподтверждённые видны отдельно. Специалист смотрит на факт подтверждения,
 * а не на факт отправки — отправленный push и прочитанный push это разные
 * вещи, и показывать первое вместо второго значит врать.
 */

/** За сутки — успеть перенести и пройти назначенное; за час — успеть дойти */
const DAY_AHEAD_MS = 24 * 3600_000;
const HOUR_AHEAD_MS = 3600_000;

/**
 * На каком языке писать человеку.
 *
 * Отдельного поля языка у учётной записи нет, а рассылка идёт без запроса —
 * взять язык из заголовка неоткуда. Берём тот, на котором человек последний
 * раз проходил методику: это его собственный выбор, сделанный в этой же
 * системе. Не проходил ничего — украинский, государственный язык учреждения.
 */
async function langOfPatient(userId: string): Promise<Lang> {
  const [row] = await db
    .select({ lang: responses.lang })
    .from(responses)
    .where(and(eq(responses.userId, userId), sql`${responses.lang} is not null`))
    .orderBy(desc(responses.submittedAt))
    .limit(1);
  return (row?.lang as Lang) ?? "uk";
}

function timeOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}

/** Дата приёма по часам отделения: «12.09» */
function dateOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
  });
}

/**
 * Разослать напоминания.
 *
 * Повторов не боится: `pushToUser` отсекает по ключу события, и ключ здесь
 * привязан к приёму и сроку — `appointment:<id>:day`. Тик рассыльщика
 * минутный, и без этой защиты человек получал бы напоминание каждую минуту
 * последних суток.
 */
export async function remindAppointments(now = new Date()): Promise<{ day: number; hour: number }> {
  const rows = await db
    .select({ a: appointments, slot: slots, room: specialistProfiles.room })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .leftJoin(specialistProfiles, eq(specialistProfiles.userId, appointments.specialistId))
    .where(
      and(
        inArray(appointments.status, ["booked", "confirmed"]),
        gt(slots.startsAt, now.toISOString()),
        lte(slots.startsAt, new Date(now.getTime() + DAY_AHEAD_MS).toISOString()),
      ),
    )
    .limit(500);

  if (!rows.length) return { day: 0, hour: 0 };

  const departments = new Map<string, string>();
  for (const r of rows) {
    if (!departments.has(r.slot.departmentId)) {
      const dep = await db.query.departments.findFirst({
        where: (d, { eq: e }) => e(d.id, r.slot.departmentId),
      });
      departments.set(r.slot.departmentId, dep?.timezone ?? "Europe/Kyiv");
    }
  }

  let day = 0;
  let hour = 0;
  for (const r of rows) {
    const left = new Date(r.slot.startsAt).getTime() - now.getTime();
    const lang = await langOfPatient(r.a.patientId);
    const tz = departments.get(r.slot.departmentId) ?? "Europe/Kyiv";
    const time = timeOf(r.slot.startsAt, tz);
    const date = dateOf(r.slot.startsAt, tz);
    const room = r.room ? renderPush("push.room", lang, { room: r.room }) : "";

    if (left <= HOUR_AHEAD_MS) {
      const sent = await pushToUser(r.a.patientId, {
        eventKey: `appointment:${r.a.id}:hour`,
        kind: "appointment",
        title: renderPush("push.appointmentSoonTitle", lang),
        body: renderPush("push.appointmentSoonBody", lang, { time, room }),
        path: "/appointments",
      });
      if (sent) hour += 1;
      continue;
    }

    /*
     * Напоминание за сутки не шлётся тому, кто записался в последний час:
     * иначе он получил бы оба сразу — «завтра приём» и «приём через час» — и
     * первое было бы просто неправдой.
     */
    const sent = await pushToUser(r.a.patientId, {
      eventKey: `appointment:${r.a.id}:day`,
      kind: "appointment",
      title: renderPush("push.appointmentDayTitle", lang),
      body: renderPush("push.appointmentDayBody", lang, { date, time, room }),
      path: "/appointments",
    });
    if (sent) day += 1;
  }

  if (day || hour) log.info("clinic.reminders_sent", { day, hour });
  return { day, hour };
}
