import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { QueryObserver, environmentManager, isServer, type QueryClient, type QueryObserverOptions } from "@tanstack/react-query";
import { ApiError, api, isAbort, tokenStore, withSignal } from "../src/api";
import { connection } from "../src/connection";
import { createQueryClient, hashResourceKey, isTransient, retryTransient, wireConnection } from "../src/query";
import { onNetworkFailure, type NetworkFailure } from "../src/telemetry/bus";
import { resourceQuery, resourceState } from "../src/useResource";

/**
 * Слой загрузки (волна 13, решение заказчика 2026-09-27: TanStack Query).
 *
 * Прежний тест проверял копию счётчика запусков, переписанную сюда «один в
 * один», — то есть проверял копию, а не хук. Теперь проверяется ровно то,
 * что получает библиотека: параметры запроса (resourceQuery) и перевод её
 * состояния в слова экрана (resourceState), на живом клиенте TanStack с
 * умолчаниями консоли (createQueryClient) и подключённым знанием о связи
 * (wireConnection). Наблюдатель запроса — тот же, что внутри useQuery:
 * смена deps у хука — это setOptions с новым ключом у наблюдателя.
 *
 * Хуки поверх этого — тонкие (ключ вызова, стабильные reload/patch); React
 * в тестовом процессе без DOM эффектов не выполняет, и проверять их здесь
 * значило бы проверять React.
 */

let client: QueryClient;

beforeAll(() => {
  // тестовый процесс — «сервер» для TanStack (нет window): таймеры и повторы там выключены
  environmentManager.setIsServer(() => false);
  wireConnection();
});

afterAll(() => {
  environmentManager.setIsServer(() => isServer);
  connection.resetForTest();
});

beforeEach(() => {
  // проверка связи по умолчанию «нет ответа», и не скоро: связь в тестах возвращает сам тест
  connection.resetForTest({ probe: async () => false, delays: [60_000] });
  client = createQueryClient();
  client.mount();
});

afterEach(() => {
  client.unmount();
  client.clear();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("не дождались");
    await tick(2);
  }
}

type Options<T> = QueryObserverOptions<T | null, unknown, T | null, T | null, readonly unknown[]>;

/** Наблюдатель, как внутри useQuery, и всё, что экран видел по дороге */
function watch<T>(options: Options<T>) {
  const observer = new QueryObserver(client, options);
  const seen: ReturnType<typeof resourceState<T>>[] = [];
  const off = observer.subscribe((r) => seen.push(resourceState<T>(r)));
  return { observer, off, seen, now: () => resourceState<T>(observer.getCurrentResult()) };
}

/** Короткая пауза перед повтором — чтобы тест не ждал секундами */
const fast = <T>(o: Options<T>): Options<T> => ({ ...o, retryDelay: 1 });

describe("устаревший ответ не применяется", () => {
  test("медленный ответ по прежнему фильтру не ложится под новый — и прежний запрос отменён", async () => {
    const wide = deferred<string>();
    const narrow = deferred<string>();
    const signals: Record<string, AbortSignal> = {};
    const load = (period: "wide" | "narrow") => (signal: AbortSignal) => {
      signals[period] = signal;
      return period === "wide" ? wide.promise : narrow.promise;
    };

    // широкий период отвечает долго; человек сузил период, не дождавшись
    const w = watch(resourceQuery(["экран", "wide"], load("wide")));
    await tick();
    w.observer.setOptions(resourceQuery(["экран", "narrow"], load("narrow")));

    narrow.resolve("узкий период");
    await tick();
    wide.resolve("широкий период");
    await tick();

    expect(w.now().data).toBe("узкий период");
    expect(signals.wide!.aborted).toBe(true);
    expect(signals.narrow!.aborted).toBe(false);
    // и ни в один момент экран не показал ответ на прежний вопрос
    expect(w.seen.some((s) => s.data === "широкий период")).toBe(false);
    w.off();
  });

  test("подряд идущие запросы вразнобой: остаётся ответ последнего", async () => {
    const w = watch(resourceQuery<number>(["дата", 1], () => tick(40).then(() => 1)));
    for (const [n, ms] of [
      [2, 5],
      [3, 30],
      [4, 15],
    ] as const) {
      await tick(1);
      w.observer.setOptions(resourceQuery<number>(["дата", n], () => tick(ms).then(() => n)));
    }
    await tick(60);
    expect(w.now().data).toBe(4);
    expect(w.seen.map((s) => s.data).filter((d) => d !== null && d !== 4)).toEqual([]);
    w.off();
  });

  test("отказ последнего не подставляет данные предыдущего", async () => {
    const old = deferred<string>();
    const w = watch(resourceQuery(["отказ", "старое"], () => old.promise));
    await tick();
    w.observer.setOptions(
      resourceQuery<string>(["отказ", "новое"], () => Promise.reject(new ApiError("Не знайдено", 404))),
    );
    await tick();
    old.resolve("старое");
    await tick();
    /*
     * Старый ответ пришёл позже отказа, но он устарел — применять его
     * нельзя: экран показал бы данные, которых пользователь уже не просил.
     */
    expect(w.now()).toMatchObject({ data: null, error: "Не знайдено" });
    w.off();
  });

  test("ушёл с экрана — запрос отменён", async () => {
    let signal: AbortSignal | null = null;
    const w = watch(
      resourceQuery(["уход"], (s) => {
        signal = s;
        return deferred<string>().promise;
      }),
    );
    await tick();
    w.off();
    expect(signal!.aborted).toBe(true);
  });
});

