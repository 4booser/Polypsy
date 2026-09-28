/**
 * Время приёма для сценариев e2e — чистая логика, без браузера и Playwright.
 *
 * Отдельным модулем от helpers.ts, потому что проверяется юнит-тестом на
 * подменённых часах (slotWindow.test.ts), а helpers.ts тянет @playwright/test,
 * который в процессе `bun test` не грузится (см. testMatch в
 * playwright.config.ts).
 *
 * Было (внешний разбор, волна 15, п. 15): дата окна дополнительного времени
 * — сегодняшняя, а время — «сейчас + N минут» с переходом через полночь. В
 * 23:58 по Киеву помощник заводил окно «сегодня 00:02–00:07», то есть в
 * прошлом; свободного слота не появлялось, и сценарии приёма падали на
 * подготовке примерно с 23:00 до 00:00 — окна к тому же уезжали вперёд с
 * каждым вызовом (общий счётчик), и к концу прогона до полуночи не хватало
 * часа.
 *
 * Стало:
 *   — день окна и его время считаются от одного момента по Киеву;
 *   — окна лежат на пятиминутной сетке суток и через полночь не переходят;
 *   — ближайшее незаведённое окно, а не «на пять минут дальше предыдущего»:
 *     окна не уезжают вперёд от вызова к вызову;
 *   — места до конца суток нет — сценарий пропускается явно, с причиной
 *     (helpers.ts зовёт test.skip), а не падает. Сервер часами не
 *     подменяется: и экран дня, и занятие слота живут по настоящему времени.
 */

/** Длина окна и слота в нём, минут */
export const WINDOW_MINUTES = 5;
/**
 * Запас до начала окна, минут: занять можно только будущий слот (takeSlot в
 * routes/clinic.ts), а между заведением окна и записью проходят секунды.
 */
export const WINDOW_LEAD_MINUTES = 4;
/** Последняя минута суток, которую можно записать временем «HH:MM» */
const LAST_MINUTE = 23 * 60 + 59;

export const NO_ROOM_TODAY =
  "до конца суток в Киеве не осталось места под своё время приёма: сценарий приёма пропущен, а не провален — экран дня показывает сегодняшний день, а сервер часами не подменяется";

export interface ExtraWindow {
  /** День по Киеву, YYYY-MM-DD */
  date: string;
  startsAt: string;
  endsAt: string;
}

/** День и минута суток по стенным часам Киева — у отделения посева этот пояс */
export function kyivNow(now: number): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minute: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** Ключ окна для списка уже заведённых */
export const windowKey = (w: ExtraWindow) => `${w.date} ${w.startsAt}`;

/**
 * Ближайшее незаведённое окно сегодня; `null` — до конца суток места нет.
 *
 * Сетка пяти минут, а не «сейчас + N»: слоты уникальны парой «специалист +
 * начало», а открытые слоты одного специалиста не пересекаются (0105) —
 * окна, сдвинутые друг от друга на пару минут, накладывались бы, и второе
 * не раскладывалось бы в слот.
 */
export function nextExtraWindow(now: number, tried: ReadonlySet<string>): ExtraWindow | null {
  const { date, minute } = kyivNow(now);
  let start = Math.ceil((minute + WINDOW_LEAD_MINUTES) / WINDOW_MINUTES) * WINDOW_MINUTES;
  while (tried.has(`${date} ${hhmm(start)}`)) start += WINDOW_MINUTES;
  if (start + WINDOW_MINUTES > LAST_MINUTE) return null;
  return { date, startsAt: hhmm(start), endsAt: hhmm(start + WINDOW_MINUTES) };
}

export interface SlotIo {
  now(): number;
  /** Первый свободный слот специалиста в этот день по Киеву */
  freeToday(date: string): Promise<string | null>;
  /** Завести дополнительное время (исключение расписания kind: "extra") */
  addWindow(w: ExtraWindow): Promise<void>;
}

export type SlotPick = { slotId: string } | { skip: string };

/**
 * Свободный слот на сегодня: из сетки дня или из заведённого окна.
 *
 * `tried` — окна, уже заведённые этим процессом: второй вызов в ту же минуту
 * не просит занятое время. Места до конца суток нет или полночь наступила
 * посреди подбора — `{ skip }`; свободного слота нет, хотя место в сутках
 * есть, — это поломка, и она падает.
 */
export async function pickSlotToday(io: SlotIo, tried: Set<string>, attempts = 60): Promise<SlotPick> {
  const today = kyivNow(io.now()).date;
  /*
   * Сутки на исходе — пропуск и при свободном слоте в сетке: сценарий
   * открывает экран «сегодня» уже после записи, и полночь посреди него
   * показала бы другой день.
   */
  if (!nextExtraWindow(io.now(), new Set())) return { skip: NO_ROOM_TODAY };

  const first = await io.freeToday(today);
  if (first) return { slotId: first };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const window = nextExtraWindow(io.now(), tried);
    if (!window || window.date !== today) return { skip: NO_ROOM_TODAY };
    tried.add(windowKey(window));
    await io.addWindow(window);
    const slotId = await io.freeToday(today);
    if (slotId) return { slotId };
  }
  throw new Error(`дополнительное время заводилось ${attempts} раз подряд, а свободного слота не появилось`);
}
