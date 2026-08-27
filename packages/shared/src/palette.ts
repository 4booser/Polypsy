import type { Severity } from "./types";

/**
 * Единая палитра степеней выраженности.
 *
 * Держалась в двух местах: `theme.css` консоли и `theme.ts` мобильного
 * приложения. Значения совпадали случайно и однажды бы разошлись — а
 * «умеренная выраженность» обязана быть одного цвета в отчёте на бумаге, на
 * экране специалиста и на телефоне обследуемого. Иначе люди начинают
 * сверять оттенки вместо того, чтобы читать результат.
 *
 * Заливка и текст разведены намеренно: один цвет не может решать обе задачи.
 * Насыщенный оттенок хорош для метки на графике, где рядом нет мелкого
 * текста, и провален как цвет подписи — жёлтый #fab219 на белой карточке
 * даёт контраст 1.83 при пороге 4.5.
 */

/** Заливка: метки на графиках, полоски, доли кольца */
export const SEVERITY_FILL: Record<Severity, string> = {
  none: "#0ca30c",
  mild: "#fab219",
  moderate: "#ec835a",
  severe: "#d03b3b",
};

/** Цвет текста на тёмной подложке — посчитан, а не подобран */
export const SEVERITY_TEXT_DARK: Record<Severity, string> = {
  none: "#4ecb4e",
  mild: "#f0c168",
  moderate: "#f2ab8f",
  severe: "#e8706e",
};

/** Цвет текста на светлой подложке */
export const SEVERITY_TEXT_LIGHT: Record<Severity, string> = {
  none: "#0a7d0a",
  mild: "#8a6410",
  moderate: "#b3542c",
  severe: "#c22f2f",
};

/** Ключи подписей — сами подписи в словаре оболочки */
export const SEVERITY_KEY = {
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
} as const;
