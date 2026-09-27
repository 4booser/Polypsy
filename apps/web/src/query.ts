import { QueryClient, onlineManager } from "@tanstack/react-query";
import { MAINTENANCE_CODE } from "@quizzy/shared";
import { ApiError } from "./api";
import { connection } from "./connection";

/**
 * Слой загрузки консоли и кабинета пациента — TanStack Query.
 *
 * Решение заказчика 2026-09-27 («давай сделаем как правильнее и лучше»):
 * все загрузки данных идут одним путём. Раньше путей было два: useResource
 * (свой счётчик запусков, защищал от устаревших ответов) и голые useEffect с
 * api.* и setState — сорок с лишним мест, где устаревший ответ применялся,
 * ошибка не сбрасывалась, а связь, вернувшись, никого не будила. Экраны
 * по-прежнему зовут useResource/usePagedResource — внешний вид хуков тот
 * же, — а под ними теперь библиотека, у которой эти гарантии проверены на
 * миллионах экранов, а не на наших тестах.
 *
 * Умолчания — под клиническую работу, и каждое с причиной.
 */

/**
 * Временный ли отказ — есть ли смысл повторить тот же запрос через секунду.
 *
 * Да — обрыв связи (status 0) и пятисотки: сервер перезапускают при
 * выкатке, база на мгновение недоступна. Нет — 4xx: «нет прав», «не
 * найдено», «неверный запрос» через секунду останутся теми же, а повтор
 * отказа в правах сервер к тому же пишет в журнал доступа ещё раз. Нет —
 * и 503 обслуживания: работы идут минутами, а о них скажет баннер.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 0) return true;
  if (error.status < 500) return false;
  const code = (error.body as { code?: unknown } | null | undefined)?.code;
  return !(error.status === 503 && code === MAINTENANCE_CODE);
}

/** Сколько раз повторить временный отказ до того, как показать его человеку */
export const TRANSIENT_RETRIES = 2;

export function retryTransient(failureCount: number, error: unknown): boolean {
  return failureCount < TRANSIENT_RETRIES && isTransient(error);
}

/** Пауза перед повтором: 1 с, 2 с — дольше человек ждать не станет, а обрыв подхватит connection.ts */
export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 4000);
}

/*
 * Ключ запроса — это зависимости экрана (deps useResource), и в них бывает
 * всё, что бывает в зависимостях эффекта: строки, числа, объекты фильтров,
 * а иногда URLSearchParams, Set или функция. Стандартный хэш TanStack —
 * JSON.stringify, и для таких значений он врёт: URLSearchParams и Set
 * превращаются в «{}», и смена фильтра не меняла бы ключ — экран показывал
 * бы ответ на прежний фильтр как ответ на новый. Ровно та тихая ошибка,
 * от которой слой и защищает.
 *
 * Поэтому хэш свой: простые объекты и массивы — по содержимому (как у
 * TanStack: порядок полей не важен), известные контейнеры — по
 * содержимому, всё остальное (функции, экземпляры классов) — по
 * тождеству, как сравнивает зависимости сам React.
 */
const identities = new WeakMap<object, number>();
let lastIdentity = 0;
function identity(o: object): number {
  let id = identities.get(o);
  if (id === undefined) {
    id = ++lastIdentity;
    identities.set(o, id);
  }
  return id;
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function hashResourceKey(key: readonly unknown[]): string {
  return JSON.stringify(key, (_k, v: unknown) => {
    // undefined и null — разные зависимости для React; в JSON они слились бы
    if (v === undefined) return { $u: 1 };
    if (typeof v === "function") return { $fn: identity(v) };
    if (typeof v === "bigint") return { $n: String(v) };
    if (typeof v === "symbol") return { $s: String(v) };
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    if (v instanceof URLSearchParams) return { $q: v.toString() };
    if (v instanceof Map) return { $map: [...v.entries()] };
    if (v instanceof Set) return { $set: [...v] };
    if (!isPlain(v)) return { $o: identity(v) };
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /* один хэш на весь клиент: и загрузка, и patch (setQueryData), и сброс кэша считают ключ одинаково */
        queryKeyHashFn: hashResourceKey,
        retry: retryTransient,
        retryDelay,
        /*
         * Без перечитывания по фокусу окна.
         *
         * Специалист на приёме переключается между консолью, почтой и
         * медицинской системой десятки раз за час. Перечитывание на каждый
         * возврат гоняло бы тяжёлые экраны (аналитика, статистика, сводка по
         * отделению — секунды расчёта на сервере) и перерисовывало бы экран
         * под рукой: таблица, которую человек читает, дёргалась бы от того,
         * что он глянул в почту. Свежесть обеспечивают поток событий сервера
         * (events.ts → useLiveReload) и опрос у живых экранов (pollMs) — они
         * и включают перечитывание по возврату на вкладку у себя
         * (useResource.ts).
         */
        refetchOnWindowFocus: false,
        /*
         * Связь вернулась — всё, что на экране, перечитывается само. Это и
         * есть ответ на «понятное восстановление после потери связи»: данные
         * не пропадают на время обрыва (остаются последние загруженные), а
         * по возвращении обновляются без перезагрузки страницы.
         */
        refetchOnReconnect: true,
        /*
         * Данные устаревают сразу: клинические цифры не держатся «свежими»
         * по таймеру — каждый новый показ экрана спрашивает сервер. Кэш при
         * этом жив и полезен: вернувшись к прежнему фильтру, человек видит
         * прежний ответ сразу, пока идёт перечитывание, — с пометкой
         * «обновляется» (refreshing), а не пустой экран.
         */
        staleTime: 0,
        /*
         * Минута, а не библиотечные пять. Ключ у каждого вызова useResource
         * свой (useResource.ts), и ответ снятого экрана новым показом того же
         * экрана уже не прочтётся — держать его пять минут значило бы держать
         * в памяти вкладки аналитику, которую никто не увидит. Минуты хватает
         * на то, ради чего кэш есть: вернуться к прежнему фильтру на том же
         * экране.
         */
        gcTime: 60_000,
      },
      mutations: {
        /* изменение не повторяется само: повтор записи без ведома человека — не наше решение */
        retry: false,
      },
    },
  });
}

/**
 * Состояние связи для TanStack — из connection.ts, а не из событий браузера.
 *
 * Браузер знает только про сеть: Wi-Fi есть — значит «online», даже если
 * сервер за VPN недоступен или перезапускается. connection.ts знает и это:
 * ему сообщает о каждом недошедшем запросе сетевой клиент, и он сам
 * проверяет, когда сервер снова ответит. Пока связи нет, запросы стоят на
 * паузе, а не бьются в закрытую дверь; вернулась — продолжаются, и всё, что
 * на экране, перечитывается (refetchOnReconnect).
 */
export function wireConnection(): () => void {
  const uninstall = connection.install();
  onlineManager.setEventListener((setOnline) => {
    setOnline(connection.isOnline());
    return connection.subscribe(() => setOnline(connection.isOnline()));
  });
  return uninstall;
}

/**
 * Клиент вкладки. Один на консоль и кабинет пациента: это один корень
 * React (main.tsx), и кабинет — ветка App.tsx по классу учётной записи.
 */
export const queryClient = createQueryClient();
