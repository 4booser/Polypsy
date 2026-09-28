import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { appointments, departments, episodes, patientNotes, responses, slots, surveys, users } from "../db/schema";

/**
 * История человека для печатной амбулаторной карты — целиком, порциями
 * (волна 15, внешний разбор, п. 20).
 *
 * Было: визиты и завершённые прохождения — последние 200, подписанные
 * записи — последние 100, и карта об этом не говорила ни слова. Лист
 * называется «Амбулаторная карта», его подшивают и передают, и выглядел он
 * полным — а у человека с долгой историей в нём не было начала: у ревьюера
 * из 101 записи напечатано 100, самой первой нет.
 *
 * Решение — полная карта, а не «явно ограниченная выписка». Выписка с
 * периодом и счётчиком пропущенного требует второго документа («остальное —
 * там-то») и экрана выбора периода, а подшитая часть всё равно читалась бы
 * как карта. Карта одного человека конечна и мала по меркам сервера: сотни
 * строк за годы работы, а не миллионы; ограничение было защитой от объёма,
 * которого у одного человека не бывает, и стоило оно полноты документа.
 * Поэтому ограничивается не документ, а разовое чтение: история читается
 * порциями по CHART_PORTION строк — одна выборка не тянет всю историю разом,
 * а документ получает её всю.
 *
 * Порции — по ключу (время, id), а не по смещению: смещение на живой таблице
 * съезжает, если между порциями добавили запись, и строка на стыке
 * пропадала бы или печаталась дважды. Время в ключе — текстом из самой
 * базы, с микросекундами: колонка времени в приложении округляется до
 * миллисекунд (db/schema.ts, timestampCol), и записи, сделанные в одну
 * миллисекунду (now() у пачки подписей), на стыке порций терялись бы по
 * округлённому ключу. Порядок — полный: время, при равенстве id.
 */
export const CHART_PORTION = 500;

interface Cursor {
  at: string;
  id: string;
}

/** Все строки выборки порциями по ключу (at, id), от новых к старым */
async function inPortions<T extends { cursorAt: string; cursorId: string }>(
  read: (after: Cursor | null, size: number) => Promise<T[]>,
  size: number,
): Promise<T[]> {
  const all: T[] = [];
  let after: Cursor | null = null;
  for (;;) {
    const rows = await read(after, size);
    all.push(...rows);
    if (rows.length < size) return all;
    const last = rows[rows.length - 1]!;
    after = { at: last.cursorAt, id: last.cursorId };
  }
}

/** Строго раньше курсора по паре (время, id) — условие следующей порции */
function before(at: SQL, id: SQL, after: Cursor | null): SQL | undefined {
  return after ? sql`(${at}, ${id}) < (${after.at}::timestamptz, ${after.id})` : undefined;
}

export async function chartHistory(userId: string, portion: number = CHART_PORTION) {
  /*
   * Обращения — без порций: их у человека единицы, и лимита у них не было.
   * Порядок полный, чтобы два обращения, открытые в одну секунду, не
   * менялись местами от печати к печати.
   */
  const eps = await db
    .select({ e: episodes, lead: users })
    .from(episodes)
    .leftJoin(users, eq(users.id, episodes.leadSpecialistId))
    .where(eq(episodes.patientId, userId))
    .orderBy(desc(episodes.openedAt), desc(episodes.id));

  /* приём — с поясом своего отделения: дата приёма на карте та же, что в справке о посещении */
  const visits = await inPortions(
    (after, size) =>
      db
        .select({
          a: appointments,
          slot: slots,
          specialist: users,
          timezone: departments.timezone,
          cursorAt: sql<string>`${slots.startsAt}::text`,
          cursorId: appointments.id,
        })
        .from(appointments)
        .innerJoin(slots, eq(slots.id, appointments.slotId))
        .innerJoin(users, eq(users.id, appointments.specialistId))
        .leftJoin(departments, eq(departments.id, slots.departmentId))
        .where(and(eq(appointments.patientId, userId), before(sql`${slots.startsAt}`, sql`${appointments.id}`, after)))
        .orderBy(desc(slots.startsAt), desc(appointments.id))
        .limit(size),
    portion,
  );

  const notes = await inPortions(
    (after, size) =>
      db
        .select({
          n: patientNotes,
          author: users,
          cursorAt: sql<string>`${patientNotes.createdAt}::text`,
          cursorId: patientNotes.id,
        })
        .from(patientNotes)
        .leftJoin(users, eq(users.id, patientNotes.signedBy))
        .where(
          and(
            eq(patientNotes.userId, userId),
            eq(patientNotes.status, "signed"),
            before(sql`${patientNotes.createdAt}`, sql`${patientNotes.id}`, after),
          ),
        )
        .orderBy(desc(patientNotes.createdAt), desc(patientNotes.id))
        .limit(size),
    portion,
  );

  /* время обследования — сдача, а у старых строк без неё — начало, как и печатается */
  const doneAt = sql`coalesce(${responses.submittedAt}, ${responses.startedAt})`;
  const done = await inPortions(
    (after, size) =>
      db
        .select({
          r: responses,
          title: surveys.title,
          cursorAt: sql<string>`${doneAt}::text`,
          cursorId: responses.id,
        })
        .from(responses)
        .innerJoin(surveys, eq(surveys.id, responses.surveyId))
        .where(and(eq(responses.userId, userId), eq(responses.status, "completed"), before(doneAt, sql`${responses.id}`, after)))
        .orderBy(sql`${doneAt} desc`, desc(responses.id))
        .limit(size),
    portion,
  );

  return { episodes: eps, visits, notes, responses: done };
}
