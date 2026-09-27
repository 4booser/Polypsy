import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  QueryClientContext,
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQuery,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type InfiniteQueryObserverResult,
  type QueryObserverOptions,
  type QueryObserverResult,
} from "@tanstack/react-query";
import { uiText } from "@quizzy/shared";
import { ApiError, withSignal } from "./api";
import { connection } from "./connection";
import { hashResourceKey, queryClient } from "./query";
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
 * Хук решает это не «аккуратностью», а устройством. С волны 13 (решение
 * заказчика 2026-09-27: слой загрузки — TanStack Query) устройство такое:
 * у каждой выборки свой ключ — зависимости экрана (`deps`), и ответ ложится
 * под ключ, под которым его спрашивали. Ответ на прежний фильтр не может
 * лечь под новый, как бы поздно он ни пришёл. Раньше то же делал свой
 * номер запуска; теперь — библиотека, а номер больше не нужен.
 *
 * Что гарантировано каждому экрану, который грузит данные отсюда:
 *  - устаревший ответ не применяется (ключ из deps);
 *  - ненужный запрос отменяется: загрузка получает AbortSignal, а запросы
 *    api.*, начатые в ней, идут под ним сами (withSignal в api.ts);
 *  - ошибка сбрасывается, как только повтор удался, и не висит, пока идёт
 *    повтор (внешний разбор: 22 экрана застревали в отказе);
 *  - временный отказ (обрыв, пятисотка) повторяется сам, отказ по существу
 *    (4xx) — нет (query.ts);
 *  - обрыв связи — не ошибка экрана: данные остаются, `offline` поднят, а
 *    когда связь вернётся, экран перечитается сам (connection.ts).
 *
 * Внешний вид хука — прежний: его зовут почти сто экранов, и переписывать
 * их ради библиотеки было бы риском без пользы.
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
  /**
   * Когда пришёл последний ответ (мс). Отдельно от data: ответ, совпавший
   * с прежним, данные не меняет (тот же объект — экран не перерисовывается
   * зря), а «оновлено о …» обязано сдвинуться.
   */
  updatedAt: number | null;
  reload: () => void;
  /** Подменить данные локально: после действия, изменившего одну строку */
  patch: (next: T) => void;
}

export interface ResourceOptions {
  enabled?: boolean;
  /** Живой экран: перечитывать раз в столько миллисекунд, пока вкладка видна */
  pollMs?: number;
  /**
   * Опрашивать и скрытую вкладку. Только для того, что человек должен
   * увидеть, не глядя на вкладку: число тревог на значке вкладки (App.tsx).
   * Экраны скрытую вкладку не опрашивают — на общей сети госпиталя
   * забытая вкладка сутками стучалась бы в API.
   */
  pollHidden?: boolean;
  /**
   * Общий кэш по имени — для справочников, которые на странице читают
   * несколько мест (флаги функций, подсказки населённых пунктов). Одно имя
   * обязано значить одну и ту же загрузку: экраны с одним именем и одними
   * deps делят и ответ, и запрос в полёте. Без имени кэш — свой у каждого
   * вызова хука.
   */
  key?: string;
  /** Сколько ответ считается свежим; по умолчанию 0 — каждый показ спрашивает сервер */
  staleMs?: number;
  /**
   * Источник черновика: перечитывать только по reload() и смене deps, а не
   * сам (возврат связи, возврат на вкладку). Экран правки заливает ответ в
   * поля; ответ, перечитанный сам собой после обрыва, залил бы их поверх
   * набранного и не сохранённого. Первая загрузка, не дошедшая из-за обрыва,
   * по возвращении связи повторяется и здесь — данных ещё нет, стирать нечего.
   */
  manual?: boolean;
  /**
   * Держать прежний ответ на экране, пока грузится новый (по умолчанию да).
   * Нет — там, где прежний ответ под новым ключом был бы неправдой, а не
   * «устаревающими данными»: счётчики полосы после смены вошедшего.
   */
  keep?: boolean;
}

/** Загрузка: сигнал отмены — необязательный аргумент, старые `() => api.x()` работают как были */
export type Load<T> = (signal?: AbortSignal) => Promise<T>;

/*
 * Свой ключ у каждого вызова хука.
 *
 * Загрузка — анонимная функция, по ней не понять, «то же» ли грузят два
 * экрана; а два разных экрана с одинаковыми deps (`[]`) — обычное дело.
 * Общий ключ смешал бы их данные. Поэтому ключ начинается с метки вызова, и
 * кэш делится только по явному имени (ResourceOptions.key).
 */
