import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InfiniteData, InfiniteQueryObserverResult } from "@tanstack/react-query";
import type { Respondent } from "@quizzy/shared";
import { api, tokenStore } from "../src/api";
import { allTabBody, groupTab, groupTabBody, searchOf, SEARCH_MAX } from "../src/pages/patients/model";
import { cursorPagePlan, pageFrom, perFrom, refilter, toPage, toPer } from "../src/ui/paging";
import { patchParams } from "../src/ui/viewParams";
import { pagedState, type Page } from "../src/useResource";

/**
 * Список пациентов: адрес → запрос, адрес → вкладка, адрес → что на месте
 * сетки (волна 13, внешний разбор: «покрытие интерфейса проверяло в основном
 * отрисовку, оставляя фильтры без проверок»).
 *
 * Всё состояние экрана живёт в адресе (?group, ?q, ?page, ?per), и его
 * присылают ссылкой, правят руками, открывают из сохранённых видов. Поэтому
 * здесь проверяется не картинка, а переходы: какой параметр что меняет, что
 * сбрасывается вместе с ним и что делает экран с кривым адресом.
 */

const url = (search: string) => new URLSearchParams(search);

describe("адрес → запрос", () => {
  test("поиск уходит на сервер без пробелов по краям", () => {
    expect(searchOf("  Коваль ")).toBe("Коваль");
    expect(searchOf("   ")).toBe("");
  });

  test("поиск длиннее предела сервера обрезается, а не роняет список в 400", () => {
    // сервер (respondentQuery) отвергает search длиннее 120 знаков целиком
    const long = "а".repeat(500);
    expect(searchOf(long).length).toBe(SEARCH_MAX);
    // обрезок не кончается пробелом — сервер его и так срезал бы, а ключ выборки был бы другим
    expect(searchOf(`${"б".repeat(119)} ${"в".repeat(10)}`)).toBe("б".repeat(119));
  });

  test("кривые ?page и ?per — умолчание, а не запрос чужого размера", () => {
    expect(pageFrom("-1")).toBe(1);
    expect(pageFrom("2.7")).toBe(2);
    expect(pageFrom("")).toBe(1);
    expect(perFrom("7")).toBe(10);
    expect(perFrom("-20")).toBe(10);
    expect(perFrom("50")).toBe(50);
  });
});

describe("адрес → запрос: до сервера", () => {
  /*
   * Последний шаг — сам сетевой клиент: какой адрес уходит в fetch. Проверка
   * модели без него оставляла бы щель — параметр мог бы собираться верно и
   * теряться по дороге (пустое значение ушло бы как `search=`).
   */
  const saved = { fetch: globalThis.fetch, localStorage: (globalThis as { localStorage?: Storage }).localStorage };
  let seen: string[] = [];

  beforeEach(() => {
    const data = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k) => data.get(k) ?? null,
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
      setItem: (k, v) => void data.set(k, String(v)),
    };
    tokenStore.set("t");
    seen = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = saved.fetch;
    (globalThis as { localStorage?: Storage }).localStorage = saved.localStorage;
  });

  test("поиск и размер страницы — в запросе; пустой поиск не уходит вовсе", async () => {
    // так зовёт загрузку вкладка «Усі» (Patients.tsx, AllPatients)
    const load = (q: string, per: number, cursor: string | null) =>
      api.respondents({ search: searchOf(q) || undefined, cursor: cursor ?? undefined, limit: String(per) });

    await load(" Коваль ", 20, null);
    await load("   ", 10, "CUR");
    const [first, second] = seen.map((s) => new URL(s, "http://x"));
    expect(first!.pathname).toBe("/api/dynamics/respondents");
    expect(first!.searchParams.get("search")).toBe("Коваль");
    expect(first!.searchParams.get("limit")).toBe("20");
    expect(second!.searchParams.has("search")).toBe(false);
    expect(second!.searchParams.get("cursor")).toBe("CUR");
  });
});

