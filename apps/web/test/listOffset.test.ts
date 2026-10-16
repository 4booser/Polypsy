import { describe, expect, test } from "bun:test";
import { LIST_OFFSET_MAX, mailingListQuery, statModelListQuery, surveyListQuery } from "@quizzy/shared";
import { listQuery } from "../src/pages/constructor/catalogue";
import { statListQuery } from "../src/pages/statistics/model";
import { PER_PAGE, offsetPageCount, pageOffset } from "../src/ui/paging";

/**
 * Консоль не просит смещения за пределом сервера (#205).
 *
 * Каталог, рассылки и перечень моделей листаются смещением, а сервер
 * принимает его не дальше LIST_OFFSET_MAX (5 000; прежде — миллион).
 * Страница из закладки или руки («?page=99999») не должна становиться
 * отказом на весь список: смещение упирается в предел, приходит пустая
 * страница с общим числом, и экран возвращает на последнюю. Страниц экран
 * предлагает не больше, чем достижимо смещением.
 *
 * Запрос экрана проверяется схемой самого сервера (как в
 * statisticsFilters.test.ts): пройдёт ли он, решает она, а не копия предела.
 */

const FAR = [999_999, 1_000_000_000] as const;

describe("смещение списков консоли — не дальше предела сервера", () => {
  test("каталог методик", () => {
    for (const page of FAR) {
      for (const per of PER_PAGE) {
        const q = listQuery({ tab: "published", folder: null, q: "", page, per });
        const verdict = surveyListQuery.safeParse({ limit: String(q.limit), offset: String(q.offset), folder: q.folder });
        expect(verdict.success, `page=${page} per=${per} offset=${q.offset}`).toBe(true);
      }
    }
  });

  test("рассылки", () => {
    for (const page of FAR) {
      for (const per of PER_PAGE) {
        const offset = pageOffset(page, per);
        const verdict = mailingListQuery.safeParse({ limit: String(per), offset: String(offset) });
        expect(verdict.success, `page=${page} per=${per} offset=${offset}`).toBe(true);
      }
    }
  });

  test("перечень моделей", () => {
    for (const page of FAR) {
      const q = statListQuery("", page, 10);
      const verdict = statModelListQuery.safeParse({ q: q.q, limit: String(q.limit), offset: String(q.offset) });
      expect(verdict.success, `page=${page} offset=${q.offset}`).toBe(true);
    }
  });

  test("страниц — не больше достижимых, и последняя из них не обрезана", () => {
    for (const per of PER_PAGE) {
      const pages = offsetPageCount(10_000_000, per);
      expect(pages, `per=${per}`).toBe(LIST_OFFSET_MAX / per + 1);
      // последняя предложенная страница — ровно её смещение, без упора в предел
      expect(pageOffset(pages, per)).toBe((pages - 1) * per);
      expect(pageOffset(pages, per)).toBeLessThanOrEqual(LIST_OFFSET_MAX);
    }
  });

  test("положительный контроль: обычные страницы — как прежде", () => {
    expect(pageOffset(1, 10)).toBe(0);
    expect(pageOffset(3, 20)).toBe(40);
    expect(offsetPageCount(0, 10)).toBe(1);
    expect(offsetPageCount(35, 10)).toBe(4);
    expect(listQuery({ tab: "drafts", folder: "f1", q: "", page: 2, per: 50 }).offset).toBe(50);
    expect(statListQuery("", 3, 20).offset).toBe(40);
  });
});
