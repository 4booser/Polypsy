import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RespondentDynamics } from "@quizzy/shared";
import { api, tokenStore } from "../src/api";
import { instrumentsOf } from "../src/pages/patients/instruments";
import {
  ageOf,
  groupTab,
  initialsName,
  plural,
  registerBody,
  registerPer,
  registerQuery,
  searchOf,
  SEARCH_MAX,
  shownLimit,
  shownNumber,
  shownSeries,
  shownSeriesText,
  shownStep,
  shownValue,
  signedShown,
  sortOf,
  viewOf,
  whenShort,
} from "../src/pages/patients/model";
import { cursorPagePlan, pageFrom, perFrom, refilter, toPage, toPer } from "../src/ui/paging";
import { patchParams } from "../src/ui/viewParams";

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

  test("поиск, подання, порядок и страница — в запросе; пустое не уходит вовсе", async () => {
    // так зовёт загрузку реестр (Patients.tsx, PatientList)
    const base = { group: null, view: null, mine: false, me: "me-1", sort: "risk" as const, page: 1, per: 20 };
    await api.patientRegister(registerQuery({ ...base, q: " Коваль " }));
    await api.patientRegister(registerQuery({ ...base, q: "   ", group: "g1", view: "stale", page: 3, per: 50 }));
    await api.patientRegister(registerQuery({ ...base, q: "", view: "risk", mine: true }));
    await api.patientRegister(registerQuery({ ...base, q: "", mine: true }));
    const [first, second, third, fourth] = seen.map((s) => new URL(s, "http://x"));
    expect(first!.pathname).toBe("/api/patients");
    expect(first!.searchParams.get("q")).toBe("Коваль");
    expect(first!.searchParams.get("limit")).toBe("20");
    expect(first!.searchParams.get("offset")).toBe("0");
    expect(first!.searchParams.get("sort")).toBe("risk");
    expect(first!.searchParams.has("view")).toBe(false);
    expect(first!.searchParams.has("patientGroup")).toBe(false);
    expect(second!.searchParams.has("q")).toBe(false);
    expect(second!.searchParams.get("patientGroup")).toBe("g1");
    expect(second!.searchParams.get("view")).toBe("stale");
    expect(second!.searchParams.get("offset")).toBe("100");
    /*
     * «Закріплені за мною» — сужение поверх подання, а не подання вместо
     * пилюли: на экране горят обе, и в списке — мои С РИСКОМ. Прежде уходило
     * `view=mine`, выбранная «з ризиком» молча терялась, и в списке стояли
     * все мои.
     */
    expect(third!.searchParams.get("view")).toBe("risk");
    expect(third!.searchParams.get("lead")).toBe("me-1");
    expect(fourth!.searchParams.has("view")).toBe(false);
    expect(fourth!.searchParams.get("lead")).toBe("me-1");
    expect(first!.searchParams.has("lead")).toBe(false);
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

describe("адрес реестра: подання, порядок, строк на странице", () => {
  test("чужое подання и порядок из закладки — «все» и «ризик спершу», а не отказ сервера", () => {
    expect(viewOf("risk")).toBe("risk");
    expect(viewOf("stale")).toBe("stale");
    expect(viewOf("mine")).toBeNull(); // «за мною» — свой параметр ?mine, не пилюля
    expect(viewOf("drop table")).toBeNull();
    expect(viewOf(null)).toBeNull();
    expect(sortOf("next")).toBe("next");
    expect(sortOf("bogus")).toBe("risk");
    expect(sortOf(null)).toBe("risk");
  });

  test("строк на странице — 20 по умолчанию, чужое число — тоже 20", () => {
    expect(registerPer(null)).toBe(20);
    expect(registerPer("50")).toBe(50);
    expect(registerPer("7")).toBe(20);
  });
});

describe("что на месте таблицы реестра", () => {
  const at = (over: Partial<Parameters<typeof registerBody>[0]>) =>
    registerBody({ hasData: true, error: null, rows: 0, filtered: false, group: false, ...over });

  test("до ответа — скелет, в том числе без связи; отказ — отказ с «повторити», а не пустота", () => {
    expect(at({ hasData: false })).toBe("loading");
    expect(at({ hasData: false, error: "Сервер не відповідає" })).toBe("failed");
  });

  test("пусто по отбору, пусто в группе и пусто вообще — три разных слова", () => {
    expect(at({ filtered: true })).toBe("noMatch");
    expect(at({ group: true })).toBe("emptyGroup");
    expect(at({})).toBe("empty");
    // отбор главнее группы: «нікого не знайдено» зовёт снять отбор
    expect(at({ filtered: true, group: true })).toBe("noMatch");
  });

  test("строки есть — таблица, даже если перечитывание не удалось: прежние остаются на экране", () => {
    expect(at({ rows: 3 })).toBe("rows");
    expect(at({ rows: 3, error: "обрыв" })).toBe("rows");
  });
});

describe("числа и слова строки реестра", () => {
  test("доля — процентом, остальное — числом без лишних знаков", () => {
    expect(shownValue(0.5, "ratio")).toEqual({ text: "50", unit: "%" });
    // вне браузера язык консоли — русский: дробь пишется запятой
    expect(shownValue(64.24, "tscore")).toEqual({ text: "64,2", unit: "" });
    expect(shownValue(14, "raw")).toEqual({ text: "14", unit: "" });
    expect(shownSeries([0.3, 0.5, 0.55], "ratio")).toEqual([30, 50, 55]);
  });

  test("дробь — запятой украинского и русского, точкой английского; минус — знаком минуса", () => {
    expect(shownNumber(62.5, "uk-UA")).toBe("62,5");
    expect(shownNumber(62.5, "ru-RU")).toBe("62,5");
    expect(shownNumber(62.5, "en-GB")).toBe("62.5");
    expect(shownNumber(1234.56, "uk-UA")).toBe("1234,6");
    expect(signedShown(-16.8, "uk-UA")).toBe("−16,8");
    expect(signedShown(2.5, "uk-UA")).toBe("+2,5");
    expect(signedShown(0, "uk-UA")).toBe("0");
    /* ряд «було → стало» строки реестра и карточки фахівця — той же дробью */
    expect(shownSeriesText([64.24, 61.78], "tscore", "uk-UA")).toEqual(["64,2", "61,8"]);
    expect(shownSeriesText([64.24, 61.78], "tscore", "en-GB")).toEqual(["64.2", "61.8"]);
    expect(shownSeriesText([0.3, 0.555], "ratio", "uk-UA")).toEqual(["30", "56"]);
  });

  test("сдвиг и порог — в единицах экрана: у доли процентные пункты", () => {
    expect(shownStep(0.49 - 0.29, "ratio")).toBe(20);
    expect(shownStep(-6.66, "tscore")).toBe(-6.7);
    expect(shownLimit(0.104, "ratio")).toBe(11);
    expect(shownLimit(3.6, "raw")).toBe(4);
    expect(shownLimit(3.64, "tscore")).toBe(3.6);
  });

  test("форма слова по числу — правилами языка, три формы в одной строке словаря", () => {
    const forms = "{n} людина|{n} людини|{n} людей";
    expect(plural(forms, 1, "uk-UA")).toBe("1 людина");
    expect(plural(forms, 3, "uk-UA")).toBe("3 людини");
    expect(plural(forms, 11, "uk-UA")).toBe("11 людей");
    expect(plural(forms, 134, "uk-UA")).toBe("134 людини");
    expect(plural("{n} person|{n} people|{n} people", 248, "en-GB")).toBe("248 people");
  });

  test("когда приём: сегодня и завтра — словом, иначе день недели с датой", () => {
    const now = new Date(2026, 9, 8, 17, 0).getTime();
    const words = { today: "сьогодні", tomorrow: "завтра" };
    const today = whenShort(new Date(2026, 9, 8, 18, 0).toISOString(), now, "uk-UA", words);
    expect(today).toEqual({ text: "сьогодні, 18:00", soon: true });
    expect(whenShort(new Date(2026, 9, 9, 10, 30).toISOString(), now, "uk-UA", words).text).toBe("завтра, 10:30");
    const later = whenShort(new Date(2026, 9, 10, 10, 30).toISOString(), now, "uk-UA", words);
    expect(later.soon).toBe(false);
    expect(later.text).toContain("10.10, 10:30");
  });

  test("возраст по году рождения и фамилия с инициалами", () => {
    const now = new Date(2026, 9, 8).getTime();
    expect(ageOf(1988, now)).toBe(38);
    expect(ageOf(null, now)).toBeNull();
    expect(ageOf(1800, now)).toBeNull();
    expect(initialsName("Шевченко Марія Василівна")).toBe("Шевченко М. В.");
    expect(initialsName("Шевченко")).toBe("Шевченко");
  });
});

describe("методика человека: главная шкала", () => {
  /** Міні-мульт в миниатюре: шкала достоверности F тяжелее содержательной Hs */
  function profile(withKind: boolean): RespondentDynamics {
    const point = (severity: "mild" | "moderate", v: number) => ({
      responseId: "r1",
      submittedAt: "2026-10-09T10:00:00.000Z",
      rawScore: v,
      maxScore: 100,
      percent: v,
      bandLabel: null,
      severity,
      percentile: null,
      reliable: true,
      normalization: "tscore" as const,
    });
    const scale = (scaleId: string, code: string, title: string, kind: "clinical" | "validity", p: ReturnType<typeof point>) => ({
      scaleId,
      code,
      title,
      ...(withKind ? { kind } : {}),
      points: [p],
      delta: null,
      direction: null,
    });
    return {
      userId: "u1",
      fullName: "Мельник Андрій",
      email: "a@example.org",
      sex: "male",
      age: 38,
      surveys: [
        {
          surveyId: "mm",
          title: "Опитувальник Міні-мульт",
          responseCount: 1,
          firstAt: "2026-10-09T10:00:00.000Z",
          lastAt: "2026-10-09T10:00:00.000Z",
          scales: [
            scale("f", "F", "Шкала достовірності", "validity", point("moderate", 67)),
            scale("hs", "Hs", "Іпохондрія", "clinical", point("mild", 61)),
          ],
        },
      ],
    } as unknown as RespondentDynamics;
  }

  test("шкала достоверности главной не встаёт, пока есть содержательная", () => {
    const [mm] = instrumentsOf(profile(true));
    expect(mm!.main.scale.code).toBe("Hs");
    // остальные шкалы методики — на месте, главная первой
    expect(mm!.scales.map((s) => s.scale.code)).toEqual(["Hs", "F"]);
  });

  test("без вида шкалы (старый сервер) — как прежде: тяжелее последний замер", () => {
    expect(instrumentsOf(profile(false))[0]!.main.scale.code).toBe("F");
  });
});
