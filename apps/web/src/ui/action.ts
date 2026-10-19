import { useCallback, useRef, useState } from "react";
import { useLang } from "../lang";
import { useToast } from "./toast";

/** Оборачивает действие: показывает результат и не даёт ошибке уйти в пустоту */
export function useAction() {
  const toast = useToast();
  const { ut } = useLang();
  const [busy, setBusy] = useState(false);
  /*
   * Пока действие в полёте, второе не начинается.
   *
   * Иначе «Сохранить черновиком» и сразу «Подписать» уходили на сервер
   * одновременно с одной и той же базовой версией: второй запрос падал на
   * проверке параллельных правок, и подпись молча не ставилась. Флаг живёт
   * в ref, а не только в состоянии, потому что решение принимается в момент
   * клика, до перерисовки.
   */
  const inFlight = useRef(false);

  /*
   * Действие, вернувшее ложь, считается несделанным.
   *
   * Раньше любой штатный возврат означал успех — и подтверждение
   * показывалось даже тогда, когда действие не состоялось. Так и выходило:
   * человек нажимал «удалить», отказывался в системном окне, и ему
   * сообщали «группа удалена». Группа при этом оставалась на месте.
   *
   * Вопрос лучше задавать ДО run — тогда обманывать нечему. Но там, где он
   * должен быть внутри, у действия теперь есть способ сказать «я ничего не
   * сделал»: вернуть false.
   */
  const run = useCallback(
    async (fn: () => Promise<unknown>, okText?: string) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        const outcome = await fn();
        if (outcome === false) return false;
        if (okText) toast(okText, "ok");
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : ut("ui.actionFailed"), "err");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [toast, ut],
  );

  return { run, busy };
}
