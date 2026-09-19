import { describe, expect, test } from "bun:test";
import type { SurveyFolder, SurveyListItem } from "@quizzy/shared";
import {
  catalogueHref,
  folderChildren,
  folderOptions,
  folderPath,
  listQuery,
  localToday,
  numericDate,
  pageCount,
  pageFrom,
  perFrom,
  retiredPage,
  tabFromPath,
} from "../src/pages/constructor/catalogue";

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
