import type { Severity } from "@quizzy/shared";

export const severityColor: Record<Severity, string> = {
  none: "var(--sev-none)",
  mild: "var(--sev-mild)",
  moderate: "var(--sev-moderate)",
  severe: "var(--sev-severe)",
};

export const severityLabel: Record<Severity, string> = {
  none: "Норма",
  mild: "Лёгкая",
  moderate: "Умеренная",
  severe: "Выраженная",
};

export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

export function duration(ms: number): string {
  if (!ms) return "—";
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1).replace(".", ",")} с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} мин ${s} с` : `${m} мин`;
}

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
