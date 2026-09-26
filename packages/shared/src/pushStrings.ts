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
 *
 * Все три языка обязательны, в отличие от словаря оболочки: записей здесь
 * единицы, и переведены они сразу. Язык выбирается по устройству, на которое
 * уходит уведомление (push_tokens.lang, см. apps/api/src/lib/push.ts), — то
 * есть на том, на котором человек читает приложение, а не на том, на котором
 * последний раз проходил методику.
 */
export type PushEntry = Record<Lang, string>;

export const PUSH: Record<string, PushEntry> = {
  /*
   * «Завтра» здесь было бы неправдой.
   *
   * Напоминание уходит за сутки до приёма — то есть и за двадцать часов, и
   * за пять: пока человек не записался позже. Слово «завтра» верно только в
   * части этих случаев, а в остальных отправляет человека не в тот день.
   * Дата не короче и не длиннее — зато верна всегда.
   */
  "push.appointmentDayTitle": {
    uk: "Нагадування про прийом",
    ru: "Напоминание о приёме",
    en: "Appointment reminder",
  },
  "push.appointmentDayBody": {
    uk: "{date}, {time}{room}. Якщо не встигаєте — перенесіть заздалегідь",
    ru: "{date}, {time}{room}. Если не успеваете — перенесите заранее",
    en: "{date}, {time}{room}. If you can’t make it, please reschedule in advance",
  },
  "push.appointmentSoonTitle": { uk: "Прийом за годину", ru: "Приём через час", en: "Appointment in one hour" },
  "push.appointmentSoonBody": { uk: "{time}{room}", ru: "{time}{room}", en: "{time}{room}" },
  "push.room": { uk: ", каб. {room}", ru: ", каб. {room}", en: ", room {room}" },
  /*
   * Рассылка: ни названия, ни текста. Название пишет специалист, и «Група
   * ризику: анкета настрою» на экране блокировки сообщает соседу ровно то,
   * чего сообщать нельзя. Уведомление лишь зовёт открыть приложение.
   */
  "push.mailingTitle": { uk: "Нове повідомлення", ru: "Новое сообщение", en: "New message" },
  "push.mailingBody": {
    uk: "Відкрийте застосунок, щоб прочитати",
    ru: "Откройте приложение, чтобы прочитать",
    en: "Open the app to read it",
  },
  /*
   * Назначение по расписанию (lib/scheduler.ts). Было набрано в коде
   * по-русски и уходило русским всем, включая тех, у кого приложение на
   * украинском. Ни методики, ни диагноза — по той же причине, что выше.
   * Дата — календарный день ISO, одинаково читаемый на любом языке.
   */
  "push.assignmentTitle": { uk: "Призначено обстеження", ru: "Назначено обследование", en: "New assessment assigned" },
  "push.assignmentBody": { uk: "Строк — до {date}", ru: "Срок — до {date}", en: "Due by {date}" },
  /*
   * Тревога — дежурному специалисту (lib/notify.ts), тоже прежде русской
   * строкой в коде. Название методики здесь есть и было: уведомление идёт
   * сотруднику, а не пациенту, и без названия по нему нельзя решить, бежать
   * ли прямо сейчас.
   */
  "push.alertTitle": { uk: "Тривога у вашій групі", ru: "Тревога в вашей группе", en: "Risk alert in your group" },
  "push.alertBody": {
    uk: "Методика «{title}». Відкрийте розбір випадків.",
    ru: "Методика «{title}». Откройте разбор случаев.",
    en: "Assessment “{title}”. Open risk cases to review it.",
  },
  /*
   * Оповещения техпанели (участок obs2b, apps/api/src/lib/opsAlerts.ts) —
   * в Telegram и на почту дежурным разработчикам и администратору. Язык —
   * украинский: у адреса в Telegram и почтового ящика языка нет, а у
   * отделения он один. {what} — описание сигнала из push.ops.what.*.
   */
  "push.ops.fired": { uk: "Збій: {what}", ru: "Сбой: {what}", en: "Failure: {what}" },
  "push.ops.repeat": { uk: "Досі триває (з {since}): {what}", ru: "Всё ещё идёт (с {since}): {what}", en: "Still ongoing (since {since}): {what}" },
  "push.ops.resolved": { uk: "Відновлено: {what}. Тривало {minutes} хв.", ru: "Восстановлено: {what}. Длилось {minutes} мин.", en: "Recovered: {what}. Lasted {minutes} min." },
  "push.ops.test": { uk: "Тестове сповіщення техпанелі: канал працює", ru: "Тестовое оповещение техпанели: канал работает", en: "Tech panel test alert: the channel works" },
  "push.ops.link": { uk: "Техпанель: {url}", ru: "Техпанель: {url}", en: "Tech panel: {url}" },
  "push.ops.what.errors5xx": { uk: "частка 5xx {value} % за {window} хв (поріг {threshold} %)", ru: "доля 5xx {value} % за {window} мин (порог {threshold} %)", en: "5xx share {value}% over {window} min (threshold {threshold}%)" },
  "push.ops.what.schedulerSilent": { uk: "планувальник мовчить {value} хв (поріг {threshold} хв)", ru: "планировщик молчит {value} мин (порог {threshold} мин)", en: "scheduler silent for {value} min (threshold {threshold} min)" },
  "push.ops.what.p95": { uk: "p95 відповіді {value} мс за {window} хв (поріг {threshold} мс)", ru: "p95 ответа {value} мс за {window} мин (порог {threshold} мс)", en: "response p95 {value} ms over {window} min (threshold {threshold} ms)" },
  "push.ops.what.diskFree": { uk: "вільно {value} % диска записів (поріг {threshold} %)", ru: "свободно {value} % диска записей (порог {threshold} %)", en: "{value}% free on the recordings disk (threshold {threshold}%)" },
  "push.ops.what.auditChain": { uk: "перевірка ланцюжка журналу не пройшла", ru: "проверка цепочки журнала не прошла", en: "audit log chain check failed" },
};

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
