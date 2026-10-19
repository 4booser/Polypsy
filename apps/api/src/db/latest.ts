import { sql } from "drizzle-orm";
import { dbContext } from "./context";

/**
 * «Последние N строк» — путём по индексу, а не перебором (#188), и
 * системной ролью — для выборок учреждения.
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
 *
 * Роль — системная, как у asSystem (db/context.ts): нормативная выборка,
 * выборка перцентиля и альфы (lib/changeBasis.ts, lib/referenceSample.ts) —
 * числа об учреждении, и ничего, кроме них, из чтения наружу не уходит.
 * Роль и сортировка меняются одним оператором и возвращаются другим: по
 * отдельности (asSystem вокруг inIndexOrder) это было пять обращений к базе
 * на каждое чтение, и на динамике человека их набиралось больше, чем самих
 * чтений (волна 27).
 *
 * Заодно на время fn выключается Memoize: в этих чтениях каждое прохождение
 * ищется ровно один раз, кэш узла не попадает ни разу (0 из 28 тыс. проб на
 * карточке с семью методиками), а держать его — десятая часть времени чтения.
 *
 * Возврат — как у asSystem: при ошибке — если транзакция жива, наружу —
 * исходная ошибка. Под системной ролью уже — возврат пишет её же.
 */
export async function systemInIndexOrder<T>(fn: () => Promise<T>): Promise<T> {
  const tx = dbContext.getStore();
  if (!tx) return fn();
  const [row] = (await tx.execute(
    sql`select current_setting('app.role', true) as role, current_setting('enable_sort') as sort,
               current_setting('enable_memoize') as memoize,
               set_config('app.role', 'system', true), set_config('enable_sort', 'off', true),
               set_config('enable_memoize', 'off', true)`,
  )) as unknown as { role: string | null; sort: string; memoize: string }[];
  const restore = () =>
    tx.execute(
      sql`select set_config('app.role', ${row?.role ?? ""}, true), set_config('enable_sort', ${row?.sort ?? "on"}, true),
                 set_config('enable_memoize', ${row?.memoize ?? "on"}, true)`,
    );
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    // прерванной транзакции настройки уже не нужны; наружу — исходная ошибка
    await restore().catch(() => {});
    throw error;
  }
  await restore();
  return result;
}