describe("ошибка", () => {
  test("сбрасывается удачным повтором и не висит, пока повтор идёт", async () => {
    let fail = true;
    const w = watch(
      resourceQuery(["повтор"], async () => {
        if (fail) throw new ApiError("Не знайдено", 404);
        return "дані";
      }),
    );
    await until(() => w.now().error !== null);
    expect(w.now()).toMatchObject({ data: null, error: "Не знайдено", offline: false });

    fail = false;
    const again = w.observer.refetch();
    // внешний разбор: 22 экрана застревали в отказе — здесь отказ уходит с началом повтора
    expect(w.now()).toMatchObject({ error: null, loading: true });
    await again;
    await tick();
    expect(w.now()).toMatchObject({ data: "дані", error: null, loading: false, refreshing: false });
    w.off();
  });

  test("временный отказ повторяется сам, и человек его не видит", async () => {
    let calls = 0;
    const w = watch(
      fast(
        resourceQuery(["пятисотка"], async () => {
          calls += 1;
          if (calls < 3) throw new ApiError("Помилка 503", 503);
          return "дочекались";
        }),
      ),
    );
    await until(() => w.now().data !== null);
    expect(calls).toBe(3);
    expect(w.seen.every((s) => s.error === null)).toBe(true);
    w.off();
  });

  test("отказ по существу (4xx) не повторяется", async () => {
    let calls = 0;
    const w = watch(
      fast(
        resourceQuery(["запрет"], async () => {
          calls += 1;
          throw new ApiError("Немає доступу", 403);
        }),
      ),
    );
    await until(() => w.now().error !== null);
    await tick(20);
    expect(calls).toBe(1);
    w.off();
  });

  test("что считается временным", () => {
    expect(isTransient(new ApiError("нет связи", 0))).toBe(true);
    expect(isTransient(new ApiError("сбой", 500))).toBe(true);
    expect(isTransient(new ApiError("шлюз", 502))).toBe(true);
    expect(isTransient(new ApiError("нет базы", 503, { code: "db" }))).toBe(true);
    // обслуживание идёт минутами, о нём скажет баннер
    expect(isTransient(new ApiError("работы", 503, { code: "maintenance" }))).toBe(false);
    expect(isTransient(new ApiError("не найдено", 404))).toBe(false);
    expect(isTransient(new ApiError("нет прав", 403))).toBe(false);
    // ошибка в самой загрузке (опечатка в коде экрана) — не сеть
    expect(isTransient(new TypeError("x is undefined"))).toBe(false);
    expect(retryTransient(0, new ApiError("сбой", 500))).toBe(true);
    expect(retryTransient(2, new ApiError("сбой", 500))).toBe(false);
  });
});

describe("обрыв связи", () => {
  test("не ошибка: экран ждёт, а когда связь вернулась — загружается сам", async () => {
    let reachable = false;
    let calls = 0;
    const w = watch(
      fast(
        resourceQuery(["обрыв"], async () => {
          calls += 1;
          if (!reachable) {
            // то, что делает api.ts при недошедшем запросе
            connection.lost();
            throw new ApiError("Немає зв’язку з сервером", 0);
          }
          return "свіже";
        }),
      ),
    );
    await until(() => w.now().offline);
    expect(w.now()).toMatchObject({ data: null, error: null, offline: true, loading: false });
    expect(connection.isOnline()).toBe(false);
    const before = calls;
    await tick(20);
    // без связи запрос стоит на паузе, а не бьётся в закрытую дверь
    expect(calls).toBe(before);

    reachable = true;
    // то, что делает проверка связи (connection.ts), когда сервер ответил
    connection.reached();
    await until(() => w.now().data !== null);
    expect(w.now()).toMatchObject({ data: "свіже", error: null, offline: false });
    w.off();
  });

  test("вернулась связь — показанное перечитывается; источник черновика (manual) — нет", async () => {
    const loads = { screen: 0, draft: 0 };
    const screen = watch(resourceQuery(["экран"], async () => ++loads.screen));
    // manual у хука — это staleMs: ∞ (useResource.ts)
    const draft = watch(resourceQuery(["черновик"], async () => ++loads.draft, { staleMs: Number.POSITIVE_INFINITY }));
    await until(() => screen.now().data !== null && draft.now().data !== null);

    connection.lost();
    connection.reached();
    await until(() => loads.screen === 2);
    await tick(10);
    expect(screen.now().data).toBe(2);
    expect(loads.draft).toBe(1);
    screen.off();
    draft.off();
  });

  test("данные на экране при обрыве остаются", async () => {
    let reachable = true;
    const w = watch(
      fast(
        resourceQuery(["остаются"], async () => {
          if (!reachable) {
            connection.lost();
            throw new ApiError("Немає зв’язку з сервером", 0);
          }
          return "показане";
        }),
      ),
    );
    await until(() => w.now().data !== null);
    reachable = false;
    void w.observer.refetch();
    await until(() => w.now().offline);
    expect(w.now()).toMatchObject({ data: "показане", error: null, offline: true });
    w.off();
  });
});

