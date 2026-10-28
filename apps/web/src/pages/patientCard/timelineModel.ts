import type { TimelineItem } from "../../api";
import { dayKey } from "../../format";

/*
 * Хронология рабочего места — чистая часть: события по дням и строки ленты.
 * Проверяется без отрисовки (apps/web/test/timelineDay.test.ts).
 */

/**
 * События по календарным дням — в поясе консоли, а не по UTC.
 *
 * День брался срезом строки ISO, то есть по Гринвичу: всё, что случилось в
 * Киеве после 21:00 летом (после 22:00 зимой), уезжало в следующий день —
 * тревога, сработавшая вечером, стояла под завтрашней датой рядом с
 * утренним замером того «завтра». Для хронологии, где смысл — порядок, это
 * ошибка по существу. Порядок внутри дня — как пришёл с сервера.
 */
export function groupByDay<T extends { at: string }>(items: readonly T[], timeZone?: string): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const i of items) {
    const day = dayKey(i.at, timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }
  return byDay;
}

/** Строка ленты: одно событие или однородные события одного часа вместе */
export interface TimelineLine {
  key: string;
  at: string;
  kind: TimelineItem["kind"];
  items: TimelineItem[];
}

/** Что складывается в одну строку: замеры набора и сигналы, поднятые ими */
const GROUPED = new Set<TimelineItem["kind"]>(["response", "alert"]);

/**
 * Замеры подряд в пределах часа — одна строка: набор сдают за один
 * присест, и четыре строки «пройдено» подряд читались бы как четыре
 * события. Так же сигналы: пять сигналов одной сдачи — одна строка
 * «Сигнали: 5» с перечнем, а не пять красных строк одной минуты.
 */
export function rowsOf(items: readonly TimelineItem[]): TimelineLine[] {
  const out: TimelineLine[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (
      prev &&
      GROUPED.has(it.kind) &&
      it.kind === prev.kind &&
      dayKey(prev.at) === dayKey(it.at) &&
      Math.abs(Date.parse(prev.items.at(-1)!.at) - Date.parse(it.at)) <= 3_600_000
    ) {
      prev.items.push(it);
      continue;
    }
    out.push({ key: it.id, at: it.at, kind: it.kind, items: [it] });
  }
  return out;
}

/** Подписи сигналов строки — без повторов, с числом: «PHQ-9: думки про смерть (×3)» */
export function signalLabels(items: readonly TimelineItem[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.title, (counts.get(it.title) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}
