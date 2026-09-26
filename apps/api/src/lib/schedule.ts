import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { asSystem, dbContext } from "../db/context";
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

/**
 * Слоты одного дня без пересечений.
 *
 * Интервалы берутся по порядку — обычная неделя раньше дополнительных
 * часов, — и каждый следующий режется только по времени, которое ещё не
 * занято уже разложенными слотами. Без этого дополнительные часы 09:45–11:00
 * поверх обычных 09:00–10:00 давали 09:45–10:15 поверх 09:30–10:00: два
 * открытых слота на одни и те же четверть часа. Теперь такое не примет и
 * база (миграция 0105), и сетка обязана строиться так, чтобы ей нечего было
 * отвергать, — иначе дополнительные часы молча пропадали бы целиком.
 *
 * Вычитаются именно слоты, а не интервалы: отброшенный хвост обычного
 * интервала (09:50–10:10 при слотах по 50 минут) свободен, и дополнительные
 * часы вправе его занять.
 */
export function layOutDay(intervals: Interval[]): { from: string; to: string }[] {
  const laid: { from: string; to: string }[] = [];
  for (const interval of intervals) {
    let free: Interval[] = [interval];
    for (const piece of laid) free = free.flatMap((part) => subtract(part, piece));
    for (const part of free) laid.push(...sliceInterval(part));
  }
  return laid.sort((a, b) => toMinutes(a.from) - toMinutes(b.from));
}

interface Wanted {
  date: string;
  from: string;
  to: string;
}

/** Желаемая сетка специалиста на окно вперёд — в стенных часах, без поясов */
export async function plannedSlots(specialistId: string, weeks = HORIZON_WEEKS): Promise<Wanted[]> {
  // порядок важен: раскладка дня отдаёт время тому интервалу, что раньше
  const templates = await db
    .select()
    .from(scheduleTemplates)
    .where(eq(scheduleTemplates.specialistId, specialistId))
    .orderBy(asc(scheduleTemplates.startsAt), asc(scheduleTemplates.endsAt));

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
      }));

    const intervals = intervalsForDay(isoWeekday(d), dayTemplates, offs, extras);
    for (const piece of layOutDay(intervals)) {
      wanted.push({ date: key, from: piece.from, to: piece.to });
    }
  }
  return wanted;
}

/**
 * Правки расписания одного специалиста выполняются по одной.
 *
 * Транзакционный advisory-замок на специалиста. Две правки одной недели
 * одновременно — специалист у себя и регистратор за него — иначе
 * переплетались бы: удаление шаблона одной не видит вставку другой, и
 * неделя удваивается, а две синхронизации решают судьбу одних и тех же
 * слотов каждая по своему прочитанному. Берут его маршруты правки
 * расписания до того, как тронуть шаблон, и сама синхронизация; повторный
 * захват в той же транзакции ничего не ждёт.
 */
