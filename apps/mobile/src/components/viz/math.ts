/**
 * Числовая часть графиков — отдельно от компонентов.
 *
 * Лежала в `.tsx` рядом с разметкой и потому не тестировалась: импорт файла
 * тянет react-native, которого в тестовом окружении нет. Здесь из импортов
 * только текущий язык (модуль без react-native) — эти функции проверяются
 * как обычная арифметика.
 */
import { currentLang } from "../../currentLang";

/**
 * Дробная часть — запятой по-украински и по-русски, точкой по-английски:
 * тот же выбор, что у длительности в общем пакете и у num() экранов
 * сотрудника. «11.3%» на украинском экране читается как чужой формат.
 */
export function localDecimal(text: string, lang: string = currentLang): string {
  return lang === "en" ? text : text.replace(".", ",");
}

/** Красивые деления оси: 0, 5, 10 вместо 0, 3.7, 7.4 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  /*
   * Последнее деление всегда не ниже максимума: иначе верхняя точка висит над
   * сеткой, а график, забывший подстраховаться `Math.max(...ticks, max)`,
   * обрежет её совсем. Считаем по индексу, а не накоплением: 0.1 + 0.1 + 0.1
   * даёт 0.30000000000000004, и деления оси разъезжаются на дробных шкалах.
   */
  const last = Math.ceil(max / step);
  return Array.from({ length: last + 1 }, (_, i) => Math.round(i * step * 100) / 100);
}

/** Компактное число для подписи: 1240 → «1,2k», 7,25 — с запятой там, где так пишут */
export function formatShort(v: number, lang: string = currentLang): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return localDecimal(`${Math.round(v / 100) / 10}k`, lang);
  return localDecimal(String(Math.round(v * 100) / 100), lang);
}

export interface BoxStat {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  n: number;
}

/**
 * Квартили по массиву значений.
 *
 * Интерполяция между соседними значениями (метод R-7, он же по умолчанию в
 * numpy и Excel): на малых выборках выбор «ближайшего элемента» даёт заметно
 * смещённый межквартильный размах, а групп меньше 20 человек здесь большинство.
 */
export function boxStatsOf(label: string, values: number[]): BoxStat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  };
  return {
    label,
    min: s[0]!,
    q1: Math.round(at(0.25) * 100) / 100,
    median: Math.round(at(0.5) * 100) / 100,
    q3: Math.round(at(0.75) * 100) / 100,
    max: s[s.length - 1]!,
    n: values.length,
  };
}

/**
 * Ступень тепловой лестницы h1…h5 (0…4) по доле от максимума.
 *
 * Лестница — один фиолетовый тон, пять ступеней с заранее подобранным
 * текстом на каждой (chart.heatInk): прозрачность поверх листа давала
 * серединки, на которых не читался ни белый, ни тёмный текст.
 */
export function heatStep(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(4, Math.floor(share * 5));
}
