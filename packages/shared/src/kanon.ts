/**
 * k-анонимность выгрузки.
 *
 * Обезличенная выгрузка убирает имя и подразделение, но оставляет пол и
 * возрастную полосу. Это квазиидентификаторы: в выборке на сорок человек
 * сочетание «женщина, 45 и старше» может оказаться единственным, и тот, кто
 * знает подразделение, узнает человека по одной строке. Стабильный код
 * субъекта делает узнавание переносимым между выгрузками.
 *
 * ## Обобщение, а не подавление
 *
 * Редкую ячейку можно обнулить — но пропуск в данных исследователь читает как
 * «неизвестно» и обрабатывает как случайный, а он не случайный: пропущено
 * ровно то, что было редким. Это тихо искажает анализ.
 *
 * Поэтому сначала полосы **сливаются**: соседние объединяются, пока в каждой не
 * наберётся k человек. Точность падает явно и одинаково для всех.
 *
 * Если слияния не хватило — у оставшихся малых ячеек квазиидентификаторы
 * стираются, и число таких строк записывается в манифест. Стирать всем, из-за
 * двух редких строк, было бы хуже, чем кажется: обезличенная выгрузка без пола
 * и возраста бесполезна для исследования, и люди начнут брать полный профиль —
 * то есть защита, от которой уходят, защищает хуже отсутствующей.
 *
 * ## Чего это не делает
 *
 * k-анонимность не защищает от того, кто знает про человека больше, чем есть
 * в выгрузке. Она защищает от узнавания по самой выгрузке — и только.
 */

/** Порядок полос значим: сливаются только соседние */
export const AGE_BANDS = ["<25", "25-34", "35-44", "45+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface QuasiRow {
  sex: "male" | "female" | null;
  band: AgeBand | null;
}

export interface Generalization {
  /** Во что превращается каждая исходная полоса */
  bandMap: Record<string, string>;
  /**
   * Ячейки, не набравшие k даже после слияния: у их строк пол и возраст
   * стираются. Ключ — «пол|полоса» после слияния.
   */
  blanked: string[];
  /** Сколько строк потеряло квазиидентификаторы — для манифеста */
  blankedRows: number;
  /** Сколько шагов слияния понадобилось — для манифеста */
  merges: number;
}

/** Минимальный размер ячейки. Тот же порог, что у подавления малых ячеек */
export const DEFAULT_K = 5;

function cellCounts(rows: QuasiRow[], bandMap: Record<string, string>, useSex: boolean, useBand: boolean) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const sex = useSex ? (row.sex ?? "—") : "*";
    const band = useBand ? (row.band ? (bandMap[row.band] ?? row.band) : "—") : "*";
    const key = `${sex}|${band}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function smallest(counts: Map<string, number>, k: number): boolean {
  for (const n of counts.values()) if (n < k) return true;
  return false;
}

/**
 * Как обобщить квазиидентификаторы, чтобы каждая ячейка набрала k.
 *
 * Возвращает описание преобразования, а не преобразованные данные: применить
 * его должен тот, кто строит выгрузку, и он же обязан записать его в манифест.
 * Молчаливое изменение данных — ровно то, чего в исследовательской выгрузке
 * быть не должно.
 */
export function generalizeQuasi(rows: QuasiRow[], k = DEFAULT_K): Generalization {
  const groups: AgeBand[][] = AGE_BANDS.map((b) => [b]);
  let merges = 0;

  const mapOf = () => {
    const map: Record<string, string> = {};
    for (const group of groups) {
      const label = group.length === 1 ? group[0]! : `${group[0]}…${group[group.length - 1]}`;
      for (const band of group) map[band] = label;
    }
    return map;
  };

  /*
   * Пустая выборка обобщать не нужно и нельзя: любая проверка на ней проходит,
   * и «обобщили в ноль шагов» здесь честнее, чем слить все полосы.
   */
  if (!rows.length) return { bandMap: mapOf(), blanked: [], blankedRows: 0, merges: 0 };

  while (groups.length > 1 && smallest(cellCounts(rows, mapOf(), true, true), k)) {
    /*
     * Сливается пара с наименьшей суммой: так теряется меньше всего точности.
     * Слияние по порядку слева направо оставляло бы «45+» гигантским, а
     * молодые полосы дробными.
     */
    let at = 0;
    let best = Infinity;
    const map = mapOf();
    for (let i = 0; i < groups.length - 1; i++) {
      const pair = [...groups[i]!, ...groups[i + 1]!];
      const n = rows.filter((r) => r.band && pair.includes(r.band)).length;
      void map;
      if (n < best) {
        best = n;
        at = i;
      }
    }
    groups.splice(at, 2, [...groups[at]!, ...groups[at + 1]!]);
    merges++;
  }

  const bandMap = mapOf();

  /*
   * Что не набрало k после слияния — стирается. Стёртые строки не исчезают из
   * выгрузки: пропадают только пол и возраст, а баллы остаются, потому что
   * ради них выгрузку и делают.
   */
  const counts = cellCounts(rows, bandMap, true, true);
  const blanked = [...counts.entries()].filter(([, n]) => n < k).map(([key]) => key);
  const blankedRows = blanked.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);

  return { bandMap, blanked, blankedRows, merges };
}

/**
 * Ключ ячейки строки после обобщения. Вынесен, чтобы строящий выгрузку и
 * проверяющий её считали его одинаково.
 */
export function quasiKey(row: QuasiRow, g: Generalization): string {
  const band = row.band ? (g.bandMap[row.band] ?? row.band) : "—";
  return `${row.sex ?? "—"}|${band}`;
}

/** Что показывать в выгрузке для этой строки: null — стёрто */
export function applyQuasi(
  row: QuasiRow,
  g: Generalization,
): { sex: "male" | "female" | null; band: string | null } {
  if (g.blanked.includes(quasiKey(row, g))) return { sex: null, band: null };
  return { sex: row.sex, band: row.band ? (g.bandMap[row.band] ?? row.band) : null };
}
