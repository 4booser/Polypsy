import type { AppointmentView, UiKey } from "@quizzy/shared";

/**
 * Ход приёма с экрана дня: одно следующее действие и один уход с хода.
 *
 * То, куда приём можно двинуть отсюда: остальные переходы этому экрану не
 * принадлежат. «booked» здесь — только шаг назад от ошибочного «пришёл»
 * (см. OFF_PATH), а не запись. Проверяется без браузера
 * (apps/web/test/dayActions.test.tsx).
 */
export type Move = "booked" | "arrived" | "in_progress" | "done" | "no_show";
type Status = AppointmentView["status"];

export const STATUS_KEY: Record<Status, UiKey> = {
  booked: "day.statusBooked",
  confirmed: "day.statusConfirmed",
  arrived: "day.statusArrived",
  in_progress: "day.statusInProgress",
  done: "day.statusDone",
  no_show: "day.statusNoShow",
  cancelled: "day.statusCancelled",
};

/** Одно действие: куда двинуть приём и как это называется на кнопке */
export interface Act {
  to: Move;
  key: UiKey;
  /**
   * Вопрос перед нажатием. Есть только у шага назад: он снимает отметку
   * времени, и случайное нажатие стоило бы ещё одного исправления.
   */
  confirm?: UiKey;
  /** Тихая кнопка: поправка, а не ход приёма — глаз не должен цепляться за неё первой */
  quiet?: true;
}

/**
 * Следующее действие для приёма — ровно одно.
 *
 * Специалисту в этот момент нужно одно нажатие: человек вошёл в кабинет.
 * Неявку исправляет та же «Явка»: её ставит и фоновый проход через два часа
 * после конца приёма — ошибаясь ровно там, где специалист забыл отметить
 * явку между двумя людьми. Кнопки — «Явка» / «Неявка», без рода: человек на
 * приёме бывает и женщиной.
 */
const NEXT: Partial<Record<Status, Act>> = {
  booked: { to: "arrived", key: "day.came" },
  confirmed: { to: "arrived", key: "day.came" },
  arrived: { to: "in_progress", key: "day.start" },
  in_progress: { to: "done", key: "day.finish" },
  no_show: { to: "arrived", key: "day.came" },
};

/**
 * Уход с обычного хода — неявка и шаг назад (#38, w19:ui): снять ошибочную
 * отметку явки или начала приёма. Сервер снимает ровно одну отметку; перед
 * нажатием — вопрос, потому что кнопка стоит вплотную к «Почати».
 * Отмена приёма сюда не относится: её делают из розкладу.
 */
const OFF_PATH: Partial<Record<Status, Act>> = {
  booked: { to: "no_show", key: "day.noShow" },
  confirmed: { to: "no_show", key: "day.noShow" },
  arrived: { to: "booked", key: "day.undo", confirm: "day.undoArrived", quiet: true },
  in_progress: { to: "arrived", key: "day.undo", confirm: "day.undoStarted", quiet: true },
};

/**
 * Места в столбце действий, слева направо. Мест всегда столько, сколько
 * здесь перечислено, независимо от того, сколько действий доступно в
 * строке: «Неявка» и «Явка» стоят на одном отступе во всех строках,
 * и столбец читается сверху вниз.
 */
export const SLOTS = ["offPath", "step"] as const;
export type Slot = (typeof SLOTS)[number];

/** Что можно нажать по строке: по действию на каждое место, пустые — тоже места */
export function rowActions(status: Status): Record<Slot, Act | null> {
  return { offPath: OFF_PATH[status] ?? null, step: NEXT[status] ?? null };
}

/**
 * Что уйдёт на сервер по нажатию: ход приёма — сразу, шаг назад — только
 * после «да». Отказ в вопросе — null, и запроса нет вовсе.
 */
export function moveOf(act: Act, ask: (question: UiKey) => boolean): Move | null {
  if (act.confirm && !ask(act.confirm)) return null;
  return act.to;
}
