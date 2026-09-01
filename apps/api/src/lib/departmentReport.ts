import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { appointments, departmentPatients, departments, slots } from "../db/schema";
import { SMALL_CELL_FLOOR, suppress } from "./privacy";

export interface DepartmentReport {
  departmentId: string;
  from: string;
  to: string;
  received: number;
  people: number | null;
  primary: number | null;
  repeat: number | null;
  noShow: number | null;
  cancelled: number | null;
  attached: number | null;
  floor: number;
}

/**
 * Расчёт отчёта отделения.
 *
 * Живёт здесь, а не в маршруте, потому что тех же чисел просят двое: экран и
 * печатный лист. Два расчёта одного числа — это два числа, которые однажды
 * разойдутся, и разойдутся молча; сверить их будет некому, а подпишут
 * бумажное.
 */
export async function departmentReport(
  departmentId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<DepartmentReport> {
  /*
   * Границы периода — по часам отделения. Отчёт за месяц, посчитанный по
   * часам сервера, теряет или прихватывает приёмы последнего вечера.
   */
  const within = and(
    eq(slots.departmentId, departmentId),
    sql`${slots.startsAt} >= (${`${from} 00:00`}::timestamp at time zone ${timezone})`,
    sql`${slots.startsAt} < (${`${to} 00:00`}::timestamp at time zone ${timezone}) + interval '1 day'`,
  );

  const rows = await db
    .select({
      status: appointments.status,
      kind: appointments.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(within)
    .groupBy(appointments.status, appointments.kind);

  const count = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((sum, r) => sum + Number(r.n), 0);
  const held = (r: (typeof rows)[number]) => r.status === "done";

  /*
   * Сколько человек, а не сколько приёмов. Один человек за месяц приходит
   * трижды, и «принято 30» рядом с «на учёте 12» — это два разных числа,
   * которые нельзя складывать и нельзя путать.
   */
  const [people] = await db
    .select({ n: sql<number>`count(distinct ${appointments.patientId})::int` })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .where(and(within, eq(appointments.status, "done")));

  const [attached] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(departmentPatients)
    .where(
      and(eq(departmentPatients.departmentId, departmentId), isNull(departmentPatients.detachedAt)),
    );

  return {
    departmentId,
    from,
    to,
    /*
     * Общее число принятых — это работа отделения, а не сведение о человеке,
     * и оно не подавляется. Подавляются разрезы, по которым человека можно
     * опознать.
     */
    received: count(held),
    people: suppress(Number(people?.n ?? 0)),
    primary: suppress(count((r) => held(r) && r.kind === "primary")),
    repeat: suppress(count((r) => held(r) && r.kind === "repeat")),
    noShow: suppress(count((r) => r.status === "no_show")),
    cancelled: suppress(count((r) => r.status === "cancelled")),
    attached: suppress(Number(attached?.n ?? 0)),
    floor: SMALL_CELL_FLOOR,
  };
}

/** Отделение, чей отчёт спрашивают: явно названное или своё */
export async function resolveDepartment(
  userId: string,
  asked: string | undefined,
): Promise<{ id: string; timezone: string } | null> {
  const { specialistProfiles } = await import("../db/schema");
  const id =
    asked ??
    (
      await db.query.specialistProfiles.findFirst({
        where: eq(specialistProfiles.userId, userId),
      })
    )?.departmentId;
  if (!id) return null;
  const department = await db.query.departments.findFirst({ where: eq(departments.id, id) });
  return department ? { id: department.id, timezone: department.timezone } : null;
}
