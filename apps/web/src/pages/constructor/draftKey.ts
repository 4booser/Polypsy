/*
 * Ключи автосохранения конструктора — отдельным маленьким модулем: их знает
 * и вход (auth.tsx, чистка прежних ключей), а модель конструктора в
 * начальный кусок консоли тянуть незачем (test/bundle.test.ts).
 */

const PREFIX = "quizzy.constructor.";

/**
 * Ключ автосохранения конструктора в localStorage — с учёткой (#176).
 *
 * Черновик живёт в браузере: правка методики на 200 пунктов не должна
 * умирать от F5 или упавшей вкладки; id методики в ключе — чтобы черновики
 * разных методик не затирали друг друга. Учётки в ключе не было, а браузер в
 * ординаторской общий: врач B открывал ту же методику и видел «Відновлено
 * незбережену чернетку» с правками врача A — и публиковал их от своего
 * имени. Теперь ключ свой у каждой учётки (id из /api/auth/me — тот же sub
 * токена); без учётки автосохранения нет вовсе. Прежние ключи без учётки
 * не читаются: чьи они — неизвестно.
 */
export function draftKey(owner: string | null | undefined, id: string | undefined): string | null {
  return owner ? `${PREFIX}${owner}.${id ?? "new"}` : null;
}

/**
 * Прежний ключ без учётки: `quizzy.constructor.<id методики | new>` — одно
 * звено после приставки, а у ключа с учёткой их два (идентификаторы — UUID,
 * точек в них нет).
 */
export function isLegacyDraftKey(key: string): boolean {
  return key.startsWith(PREFIX) && key.length > PREFIX.length && !key.slice(PREFIX.length).includes(".");
}

/**
 * Убрать прежние ключи без учётки (#200). Их никто не читает, а лежат в
 * них чужие несохранённые правки методик — на общем компьютере, без срока.
 * Вызывается при входе (auth.tsx); черновики с учёткой не трогаются.
 */
export function dropLegacyDrafts(storage: Pick<Storage, "length" | "key" | "removeItem">): void {
  const legacy: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && isLegacyDraftKey(key)) legacy.push(key);
  }
  // удаление после обхода: removeItem сдвигает номера ключей
  for (const key of legacy) storage.removeItem(key);
}