describe("смена отбора возвращает на первую страницу", () => {
  const start = "group=g1&q=Пет&page=4&per=20";

  test("поиск: страница снимается, группа и размер страницы остаются", () => {
    const next = patchParams(start, refilter({ q: "Коваль" }));
    expect(next.get("q")).toBe("Коваль");
    expect(next.get("page")).toBeNull();
    expect(next.get("group")).toBe("g1");
    expect(next.get("per")).toBe("20");
  });

  test("очищенный поиск снимается из адреса, а не остаётся пустым `q=`", () => {
    expect(patchParams(start, refilter({ q: "" })).has("q")).toBe(false);
  });

  test("вкладка группы: другая группа — с первой страницы, поиск остаётся", () => {
    const next = patchParams(start, refilter({ group: "g2" }));
    expect(next.get("group")).toBe("g2");
    expect(next.get("page")).toBeNull();
    expect(next.get("q")).toBe("Пет");
  });

  test("«Усі» снимает группу, а не ставит пустую", () => {
    const next = patchParams(start, refilter({ group: null }));
    expect(next.has("group")).toBe(false);
    expect(next.get("page")).toBeNull();
  });

  test("размер страницы: умолчание — без параметра, и страница с первой", () => {
    expect(patchParams(start, toPer(10)).has("per")).toBe(false);
    expect(patchParams(start, toPer(50)).get("per")).toBe("50");
    expect(patchParams(start, toPer(50)).get("page")).toBeNull();
  });

  test("листание не трогает отбор; первая страница — без параметра", () => {
    expect(patchParams(start, toPage(5)).toString()).toBe("group=g1&q=%D0%9F%D0%B5%D1%82&page=5&per=20");
    expect(patchParams(start, toPage(1)).has("page")).toBe(false);
  });

  test("правка не меняет прежний объект адреса", () => {
    const prev = url(start);
    patchParams(prev, refilter({ q: "x" }));
    expect(prev.toString()).toBe(url(start).toString());
  });

  test("все поля отбора экранов списков идут через refilter/toPage/toPer, а не собираются руками", () => {
    /*
     * Правило «смена отбора — с первой страницы» раньше жило в каждом
     * onChange отдельно; новое поле, собранное руками, его бы забыло. Здесь
     * сторож: в экранах со страницами прямых правок адреса нет, кроме снятия
     * мёртвой группы (оно не меняет того, что на экране).
     */
    for (const file of [
      "../src/pages/Patients.tsx",
      "../src/pages/patientGroups/PatientGroups.tsx",
      "../src/pages/patientGroups/PatientGroupCard.tsx",
    ]) {
      const src = readFileSync(resolve(import.meta.dir, file), "utf8");
      const raw = [...src.matchAll(/update\(\{([^}]*)\}\)/g)].map((m) => m[1]!.trim());
      expect(raw.filter((body) => body !== "group: null"), file).toEqual([]);
    }
  });
});

describe("адрес → вкладка", () => {
  const groups = [{ id: "g1" }, { id: "g2" }];

  test("своя группа из адреса открывается своей вкладкой", () => {
    expect(groupTab("g2", groups, null)).toEqual({ current: { id: "g2" }, pending: false, stale: false });
  });

  test("без группы в адресе — «Усі»; пустое `?group=` — тоже, и ждать список групп незачем", () => {
    expect(groupTab(null, null, null)).toEqual({ current: null, pending: false, stale: false });
    expect(groupTab("", null, null)).toEqual({ current: null, pending: false, stale: false });
  });

  test("группа в адресе, список групп в пути — ждём, а не мигаем «Усі»", () => {
    expect(groupTab("g1", null, null).pending).toBe(true);
  });

  test("чужая или удалённая группа — «Усі», и адрес надо поправить", () => {
    /*
     * Экран показывает «Усі», а в адресе оставалась мёртвая группа: пункт
     * «Усі» в шестерёнке был погашен как «уже открыт», снять параметр было
     * нечем, а «Зберегти відбір» сохранял вид с группой, которой на экране
     * нет. Теперь `stale` — и экран снимает её из адреса (Patients.tsx).
     */
    expect(groupTab("gone", groups, null)).toEqual({ current: null, pending: false, stale: true });
  });

  test("список групп не пришёл — группа из адреса не теряется", () => {
    // отказ — не знание «группы нет»: вернётся список — вернётся и вкладка
    expect(groupTab("g1", null, "Сервер не відповідає")).toEqual({ current: null, pending: false, stale: false });
  });

  test("экран снимает мёртвую группу из адреса", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Patients.tsx"), "utf8");
    expect(src).toMatch(/if \(stale\) update\(\{ group: null \}\)/);
  });
});

describe("страница поверх курсора", () => {
  test("страница дальше последней при известном общем числе — сразу на последнюю, без догрузки всего списка", () => {
    /*
     * ?page=9999 из старой закладки: раньше экран просил порцию за порцией,
     * пока сервер обещал ещё, — тысячу запросов подряд, — и только потом
     * возвращал на последнюю страницу. Общее число известно с первой же
     * порции, а с ним и число страниц.
     */
    const plan = cursorPagePlan({ page: 9999, per: 10, loaded: 10, total: 4321, hasMore: true });
    expect(plan.pages).toBe(433);
    expect(plan.clampTo).toBe(433);
    // догружается только до последней страницы — и то уже после возврата на неё
    const after = cursorPagePlan({ page: 433, per: 10, loaded: 10, total: 4321, hasMore: true });
    expect(after.clampTo).toBeNull();
    expect(after.loadMore).toBe(true);
  });

  test("внутри списка: догружается недостающая порция, возвращать некуда", () => {
    expect(cursorPagePlan({ page: 3, per: 10, loaded: 20, total: 95, hasMore: true })).toEqual({
      pages: 10,
      clampTo: null,
      loadMore: true,
    });
    // порция уже есть — просить нечего
    expect(cursorPagePlan({ page: 2, per: 10, loaded: 20, total: 95, hasMore: true }).loadMore).toBe(false);
  });

  test("с поиском (общего числа нет) — добирать, пока сервер обещает, и вернуть, когда обещать нечего", () => {
    expect(cursorPagePlan({ page: 5, per: 10, loaded: 20, total: null, hasMore: true })).toMatchObject({
      clampTo: null,
      loadMore: true,
    });
    expect(cursorPagePlan({ page: 5, per: 10, loaded: 23, total: null, hasMore: false })).toEqual({
      pages: 3,
      clampTo: 3,
      loadMore: false,
    });
  });

  test("пустая выборка — одна пустая страница, и ?page=4 возвращается на неё", () => {
    expect(cursorPagePlan({ page: 4, per: 10, loaded: 0, total: 0, hasMore: false })).toEqual({
      pages: 1,
      clampTo: 1,
      loadMore: false,
    });
  });
});

