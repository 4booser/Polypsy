import { LOCALE_OF, type Lang } from "@quizzy/shared";
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

const groupers = new Map<Lang, Intl.NumberFormat>();

/**
 * Счёт с разрядами на языке экрана: «8 123» по-украински и по-русски
 * (неразрывным пробелом — число не рвётся переносом), «8,123» по-английски.
 * Для счётчиков набора: вкладки, «з 8 123», «Вибрано: 1 204», пилюли.
 */
export function grouped(n: number, lang: Lang = currentLang): string {
  let f = groupers.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE_OF[lang], { maximumFractionDigits: 0 });
    groupers.set(lang, f);
  }
  return f.format(n);
}
