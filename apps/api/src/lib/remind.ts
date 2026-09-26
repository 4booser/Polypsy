import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { LOCALE_OF, renderPush, type Lang } from "@quizzy/shared";
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
 * На каком языке писать человеку, если устройство своего языка не прислало.
 *
 * Главный источник теперь — само устройство: язык приходит с регистрацией
 * для уведомлений и хранится в push_tokens.lang (миграция 0087), и текст
 * собирается под каждое устройство в pushToUser. Эта функция — запасной путь
 * для устройств, зарегистрированных до миграции.
 *
 * Запасной путь прежний: язык последнего прохождения — собственный выбор
 * человека, сделанный в этой же системе. Не проходил ничего — украинский,
 * государственный язык учреждения. Английского он не даст никогда:
 * прохождение записывает язык текста методики, а английского текста у
 * методик нет. Поэтому он и запасной, а не главный.
 */
export async function langsOfPatients(userIds: string[]): Promise<Map<string, Lang>> {
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

function timeOf(iso: string, timezone: string, lang: Lang): string {
  return new Date(iso).toLocaleTimeString(LOCALE_OF[lang], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
}

/** Дата приёма по часам отделения: «12.09» (по-английски — «12/09», день первым, см. LOCALE_OF) */
function dateOf(iso: string, timezone: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(LOCALE_OF[lang], {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
  });
}

/** Сколько приёмов берёт один проход */
const BATCH = 500;

/**
 * Где остановилась прошлая пачка: (начало слота, приём). Следующий проход
 * продолжает отсюда, а дойдя до конца очереди, начинает сначала.
 *
 * Без этого пачка топталась на месте. Кандидаты, которым не удалось
 * отправить (отказ провайдера снимает заявку — см. lib/push.ts), остаются
 * кандидатами, и если их набиралось на целую пачку, каждый проход брал их
 * же, а до остальных не доходил. В памяти процесса, а не в базе: после
 * перезапуска очередь просто начнётся сначала, и это никому не вредит.
 */
let reminderCursor: { at: string; id: string } | null = null;

/**
 * Разослать напоминания.
 *
 * Повторов не боится: `pushToUser` отсекает по ключу события, и ключ здесь
 * привязан к приёму, ВРЕМЕНИ его слота и сроку —
 * `appointment:<id>:<время слота UTC>:day`. Тик рассыльщика минутный, и без
 * этой защиты человек получал бы напоминание каждую минуту последних суток.
 *
 * Время слота в ключе — ради переноса. Перенос сохраняет номер приёма, и с
 * ключом `appointment:<id>:day` напоминание о НОВОМ времени считалось уже
 * отправленным: человек помнил старое время, а о новом ему не напоминал
 * никто.
 *
 * `batch` — размер пачки; тестам, чтобы проверить очередь без пятисот строк.
 */
export async function remindAppointments(
  now = new Date(),
  batch = BATCH,
): Promise<{ day: number; hour: number }> {
  const hourAhead = new Date(now.getTime() + HOUR_AHEAD_MS).toISOString();
  /** Какое напоминание сейчас положено: «через час» или «за сутки» */
  const due = sql<"hour" | "day">`(case when ${slots.startsAt} <= ${hourAhead} then 'hour' else 'day' end)`;
  const eventKey = sql<string>`('appointment:' || ${appointments.id} || ':'
    || to_char(${slots.startsAt} at time zone 'UTC', 'YYYYMMDD"T"HH24MISS') || ':' || ${due})`;
  /*
   * Ключи, записанные до времени в ключе (`appointment:<id>:day`), тоже
   * считаются: иначе в день выкатки все приёмы ближайших суток получили бы
   * напоминание второй раз. Через сутки после выкатки таких ключей у
   * будущих приёмов не останется, и условие можно убрать.
   */
  const legacyKey = sql<string>`('appointment:' || ${appointments.id} || ':' || ${due})`;
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
    /*
     * Кандидат — только тот, кому есть куда слать и кому положенное сейчас
     * напоминание ещё не ушло. Оба условия — ДО лимита пачки.
     *
     * Прежде лимит резал выборку раньше: в пятьсот попадали приёмы, чьё
     * напоминание уже ушло, и люди без устройства (заявки у них не
     * появляется — слать некуда), и в следующую минуту пачку занимали они
     * же. В отделении, где на сутки вперёд больше пятисот приёмов, остальные
     * не получали напоминаний вовсе — в том числе «через час».
     *
     * Порядок — по началу приёма: ближайшие первыми.
     */
    const select = (after: { at: string; id: string } | null) =>
      db
        .select({ a: appointments, slot: slots, room: specialistProfiles.room, due, eventKey })
        .from(appointments)
        .innerJoin(slots, eq(slots.id, appointments.slotId))
        .leftJoin(specialistProfiles, eq(specialistProfiles.userId, appointments.specialistId))
        .where(
          and(
            inArray(appointments.status, ["booked", "confirmed"]),
            gt(slots.startsAt, now.toISOString()),
            lte(slots.startsAt, new Date(now.getTime() + DAY_AHEAD_MS).toISOString()),
            sql`exists (select 1 from push_tokens pt where pt.user_id = ${appointments.patientId})`,
            sql`not exists (select 1 from push_deliveries pd
                  where pd.user_id = ${appointments.patientId}
                    and pd.event_key in (${eventKey}, ${legacyKey}))`,
            after ? sql`(${slots.startsAt}, ${appointments.id}) > (${after.at}::timestamptz, ${after.id})` : undefined,
          ),
        )
        .orderBy(slots.startsAt, appointments.id)
        .limit(batch);
    let rows = await select(reminderCursor);
    // хвост после прошлой пачки пуст — очередь сначала
    if (!rows.length && reminderCursor) rows = await select(null);
    const last = rows.at(-1);
    reminderCursor = rows.length >= batch && last ? { at: last.slot.startsAt, id: last.a.id } : null;
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
    // для устройств без своего языка; не проходил ничего — украинский
    const fallback = langs.get(r.a.patientId) ?? "uk";
    const tzName = tz.get(r.slot.departmentId) ?? "Europe/Kyiv";
    /*
     * Всё, что зависит от языка, — функциями: текст собирается под каждое
     * устройство отдельно (pushToUser), а формат даты и слово «каб.» — часть
     * этого текста.
     */
    const time = (lang: Lang) => timeOf(r.slot.startsAt, tzName, lang);
    const date = (lang: Lang) => dateOf(r.slot.startsAt, tzName, lang);
    const room = (lang: Lang) => (r.room ? renderPush("push.room", lang, { room: r.room }) : "");

    // какое напоминание и под каким ключом — посчитано в запросе, тем же выражением, что отсеивает ушедшие
    if (r.due === "hour") {
      const sent = await systemContext(baseDb, () =>
        pushToUser(
          r.a.patientId,
          {
            eventKey: r.eventKey,
            kind: "appointment",
            title: (lang) => renderPush("push.appointmentSoonTitle", lang),
            body: (lang) => renderPush("push.appointmentSoonBody", lang, { time: time(lang), room: room(lang) }),
            path: "/appointments",
          },
          fallback,
        ),
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
      pushToUser(
        r.a.patientId,
        {
          eventKey: r.eventKey,
          kind: "appointment",
          title: (lang) => renderPush("push.appointmentDayTitle", lang),
          body: (lang) =>
            renderPush("push.appointmentDayBody", lang, { date: date(lang), time: time(lang), room: room(lang) }),
          path: "/appointments",
        },
        fallback,
      ),
    );
    if (sent) day += 1;
  }

  if (day || hour) log.info("clinic.reminders_sent", { day, hour });
  return { day, hour };
}