/*
 * Состояние вкладки «Усі» — из настоящего перевода состояния запроса
 * TanStack в слова экрана (pagedState), а не из придуманных флагов: «нет
 * связи» здесь — это ровно то, что видит экран, когда запрос стоит на паузе.
 */
type R = InfiniteQueryObserverResult<InfiniteData<Page<Respondent>, string | null>, unknown>;
function paged(over: Partial<R> & { pages?: Page<Respondent>[] }) {
  const { pages, ...rest } = over;
  const r = {
    data: pages ? { pages, pageParams: pages.map(() => null) } : undefined,
    fetchStatus: "idle",
    error: null,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    hasNextPage: false,
    ...rest,
  } as unknown as R;
  return pagedState<Respondent, Page<Respondent>>(r, pages ? pages.flatMap((p) => p.items) : null);
}
const person = (n: number): Respondent => ({ userId: `u${n}`, fullName: `Людина ${n}`, email: `p${n}@x` }) as Respondent;
const portion = (from: number, n: number, next: string | null): Page<Respondent> => ({
  items: Array.from({ length: n }, (_, i) => person(from + i)),
  nextCursor: next,
});

function body(s: ReturnType<typeof paged>, page: number, per: number) {
  const loaded = s.items ?? [];
  const rows = loaded.slice((page - 1) * per, page * per);
  return allTabBody({ items: s.items, error: s.error, rowsOnPage: rows.length, hasMore: s.hasMore, loadingMore: s.loadingMore });
}

describe("что на месте сетки: вкладка «Усі»", () => {
  test("первая загрузка — скелет; обрыв связи до первого ответа — тоже скелет, а не «нікого»", () => {
    expect(body(paged({ fetchStatus: "fetching" }), 1, 10)).toBe("loading");
    expect(body(paged({ fetchStatus: "paused" }), 1, 10)).toBe("loading");
  });

  test("отказ сервера — отказ с «повторити», а не пустота", () => {
    const s = paged({ error: new Error("Сервер не відповідає"), fetchStatus: "idle" });
    expect(body(s, 1, 10)).toBe("failed");
  });

  test("пусто — только по ответу сервера, за которым ничего не обещано", () => {
    expect(body(paged({ pages: [portion(0, 0, null)] }), 1, 10)).toBe("empty");
  });

  test("листнули вперёд при оборвавшейся связи — ждём порцию, а не «нікого не знайдено»", () => {
    /*
     * Страница 2: первая порция есть, вторая попрошена, но связь пропала, и
     * запрос встал на паузу. «Идёт подгрузка» при паузе не поднят — и экран
     * читал пустую страницу как «никого нет».
     */
    const s = paged({ pages: [portion(0, 10, "c2")], hasNextPage: true, fetchStatus: "paused" });
    expect(s.offline).toBe(true);
    expect(s.loadingMore).toBe(false);
    expect(body(s, 2, 10)).toBe("loading");
  });

  test("страница с людьми — сетка, в том числе без связи: последние загруженные остаются на экране", () => {
    expect(body(paged({ pages: [portion(0, 10, "c2")], hasNextPage: true }), 1, 10)).toBe("rows");
    expect(body(paged({ pages: [portion(0, 10, "c2")], hasNextPage: true, fetchStatus: "paused" }), 1, 10)).toBe("rows");
  });
});

describe("что на месте сетки: вкладка группы", () => {
  test("пусто по запросу и пусто в группе — разные слова", () => {
    expect(groupTabBody({ hasCard: true, error: null, rowsOnPage: 0, q: "Коваль" })).toBe("noMatch");
    expect(groupTabBody({ hasCard: true, error: null, rowsOnPage: 0, q: "  " })).toBe("empty");
  });

  test("отказ — главнее; без карточки — скелет", () => {
    expect(groupTabBody({ hasCard: false, error: "Групу не знайдено", rowsOnPage: 0, q: "" })).toBe("failed");
    expect(groupTabBody({ hasCard: false, error: null, rowsOnPage: 0, q: "" })).toBe("loading");
    expect(groupTabBody({ hasCard: true, error: null, rowsOnPage: 3, q: "" })).toBe("rows");
  });
});
