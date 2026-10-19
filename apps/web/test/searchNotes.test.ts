import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as auth from "../src/auth";
import {
  facetCounts,
  filterHits,
  forgetRecent,
  groupHits,
  highlight,
  inPeriod,
  parseRecent,
  pushRecent,
  RECENT_KEY,
  RECENT_MAX,
  type Hit,
} from "../src/pages/search/model";

/**
 * «Пошук по записах»: подсветка основ в уривке, группировка, отбор и
 * нещодавні запити — без браузера и сервера.
 */

const hit = (over: Partial<Hit>): Hit => ({
  id: "h",
  userId: "u1",
  userName: "Мельник Андрій",
  kind: "session",
  version: 1,
  status: "signed",
  createdAt: "2026-10-05T10:40:00.000Z",
  authorName: "Ірина Савчук",
  excerpt: "",
  ...over,
});

describe("подсветка основ", () => {
  test("слово подсвечивается целиком от основы, без учёта регистра", () => {
    const parts = highlight("Кошмари двічі на тиждень, після них безсоння.", ["кошмар", "безсонн"]);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["Кошмари", "безсоння"]);
    // текст собирается обратно без потерь
    expect(parts.map((p) => p.text).join("")).toBe("Кошмари двічі на тиждень, після них безсоння.");
  });

  test("основа внутри слова — не совпадение: «сон» не горит в «безсоння»", () => {
    expect(highlight("безсоння і сон", ["сон"]).filter((p) => p.hit).map((p) => p.text)).toEqual(["сон"]);
  });

  test("без основ и без текста — один кусок без пометки; спецзнаки в основе не ломают поиск", () => {
    expect(highlight("текст", [])).toEqual([{ text: "текст", hit: false }]);
    expect(highlight("", ["а"])).toEqual([{ text: "", hit: false }]);
    expect(highlight("a+b (c)", ["a+b"]).some((p) => p.hit)).toBe(true);
  });
});

describe("группы и отбор", () => {
  const hits = [
    hit({ id: "1", userId: "u1", createdAt: "2026-10-01T10:00:00.000Z", kind: "intake" }),
    hit({ id: "2", userId: "u2", userName: "Бойко Тарас", createdAt: "2026-10-08T10:00:00.000Z", authorName: "Олег Бондар", kind: "consult" }),
    hit({ id: "3", userId: "u1", createdAt: "2026-10-05T10:00:00.000Z" }),
  ];

  test("по пациенту: группы — от самой свежей записи, внутри — новые сверху", () => {
    const g = groupHits(hits, "patient");
    expect(g.map((x) => x.userId)).toEqual(["u2", "u1"]);
    expect(g[1]!.hits.map((h) => h.id)).toEqual(["3", "1"]);
    expect(groupHits(hits, "date")[0]!.hits.map((h) => h.id)).toEqual(["2", "3", "1"]);
  });

  test("числа отбора: вид и автор", () => {
    expect(facetCounts(hits, "authorName")).toEqual([
      { value: "Ірина Савчук", count: 2 },
      { value: "Олег Бондар", count: 1 },
    ]);
  });

  test("снятые галочки, период и пациент сужают найденное", () => {
    const now = Date.parse("2026-10-10T00:00:00.000Z");
    const base = { hiddenKinds: new Set<string>(), hiddenAuthors: new Set<string>(), period: "all" as const, patient: "", now };
    expect(filterHits(hits, { ...base, hiddenKinds: new Set(["intake"]) }).map((h) => h.id)).toEqual(["2", "3"]);
    expect(filterHits(hits, { ...base, hiddenAuthors: new Set(["Олег Бондар"]) }).map((h) => h.id)).toEqual(["1", "3"]);
    expect(filterHits(hits, { ...base, patient: "u2" }).map((h) => h.id)).toEqual(["2"]);
    expect(inPeriod("2026-10-01T00:00:00.000Z", "30", now)).toBe(true);
    expect(inPeriod("2026-01-01T00:00:00.000Z", "90", now)).toBe(false);
  });
});

