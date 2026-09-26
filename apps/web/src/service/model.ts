import type { PublicServiceStatus, ServiceStatus } from "@quizzy/shared";

/*
 * Состояние системы на клиенте: баннер, страница статуса, флаги функций.
 * Здесь только решения — что показать и когда перечитать; разметка и
 * запросы живут рядом (MaintenanceBanner.tsx, status.ts, flags.ts).
 */

export interface BannerModel {
  tone: Exclude<ServiceStatus, "ok">;
  message: string | null;
  expectedEnd: string | null;
}

/**
 * Показывать ли баннер и какой.
 *
 * Только при «обслуговуванні» и «збоях». Объявление с состоянием «працює»
 * и текстом («Роботи завершено») баннер не держит: он янтарный, то есть
 * «требует внимания», а «всё снова работает» внимания не требует — такой
 * текст виден на странице статуса. Иначе баннер после работ висел бы до
 * следующего объявления.
 *
 * Нет ответа сервера — баннера нет. Выдумывать состояние клиенту нечем, а
 * о пропавшей связи экраны и так говорят своими словами.
 */
export function bannerFor(status: PublicServiceStatus | null): BannerModel | null {
  if (!status || status.status === "ok") return null;
  return { tone: status.status, message: status.message, expectedEnd: status.expectedEnd };
}

/**
 * Сколько минут до объявленного конца работ — для отсчёта в баннере.
 *
 * null — срок не назван или уже прошёл: «≈ 0 хв» и отрицательное число
 * обещали бы то, чего никто не обещал. Округление вверх: «≈ 1 хв» за
 * двадцать секунд до конца честнее, чем «≈ 0».
 */
export function minutesLeft(expectedEnd: string | null, now: number): number | null {
  if (!expectedEnd) return null;
  const ms = Date.parse(expectedEnd) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 60_000);
}

/** Тот же ли это календарный день (по часам человека): «до 21:30» или «до 27 вересня, 09:00» */
export function sameLocalDay(iso: string, now: number): boolean {
  const a = new Date(iso);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Как часто перечитывать состояние.
 *
 * Пока всё работает — раз в две минуты: баннер нужен, когда работы
 * начались, и две минуты задержки перекрывает событие отказа (api.ts,
 * MAINTENANCE_EVENT), которое будит опрос сразу. Во время работ — раз в
 * полминуты: люди ждут, когда можно будет сохранить, и снятый баннер —
 * это и есть ответ.
 */
export function statusPollMs(status: PublicServiceStatus | null): number {
  return status && status.status !== "ok" ? 30_000 : 120_000;
}

/**
 * Флаги перечитываются, когда сменился человек, — и только тогда.
 *
 * «Кэш на сессию»: флаг решает, показать ли новое, и мигать экраном при
 * каждом переходе незачем. Но вход другого человека за тем же компьютером
 * — это другая сессия, и чужие флаги у него остаться не должны.
 */
export function flagsStale(cachedFor: string | null | undefined, current: string | null): boolean {
  return cachedFor === undefined || cachedFor !== current;
}
