import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  appointments,
  departments,
  scheduleExceptions,
  scheduleTemplates,
  slots,
  specialistProfiles,
} from "../db/schema";

/**
 * Генерация слотов из шаблона недели.
 *
 * Расписание задаётся стенными часами: «приём с девяти до часу». Слоты
 * генерируются на восемь недель вперёд — то есть заведомо через перевод
 * часов. Поэтому перевод стенного времени в момент делает Postgres через
 * часовой пояс отделения, а не сложение смещения в JS: сложение уводит
 * половину осени на час, причём молча — даты правдоподобные, приёмы не те.
 *
 * В JS остаётся только календарная арифметика, где часовых поясов нет вовсе:
 * какие даты попадают в окно и какие стенные времена внутри дня. Это делит
 * задачу по линии, где ошибиться нечем.
 */

/** На сколько вперёд держим сетку. Восемь недель — два месяца записи. */
export const HORIZON_WEEKS = 8;

interface Interval {
  /** Стенное время начала, HH:MM */
  from: string;
  /** Стенное время конца, HH:MM */
  to: string;
  slotMinutes: number;
  kind: "primary" | "repeat" | "any";
  capacity: number;
}

/** Календарная дата без времени и без пояса: с ней часовых ошибок не бывает */
function dateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** ISO-номер дня недели: 1 — понедельник, 7 — воскресенье */
function isoWeekday(d: Date): number {
  const day = d.getUTCDay();
  return day === 0 ? 7 : day;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Время из Postgres приходит как HH:MM:SS — нам нужны часы и минуты */
function hhmm(raw: string): string {
  return raw.slice(0, 5);
}

/**
 * Что именно вычесть из интервала.
 *
 * Отпуск на весь день убирает его целиком; отпуск с часами вырезает середину
 * и может разорвать один интервал на два — поэтому возвращается список, а не
 * один интервал.
 */
function subtract(interval: Interval, off: { from: string; to: string } | null): Interval[] {
  if (!off) return [];
  const a = toMinutes(interval.from);
  const b = toMinutes(interval.to);
  const x = toMinutes(off.from);
  const y = toMinutes(off.to);
  if (y <= a || x >= b) return [interval];
  const parts: Interval[] = [];
  if (x > a) parts.push({ ...interval, from: interval.from, to: fromMinutes(x) });
  if (y < b) parts.push({ ...interval, from: fromMinutes(y), to: interval.to });
  return parts;
}

/** Желаемая сетка на один день: шаблон дня недели минус отпуска плюс дополнительные часы */
export function intervalsForDay(
  weekday: number,
  templates: (Interval & { weekday: number })[],
  offs: { from: string | null; to: string | null }[],
  extras: Interval[],
): Interval[] {
  let result: Interval[] = templates.filter((t) => t.weekday === weekday).map((t) => ({ ...t }));

  for (const off of offs) {
    // отпуск без часов — весь день целиком
    if (!off.from || !off.to) return extras;
    result = result.flatMap((i) => subtract(i, { from: off.from!, to: off.to! }));
  }
  return [...result, ...extras];
}

/** Разбивка интервала на слоты. Хвост короче слота отбрасывается: приём в 20 минут вместо 50 — это не приём. */
export function sliceInterval(interval: Interval): { from: string; to: string }[] {
  const start = toMinutes(interval.from);
  const end = toMinutes(interval.to);
  const out: { from: string; to: string }[] = [];
  for (let t = start; t + interval.slotMinutes <= end; t += interval.slotMinutes) {
    out.push({ from: fromMinutes(t), to: fromMinutes(t + interval.slotMinutes) });
  }
  return out;
}

interface Wanted {
  date: string;
  from: string;
  to: string;
  kind: "primary" | "repeat" | "any";
  capacity: number;
}

/** Желаемая сетка специалиста на окно вперёд — в стенных часах, без поясов */
export async function plannedSlots(specialistId: string, weeks = HORIZON_WEEKS): Promise<Wanted[]> {
  const templates = await db
    .select()
    .from(scheduleTemplates)
    .where(eq(scheduleTemplates.specialistId, specialistId));

  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const to = new Date(from.getTime() + weeks * 7 * 24 * 3600 * 1000);

  const exceptions = await db
    .select()
    .from(scheduleExceptions)
    .where(
      and(
        eq(scheduleExceptions.specialistId, specialistId),
        gte(scheduleExceptions.date, dateKey(from)),
        lt(scheduleExceptions.date, dateKey(to)),
      ),
    );

  const dayTemplates = templates.map((t) => ({
    weekday: t.weekday,
    from: hhmm(t.startsAt),
    to: hhmm(t.endsAt),
    slotMinutes: t.slotMinutes,
    kind: t.kind,
    capacity: t.capacity,
  }));

  const wanted: Wanted[] = [];
  for (let d = new Date(from); d < to; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = dateKey(d);
    const dayExceptions = exceptions.filter((e) => e.date === key);
    const offs = dayExceptions
      .filter((e) => e.kind === "off")
      .map((e) => ({ from: e.startsAt ? hhmm(e.startsAt) : null, to: e.endsAt ? hhmm(e.endsAt) : null }));
    const extras = dayExceptions
      .filter((e) => e.kind === "extra")
      .map((e) => ({
        from: hhmm(e.startsAt!),
        to: hhmm(e.endsAt!),
        slotMinutes: e.slotMinutes ?? 50,
        kind: "any" as const,
        capacity: 1,
      }));

    const intervals = intervalsForDay(isoWeekday(d), dayTemplates, offs, extras);
    for (const interval of intervals) {
      for (const piece of sliceInterval(interval)) {
        wanted.push({ date: key, from: piece.from, to: piece.to, kind: interval.kind, capacity: interval.capacity });
      }
    }
  }
  return wanted;
}

/**
 * Привести сетку слотов специалиста к шаблону.
 *
 * Идемпотентна: повторный прогон ничего не меняет. Держится это на уникальном
 * индексе (specialist_id, starts_at) — дубликат физически невозможен, а не
 * «мы стараемся его не вставить».
 *
 * Три действия, и третье — самое важное:
 *  — недостающие слоты добавляются;
 *  — свободные слоты, выпавшие из расписания, удаляются;
 *  — занятые, выпавшие из расписания, ОСТАЮТСЯ и помечаются.
 *
 * Молчаливая отмена чужого приёма недопустима ни при каких обстоятельствах, а
 * «сузил приёмные часы задним числом» — самый вероятный способ её устроить.
 * Поэтому занятый слот вне расписания живёт дальше и подсвечивается:
 * переносить или оставить решает человек.
 */
export async function syncSlots(
  specialistId: string,
  weeks = HORIZON_WEEKS,
): Promise<{ added: number; removed: number; flagged: number }> {
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, specialistId),
  });
  if (!profile) return { added: 0, removed: 0, flagged: 0 };

  const department = await db.query.departments.findFirst({
    where: eq(departments.id, profile.departmentId),
  });
  if (!department) return { added: 0, removed: 0, flagged: 0 };

  const tz = department.timezone;
  const wanted = await plannedSlots(specialistId, weeks);

  const today = new Date();
  const windowFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const windowTo = new Date(windowFrom.getTime() + weeks * 7 * 24 * 3600 * 1000);

  let added = 0;
  if (wanted.length) {
    /*
     * Перевод стенного времени в момент — здесь, одним выражением Postgres.
     * `at time zone` знает про переводы часов; сложение смещения — нет.
     */
    const rows = wanted.map((w) => ({
      id: crypto.randomUUID(),
      specialistId,
      departmentId: profile.departmentId,
      startsAt: sql`(${`${w.date} ${w.from}`}::timestamp at time zone ${tz})`,
      endsAt: sql`(${`${w.date} ${w.to}`}::timestamp at time zone ${tz})`,
      kind: w.kind,
      capacity: w.capacity,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const result = await db
        .insert(slots)
        .values(chunk as never)
        .onConflictDoNothing()
        .returning({ id: slots.id });
      added += result.length;
    }
  }

  // что должно быть — в виде набора моментов, посчитанных той же базой
  const wantedKeys = new Set(
    wanted.length
      ? (
          await db.execute<{ at: string }>(
            sql`select unnest(array[${sql.join(
              wanted.map((w) => sql`(${`${w.date} ${w.from}`}::timestamp at time zone ${tz})`),
              sql`, `,
            )}]) as at`,
          )
        ).map((r) => new Date(r.at).toISOString())
      : [],
  );

  const existing = await db
    .select({ id: slots.id, startsAt: slots.startsAt, offSchedule: slots.offSchedule })
    .from(slots)
    .where(
      and(
        eq(slots.specialistId, specialistId),
        gte(slots.startsAt, windowFrom.toISOString()),
        lt(slots.startsAt, windowTo.toISOString()),
      ),
    );

  /*
   * Снятая пометка считается первой и безусловно.
   *
   * Первая редакция сняла её последней — после раннего выхода «нечего
   * удалять», — и специалист, вернувший часы обратно, продолжал видеть
   * тревогу на слоте, который давно в расписании. Проверка «возвращённые
   * часы снимают пометку» это и поймала: в установившемся состоянии удалять
   * действительно нечего, и весь хвост не выполнялся никогда.
   */
  const backIn = existing
    .filter((s) => s.offSchedule && wantedKeys.has(new Date(s.startsAt).toISOString()))
    .map((s) => s.id);
  if (backIn.length) {
    await db.update(slots).set({ offSchedule: false }).where(inArray(slots.id, backIn));
  }

  const stale = existing.filter((s) => !wantedKeys.has(new Date(s.startsAt).toISOString()));
  if (!stale.length) return { added, removed: 0, flagged: 0 };

  const live = await db
    .select({ slotId: appointments.slotId })
    .from(appointments)
    .where(
      and(
        inArray(appointments.slotId, stale.map((s) => s.id)),
        sql`${appointments.status} <> 'cancelled'`,
      ),
    );
  const busy = new Set(live.map((a) => a.slotId));

  const toRemove = stale.filter((s) => !busy.has(s.id)).map((s) => s.id);
  const toFlag = stale.filter((s) => busy.has(s.id) && !s.offSchedule).map((s) => s.id);

  /*
   * Удаляем с проверкой занятости в самом операторе, а не по списку,
   * прочитанному выше.
   *
   * Между чтением занятых слотов и удалением проходит время, и в это окно
   * пациент может записаться на слот, который мы уже решили удалить. У
   * `appointments.slot_id` стоит `on delete cascade`, поэтому удаление
   * слота уносит и приём — молча, без строки в журнале, без уведомления.
   * Пациент при этом видел на экране «вы записаны».
   *
   * Это ровно та «молчаливая отмена чужого приёма», которую пояснение к
   * `offSchedule` объявляет недопустимой ни при каких обстоятельствах:
   * пометка защищала от последовательного случая, но не от параллельного.
   *
   * Условие в самом DELETE закрывает окно; ключ базы (`on delete restrict`)
   * закрывает его окончательно, чем бы гонка ни кончилась. Здесь учитывается
   * ЛЮБОЙ приём, включая отменённый: он тоже история, и удаление слота под
   * ним упёрлось бы во внешний ключ.
   */
  let removedSlots: { id: string }[] = [];
  if (toRemove.length) {
    removedSlots = await db
      .delete(slots)
      .where(
        and(
          inArray(slots.id, toRemove),
          sql`not exists (
            select 1 from appointments a where a.slot_id = ${slots.id}
          )`,
        ),
      )
      .returning({ id: slots.id });
  }
  /*
   * Кого записали в последний момент — помечаем «вне расписания», как и
   * тех, кто был занят на момент чтения. Иначе слот остался бы обычным, и
   * специалист не увидел бы, что приём выпал из его часов.
   */
  const survived = toRemove.filter((id) => !removedSlots.some((r) => r.id === id));
  if (survived.length) {
    await db.update(slots).set({ offSchedule: true }).where(inArray(slots.id, survived));
  }
  if (toFlag.length) {
    await db.update(slots).set({ offSchedule: true }).where(inArray(slots.id, toFlag));
  }

  // считаем удалённые по факту, а не по намерению: часть могла уцелеть
  // из-за записи, появившейся между чтением и удалением
  return {
    added,
    removed: removedSlots.length,
    flagged: toFlag.length + survived.length,
  };
}
