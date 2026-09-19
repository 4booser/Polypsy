import { ApiError, api } from "../../api";
import { type StaffRow, fromAssignable, fromUser, isStaff, sortByName } from "./model";

/**
 * Справочник сотрудников — из того, что сервер уже отдаёт.
 *
 * Своего маршрута «список лікарів» у сервера нет (см. api_gaps). Есть два
 * соседних: GET /api/users — весь реестр, закрытый правом users.manage, и
 * GET /api/permissions/staff — «кого я вправе назначать», открытый
 * заведующему. Первый полнее (пол, дата рождения, специальность), второй
 * доступнее. Берётся первый, а на отказ в праве — второй: экран «Лікарі»
 * по схеме заказчика (кадр f40) открывает именно администратор, и остаться
 * ему с пустым экраном нельзя.
 *
 * `partial` говорит экрану, что перед ним усечённый ответ: он печатает
 * подсказку, а не притворяется полным реестром.
 */
export interface Directory {
  rows: StaffRow[];
  partial: boolean;
}

export async function loadDirectory(): Promise<Directory> {
  try {
    const users = await api.users();
    return { rows: sortByName(users.filter(isStaff).map(fromUser)), partial: false };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 403) throw e;
    const staff = await api.assignableStaff();
    return { rows: sortByName(staff.map(fromAssignable)), partial: true };
  }
}

/**
 * Ступени лестницы у каждой строки — по одному запросу на человека.
 *
 * Иначе нельзя: список учётных записей класса лестницы не несёт, а
 * «администратор» — это ступень, а не класс (см. isAdministrator). Запросы
 * идут разом, отказ по одному человеку (ступень выше моей) не роняет
 * список — такой человек остаётся без лестницы и в реестр администраторов
 * не попадает: суперадмин видит всех, а заведующему вышестоящие и не
 * положены. Сотрудников в учреждении десятки, не тысячи; маршрут отдаёт
 * карточку без записи в журнал, поэтому это дёшево и с обеих сторон.
 */
export async function withLadder(rows: StaffRow[]): Promise<StaffRow[]> {
  const cards = await Promise.allSettled(rows.map((r) => api.userPermissions(r.id)));
  return rows.map((r, i) => {
    const c = cards[i];
    return c?.status === "fulfilled" ? { ...r, ladder: c.value.roles.map((x) => x.code) } : r;
  });
}

/**
 * Один сотрудник — из того же справочника: маршрута GET /api/users/:id нет.
 * Своя запись берётся из профиля напрямую: она полнее и не требует права
 * на реестр — свою карточку открывает и рядовой специалист (кадр f03).
 */
/*
 * Ответ обёрнут, а не отдан голым `StaffRow | null`: у useResource «ещё не
 * загружено» — это тоже null, и экран на первом кадре показывал бы «такого
 * сотрудника нет» вместо скелета. Обёртка делает «загружено, но не найден»
 * отличимым от «не загружено».
 */
export async function loadMember(id: string, me: { id: string } | null): Promise<{ row: StaffRow | null }> {
  if (me && me.id === id) {
    const user = await api.me();
    return { row: fromUser(user) };
  }
  const dir = await loadDirectory();
  return { row: dir.rows.find((r) => r.id === id) ?? null };
}
