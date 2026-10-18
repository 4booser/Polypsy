/**
 * Сетка приёмного дня в стенных часах — одна на сервер и консоль.
 *
 * Сервер раскладывает по ней слоты (apps/api/src/lib/schedule.ts), а
 * календарь недели в консоли рисует по ней часы приёма и считает окна
 * (apps/web/src/pages/schedule). Прежде арифметика жила только на сервере, и
 * повторить её на экране значило завести вторую — с той же ошибкой или со
 * своей: «3 з 6 вікон» на экране и шесть слотов в базе разошлись бы при первой
 * же правке одного места без другого.
 *
 * Часовых поясов здесь нет вовсе: только «HH:MM» внутри одного дня. Перевод
 * в моменты делает Postgres (resolveWanted на сервере).
 */

export interface GridInterval {
  /** Стенное время начала, HH:MM */
  from: string;
  /** Стенное время конца, HH:MM */
  to: string;
  slotMinutes: number;
}

export function gridMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function gridClock(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Что именно вычесть из интервала.
 *
 * Отпуск на весь день убирает его целиком; отпуск с часами вырезает середину
 * и может разорвать один интервал на два — поэтому возвращается список, а не
 * один интервал.
 */
export function subtractInterval(interval: GridInterval, off: { from: string; to: string } | null): GridInterval[] {
  if (!off) return [];
  const a = gridMinutes(interval.from);
  const b = gridMinutes(interval.to);
  const x = gridMinutes(off.from);
  const y = gridMinutes(off.to);
  if (y <= a || x >= b) return [interval];
  const parts: GridInterval[] = [];
  if (x > a) parts.push({ ...interval, from: interval.from, to: gridClock(x) });
  if (y < b) parts.push({ ...interval, from: gridClock(y), to: interval.to });
  return parts;
}

/** Желаемая сетка на один день: шаблон дня недели минус отпуска плюс дополнительные часы */
export function intervalsForDay(
  weekday: number,
  templates: (GridInterval & { weekday: number })[],
  offs: { from: string | null; to: string | null }[],
  extras: GridInterval[],
): GridInterval[] {
  let result: GridInterval[] = templates.filter((t) => t.weekday === weekday).map((t) => ({ ...t }));

  for (const off of offs) {
    // отпуск без часов — весь день целиком
    if (!off.from || !off.to) return extras;
    result = result.flatMap((i) => subtractInterval(i, { from: off.from!, to: off.to! }));
  }
  return [...result, ...extras];
}

/** Разбивка интервала на слоты. Хвост короче слота отбрасывается: приём в 20 минут вместо 50 — это не приём. */
export function sliceInterval(interval: GridInterval): { from: string; to: string }[] {
  const start = gridMinutes(interval.from);
  const end = gridMinutes(interval.to);
  const out: { from: string; to: string }[] = [];
  for (let t = start; t + interval.slotMinutes <= end; t += interval.slotMinutes) {
    out.push({ from: gridClock(t), to: gridClock(t + interval.slotMinutes) });
  }
  return out;
}

/**
 * Слоты одного дня без пересечений.
 *
 * Интервалы берутся по порядку — обычная неделя раньше дополнительных
 * часов, — и каждый следующий режется только по времени, которое ещё не
 * занято уже разложенными слотами. Без этого дополнительные часы 09:45–11:00
 * поверх обычных 09:00–10:00 давали 09:45–10:15 поверх 09:30–10:00: два
 * открытых слота на одни и те же четверть часа. Теперь такое не примет и
 * база (миграция 0105), и сетка обязана строиться так, чтобы ей нечего было
 * отвергать, — иначе дополнительные часы молча пропадали бы целиком.
 *
 * Вычитаются именно слоты, а не интервалы: отброшенный хвост обычного
 * интервала (09:50–10:10 при слотах по 50 минут) свободен, и дополнительные
 * часы вправе его занять.
 */
export function layOutDay(intervals: GridInterval[]): { from: string; to: string }[] {
  const laid: { from: string; to: string }[] = [];
  for (const interval of intervals) {
    let free: GridInterval[] = [interval];
    for (const piece of laid) free = free.flatMap((part) => subtractInterval(part, piece));
    for (const part of free) laid.push(...sliceInterval(part));
  }
  return laid.sort((a, b) => gridMinutes(a.from) - gridMinutes(b.from));
}
