import { FONT } from "./fonts";

/**
 * Файлы Manrope для expo-font — отдельно от fonts.ts, потому что `require`
 * шрифта разбирает только сборщик, а не тестовый процесс.
 *
 * Статические начертания 400…800 из google/fonts (Manrope 4.504, SIL OFL 1.1,
 * текст лицензии — assets/fonts/OFL.txt). Покрывают кириллицу, латиницу,
 * «№», «₴», стрелки и «≈»; признак tnum (моноширинные цифры) в файлах есть.
 */
export const FONT_FILES = {
  [FONT[400]]: require("../assets/fonts/Manrope-Regular.ttf"),
  [FONT[500]]: require("../assets/fonts/Manrope-Medium.ttf"),
  [FONT[600]]: require("../assets/fonts/Manrope-SemiBold.ttf"),
  [FONT[700]]: require("../assets/fonts/Manrope-Bold.ttf"),
  [FONT[800]]: require("../assets/fonts/Manrope-ExtraBold.ttf"),
};
