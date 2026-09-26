import { isStoreWriteError } from "../offline/writeError";

/**
 * Завершение прохождения: сдать и только потом стереть черновик.
 *
 * Черновик на устройстве — единственная копия ответов, пока сдача не
 * подтверждена: сервером (сеть есть) или очередью (сети нет, запись легла и
 * прочиталась — queue.ts, enqueue). Раньше экран стирал черновик после
 * любого «успеха», а успехом очередь отчитывалась и тогда, когда запись не
 * легла, — и ответы пропадали после слов «збережено».
 *
 * Отказ — не исключение наружу, а исход: экрану надо не упасть, а сказать
 * человеку, что случилось, и оставить кнопку «Завершити» живой.
 * `notSaved` — особый случай: сети нет и на устройство записать не вышло
 * (кончилось место). Отличается от «сервер отказал» тем, что человеку есть
 * что сделать самому — освободить место или дождаться связи.
 *
 * Без react-native: решение «когда можно стирать» проверяется тестом.
 */
export type FinishOutcome<R> =
  | { ok: true; result: R }
  | { ok: false; notSaved: boolean; error: unknown };

export async function finishSubmission<R>(steps: {
  submit: () => Promise<R>;
  dropDraft: () => void;
}): Promise<FinishOutcome<R>> {
  let result: R;
  try {
    result = await steps.submit();
  } catch (error) {
    return { ok: false, notSaved: isStoreWriteError(error), error };
  }
  try {
    steps.dropDraft();
  } catch {
    /*
     * Сдача уже подтверждена; не стёрся лишь черновик. Это хуже, чем
     * чисто, — при следующем открытии предложат «продолжить», — но ответы
     * целы, и ронять из-за этого экран результата нельзя.
     */
  }
  return { ok: true, result };
}

/**
 * Что сказать человеку при отказе: ключ словаря или текст ошибки сервера.
 * Текст ошибки хранилища — для разработчика (writeError.ts), на экран он не
 * идёт.
 */
export function finishFailureText(
  outcome: { notSaved: boolean; error: unknown },
  ut: (key: "ms.notSavedOnDevice" | "runner.submitFailed") => string,
): string {
  if (outcome.notSaved) return ut("ms.notSavedOnDevice");
  return outcome.error instanceof Error && outcome.error.message ? outcome.error.message : ut("runner.submitFailed");
}
