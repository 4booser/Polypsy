import type { Lang } from "./types";

/**
 * Тексты уведомлений.
 *
 * Третий словарь рядом с UI и ERRORS, и заведён он по той же причине, что
 * ERRORS: это текст, который собирает сервер, а читает человек. Словарь
 * интерфейса сюда не годится — фоновая рассылка идёт без запроса, и клиента,
 * который перевёл бы ключ, в этот момент не существует.
 *
 * Текст нейтральный: слова «психолог» и «психиатр» на экране блокировки нет.
 * Уведомление видят посторонние — сосед в маршрутке, сослуживец, — и по нему
 * не должно быть понятно, к кому человек идёт.
 */
export const PUSH: Record<string, { uk: string; ru: string }> = {
  /*
   * «Завтра» здесь было бы неправдой.
   *
   * Напоминание уходит за сутки до приёма — то есть и за двадцать часов, и
   * за пять: пока человек не записался позже. Слово «завтра» верно только в
   * части этих случаев, а в остальных отправляет человека не в тот день.
   * Дата не короче и не длиннее — зато верна всегда.
   */
  "push.appointmentDayTitle": { uk: "Нагадування про прийом", ru: "Напоминание о приёме" },
  "push.appointmentDayBody": {
    uk: "{date}, {time}{room}. Якщо не встигаєте — перенесіть заздалегідь",
    ru: "{date}, {time}{room}. Если не успеваете — перенесите заранее",
  },
  "push.appointmentSoonTitle": { uk: "Прийом за годину", ru: "Приём через час" },
  "push.appointmentSoonBody": { uk: "{time}{room}", ru: "{time}{room}" },
  "push.room": { uk: ", каб. {room}", ru: ", каб. {room}" },
} as const;

export type PushKey = keyof typeof PUSH;
export type PushParams = Record<string, string | number>;

/** Собрать текст уведомления: тот же механизм подстановки, что у отказов */
export function renderPush(key: string, lang: Lang, params?: PushParams): string {
  const entry = PUSH[key];
  if (!entry) return key;
  let text = entry[lang];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
