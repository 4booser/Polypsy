import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { UI } from "@quizzy/shared";
import { currentLang } from "./lang";

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
        else setError(e instanceof Error ? e.message : UI["net.loadFailed"][currentLang]);
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

/** Страница списка: то, что отдают курсорные эндпоинты */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number | null;
}

export interface PagedResource<T> {
  items: T[] | null;
  loading: boolean;
  /** Идёт подгрузка следующей страницы: список на экране остаётся */
  loadingMore: boolean;
  error: string | null;
  offline: boolean;
  total: number | null;
  /** Есть ли что дозагрузить */
  hasMore: boolean;
  loadMore: () => void;
  /** Перечитать с первой страницы — после действия, изменившего список */
  reload: () => void;
}

/**
 * Список с постраничной подгрузкой.
 *
 * Отличается от useResource тем, что страницы дописываются к показанным, а не
 * заменяют их. Всё остальное — то же самое и по той же причине: у каждой
 * загрузки свой номер, и ответ применяется только от последней.
 *
 * Гонка здесь коварнее, чем на обычном экране: пока летит ответ на «показать
 * ещё», человек меняет фильтр — и хвост старой выборки дописывается к новой.
 * Список выглядит правдоподобно и содержит чужие строки. Поэтому номер
 * запуска проверяется и перед дописыванием тоже.
 *
 * `debounceMs` — для поиска: набор текста не должен дёргать сервер на каждую
 * букву, но первая загрузка и смена фильтров должны идти сразу.
 */
export function usePagedResource<T>(
  load: (cursor: string | null) => Promise<Page<T>>,
  deps: readonly unknown[],
  options: { debounceMs?: number } = {},
): PagedResource<T> {
  const debounceMs = options.debounceMs ?? 0;
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appending, setAppending] = useState(false);

  const runId = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const cursorRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchPage = useCallback((more: boolean) => {
    const id = ++runId.current;
    setBusy(true);
    setAppending(more);
    setError(null);
    setOffline(false);

    loadRef
      .current(more ? cursorRef.current : null)
      .then((page) => {
        if (id !== runId.current || !mounted.current) return;
        cursorRef.current = page.nextCursor;
        setCursor(page.nextCursor);
        setItems((prev) => (more && prev ? [...prev, ...page.items] : page.items));
        if (!more) setTotal(page.total ?? null);
      })
      .catch((e: unknown) => {
        if (id !== runId.current || !mounted.current) return;
        if (e instanceof ApiError && e.status === 0) setOffline(true);
        else setError(e instanceof Error ? e.message : UI["net.loadFailed"][currentLang]);
      })
      .finally(() => {
        if (id !== runId.current || !mounted.current) return;
        setBusy(false);
        setAppending(false);
      });
  }, []);

  const reload = useCallback(() => {
    cursorRef.current = null;
    fetchPage(false);
  }, [fetchPage]);

  useEffect(() => {
    // задержка только при повторных сменах: первый показ ждать незачем
    if (!debounceMs) {
      reload();
      return;
    }
    const timer = setTimeout(reload, debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps]);

  return {
    items,
    loading: busy && !appending && items === null,
    loadingMore: appending,
    error,
    offline,
    total,
    hasMore: cursor !== null,
    loadMore: () => {
      if (!busy && cursor) fetchPage(true);
    },
    reload,
  };
}
