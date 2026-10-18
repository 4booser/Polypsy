import { locale } from "../../format";

/*
 * Короткие даты карточки — как в макете: «08.10» в столбцах замеров и
 * «сб 10.10» у приёма. Общие day()/dateTime() пишут месяц словом («8 жовт.»),
 * и в узком столбце таблицы методик три таких даты не помещаются.
 */

/** «08.10» */
export function dm(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

/** «сб 10.10» */
export function wdm(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale(), { weekday: "short" })} ${dm(iso)}`;
}

/** Полных суток между двумя моментами по местному календарю: «13 днів тому» */
export function daysBetween(fromIso: string, now: number): number {
  const a = new Date(fromIso);
  const b = new Date(now);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}
