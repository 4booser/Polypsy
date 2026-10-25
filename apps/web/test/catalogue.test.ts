import { describe, expect, test } from "bun:test";
import type { SurveyFolder, SurveyListItem } from "@quizzy/shared";
import {
  assignPending,
  catalogueHref,
  domainCounts,
  domainFrom,
  folderChildren,
  folderOptions,
  folderPath,
  listQuery,
  localToday,
  movePlan,
  numericDate,
  pageCount,
  pageFrom,
  perFrom,
  retiredPage,
  sameValue,
  tabFromPath,
} from "../src/pages/constructor/catalogue";
import { eachOf } from "../src/ui/action";

/**
 * Чистая часть каталога тестов: адрес, запрос, страницы, папки.
 *
 * Здесь нет React и сервера — только решения, которые на живом экране
 * проверяются лишь случайно: последняя страница после удаления, папка с
 * кольцом родителей, старая закладка с чужим числом строк на странице.
 */

const folder = (id: string, parentId: string | null, over: Partial<SurveyFolder> = {}): SurveyFolder => ({
  id,
  groupId: "g1",
  parentId,
  title: id,
  startsOn: "2023-02-05",
  position: 0,
  createdBy: null,
  createdAt: "2023-02-05T00:00:00Z",
  ...over,
});

const item = (id: string, archivedAt: string | null): SurveyListItem =>
  ({ id, title: id, archivedAt }) as unknown as SurveyListItem;

describe("вкладки в адресе", () => {
  test("сегмент адреса даёт вкладку, неизвестный хвост — опубликованные", () => {
    expect(tabFromPath("/surveys")).toBe("published");
    expect(tabFromPath("/surveys/drafts")).toBe("drafts");
    expect(tabFromPath("/surveys/retired")).toBe("retired");
    expect(tabFromPath("/surveys/whatever")).toBe("published");
  });

  test("умолчания в адрес не пишутся: у одной страницы один адрес", () => {
    expect(catalogueHref("published")).toBe("/surveys");
    expect(catalogueHref("published", { page: 1, per: 10, q: "  " })).toBe("/surveys");
    expect(catalogueHref("drafts", { folder: "f1", page: 3, per: 50, q: "мло" })).toBe(
      "/surveys/drafts?folder=f1&q=%D0%BC%D0%BB%D0%BE&page=3&per=50",
    );
  });
});

describe("страницы", () => {
  test("чужое число строк из адреса заменяется ступенью селекта", () => {
    expect(perFrom("20")).toBe(20);
    expect(perFrom("7")).toBe(10);
    expect(perFrom(null)).toBe(10);
  });

  test("номер страницы не бывает меньше первой", () => {
    expect(pageFrom("3")).toBe(3);
    expect(pageFrom("0")).toBe(1);
    expect(pageFrom("abc")).toBe(1);
    expect(pageFrom(null)).toBe(1);
  });

  test("пустой список — одна страница, а не ноль", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
  });
});

describe("запрос к серверу", () => {
  test("в корне без поиска — только методики вне папок, постранично", () => {
    expect(listQuery({ tab: "published", folder: null, q: "", page: 2, per: 20 })).toEqual({
      folder: "root",
      q: "",
      status: "published",
      limit: 20,
      offset: 20,
    });
  });

  test("поиск в корне идёт по всему каталогу, внутри папки — по ней", () => {
    expect(listQuery({ tab: "drafts", folder: null, q: " мло ", page: 1, per: 10 }).folder).toBeUndefined();
    expect(listQuery({ tab: "drafts", folder: "f1", q: "мло", page: 1, per: 10 })).toMatchObject({
      folder: "f1",
      q: "мло",
      status: "draft",
    });
  });

  test("снятые просятся целиком: сервер отдаёт их вместе с остальными", () => {
    expect(listQuery({ tab: "retired", folder: null, q: "", page: 4, per: 10 })).toEqual({
      folder: "root",
      q: "",
      archived: true,
    });
  });

  test("страница снятых отбирает и режет сама", () => {
    const rows = [item("a", null), item("b", "2024-01-01"), item("c", "2024-01-02"), item("d", "2024-01-03")];
    expect(retiredPage(rows, 1, 2)).toEqual({ items: [rows[1]!, rows[2]!], total: 3 });
    expect(retiredPage(rows, 2, 2)).toEqual({ items: [rows[3]!], total: 3 });
  });
});

