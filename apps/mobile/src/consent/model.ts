/**
 * Экран информированного согласия — что показать и какие у человека выходы.
 *
 * Две ошибки, которые здесь закрываются.
 *
 * Отказ, которого не видно. Кнопка «Не погоджуюся» была, но сразу выводила
 * из учётной записи и уводила на вход — а объяснение последствий ставилось
 * на экран, который в тот же миг закрывался. Человек не узнавал, что именно
 * стало недоступно и что делать дальше, а сервер не узнавал об отказе вовсе.
 * Теперь отказ — своё состояние экрана (declined): что недоступно, как
 * обсудить условия, и два выхода — выйти из учётной записи или вернуться к
 * тексту и передумать.
 *
 * Согласие с невиданным текстом. Если текст не загрузился (сервер ответил
 * ошибкой), экран показывал ошибку — и рядом ту же кнопку «Погоджуюся»:
 * нажатие принимало действующую редакцию, которую человек не видел.
 * Согласие без прочтения юридически пусто. Теперь без текста принимать
 * нечего (failed): повторить загрузку или выйти.
 *
 * Правило, которое сторожит тест: из каждого состояния есть выход, и
 * «согласиться» бывает только рядом с текстом.
 *
 * Без react-native — проверяется тестом.
 */

export interface ConsentStatus {
  required: boolean;
  accepted: boolean;
  version: number | null;
  text: string | null;
}

export type ConsentView =
  /** принято или не требуется — дальше, в приложение */
  | { kind: "pass" }
  /** текст есть: согласиться или отказаться */
  | { kind: "read"; text: string }
  /** текст не получен: принимать нечего — повторить или выйти */
  | { kind: "failed" }
  /** отказ: что недоступно, как быть дальше; выйти или вернуться к тексту */
  | { kind: "declined" };

export type ConsentAction = "accept" | "decline" | "retry" | "signOut" | "reconsider";

export function viewOfStatus(status: ConsentStatus): ConsentView {
  if (!status.required || status.accepted) return { kind: "pass" };
  const text = status.text?.trim();
  return text ? { kind: "read", text } : { kind: "failed" };
}

/**
 * Статус не получен. Без сети (status 0) экран не запирает уже работавшего
 * человека: согласие проверится при следующем онлайне, как и было. Любой
 * другой отказ — «текста нет», а не «пропустить».
 */
export function viewOfLoadError(status: number | undefined): ConsentView {
  return status === 0 ? { kind: "pass" } : { kind: "failed" };
}

export function actionsOf(view: ConsentView): ConsentAction[] {
  switch (view.kind) {
    case "pass":
      return [];
    case "read":
      return ["accept", "decline"];
    case "failed":
      return ["retry", "signOut"];
    case "declined":
      return ["signOut", "reconsider"];
  }
}
