/**
 * Шрифт «Виразной» — Manrope, пять начертаний 400…800.
 *
 * Без React и без react-native: имена и правило выбора начертания проверяются
 * тестом, а сами файлы подключает только корневая раскладка (fontFiles.ts) —
 * `require` шрифта тестовый процесс не разберёт.
 *
 * Начертание выбирается ИМЕНЕМ семейства, а не fontWeight. У каждого файла
 * своё имя («Manrope-Bold»), и fontWeight рядом с ним Android и браузер
 * понимают как просьбу дорисовать жирность поверх уже жирного файла —
 * получается размазанный «ложный полужирный». Поэтому при загруженном шрифте
 * fontWeight не ставится вовсе.
 *
 * Не загрузился (файл повреждён, нет места) — приложение не встаёт на
 * пустом экране, а рисует системным шрифтом с обычным fontWeight: прочесть
 * методику важнее, чем прочесть её нашим шрифтом.
 */

export type Weight = 400 | 500 | 600 | 700 | 800;

/** Имя семейства для каждого начертания — совпадает с PostScript-именем файла */
export const FONT: Record<Weight, string> = {
  400: "Manrope-Regular",
  500: "Manrope-Medium",
  600: "Manrope-SemiBold",
  700: "Manrope-Bold",
  800: "Manrope-ExtraBold",
};

let loaded = false;

/** Корневая раскладка сообщает, чем кончилась загрузка */
export function setFontsLoaded(ok: boolean): void {
  loaded = ok;
}

export function fontsLoaded(): boolean {
  return loaded;
}

type FontWeightValue = "400" | "500" | "600" | "700" | "800";

/**
 * Стиль начертания: семейство при загруженном Manrope, иначе системный шрифт
 * с весом.
 */
export function font(weight: Weight): { fontFamily: string } | { fontWeight: FontWeightValue } {
  return loaded ? { fontFamily: FONT[weight] } : { fontWeight: String(weight) as FontWeightValue };
}

/**
 * Начертание по весу из прежней разметки ("600", "bold", 700).
 *
 * Экраны, ещё не переписанные на T, пишут fontWeight строкой; общие
 * компоненты переводят его сюда, чтобы и такой текст шёл нашим шрифтом.
 */
export function weightOf(value: string | number | undefined): Weight {
  if (value === "bold") return 700;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 400) return 400;
  if (n >= 800) return 800;
  return (Math.round(n / 100) * 100) as Weight;
}