describe("чипы «Напрям»", () => {
  const row = (domain: string | null, over: Partial<SurveyListItem> = {}) =>
    ({ id: crypto.randomUUID(), title: "x", domain, status: "published", archivedAt: null, groupId: "g1", ...over }) as unknown as SurveyListItem;

  test("направление ищет как поиск: в корне — весь каталог, в папке — по ней", () => {
    expect(listQuery({ tab: "published", folder: null, q: "", page: 1, per: 10, domain: "trauma" })).toEqual({
      folder: undefined,
      q: "",
      status: "published",
      limit: 10,
      offset: 0,
      domain: "trauma",
    });
    expect(listQuery({ tab: "published", folder: "f1", q: "", page: 1, per: 10, domain: "none" })).toMatchObject({
      folder: "f1",
      domain: "none",
    });
    expect(listQuery({ tab: "retired", folder: null, q: "", page: 1, per: 10, domain: "sleep" })).toEqual({
      folder: undefined,
      q: "",
      archived: true,
      domain: "sleep",
    });
    // без чипа запрос прежний — в адрес сервера не уходит пустой параметр
    expect("domain" in listQuery({ tab: "published", folder: null, q: "", page: 1, per: 10, domain: null })).toBe(false);
  });

  test("чип живёт в адресе, незнакомое слово из адреса — без фильтра", () => {
    expect(catalogueHref("drafts", { domain: "addiction", per: 20 })).toBe("/surveys/drafts?domain=addiction&per=20");
    expect(domainFrom("trauma")).toBe("trauma");
    expect(domainFrom("none")).toBe("none");
    expect(domainFrom("depression")).toBeNull();
    expect(domainFrom(null)).toBeNull();
  });

  test("числа — по вкладке и группе, направления в порядке перечня", () => {
    const rows = [
      row("trauma"),
      row("trauma"),
      row("distress"),
      row(null),
      row("trauma", { status: "draft" }),
      row("sleep", { archivedAt: "2026-01-01" }),
      row("distress", { groupId: "g2" }),
    ];
    const published = domainCounts(rows, "published", null);
    expect(published.all).toBe(5);
    expect(published.none).toBe(1);
    expect(published.domains.slice(0, 2)).toEqual([
      { domain: "distress", count: 2 },
      { domain: "trauma", count: 2 },
    ]);
    expect(domainCounts(rows, "published", "g1").domains[0]).toEqual({ domain: "distress", count: 1 });
    expect(domainCounts(rows, "drafts", null).all).toBe(1);
    expect(domainCounts(rows, "retired", null).domains.find((d) => d.domain === "sleep")?.count).toBe(1);
  });
});

describe("папки", () => {
  const tree = [
    folder("2023", null),
    folder("feb", "2023"),
    folder("feb-start", "feb"),
    folder("2024", null),
    folder("other", null, { groupId: "g2" }),
  ];

  test("крошки идут от корня до папки включительно", () => {
    expect(folderPath(tree, "feb-start").map((f) => f.id)).toEqual(["2023", "feb", "feb-start"]);
    expect(folderPath(tree, "2024").map((f) => f.id)).toEqual(["2024"]);
  });

  test("неизвестная папка даёт пустые крошки, а не поломку", () => {
    expect(folderPath(tree, "nope")).toEqual([]);
  });

  test("кольцо родителей не вешает экран", () => {
    const ring = [folder("a", "b"), folder("b", "a")];
    expect(folderPath(ring, "a").length).toBeLessThanOrEqual(2);
  });

  test("уровень — дети одного родителя, корень — папки всех групп", () => {
    expect(folderChildren(tree, null).map((f) => f.id)).toEqual(["2023", "2024", "other"]);
    expect(folderChildren(tree, "2023").map((f) => f.id)).toEqual(["feb"]);
  });

  test("список для переноса — дерево одной группы с глубиной", () => {
    expect(folderOptions(tree, "g1")).toEqual([
      { id: "2023", title: "2023", depth: 0 },
      { id: "feb", title: "feb", depth: 1 },
      { id: "feb-start", title: "feb-start", depth: 2 },
      { id: "2024", title: "2024", depth: 0 },
    ]);
  });
});

describe("даты", () => {
  test("дата папки печатается числами с ведущими нулями, как на макете", () => {
    expect(numericDate("2023-02-05")).toBe("05.02.2023");
    expect(numericDate("2023-02-05T10:20:30.000Z")).toBe("05.02.2023");
    expect(numericDate("вчора")).toBe("вчора");
  });

  test("сегодня — по местному календарю, а не по Гринвичу", () => {
    // 23:30 местного 5 февраля: по UTC это может быть уже 6-е, но папка заводится «сегодня»
    expect(localToday(new Date(2023, 1, 5, 23, 30))).toBe("2023-02-05");
  });
});

