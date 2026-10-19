/**
 * Запись на приём в кабинете — состояния списка времени и выбора.
 *
 * Две ошибки, которые здесь закрываются.
 *
 * «Вільного часу поки немає» вместо «не загрузилось». Экран проверял одно —
 * пуст ли список, — а пуст он и пока грузится, и когда загрузка отказала, и
 * без связи. Человек, у которого просто не дошёл ответ, читал, что записаться
 * некуда, и уходил звонить в регистратуру. Теперь это четыре разных
 * состояния, и только одно из них — «свободного времени нет».
 *
 * Выбранное время, которого уже нет. Время, которое заняли, пока человек
 * выбирал, сервер не отдаёт («Цей час щойно зайняли»), а экран оставлял его
 * выбранным и в списке: «Записатися» снова и снова упиралось в тот же отказ.
 * Теперь после отказа список перечитывается, и выбранным считается только
 * время, которое в нём есть: ушедшее время снимается с выбора само, а кнопка
 * гаснет, пока не выбрано другое.
 */

export type SlotsView<T> =
  | { kind: "loading" }
  /** Связи нет и списка ещё не было: о связи говорит строка оболочки, здесь — что списка нет */
  | { kind: "offline" }
  | { kind: "failed"; error: string }
  | { kind: "empty" }
  | { kind: "list"; times: T[] };

/** Сколько вариантов времени показывать: дальше сорока выбирать не станет никто */
export const SLOT_LIMIT = 40;

export function slotsView<T>(res: { data: { items: T[] } | null; error: string | null; offline?: boolean }): SlotsView<T> {
  if (res.data) {
    const times = res.data.items.slice(0, SLOT_LIMIT);
    return times.length ? { kind: "list", times } : { kind: "empty" };
  }
  if (res.error) return { kind: "failed", error: res.error };
  if (res.offline) return { kind: "offline" };
  return { kind: "loading" };
}

/** Выбранное время — только если оно среди показанных; иначе выбора нет */
export function chosenSlot(slotId: string | null, times: readonly { id: string }[]): string | null {
  return slotId !== null && times.some((t) => t.id === slotId) ? slotId : null;
}

/**
 * Перенос своего приёма (`?move=<id>`): какой приём переносим.
 *
 * Пока список своих приёмов не пришёл (или отказал), неизвестно, чем кончится
 * нажатие: экран рисуется записью, и «Записатися» заводила бы второй приём
 * рядом с тем, который человек пришёл перенести. Поэтому `pending` — и
 * подтверждение ждёт ответа. Пришёл без этого приёма (отменён, прошёл) —
 * обычная запись.
 */
export function moveTarget<V extends { id: string; status: string }>(
  moveId: string | null,
  visits: readonly V[] | null,
): { moving: V | null; pending: boolean } {
  if (!moveId) return { moving: null, pending: false };
  if (visits === null) return { moving: null, pending: true };
  return { moving: visits.find((v) => v.id === moveId && v.status !== "cancelled") ?? null, pending: false };
}
