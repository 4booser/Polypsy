import { sql } from "drizzle-orm";
import { dbContext } from "./context";

/**
 * «Последние N строк» — путём по индексу, а не перебором (#188).
 *
 * Выборки вида «последние триста прохождений версии» планировщик под
 * политиками строк считает неверно. Долю строк, которые политика
 * пропустит, он оценивает почти в ноль: в условии — current_setting, у
 * которого нет статистики, и на каждое значение идёт умолчание в полпроцента.
 * Ему кажется, что подходящих строк меньше, чем просят, — и путь по индексу
 * (survey_id, submitted_at) с конца выглядит дороже, чем взять ВСЕ
 * прохождения методики и отсортировать. На 69 тыс. прохождений PHQ-9 это
 * 1,5 с под политиками врача вместо 20 мс, и время растёт с каждым чужим
 * прохождением.
 *
 * На время fn сортировка выключается (enable_sort, только в этой
 * транзакции): остаётся путь, который отдаёт строки уже по порядку и
 * останавливается на N. Запрос в fn обязан сортировать ровно по колонкам
 * индекса — иначе сортировка понадобится, и планировщик возьмёт её всё
 * равно, только дороже. Вне транзакции (сюита владельцем) — просто fn:
 * SET LOCAL там не живёт дольше одного оператора.
 */
export async function inIndexOrder<T>(fn: () => Promise<T>): Promise<T> {
  const tx = dbContext.getStore();
  if (!tx) return fn();
  const [row] = (await tx.execute(
    sql`select current_setting('enable_sort') as previous, set_config('enable_sort', 'off', true)`,
  )) as unknown as { previous: string }[];
  const restore = () => tx.execute(sql`select set_config('enable_sort', ${row?.previous ?? "on"}, true)`);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // прерванной транзакции настройка уже не нужна; наружу — исходная ошибка
    await restore().catch(() => {});
    throw error;
  }
  await restore();
  return result;
}
