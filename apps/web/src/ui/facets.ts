/**
 * Фасетные фильтры таблиц.
 *
 * Логика вынесена из компонента намеренно: подсчёт «сколько строк останется»
 * — то, на что человек смотрит, прежде чем нажать, и ошибка в нём тихо врёт.
 * Такое проверяется тестом, а не разглядыванием экрана.
 */

export interface Facet<T> {
  key: string;
  label: string;
  /** Значение строки по этому фасету; null — строка вне разбиения */
  valueOf: (row: T) => string | null;
}

export interface FacetOption {
  value: string;
  /** Сколько строк даст этот вариант при текущем состоянии прочих фасетов */
  count: number;
  selected: boolean;
}

export type FacetSelection = Record<string, string[]>;

/** Проходит ли строка выбор по всем фасетам, кроме указанного */
function passes<T>(
  row: T,
  facets: Facet<T>[],
  selection: FacetSelection,
  exceptKey: string | null,
): boolean {
  for (const facet of facets) {
    if (facet.key === exceptKey) continue;
    const picked = selection[facet.key];
    if (!picked?.length) continue;
    const value = facet.valueOf(row);
    if (value === null || !picked.includes(value)) return false;
  }
  return true;
}

/** Строки, прошедшие все фасеты */
export function applyFacets<T>(rows: T[], facets: Facet<T>[], selection: FacetSelection): T[] {
  return rows.filter((row) => passes(row, facets, selection, null));
}

/**
 * Варианты одного фасета со счётчиками.
 *
 * Счётчик считается по строкам, прошедшим ОСТАЛЬНЫЕ фасеты, но не этот.
 * Иначе выбор варианта обнулял бы счётчики его соседей, и человек не мог бы
 * увидеть, что даст переключение — а именно для этого счётчик и нужен.
 */
export function facetOptions<T>(
  rows: T[],
  facets: Facet<T>[],
  selection: FacetSelection,
  key: string,
): FacetOption[] {
  const facet = facets.find((f) => f.key === key);
  if (!facet) return [];

  const picked = selection[key] ?? [];
  const counts = new Map<string, number>();

  for (const row of rows) {
    if (!passes(row, facets, selection, key)) continue;
    const value = facet.valueOf(row);
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  // выбранный вариант остаётся в списке, даже если счётчик обнулился: иначе
  // снять фильтр было бы нечем
  for (const value of picked) if (!counts.has(value)) counts.set(value, 0);

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, selected: picked.includes(value) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Переключение варианта; пустой список ключа выбрасывается, чтобы адрес не рос */
export function toggleFacet(
  selection: FacetSelection,
  key: string,
  value: string,
): FacetSelection {
  const picked = selection[key] ?? [];
  const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
  const out = { ...selection };
  if (next.length) out[key] = next;
  else delete out[key];
  return out;
}

/*
 * Разбор и сборка выбора для адресной строки.
 *
 * Формат `ключ:знач1,знач2;ключ2:знач3` — читается глазами и переживает
 * пересылку ссылки. Ссылками здесь обмениваются постоянно, поэтому экранируются
 * только три знака: разделители и сам знак экранирования. Полный
 * `encodeURIComponent` превращал бы «Разведрота» в частокол процентов — а
 * дальше адресная строка кодирует его ещё раз, и ссылка становится нечитаемой.
 */
const ESCAPES: [RegExp, string][] = [
  [/%/g, "%25"],
  [/;/g, "%3B"],
  [/,/g, "%2C"],
];

function escapeValue(value: string): string {
  return ESCAPES.reduce((acc, [re, to]) => acc.replace(re, to), value);
}

function unescapeValue(value: string): string {
  // в обратном порядке: иначе «%253B» развернулось бы в разделитель
  return value
    .replace(/%3B/g, ";")
    .replace(/%2C/g, ",")
    .replace(/%25/g, "%");
}

export function parseFacets(raw: string): FacetSelection {
  const out: FacetSelection = {};
  for (const part of raw.split(";")) {
    if (!part) continue;
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const key = part.slice(0, at);
    const values = part
      .slice(at + 1)
      .split(",")
      .map(unescapeValue)
      .filter(Boolean);
    if (values.length) out[key] = values;
  }
  return out;
}

export function serializeFacets(selection: FacetSelection): string {
  return Object.entries(selection)
    .filter(([, values]) => values.length)
    .map(([key, values]) => `${key}:${values.map(escapeValue).join(",")}`)
    .join(";");
}
