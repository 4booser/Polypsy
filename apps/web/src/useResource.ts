import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

/**
 * Загрузка данных с отменой устаревших ответов.
 *
 * Зачем это нужно. Экран аналитики шлёт запрос на каждое нажатие в поле
 * периода. Запросы разной тяжести идут разное время: широкий период —
 * четверть секунды, узкий — вдвое быстрее. Если сузить период, ответ по
 * широкому приходит позже и затирает правильные данные. Человек видит
 * аналитику за период, который не запрашивал, и узнать об этом не может:
 * цифры выглядят настоящими.
 *
 * Для клинических данных это худший вид ошибки — тихая и правдоподобная.
 *
 * Хук решает это не «аккуратностью», а устройством: у каждой загрузки свой
 * номер, и результат принимается только от последней. Написать неправильно
 * нельзя, если данные грузятся только отсюда.
 */

export interface Resource<T> {
  data: T | null;
  /** Идёт первая загрузка: данных ещё нет */
  loading: boolean;
  /** Идёт обновление: данные есть, но они устаревают */
  refreshing: boolean;
  error: string | null;
  /** Связи нет — это не ошибка экрана, и говорить о ней надо иначе */
  offline: boolean;
  reload: () => void;
  /** Подменить данные локально: после действия, изменившего одну строку */
  patch: (next: T) => void;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; pollMs?: number } = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? 0;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * Номер запуска, а не AbortController: fetch мы всё равно доводим до конца
   * (сервер уже сделал работу), важно лишь не применять устаревший ответ.
   * Плюс это работает и для загрузок, которые не ходят в сеть.
   */
  const runId = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (!enabled) return;
    const id = ++runId.current;
    setBusy(true);
    // ошибку сбрасываем ДО запроса: иначе экран остаётся в отказе навсегда,
    // даже когда связь давно вернулась
    setError(null);
    setOffline(false);

    loadRef
      .current()
      .then((next) => {
        if (id !== runId.current || !mounted.current) return;
        setData(next);
      })
      .catch((e: unknown) => {
        if (id !== runId.current || !mounted.current) return;
        // status 0 — сети нет; это другое состояние, не поломка экрана
        if (e instanceof ApiError && e.status === 0) setOffline(true);
        else setError(e instanceof Error ? e.message : "Не удалось загрузить");
      })
      .finally(() => {
        if (id === runId.current && mounted.current) setBusy(false);
      });
  }, [enabled]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(start, [...deps, enabled]);

  /*
   * Живые экраны (киоск-сеанс, очередь тревог) обновляются сами. Опрос живёт
   * здесь, а не в экране, по той же причине, что и отмена устаревших ответов:
   * таймер, забытый при уходе со страницы, продолжает ходить в сеть, а его
   * ответ применяется к уже размонтированному экрану.
   *
   * Скрытую вкладку не опрашиваем: смысла нет, а на общей сети госпиталя
   * забытая вкладка сутками стучится в API.
   */
  useEffect(() => {
    if (!pollMs || !enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") start();
    };
    const timer = setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [pollMs, enabled, start]);

  return {
    data,
    loading: busy && data === null,
    refreshing: busy && data !== null,
    error,
    offline,
    reload: start,
    patch: setData,
  };
}