describe("ключ запроса из зависимостей экрана", () => {
  test("контейнеры — по содержимому, а не «{}»", () => {
    // стандартный JSON.stringify дал бы «{}» обоим — и смена фильтра не сменила бы ключ
    expect(hashResourceKey(["a", new URLSearchParams("x=1")])).not.toBe(hashResourceKey(["a", new URLSearchParams("x=2")]));
    expect(hashResourceKey([new Set([1])])).not.toBe(hashResourceKey([new Set([2])]));
    expect(hashResourceKey([new Map([["a", 1]])])).not.toBe(hashResourceKey([new Map([["a", 2]])]));
  });

  test("простые объекты — по содержимому, порядок полей не важен", () => {
    expect(hashResourceKey([{ b: 1, a: { d: 2, c: 3 } }])).toBe(hashResourceKey([{ a: { c: 3, d: 2 }, b: 1 }]));
  });

  test("undefined и null — разные зависимости, как у React", () => {
    expect(hashResourceKey([undefined])).not.toBe(hashResourceKey([null]));
  });

  test("функции и экземпляры классов — по тождеству", () => {
    const f = () => 1;
    const g = () => 1;
    expect(hashResourceKey([f])).toBe(hashResourceKey([f]));
    expect(hashResourceKey([f])).not.toBe(hashResourceKey([g]));
    class Box {}
    const box = new Box();
    expect(hashResourceKey([box])).toBe(hashResourceKey([box]));
    expect(hashResourceKey([box])).not.toBe(hashResourceKey([new Box()]));
  });

  test("patch ложится под тот же ключ, что и загрузка", async () => {
    const key = ["правка", new URLSearchParams("q=1")];
    const w = watch(resourceQuery(key, async () => "с сервера"));
    await until(() => w.now().data !== null);
    // setQueryData считает ключ хэшем клиента — тем же, что у загрузки (createQueryClient)
    client.setQueryData(key, "после действия");
    expect(w.now().data).toBe("после действия");
    w.off();
  });
});

/* ── сетевой клиент: сигнал отмены и знание о связи ── */

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("api.ts: сигнал и связь", () => {
  const saved = {
    fetch: globalThis.fetch,
    localStorage: (globalThis as { localStorage?: Storage }).localStorage,
    sessionStorage: (globalThis as { sessionStorage?: Storage }).sessionStorage,
  };
  let failures: NetworkFailure[] = [];

  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
    (globalThis as { sessionStorage?: Storage }).sessionStorage = memoryStorage();
    tokenStore.set("t");
    failures = [];
    onNetworkFailure((f) => failures.push(f));
  });

  afterEach(() => {
    onNetworkFailure(null);
    globalThis.fetch = saved.fetch;
    (globalThis as { localStorage?: Storage }).localStorage = saved.localStorage;
    (globalThis as { sessionStorage?: Storage }).sessionStorage = saved.sessionStorage;
  });

  test("запрос, начатый под withSignal, получает сигнал; без него — как раньше", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(JSON.stringify({ total: 3 }), { status: 200 });
    }) as typeof fetch;
    const ctrl = new AbortController();
    await withSignal(ctrl.signal, () => api.worklist());
    await api.worklist();
    expect(seen[0]).toBe(ctrl.signal);
    expect(seen[1]).toBeUndefined();
  });

  test("отменённый запрос — не обрыв: ни строки «немає зв’язку», ни записи в техпанель", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as typeof fetch;
    const ctrl = new AbortController();
    const pending = withSignal(ctrl.signal, () => api.worklist());
    ctrl.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(isAbort(error)).toBe(true);
    expect(connection.isOnline()).toBe(true);
    expect(failures).toEqual([]);
  });

  test("недошедший запрос — обрыв; любой ответ сервера — связь есть", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const error = await api.worklist().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect(connection.isOnline()).toBe(false);
    expect(failures.map((f) => f.status)).toEqual([0]);

    // шлюз ответил, приложение за ним лежит — связи с сервером ещё нет
    globalThis.fetch = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await api.worklist().catch(() => {});
    expect(connection.isOnline()).toBe(false);

    // ответ приложения, пусть и отказ, — связь вернулась
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "нет" }), { status: 404 })) as unknown as typeof fetch;
    await api.worklist().catch(() => {});
    expect(connection.isOnline()).toBe(true);
    expect(connection.get().restoredAt).not.toBeNull();
  });
});