describe("отмеченные методики", () => {
  test("умолчание окна переноса — общее значение всех отмеченных, иначе пусто", () => {
    expect(sameValue(["g1", "g1", "g1"])).toBe("g1");
    expect(sameValue(["g1", "g2"])).toBeUndefined();
    expect(sameValue([null, null])).toBeNull();
    expect(sameValue([])).toBeUndefined();
  });

  /*
   * Мутация: считать папку после смены группы по старому folderId — методика
   * из папки другой группы «уже в корне», и второй шаг не ставит её в папку.
   */
  test("перенос: смена группы — правкой, папка после неё — переносом, лишних шагов нет", () => {
    // вне групп → в корень группы: только группа (сервер сам кладёт в корень)
    expect(movePlan({ groupId: null, folderId: null }, "g1", null)).toEqual({ group: true, folder: false });
    // вне групп → в папку группы: группа, затем папка
    expect(movePlan({ groupId: null, folderId: null }, "g1", "f1")).toEqual({ group: true, folder: true });
    // из папки другой группы в папку этой: оба шага
    expect(movePlan({ groupId: "g2", folderId: "x" }, "g1", "f1")).toEqual({ group: true, folder: true });
    // из папки другой группы в корень этой: смена группы и так снимает с полки
    expect(movePlan({ groupId: "g2", folderId: "x" }, "g1", null)).toEqual({ group: true, folder: false });
    // своя группа: только папка — или ничего, если методика уже там
    expect(movePlan({ groupId: "g1", folderId: null }, "g1", "f1")).toEqual({ group: false, folder: true });
    expect(movePlan({ groupId: "g1", folderId: "f1" }, "g1", null)).toEqual({ group: false, folder: true });
    expect(movePlan({ groupId: "g1", folderId: "f1" }, "g1", "f1")).toEqual({ group: false, folder: false });
  });

  test("действие над отмеченными идёт по всем: отказ одной не обрывает остальные", async () => {
    const asked: string[] = [];
    const result = await eachOf(["a", "b", "c"], async (id) => {
      asked.push(id);
      if (id === "b") throw new Error("Немає доступу до групи");
    });
    expect(asked).toEqual(["a", "b", "c"]);
    expect(result.done).toEqual(["a", "c"]);
    expect(result.failed).toEqual([{ item: "b", reason: "Немає доступу до групи" }]);
  });
});

describe("назначение отмеченных методик", () => {
  /*
   * Мутация: при повторе выдавать все методики заново — методика, которую
   * человек прошёл между попытками, получает ещё одну попытку (grantAccess
   * обнуляет счёт), а журнал — вторую выдачу.
   */
  test("повтор выдаёт только не прошедшие пары, отказ одной не обрывает остальные", async () => {
    const surveys = [{ id: "phq9" }, { id: "gad7" }, { id: "who5" }];
    const done = new Set<string>();
    const asked: string[] = [];
    let gadFails = true;
    const act = async (s: { id: string }) => {
      asked.push(s.id);
      if (s.id === "gad7" && gadFails) throw new Error("Методику знято з використання");
    };

    const first = await assignPending(surveys, "u:p1", done, act);
    expect(asked).toEqual(["phq9", "gad7", "who5"]);
    expect(first.failed).toEqual([{ item: { id: "gad7" }, reason: "Методику знято з використання" }]);

    asked.length = 0;
    gadFails = false;
    const retry = await assignPending(surveys, "u:p1", done, act);
    expect(asked, "повтор выдал заново прошедшие").toEqual(["gad7"]);
    expect(retry.failed).toEqual([]);

    /*
     * Мутация: не забывать пары законченной операции — следующее назначение
     * тому же человеку (ещё одна попытка после прохождения) молча пропускается.
     */
    asked.length = 0;
    await assignPending(surveys, "u:p1", done, act);
    expect(asked, "законченная операция мешает следующей").toEqual(["phq9", "gad7", "who5"]);

    // другой адресат — пары свои
    asked.length = 0;
    await assignPending(surveys, "u:p2", done, act);
    expect(asked).toEqual(["phq9", "gad7", "who5"]);
  });

  test("набор отмеченных сменился посреди операции: прошедшие пары не выдаются, законченная — забывается целиком", async () => {
    const done = new Set<string>();
    const asked: string[] = [];
    let fail = true;
    const act = async (s: { id: string }) => {
      asked.push(s.id);
      if (s.id === "gad7" && fail) throw new Error("ні");
    };
    await assignPending([{ id: "phq9" }, { id: "gad7" }], "u:p1", done, act);
    // сняли отметку с PHQ-9 и добавили WHO-5, повтор тому же человеку
    asked.length = 0;
    fail = false;
    await assignPending([{ id: "gad7" }, { id: "who5" }], "u:p1", done, act);
    expect(asked).toEqual(["gad7", "who5"]);
    // операция закончена — от неё не осталось и пары PHQ-9
    expect([...done]).toEqual([]);
  });
});
