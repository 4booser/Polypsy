import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  InfiniteQueryObserver,
  environmentManager,
  isServer,
  type InfiniteData,
  type InfiniteQueryObserverOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { connection } from "../src/connection";
import { createQueryClient, wireConnection } from "../src/query";
import { pagedQuery, pagedState, type Page as ListPage } from "../src/useResource";

/**
 * Гонка постраничной подгрузки — на живом клиенте TanStack (волна 13).
 *
 * Сценарий, ради которого всё написано: человек нажал «показать ещё», и
 * пока летел ответ — сменил фильтр. Хвост старой выборки не должен
 * дописаться к новой: список выглядел бы правдоподобно, содержа чужие
 * строки. И второй, из внешнего разбора: при поиске с задержкой курсор и
 * номер выборки сбрасывались только по истечении задержки — «ещё», нажатое
 * в эти 300 мс, продолжало прежнюю выборку. Теперь выборка меняется сразу
 * (новый ключ), а задерживается лишь запрос (enabled до конца задержки).
 */

type Page = ListPage<string>;
type Options = InfiniteQueryObserverOptions<Page, unknown, InfiniteData<Page, string | null>, readonly unknown[], string | null>;

let client: QueryClient;

beforeAll(() => {
  environmentManager.setIsServer(() => false);
  wireConnection();
});

afterAll(() => {
  environmentManager.setIsServer(() => isServer);
  connection.resetForTest();
});

beforeEach(() => {
  connection.resetForTest({ probe: async () => false, delays: [60_000] });
  client = createQueryClient();
  client.mount();
});

afterEach(() => {
  client.unmount();
  client.clear();
});

const page = (items: string[], next: string | null = null): Page => ({ items, nextCursor: next });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("не дождались");
    await tick(2);
  }
}

/** Наблюдатель, как внутри useInfiniteQuery, и строки, которые экран видел по дороге */
function watch(options: Options) {
  const observer = new InfiniteQueryObserver(client, options);
  const state = () => {
    const r = observer.getCurrentResult();
    return pagedState<string, Page>(r, r.data ? r.data.pages.flatMap((p) => p.items) : null);
  };
  const seen: (string[] | null)[] = [];
  const off = observer.subscribe(() => seen.push(state().items));
  return { observer, off, seen, state };
}

describe("подгрузка страниц", () => {
  test("вторая страница дописывается к первой", async () => {
    const w = watch(pagedQuery(["список", "все"], async (cursor) => (cursor ? page(["в", "г"]) : page(["а", "б"], "c1"))));
    await until(() => w.state().items !== null);
    expect(w.state()).toMatchObject({ items: ["а", "б"], hasMore: true });

    await w.observer.fetchNextPage();
    expect(w.state()).toMatchObject({ items: ["а", "б", "в", "г"], hasMore: false, loadingMore: false });
    w.off();
  });

  test("смена фильтра заменяет список, а не дописывает", async () => {
    const w = watch(pagedQuery(["список", "старый"], async () => page(["старое"], "c1")));
    await until(() => w.state().items !== null);
    w.observer.setOptions(pagedQuery(["список", "новый"], async () => page(["новое"])));
    await until(() => w.state().items?.[0] === "новое");
    expect(w.state().items).toEqual(["новое"]);
    w.off();
  });

  test("хвост старой выборки не дописывается к новой, и его запрос отменён", async () => {
    const tail = deferred<Page>();
    let tailSignal: AbortSignal | null = null;
    const w = watch(
      pagedQuery(["очередь", "старый"], (cursor, signal) => {
        if (!cursor) return Promise.resolve(page(["старое"], "c1"));
        tailSignal = signal;
        return tail.promise;
      }),
    );
    await until(() => w.state().items !== null);

    // «показать ещё» по старому фильтру — ответ придёт поздно
    void w.observer.fetchNextPage();
    await tick();
    expect(w.state().loadingMore).toBe(true);
    // человек сменил фильтр, пока летел ответ
    w.observer.setOptions(pagedQuery(["очередь", "новый"], async () => page(["новое"])));
    await until(() => w.state().items?.[0] === "новое");
    tail.resolve(page(["хвост старого"]));
    await tick(5);

    expect(w.state().items).toEqual(["новое"]);
    expect(w.seen.some((items) => items?.includes("хвост старого"))).toBe(false);
    expect(tailSignal!.aborted).toBe(true);
    w.off();
  });

  test("поиск с задержкой: выборка меняется сразу, «ещё» к прежней — уже нельзя", async () => {
    let asked = 0;
    const w = watch(pagedQuery(["поиск", "Ков"], async () => page(["Коваль", "Коваленко"], "c1")));
    await until(() => w.state().items !== null);
    expect(w.state().hasMore).toBe(true);

    // набрана ещё буква: ключ новый сразу, запрос — по истечении задержки (enabled: false до неё)
    w.observer.setOptions(
      pagedQuery(
        ["поиск", "Кова"],
        async () => {
          asked += 1;
          return page(["Коваль"]);
        },
        { enabled: false },
      ),
    );
    // прежние строки ещё видны, но курсор их принадлежит прежней выборке — «ещё» нет
    expect(w.state()).toMatchObject({ items: ["Коваль", "Коваленко"], hasMore: false });
    expect(asked).toBe(0);

    // задержка истекла
    w.observer.setOptions(pagedQuery(["поиск", "Кова"], async () => {
      asked += 1;
      return page(["Коваль"]);
    }));
    await until(() => w.state().items?.length === 1);
    expect(w.state()).toMatchObject({ items: ["Коваль"], hasMore: false });
    expect(asked).toBe(1);
    w.off();
  });

  test("перечитывание идёт по всем показанным страницам, курсоры — от свежих ответов", async () => {
    // список изменился на сервере между показом и перечитыванием: строка «0» добавилась сверху
    let fresh = false;
    const cursors: (string | null)[] = [];
    const w = watch(
      pagedQuery(["перечитать"], async (cursor) => {
        cursors.push(cursor);
        if (!fresh) return cursor ? page(["3", "4"], "old-2") : page(["1", "2"], "old-1");
        return cursor ? page(["2", "3"], "new-2") : page(["0", "1"], "new-1");
      }),
    );
    await until(() => w.state().items !== null);
    await w.observer.fetchNextPage();
    expect(w.state().items).toEqual(["1", "2", "3", "4"]);

    fresh = true;
    cursors.length = 0;
    await w.observer.refetch();
    // вторая страница спрошена по курсору свежей первой, а не по прежнему
    expect(cursors).toEqual([null, "new-1"]);
    expect(w.state()).toMatchObject({ items: ["0", "1", "2", "3"], hasMore: true });
    w.off();
  });

  test("счётчики первой страницы (head) — от той же выборки, что и строки", async () => {
    type Counted = Page & { facets: { total: number } };
    const w = new InfiniteQueryObserver(
      client,
      pagedQuery<Counted>(["случаи", "все"], async () => ({ ...page(["а"]), facets: { total: 420 } })),
    );
    const off = w.subscribe(() => {});
    await until(() => !!w.getCurrentResult().data);
    const head = () => pagedState<string, Counted>(w.getCurrentResult(), null).head;
    expect(head()?.facets.total).toBe(420);

    w.setOptions(pagedQuery<Counted>(["случаи", "тяжелые"], async () => ({ ...page(["б"]), facets: { total: 140 } })));
    await until(() => head()?.facets.total === 140);
    off();
  });
});
