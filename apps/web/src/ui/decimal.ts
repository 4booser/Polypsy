import type { Lang } from "@quizzy/shared";
import { currentLang } from "../lang";

/**
 * Число на языке экрана: до `digits` знаков, лишние нули прочь, дробная
 * часть — через запятую в украинском и русском («5,5») и через точку в
 * английском («5.5»). Без 0.30000000000000004 из суммы.
 *
 * Язык по умолчанию — языка консоли (lang.tsx, currentLang): функцию зовут и
 * вне компонентов (подписи графиков, модели экранов). Компонент передаёт свой
 * `lang` из useLang явно. Отдельным модулем без компонентов: его берут и
 * чистые модели (charts/ladder.ts), которым незачем тянуть за собой поповер.
 */
export function decimal(v: number, lang: Lang = currentLang, digits = 2): string {
  const k = 10 ** digits;
  const s = String(Math.round(v * k) / k);
  return lang === "en" ? s : s.replace(".", ",");
}