let scopes = 0;
function useScope(name: string | undefined): string {
  const [own] = useState(() => `use:${++scopes}`);
  return name ? `key:${name}` : own;
}

/*
 * Клиент — из QueryClientProvider (main.tsx); вне него — общий клиент
 * вкладки. Вне провайдера экран рисуют только тесты (renderToStaticMarkup):
 * падать там на «No QueryClient set» значило бы оборачивать каждую проверку
 * разметки в провайдер ради хука, который на сервере всё равно не грузит.
 */
function useClient() {
  return useContext(QueryClientContext) ?? queryClient;
}

/** Текст отказа для экрана */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : uiText("net.loadFailed", currentLang);
}

/** До сервера не дошли: не ошибка экрана, а состояние связи */
function unreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/*
 * Загрузка под сигналом. Пустой ответ (204, `Promise.resolve()`) хранится
 * как null: TanStack не принимает undefined в кэш, а для экрана «ничего не
 * пришло» и так значит null.
 */
async function run<T>(load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T | null> {
  const value = await withSignal(signal, () => load(signal));
  return value === undefined ? null : value;
}

/**
 * Параметры запроса useResource — отдельно от хука, чтобы тесты проверяли
 * ровно то, что получает TanStack (test/useResource.test.ts).
 */
export function resourceQuery<T>(
  queryKey: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options: { enabled?: boolean; pollMs?: number; pollHidden?: boolean; staleMs?: number; keep?: boolean } = {},
): QueryObserverOptions<T | null, unknown, T | null, T | null, readonly unknown[]> {
  const pollMs = options.pollMs ?? 0;
  return {
    queryKey,
    queryKeyHashFn: hashResourceKey,
    // сигнал читается здесь — поэтому TanStack и отменяет запрос, ставший ненужным
    queryFn: ({ signal }) => run(load, signal),
    enabled: options.enabled ?? true,
    /*
     * Пока грузится новая выборка, на экране остаётся прежняя — с пометкой
     * refreshing, а не пустота: так было и до библиотеки, и экраны на это
     * рассчитаны (таблица не схлопывается на каждую букву в поиске).
     */
    placeholderData: options.keep === false ? undefined : keepPreviousData,
    refetchInterval: pollMs > 0 ? pollMs : false,
    refetchIntervalInBackground: options.pollHidden ?? false,
    /*
     * Живой экран, в отличие от прочих, перечитывается и по возврату на
     * вкладку: скрытую вкладку он не опрашивал, и человек, вернувшийся к
     * очереди, должен увидеть её сейчас, а не через такт опроса.
     */
    refetchOnWindowFocus: pollMs > 0,
    staleTime: options.staleMs ?? 0,
  };
}

/** Что видит экран: состояние запроса TanStack в словах прежнего Resource */
export function resourceState<T>(r: QueryObserverResult<T | null, unknown>): Omit<Resource<T>, "reload" | "patch"> {
  const data = r.data ?? null;
  const fetching = r.fetchStatus === "fetching";
  // пауза — TanStack ждёт связи (connection.ts сказал «нет связи»)
  const offline = r.fetchStatus === "paused" || (!fetching && unreachable(r.error));
  return {
    data,
    loading: fetching && data === null,
    refreshing: fetching && data !== null,
    // пока идёт повтор, прежний отказ не висит на экране; обрыв — не ошибка
    error: fetching || offline || !r.error ? null : messageOf(r.error),
    offline,
    updatedAt: r.dataUpdatedAt || null,
  };
}

export function useResource<T>(load: Load<T>, deps: readonly unknown[], options: ResourceOptions = {}): Resource<T> {
  const scope = useScope(options.key);
  const client = useClient();
  const enabled = options.enabled ?? true;
  // загрузка — самая свежая: она замыкает те же deps, что и ключ этого рендера
  const loadRef = useRef(load);
  loadRef.current = load;
  const queryKey = [scope, ...deps];
  const result = useQuery(
    resourceQuery<T>(queryKey, (signal) => loadRef.current(signal), {
      enabled,
      pollMs: options.pollMs,
      pollHidden: options.pollHidden,
      staleMs: options.manual ? Number.POSITIVE_INFINITY : options.staleMs,
      keep: options.keep,
    }),
    client,
  );

  const live = useRef({ key: queryKey, enabled, refetch: result.refetch });
  live.current = { key: queryKey, enabled, refetch: result.refetch };

  /*
   * «Повторити» и перечитывание после действия. Выключенную загрузку не
   * будит (как и раньше), а без связи сначала проверяет связь: иначе
   * кнопка ничего видимого не сделала бы — запрос встал бы на паузу до
   * следующей плановой проверки.
   */
  const reload = useCallback(() => {
    if (!live.current.enabled) return;
    if (!connection.isOnline()) void connection.check();
    void live.current.refetch();
  }, []);

  const patch = useCallback(
    (next: T) => {
      client.setQueryData(live.current.key, next);
    },
    [client],
  );

  return { ...resourceState<T>(result), reload, patch };
}

/**
 * Несколько однотипных загрузок по идентификаторам — «по требованию и по
 * одному разу»: методики, чьи шкалы понадобились редактору модели.
 *
 * Своя загрузка на каждый идентификатор (useQueries), а не одна на весь
 * список: добавил человек в модель ещё одну методику — спрашивается она
 * одна, а не весь набор заново. Ответ не устаревает (запрошено один раз за
 * показ экрана), кэш общий по имени. Результат — только пришедшие: значение
 * или null, если сервер отказал (чужую или удалённую методику он не отдаст
 * и со второго раза). Ещё не пришедших и не дошедших из-за обрыва в нём
 * нет — их загрузка повторится, когда вернётся связь.
 */
export function useResourceMap<T>(
  name: string,
  ids: readonly string[],
  load: (id: string, signal?: AbortSignal) => Promise<T>,
): Record<string, T | null> {
  const client = useClient();
  const loadRef = useRef(load);
  loadRef.current = load;
  return useQueries(
    {
      queries: ids.map((id) => ({
        queryKey: [`key:${name}`, id] as const,
        queryKeyHashFn: hashResourceKey,
        queryFn: ({ signal }: { signal: AbortSignal }) => run((s) => loadRef.current(id, s), signal),
        staleTime: Number.POSITIVE_INFINITY,
      })),
      combine: (results) => {
        const out: Record<string, T | null> = {};
        results.forEach((r, i) => {
          const id = ids[i]!;
          if (r.data !== undefined) out[id] = r.data as T | null;
          else if (r.status === "error" && !unreachable(r.error)) out[id] = null;
        });
        return out;
      },
    },
    client,
  );
}

/** Страница списка: то, что отдают курсорные эндпоинты */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number | null;
}