describe("нещодавні запити", () => {
  test("новый — первым, повтор поднимается, длина ограничена", () => {
    let list: string[] = [];
    for (const q of ["алкоголь", "кошмари  безсоння", "Алкоголь"]) list = pushRecent(list, q);
    expect(list).toEqual(["Алкоголь", "кошмари безсоння"]);
    for (let i = 0; i < 10; i++) list = pushRecent(list, `запит ${i}`);
    expect(list.length).toBe(RECENT_MAX);
  });

  test("испорченная запись — пустой список; хранится во вкладке, а не в браузере", () => {
    expect(parseRecent("не json")).toEqual([]);
    expect(parseRecent('["а", 1, "б"]')).toEqual(["а", "б"]);
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Search.tsx"), "utf8");
    expect(src).toContain("sessionStorage.getItem(RECENT_KEY)");
    expect(src).not.toContain("localStorage");
  });

  /*
   * J/K в открытом ящике листают находки, не выводя фокус из ящика: ящик
   * модальный, и фокус на кнопке под подложкой уводил диктор и клавиатуру из
   * окна. Состояние фокуса без браузера не нарисовать — проверяется исходник.
   * Мутация: вернуть .focus() на кнопку находки — падает проверка.
   */
  test("следующая находка в ящике: список докручивается, фокус остаётся в ящике", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Search.tsx"), "utf8");
    const next = src.slice(src.indexOf("const nextHit = "), src.indexOf("const stepFocus = "));
    expect(next).toContain("scrollIntoView");
    expect(next, "фокус уходит из модального ящика на кнопку под подложкой").not.toContain(".focus(");
  });

  /*
   * Ноутбук ординаторской общий: вышедший оставляет вкладку открытой, и
   * следующий входит в ту же — список «что искали» (слова клинических
   * записей, фамилии) доставался ему целиком. Теперь он стирается при выходе,
   * при входе другого человека и при конце сессии.
   *
   * Мутация: убрать forgetRecent из dropTabTraces (auth.tsx) — падает вторая
   * проверка; убрать вызов из выхода или входа — падает своя строка третьей.
   */
  test("стираются при выходе, при входе другого и при конце сессии", () => {
    const memory = (): Storage => {
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
    };
    const own = memory();
    own.setItem(RECENT_KEY, JSON.stringify(["самоушкодження"]));
    forgetRecent(own);
    expect(own.getItem(RECENT_KEY)).toBeNull();

    // конец сессии (окончательный 401, вход другого в соседней вкладке) — сброс вкладки
    // сброс вкладки читает и хранилище браузера (чей токен — для черновиков кабинета, patient/drafts.ts)
    const g = globalThis as { sessionStorage?: Storage; localStorage?: Storage };
    const saved = { session: g.sessionStorage, local: g.localStorage };
    g.sessionStorage = memory();
    g.localStorage = memory();
    g.sessionStorage.setItem(RECENT_KEY, JSON.stringify(["план безпеки"]));
    try {
      auth.dropTabSession({ user: () => {}, perms: () => {}, mfa: () => {} }, { clear: () => {} });
      expect(g.sessionStorage.getItem(RECENT_KEY), "после конца сессии список запросов остался во вкладке").toBeNull();
    } finally {
      g.sessionStorage = saved.session;
      g.localStorage = saved.local;
    }

    // выход, вход (свой и чужой) и мёртвая сессия при открытии вкладки — тем же dropTabTraces
    const src = readFileSync(resolve(import.meta.dir, "../src/auth.tsx"), "utf8");
    /* тело от начала до закрывающей скобки своего отступа */
    const body = (start: string, end: string) => {
      const at = src.indexOf(start);
      return at < 0 ? "" : src.slice(at, src.indexOf(end, at));
    };
    const paths: [string, string, string][] = [
      ["выход", "function logout() {", "\n  }\n"],
      ["вход", "async function adopt(", "\n  }\n"],
      ["мёртвая сессия при открытии", "} else if (boot.error) {", "\n    }"],
      ["сброс вкладки", "export function dropTabSession(", "\n}\n"],
    ];
    for (const [name, start, end] of paths) {
      expect(body(start, end), `${name}: недавние запросы не стираются`).toContain("dropTabTraces();");
    }
  });
});
