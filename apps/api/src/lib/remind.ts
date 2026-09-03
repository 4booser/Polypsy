import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { renderPush, type Lang } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { appointments, departments, responses, slots, specialistProfiles } from "../db/schema";
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
async function langsOfPatients(userIds: string[]): Promise<Map<string, Lang>> {
  const out = new Map<string, Lang>();
  if (!userIds.length) return out;
  /*
   * Одним запросом на всю рассылку, а не по запросу на человека.
   *
   * Проход берёт до 500 приёмов и идёт раз в минуту: на человека приходился
   * отдельный запрос за языком, то есть до 500 обращений к базе в минуту
   * ради одного поля. DISTINCT ON отдаёт последнее прохождение каждого
   * человека за один раз.
   */
  const rows = await db
    .selectDistinctOn([responses.userId], { userId: responses.userId, lang: responses.lang })
    .from(responses)
    .where(and(inArray(responses.userId, userIds), sql`${responses.lang} is not null`))
    .orderBy(responses.userId, desc(responses.submittedAt));
  for (const r of rows) if (r.userId && r.lang) out.set(r.userId, r.lang as Lang);
  return out;
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
  /*
   * Чтение — одной транзакцией, отправка — вне её.
   *
   * Отправка push уходит наружу по сети, и раньше весь проход, включая эти
   * пятьсот сетевых вызовов, шёл внутри одной транзакции: соединение из
   * пула держалось открытым всё это время. Ровно та беда, что уже описана
   * у почтового транспорта в notify.ts, — зависший поставщик уведомлений
   * съедал пул и останавливал API. Здесь она чинится границей: снимок
   * данных берётся разом, дальше каждая отправка живёт своей короткой
   * транзакцией — соединение занято на одно уведомление, а не на весь
   * проход, и заявка на отправку фиксируется сразу, а не спустя пятьсот
   * сетевых вызовов.
   */
  const { rows, tz, langs } = await systemContext(baseDb, async () => {
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
    if (!rows.length) return { rows, tz: new Map<string, string>(), langs: new Map<string, Lang>() };

    // часовые пояса отделений — одним запросом, а не по запросу на отделение
    const depIds = [...new Set(rows.map((r) => r.slot.departmentId))];
    const deps = await db
      .select({ id: departments.id, timezone: departments.timezone })
      .from(departments)
      .where(inArray(departments.id, depIds));
    const tz = new Map(deps.map((d) => [d.id, d.timezone ?? "Europe/Kyiv"]));

    const langs = await langsOfPatients([...new Set(rows.map((r) => r.a.patientId))]);
    return { rows, tz, langs };
  });

  if (!rows.length) return { day: 0, hour: 0 };

  let day = 0;
  let hour = 0;
  for (const r of rows) {
    const left = new Date(r.slot.startsAt).getTime() - now.getTime();
    // не проходил ничего — украинский, государственный язык учреждения
    const lang = langs.get(r.a.patientId) ?? "uk";
    const tzName = tz.get(r.slot.departmentId) ?? "Europe/Kyiv";
    const time = timeOf(r.slot.startsAt, tzName);
    const date = dateOf(r.slot.startsAt, tzName);
    const room = r.room ? renderPush("push.room", lang, { room: r.room }) : "";

    if (left <= HOUR_AHEAD_MS) {
      const sent = await systemContext(baseDb, () =>
        pushToUser(r.a.patientId, {
          eventKey: `appointment:${r.a.id}:hour`,
          kind: "appointment",
          title: renderPush("push.appointmentSoonTitle", lang),
          body: renderPush("push.appointmentSoonBody", lang, { time, room }),
          path: "/appointments",
        }),
      );
      if (sent) hour += 1;
      continue;
    }

    /*
     * Напоминание за сутки не шлётся тому, кто записался в последний час:
     * иначе он получил бы оба сразу — «завтра приём» и «приём через час» — и
     * первое было бы просто неправдой.
     */
    const sent = await systemContext(baseDb, () =>
      pushToUser(r.a.patientId, {
        eventKey: `appointment:${r.a.id}:day`,
        kind: "appointment",
        title: renderPush("push.appointmentDayTitle", lang),
        body: renderPush("push.appointmentDayBody", lang, { date, time, room }),
        path: "/appointments",
      }),
    );
    if (sent) day += 1;
  }

  if (day || hour) log.info("clinic.reminders_sent", { day, hour });
  return { day, hour };
}