export interface PagedResource<T, P extends Page<T> = Page<T>> {
  items: T[] | null;
  /**
   * Первая страница выборки целиком — со всем, что сервер кладёт рядом со
   * строками (счётчики очереди случаев, вид строк). Лежит под тем же
   * ключом, что и строки: счётчики от прежнего фильтра не встанут над
   * строками нового.
   */
  head: P | null;
  loading: boolean;
  /** Идёт подгрузка следующей страницы: список на экране остаётся */
  loadingMore: boolean;
  error: string | null;
  offline: boolean;
  total: number | null;
  /** Есть ли что дозагрузить */
  hasMore: boolean;
  loadMore: () => void;
  /**
   * Перечитать список — после действия, изменившего его. Перечитываются
   * все показанные страницы (курсоры пересчитываются от свежих ответов):
   * человек, долиставший очередь до третьей страницы, не должен после
   * каждого «взять на себя» оказываться снова на первой.
   */
  reload: () => void;
}

/** Параметры запроса usePagedResource — отдельно от хука, для тестов */
export function pagedQuery<P extends { nextCursor: string | null }>(
  queryKey: readonly unknown[],
  load: (cursor: string | null, signal: AbortSignal) => Promise<P>,
  options: { enabled?: boolean; keep?: boolean } = {},
): InfiniteQueryObserverOptions<P, unknown, InfiniteData<P, string | null>, readonly unknown[], string | null> {
  return {
    queryKey,
    queryKeyHashFn: hashResourceKey,
    queryFn: ({ pageParam, signal }) => withSignal(signal, () => load(pageParam, signal)),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
    placeholderData: options.keep === false ? undefined : keepPreviousData,
  };
}

