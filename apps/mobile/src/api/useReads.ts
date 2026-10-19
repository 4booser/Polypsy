import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Чтения экрана, которые можно отменить (api/abort.ts).
 *
 * `next()` — сигнал для нового чтения; прежнее, если оно ещё идёт,
 * отменяется: «Повторити» поверх медленного запроса не ждёт его, а ответ на
 * устаревший запрос не ляжет поверх свежего. `cancel()` — отменить идущее:
 * его отдают очистке useFocusEffect, и уход с экрана (другой экран поверх,
 * другая вкладка) обрывает запрос. Вернулись — фокус читает заново.
 * Размонтирование отменяет само.
 */
export function useReads(): { next: () => AbortSignal; cancel: () => void } {
  const current = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = null;
  }, []);
  const next = useCallback(() => {
    current.current?.abort();
    const ctrl = new AbortController();
    current.current = ctrl;
    return ctrl.signal;
  }, []);
  useEffect(() => cancel, [cancel]);
  return useMemo(() => ({ next, cancel }), [next, cancel]);
}
