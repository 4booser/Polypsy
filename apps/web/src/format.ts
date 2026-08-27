import { formatDuration, type Severity, type UiKey } from "@quizzy/shared";

/**
 * Цвет заливки: метки на графиках, полоски, доли кольца.
 * Рядом с ними нет мелкого текста, и насыщенность важнее контраста с фоном.
 */
export const severityColor: Record<Severity, string> = {
  none: "var(--sev-none)",
  mild: "var(--sev-mild)",
  moderate: "var(--sev-moderate)",
  severe: "var(--sev-severe)",
};

/**
 * Цвет текста той же степени выраженности — другой и зависит от темы.
 *
 * Один цвет на обе задачи не годится: жёлтый #fab219 на белой карточке даёт
 * контраст 1.83 при пороге 4.5. Заливка кружка на графике и слово
 * «умеренная» в таблице — разные вещи.
 */
export const severityTextColor: Record<Severity, string> = {
  none: "var(--sev-none-text)",
  mild: "var(--sev-mild-text)",
  moderate: "var(--sev-moderate-text)",
  severe: "var(--sev-severe-text)",
};

/**
 * Ключи подписей степени выраженности.
 *
 * Сами подписи живут в общем словаре: они видны на каждом экране с
 * результатом и в мобильном приложении тоже, а два словаря однажды
 * разойдутся.
 */
export const severityKey = {
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
} as const satisfies Record<Severity, UiKey>;

export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

/** Длительность — из общего пакета: у мобилки была своя копия, и они бы разошлись */
export const duration = formatDuration;

export function dateTime(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

export function day(iso: string): string {
  return iso.slice(5, 10);
}

/** Только часы и минуты: «проходит с 14:05» читается быстрее полной даты */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