/** Что видит экран списка: состояние бесконечного запроса в словах прежнего PagedResource */
export function pagedState<T, P extends Page<T>>(
  r: InfiniteQueryObserverResult<InfiniteData<P, string | null>, unknown>,
  items: T[] | null,
): Omit<PagedResource<T, P>, "loadMore" | "reload"> {
  const head = r.data?.pages[0] ?? null;
  const fetching = r.fetchStatus === "fetching";
  const offline = r.fetchStatus === "paused" || (!fetching && unreachable(r.error));
  return {
    items,
    head,
    loading: fetching && !r.isFetchingNextPage && items === null,
    loadingMore: r.isFetchingNextPage,
    error: fetching || offline || !r.error ? null : messageOf(r.error),
    offline,
    total: head?.total ?? null,
    /*
     * Строки прежней выборки, стоящие на экране, пока грузится новая, —
     * не повод подгружать «ещё»: их курсор принадлежит прежнему фильтру.
     */
    hasMore: !r.isPlaceholderData && r.hasNextPage,
  };
}

/**
 * Значение, переставшее меняться на `ms`: поиск на сервере не должен уходить
 * на каждую букву. Первое — сразу (первый показ ждать незачем); `ms = 0` —
 * без задержки вовсе.
 *
 * Задерживает значение, а не загрузку: загрузка по нему идёт через
 * useResource, и гонки ответов на «пере» и «перец» там уже нет.
 */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!ms) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return ms ? settled : value;
}

/**
 * Список с постраничной подгрузкой.
 *
 * Отличается от useResource тем, что страницы дописываются к показанным, а не
 * заменяют их. Всё остальное — то же самое и по той же причине: ответ ложится
 * под ключ своей выборки.
 *
 * Гонка здесь коварнее, чем на обычном экране: пока летит ответ на «показать
 * ещё», человек меняет фильтр — и хвост старой выборки дописывался бы к
 * новой. Список выглядит правдоподобно и содержит чужие строки. Страницы
 * здесь живут под ключом выборки, и хвост старой ложится к старой.
 *
 * `debounceMs` — для поиска: набор текста не должен дёргать сервер на каждую
 * букву. Но задерживается только запрос, а не смена выборки (внешний
 * разбор: курсор и номер запуска сбрасывались лишь по истечении задержки,
 * и «показать ещё», нажатое в эти 300 мс, продолжало прежнюю выборку). Ключ
 * меняется сразу: прежние строки остаются на экране как заглушка, но
 * подгружать «ещё» к ним уже нельзя.
 */
export function usePagedResource<T, P extends Page<T> = Page<T>>(
  load: (cursor: string | null, signal?: AbortSignal) => Promise<P>,
  deps: readonly unknown[],
  /** keep — как у useResource: держать прежние строки на экране, пока грузятся новые (по умолчанию да) */
  options: { debounceMs?: number; keep?: boolean } = {},
): PagedResource<T, P> {
  const scope = useScope(undefined);
  const client = useClient();
  const loadRef = useRef(load);
  loadRef.current = load;
  const queryKey = [scope, ...deps];
  const hash = hashResourceKey(queryKey);
  const settled = useDebounced(hash, options.debounceMs ?? 0);
  const result = useInfiniteQuery(
    pagedQuery<P>(queryKey, (cursor, signal) => loadRef.current(cursor, signal), {
      enabled: settled === hash,
      keep: options.keep,
    }),
    client,
  );

  const pages = result.data?.pages;
  const items = useMemo(() => (pages ? pages.flatMap((p) => p.items) : null), [pages]);
  const state = pagedState<T, P>(result, items);

  const live = useRef({ result, hash });
  live.current = { result, hash };

  /*
   * «Ещё», попросленное, пока список перечитывается целиком, не теряется:
   * оно выполняется, когда перечитывание закончится. Иначе экран, который
   * добирает строки сам (Patients: страница просит недостающую порцию),
   * остался бы без них — его эффект не перезапустится, если перечитанные
   * строки совпали с прежними.
   */
  const wantMore = useRef<string | null>(null);
  const loadMore = useCallback(() => {
    const { result: r, hash: h } = live.current;
    if (r.isPlaceholderData || !r.hasNextPage || r.isFetchingNextPage) return;
    if (r.isFetching) {
      wantMore.current = h;
      return;
    }
    void r.fetchNextPage();
  }, []);

  useEffect(() => {
    if (result.isFetching || wantMore.current === null) return;
    const wanted = wantMore.current;
    wantMore.current = null;
    // просьба относилась к прежней выборке — к новой её не применять
    if (wanted === hash && result.hasNextPage && !result.isPlaceholderData) void result.fetchNextPage();
  }, [result.isFetching, result.hasNextPage, result.isPlaceholderData, result.fetchNextPage, hash]);

  const reload = useCallback(() => {
    wantMore.current = null;
    if (!connection.isOnline()) void connection.check();
    void live.current.result.refetch();
  }, []);

  return { ...state, loadMore, reload };
}
