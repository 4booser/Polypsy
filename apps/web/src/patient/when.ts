import type { UiKey } from "@quizzy/shared";
import { locale } from "../format";

/**
 * Даты кабинета пациента — словами, которыми их говорят: «субота, 10.10»,
 * «сьогодні о 14:12», «сб 10.10». Без React, чтобы проверялись в тестах.
 *
 * Язык — страницы (format.ts, locale): украинский интерфейс — украинские
 * дни недели.
 */

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Сколько календарных дней от сегодня: 0 — сегодня, 1 — завтра, −1 — вчера */
export function dayOffset(iso: string, now = Date.now()): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(new Date(now))) / 86_400_000);
}

/** «10.10» — день и месяц числами: в строке кабинета год не нужен, а месяц словом длинный */
export function dm(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
}

/** «14:12» */
export function hm(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

/** «сб» — короткий день недели */
export function weekdayShort(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { weekday: "short" }).replace(".", "");
}

/** «Субота» — день недели с большой буквы, как начало строки */
export function weekdayLong(iso: string): string {
  const w = new Date(iso).toLocaleDateString(locale(), { weekday: "long" });
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** «Субота, 10.10, 10:30–11:20» — когда приём, крупной строкой карточки */
export function visitWhen(startsAt: string, endsAt?: string | null): string {
  const range = endsAt ? `${hm(startsAt)}–${hm(endsAt)}` : hm(startsAt);
  return `${weekdayLong(startsAt)}, ${dm(startsAt)}, ${range}`;
}

/** «сб 10.10» — день в строке списка */
export function shortDay(iso: string): string {
  return `${weekdayShort(iso)} ${dm(iso)}`;
}

/**
 * «сьогодні о 14:12», «учора о 19:40», «03.10 о 21:14» — когда что-то
 * случилось, как сказал бы человек. Ключи — у вызывающего: эта функция
 * собирает строку из уже переведённых слов.
 */
export function whenSaid(iso: string, ut: (key: UiKey) => string, now = Date.now()): string {
  const off = dayOffset(iso, now);
  const at = ut("ptw.atTime").replace("{t}", hm(iso));
  if (off === 0) return `${ut("ptw.today")} ${at}`;
  if (off === -1) return `${ut("ptw.yesterday")} ${at}`;
  if (off === 1) return `${ut("ptw.tomorrow")} ${at}`;
  return `${dm(iso)} ${at}`;
}

/** Приветствие по часу: до 12 — ранок, до 18 — день, потом — вечір */
export function greetingKey(now = new Date()): UiKey {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "ptw.helloMorning";
  if (h >= 12 && h < 18) return "ptw.helloDay";
  return "ptw.helloEvening";
}

/** Время суток слота в записи: ранок до 12, день до 17, вечір після */
export type DayPart = "morning" | "day" | "evening";

export function dayPart(iso: string): DayPart {
  const h = new Date(iso).getHours();
  if (h < 12) return "morning";
  if (h < 17) return "day";
  return "evening";
}

/** Календарный день момента по местному календарю: «2026-10-10» — ключ для группировки */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
