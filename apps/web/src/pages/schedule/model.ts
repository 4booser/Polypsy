/**
 * Расписание специалиста — что форма недели и форма исключения
 * отправляют и когда.
 *
 * Сервер проверяет то же самое (scheduleTemplateSchema и
 * scheduleExceptionSchema в packages/shared/src/schemas.ts), но его отказ —
 * строка разбора тела, адресованная разработчику: «endsAt: интервал не может
 * кончаться раньше, чем начался», по-русски на любом языке консоли и без
 * указания, какая из десяти строк недели виновата. Поэтому форма ловит это
 * сама, до отправки, и показывает у той строки, где ошибка.
 */

export interface Hours {
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
}

/** Что не так с промежутком: конец не позже начала или длительность приёма вне 5…480 минут */
export type HoursProblem = "order" | "slot";

export function hoursProblem(h: Hours): HoursProblem | null {
  /* «ЧЧ:ММ» сравнивается строкой — так же сравнивает сервер */
  if (!h.startsAt || !h.endsAt || h.endsAt <= h.startsAt) return "order";
  if (!Number.isInteger(h.slotMinutes) || h.slotMinutes < 5 || h.slotMinutes > 480) return "slot";
  return null;
}

/** Ошибки недели по месту строки в общем списке; пусто — неделю можно сохранять */
export function weekProblems(rows: readonly Hours[]): Map<number, HoursProblem> {
  const out = new Map<number, HoursProblem>();
  rows.forEach((row, at) => {
    const p = hoursProblem(row);
    if (p) out.set(at, p);
  });
  return out;
}

export interface ExceptionForm {
  date: string;
  kind: "off" | "extra";
  from: string;
  to: string;
  note: string;
}

export const EMPTY_EXCEPTION: ExceptionForm = { date: "", kind: "off", from: "", to: "", note: "" };

/**
 * Что мешает отправить исключение.
 *
 * «date» и «hours» — незаполненное: кнопка просто гаснет, как и раньше
 * (без даты исключения нет; дополнительные часы без часов бессмысленны).
 * «order» — заполненное неверно: об этом форма говорит словами.
 */
export function exceptionProblem(f: Pick<ExceptionForm, "date" | "kind" | "from" | "to">): "date" | "hours" | "order" | null {
  if (!f.date) return "date";
  if (f.kind === "extra" && (!f.from || !f.to)) return "hours";
  if (f.from && f.to && f.to <= f.from) return "order";
  return null;
}

/**
 * Форма после отправки: очищается только после успеха.
 *
 * Прежде поля стирались в момент нажатия, до ответа сервера. Отказал сервер
 * (пересечение с приёмом, обрыв связи) — всплывало сообщение, а дата, часы
 * и примечание уже были стёрты: исправить одну цифру и отправить ещё раз
 * было нельзя, только набрать всё заново.
 */
export function afterAdd(form: ExceptionForm, ok: boolean): ExceptionForm {
  return ok ? { ...EMPTY_EXCEPTION, kind: form.kind } : form;
}