export async function lockSchedule(specialistId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`schedule:${specialistId}`}))`);
}

/**
 * Выполнить в транзакции: у запроса она уже есть (middleware/auth.ts), у
 * посева и прямого вызова из тестов — нет. Замки синхронизации без
 * транзакции отпускались бы в конце своего же оператора и не держали бы
 * ничего.
 */
async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (dbContext.getStore()) return fn();
  return baseDb.transaction((tx) => dbContext.run(tx, fn));
}

interface Span {
  startsAt: string;
  endsAt: string;
}

/**
 * Ключ слота — оба конца, а не одно начало.
 *
 * Прежде слот узнавался по началу, и смена длительности 50 → 30 минут
 * оставляла 09:00–09:50 на месте: начало совпало с желаемым 09:00–09:30,
 * вставка упиралась в ключ начала и молча ничего не делала, а удалять было
 * «нечего». Рядом появлялся 09:30–10:00, и оба были открыты для записи.
 */
function keyOf(s: Span): string {
  return `${new Date(s.startsAt).toISOString()}|${new Date(s.endsAt).toISOString()}`;
}

function overlap(a: Span, b: Span): boolean {
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

/**
 * Желаемая сетка в настоящих моментах — оба конца, одним запросом Postgres.
 *
 * `at time zone` знает про переводы часов; сложение смещения в JS — нет.
 * Сетка уходит одним параметром-JSON, а не парой параметров на слот: год
 * расписания по пять минут — это десятки тысяч значений, больше, чем
 * протокол пропускает в одном запросе.
 */
async function resolveWanted(wanted: Wanted[], tz: string): Promise<Span[]> {
  if (!wanted.length) return [];
  const walls = JSON.stringify(wanted.map((w) => ({ s: `${w.date} ${w.from}`, e: `${w.date} ${w.to}` })));
  const rows = await db.execute<{ s: string | Date; e: string | Date }>(sql`
    select (w->>'s')::timestamp at time zone ${tz} as s,
           (w->>'e')::timestamp at time zone ${tz} as e
    from jsonb_array_elements(${walls}::jsonb) with ordinality as t(w, n)
    order by n
  `);
  return rows.map((r) => ({
    startsAt: new Date(r.s).toISOString(),
    endsAt: new Date(r.e).toISOString(),
  }));
}

/**
 * Привести сетку слотов специалиста к шаблону.
 *
 * Идемпотентна: повторный прогон ничего не меняет. Держится это на ключе
 * слота по обоим концам и на правилах базы: уникальное начало среди
 * открытых и запрет пересечения открытых слотов одного специалиста (0105) —
 * дубликат и наложение физически невозможны, а не «мы стараемся их не
 * вставить».
 *
 * Три действия, и третье — самое важное:
 *  — недостающие слоты добавляются;
 *  — свободные слоты, выпавшие из расписания, удаляются (или закрываются,
 *    если на них лежит история отменённого приёма);
 *  — занятые, выпавшие из расписания, ОСТАЮТСЯ и помечаются.
 *
 * Молчаливая отмена чужого приёма недопустима ни при каких обстоятельствах, а
 * «сузил приёмные часы задним числом» — самый вероятный способ её устроить.
 * Поэтому занятый слот вне расписания живёт дальше и подсвечивается:
 * переносить или оставить решает человек.
 *
 * «Выпал из расписания» теперь значит «нет в сетке слота с тем же началом И
 * концом». Занятый слот 09:00–09:50 после смены длительности на 30 минут —
 * вне расписания, хотя начало совпадает. Его интервал не меняется
 * (решение заказчика 2026-09-26, внешний разбор): человек записан на
 * 09:00–09:50 и это время видел, а растянуть или ужать чужой приём молча —
 * та же молчаливая правка. Новая сетка этого дня строится вокруг него:
 * пересекающиеся с ним слоты не создаются, пока он занят, — иначе к
 * специалисту записали бы двоих на одно время. Освободится — следующая
 * синхронизация закроет его и вернёт время в сетку.
 */
export async function syncSlots(
  specialistId: string,
  weeks = HORIZON_WEEKS,
): Promise<{ added: number; removed: number; flagged: number }> {
  /*
   * Системным контекстом: занятость слота — это ВСЕ приёмы на нём, а не те,
   * что видны правящему. Регистратор, ведущий чужое расписание, под боевой
   * ролью базы видит только пациентов своей зоны (appointments_access), и
   * занятый чужим пациентом слот выглядел бы свободным: закрылся бы из-под
   * живого приёма, а новая сетка легла бы поверх него. Право править это
   * расписание маршрут уже проверил (scheduleTarget).
   */
  return inTransaction(() => asSystem(() => syncWithin(specialistId, weeks)));
}

async function syncWithin(
  specialistId: string,
  weeks: number,
): Promise<{ added: number; removed: number; flagged: number }> {
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, specialistId),
  });
  if (!profile) return { added: 0, removed: 0, flagged: 0 };

  const department = await db.query.departments.findFirst({
    where: eq(departments.id, profile.departmentId),
  });
  if (!department) return { added: 0, removed: 0, flagged: 0 };

  await lockSchedule(specialistId);

  const wanted = await resolveWanted(await plannedSlots(specialistId, weeks), department.timezone);

  const today = new Date();
  const windowFrom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const windowTo = new Date(windowFrom.getTime() + weeks * 7 * 24 * 3600 * 1000);
  const inWindow = and(
    eq(slots.specialistId, specialistId),
    gte(slots.startsAt, windowFrom.toISOString()),
    lt(slots.startsAt, windowTo.toISOString()),
  );

  /*
   * Открытые слоты окна — под замок до чтения занятости.
   *
   * Судьба слота решается по прочитанной занятости, а записать на него в
   * это время может пациент. Прежде окно закрывалось условием в DELETE, но
   * условие не видит незакоммиченную запись: DELETE ждал её замка, а
   * дождавшись, удалял строку, которую запись лишь заперла, — и падал на
   * ключе 0064 уже после того, как половина сетки была переписана. Замок тот
   * же, что берёт takeSlot в routes/clinic.ts, поэтому они просто встают в
   * очередь: либо запись закончилась и видна ниже, либо она ждёт нас и потом
   * увидит закрытый или удалённый слот.
   */
  await db.execute(sql`
    select id from slots
    where specialist_id = ${specialistId} and status = 'open'
      and starts_at >= ${windowFrom.toISOString()} and starts_at < ${windowTo.toISOString()}
    order by id
    for update
  `);

  const existing = await db
    .select({ id: slots.id, startsAt: slots.startsAt, endsAt: slots.endsAt, offSchedule: slots.offSchedule })
    .from(slots)
    .where(and(inWindow, eq(slots.status, "open")));

  const wantedKeys = new Set(wanted.map(keyOf));
  const inGrid = existing.filter((s) => wantedKeys.has(keyOf(s)));
  const stale = existing.filter((s) => !wantedKeys.has(keyOf(s)));

  /*
   * Снятая пометка считается первой и безусловно.
   *
   * Первая редакция сняла её последней — после раннего выхода «нечего
   * удалять», — и специалист, вернувший часы обратно, продолжал видеть
   * тревогу на слоте, который давно в расписании. Проверка «возвращённые
   * часы снимают пометку» это и поймала: в установившемся состоянии удалять
   * действительно нечего, и весь хвост не выполнялся никогда.
   */
  const backIn = inGrid.filter((s) => s.offSchedule).map((s) => s.id);
  if (backIn.length) {
    await db.update(slots).set({ offSchedule: false }).where(inArray(slots.id, backIn));
  }

  /* Занятое время, вокруг которого строится сетка: новые слоты его не пересекают */
  const blockers: Span[] = [];
  let removed = 0;
  let flagged = 0;

  if (stale.length) {
    const live = await db
      .select({ slotId: appointments.slotId })
      .from(appointments)
      .where(
        and(
          inArray(
            appointments.slotId,
            stale.map((s) => s.id),
          ),
          ne(appointments.status, "cancelled"),
        ),
      );
    const busy = new Set(live.map((a) => a.slotId));
    const free = stale.filter((s) => !busy.has(s.id));

    /*
     * Удаляем и закрываем с проверкой занятости в самом операторе, а не по
     * списку, прочитанному выше.
     *
     * Замок выше не пускает в эти слоты новую запись, но проверка в самом
     * операторе остаётся: она не зависит от того, все ли пишущие берут
     * замок (посев, наполнение демонстрационными данными пишут приёмы
     * напрямую). Ключ базы (`on delete restrict`, 0064) закрывает окно
     * окончательно: удаление слота под приёмом упёрлось бы в него. Здесь
     * учитывается ЛЮБОЙ приём, включая отменённый: он тоже история.
     */
    const deleted = free.length
      ? await db
          .delete(slots)
          .where(
            and(
              inArray(
                slots.id,
                free.map((s) => s.id),
              ),
              sql`not exists (select 1 from appointments a where a.slot_id = ${slots.id})`,
            ),
          )
          .returning({ id: slots.id })
      : [];
    const gone = new Set(deleted.map((r) => r.id));

    /*
     * Слот, на котором лежит только отменённый приём, не удалить, а
     * оставить открытым нельзя: он держал бы время, которого в расписании
     * больше нет, и новая сетка не могла бы его занять. Он закрывается —
     * уходит из записи и из правила о пересечениях, а история приёма
     * остаётся при нём со своим временем.
     */
    const withHistory = free.filter((s) => !gone.has(s.id));
    const closed = withHistory.length
      ? await db
          .update(slots)
          .set({ status: "closed", offSchedule: false })
          .where(
            and(
              inArray(
                slots.id,
                withHistory.map((s) => s.id),
              ),
              sql`not exists (
                select 1 from appointments a where a.slot_id = ${slots.id} and a.status <> 'cancelled'
              )`,
            ),
          )
          .returning({ id: slots.id })
      : [];
    const shut = new Set(closed.map((r) => r.id));

    /*
     * Кого записали в последний момент — помечаем «вне расписания», как и
     * тех, кто был занят на момент чтения. Иначе слот остался бы обычным, и
     * специалист не увидел бы, что приём выпал из его часов.
     */
    const kept = stale.filter((s) => !gone.has(s.id) && !shut.has(s.id));
    const toFlag = kept.filter((s) => !s.offSchedule).map((s) => s.id);
    if (toFlag.length) {
      await db.update(slots).set({ offSchedule: true }).where(inArray(slots.id, toFlag));
    }
    blockers.push(...kept);
    // считаем по факту, а не по намерению: часть могла уцелеть
    removed = deleted.length + closed.length;
    flagged = toFlag.length;
  }

  /*
   * Закрытый слот с живым приёмом — след двойной записи, которую разобрала
   * миграция 0105: приём живёт, в правило о пересечениях слот уже не входит.
   * Его время тоже занято, и сетка обходит его сама — база здесь не
   * подскажет.
   */
  const closedButBusy = await db
    .select({ startsAt: slots.startsAt, endsAt: slots.endsAt })
    .from(slots)
    .where(
      and(
        inWindow,
        eq(slots.status, "closed"),
        sql`exists (select 1 from appointments a where a.slot_id = ${slots.id} and a.status <> 'cancelled')`,
      ),
    );
  blockers.push(...closedButBusy);

  const present = new Set(inGrid.map(keyOf));
  const missing = wanted.filter((w) => !present.has(keyOf(w)) && !blockers.some((b) => overlap(b, w)));

  /*
   * Вставка — после того, как выпавшее убрано: новый 09:00–09:30 иначе
   * упёрся бы в ещё не удалённый 09:00–09:50. `on conflict do nothing` без
   * цели ловит и ключ начала, и запрет пересечения — на случай, если кто-то
   * успел раньше; добавленные считаются по факту.
   */
  let added = 0;
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500).map((w) => ({
      id: crypto.randomUUID(),
      specialistId,
      departmentId: profile.departmentId,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
    }));
    const result = await db.insert(slots).values(chunk).onConflictDoNothing().returning({ id: slots.id });
    added += result.length;
  }

  return { added, removed, flagged };
}
