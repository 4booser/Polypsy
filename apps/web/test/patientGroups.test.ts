import { describe, expect, test } from "bun:test";
import {
  FAVORITES_KEY,
  favouritesToMove,
  fill,
  grantEach,
  groupsSummary,
  inGroupView,
  matchesQuery,
  newProgress,
  parseFavorites,
  partialFailure,
  pluralOf,
  shortDate,
  sortGroups,
  surveyCode,
} from "../src/pages/patientGroups/model";
import { pagesOf, slicePage } from "../src/ui/paging";
import { railGroups } from "../src/shell/Rail";
import { navAccess, subNavFor } from "../src/shell/nav";

/**
 * Группы пациентов: чистая часть экранов и навигация раздела.
 *
 * Здесь нет React и сервера — только решения, которые на живом экране
 * проверяются лишь случайно: пустые поля в мета-строке, запрос из пробелов,
 * испорченная запись в хранилище, число страниц у списка, который приезжает
 * курсором, — и одна проверка навигации, где ошибка тихая: «Групи» в полосе
 * ведут на группы ПАЦИЕНТОВ, а не методик.
 */

describe("поиск по списку", () => {
  test("не зависит от регистра и пробелов по краям", () => {
    expect(matchesQuery("  ФЕД ", "Дригнинога Федір", "noga@gmail.com")).toBe(true);
    expect(matchesQuery("gmail", "Дригнинога Федір", "noga@gmail.com")).toBe(true);
  });

  test("пустой запрос совпадает со всем: очистил поле — получил полный список", () => {
    expect(matchesQuery("   ", "будь-що")).toBe(true);
    expect(matchesQuery("", null, undefined)).toBe(true);
  });

  test("пустое поле не совпадает с непустым запросом", () => {
    expect(matchesQuery("x", null, undefined, "")).toBe(false);
  });
});

describe("пометка «обрана»", () => {
  test("испорченная запись в хранилище — пустая пометка, а не падение", () => {
    expect(parseFavorites(null).size).toBe(0);
    expect(parseFavorites("не json").size).toBe(0);
    expect(parseFavorites('{"a":1}').size).toBe(0);
    expect([...parseFavorites('["g1", 7, null, "g2"]')]).toEqual(["g1", "g2"]);
  });

  test("ключ прежних отметок — с именем раздела", () => {
    /* хранилище общее на всю консоль: чужой список сюда не прочитается */
    expect(FAVORITES_KEY).toContain("patientGroups");
  });
});

describe("страницы", () => {
  test("срез страницы из полного списка", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(slicePage(items, 1, 2)).toEqual(["a", "b"]);
    expect(slicePage(items, 3, 2)).toEqual(["e"]);
    expect(slicePage(items, 4, 2)).toEqual([]);
  });

  test("число страниц: общее известно — считается от него", () => {
    expect(pagesOf(10, 95, true, 10)).toBe(10);
    expect(pagesOf(0, 0, false, 10)).toBe(1);
  });

  test("число страниц: общее неизвестно — столько, сколько приехало, плюс одна, если есть ещё", () => {
    /* поиск на сервере общего числа не отдаёт; «з 2» при живой стрелке честнее, чем «з 1» */
    expect(pagesOf(10, null, true, 10)).toBe(2);
    expect(pagesOf(10, undefined, false, 10)).toBe(1);
    expect(pagesOf(0, null, false, 10)).toBe(1);
  });
});

describe("навигация раздела «Групи»", () => {
  test("«Групи пацієнтів» в подразделах пациентов ведут на группы пациентов, не методик", () => {
    /*
     * Тихая ошибка: оба адреса называются «Групи», оба открываются, и
     * глазами их не отличить — только по содержимому экрана. Polypsy 2.0
     * разводит и слова: «Групи пацієнтів» у пациентов, «Групи методик» у
     * методик.
     */
    const all = navAccess({ role: "superadmin" }, () => true);
    const patients = subNavFor("patients", "/patients", all)!.groups.flatMap((g) => g.items);
    expect(patients.find((it) => it.label === "sn.patientGroups")?.to).toBe("/patient-groups");
    const methods = subNavFor("methods", "/surveys", all)!.groups.flatMap((g) => g.items);
    expect(methods.find((it) => it.label === "adm.groupsTitle")?.to).toBe("/groups");
  });

  test("группы методик остались в бургере под своим именем", () => {
    const items = railGroups({ today: 0, worklist: 0, alerts: 0, referrals: 0 }, false, false).flatMap((g) => g.items);
    const surveyGroups = items.find((i) => i.to === "/groups");
    expect(surveyGroups, "у групп методик не осталось двери").toBeDefined();
    expect(surveyGroups!.key).toBe("adm.groupsTitle");
    /* и группы пациентов в общем списке разделов (настройка «убрать с глаз») — под своим ключом */
    expect(items.find((i) => i.to === "/patient-groups")?.key).toBe("nav.groups");
  });
});

describe("«Призначити тест» выборке: отказ посередине", () => {
  /*
   * Выдача идёт по запросу на человека, и сервер может отказать на
   * четвёртом из восьми (обрыв, выкатка, методику сняли с публикации).
   * Проверяется то, что видит и делает специалист дальше: сколько уже
   * выдано, кому уходит повтор и что происходит, если в том же окне
   * выбрать другую методику.
   */
  const people = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

  /** Сервер, который отказывает на указанных людях, пока не «починится» */
  function server(failOn: Set<string>) {
    const calls: string[] = [];
    return {
      calls,
      failOn,
      grant: async (id: string) => {
        calls.push(id);
        if (failOn.has(id)) throw new Error("Сервер недоступний");
      },
    };
  }

  test("отказ на четвёртом: трое выданы, и это названо вместе с причиной", async () => {
    const s = server(new Set(["p4"]));
    const progress = newProgress();
    const outcome = await grantEach(progress, "survey-a|", people, s.grant);
    expect(outcome.done).toBe(3);
    expect(outcome.total).toBe(8);
    expect((outcome.error as Error).message).toBe("Сервер недоступний");
    expect(s.calls, "после отказа цикл не должен идти дальше вслепую").toEqual(["p1", "p2", "p3", "p4"]);
    expect(partialFailure(outcome, "Сервер недоступний", { done: "Тест призначено", of: "з" })).toBe(
      "Сервер недоступний · Тест призначено: 3 з 8",
    );
  });

  test("повтор в том же окне идёт только к тем, кому ещё не выдано", async () => {
    const s = server(new Set(["p4"]));
    const progress = newProgress();
    await grantEach(progress, "survey-a|", people, s.grant);
    s.failOn.clear();
    s.calls.length = 0;
    const again = await grantEach(progress, "survey-a|", people, s.grant);
    expect(again.error).toBeNull();
    expect(again.done).toBe(8);
    /* первые трое повторно не выдаются: журнал не получает по второй записи «назначено» */
    expect(s.calls).toEqual(["p4", "p5", "p6", "p7", "p8"]);
  });

  test("другая методика или другой срок в том же окне — назначение новое, выдаётся всем", async () => {
    const s = server(new Set(["p4"]));
    const progress = newProgress();
    await grantEach(progress, "survey-a|", people, s.grant);
    s.failOn.clear();
    s.calls.length = 0;
    await grantEach(progress, "survey-a|2026-10-01", people, s.grant);
    expect(s.calls).toEqual(people);
  });

  test("отказ на первом: добавлять к причине нечего", async () => {
    const s = server(new Set(["p1"]));
    const outcome = await grantEach(newProgress(), "survey-a|", people, s.grant);
    expect(outcome.done).toBe(0);
    expect(partialFailure(outcome, "Немає доступу", { done: "Тест призначено", of: "з" })).toBe("Немає доступу");
  });

  test("выдано всем с первого раза — итог по всей выборке", async () => {
    const s = server(new Set());
    const outcome = await grantEach(newProgress(), "survey-a|", people, s.grant);
    expect(outcome).toEqual({ done: 8, total: 8, error: null });
  });
});

describe("таблица групп", () => {
  test("код методики берётся из названия, а без кода — название целиком", () => {
    expect(surveyCode("Депресія (PHQ-9)")).toBe("PHQ-9");
    expect(surveyCode("Поширені психічні розлади (SRQ-20, ВООЗ)")).toBe("SRQ-20");
    expect(surveyCode("СР-45. Схильність до суїцидальних реакцій")).toBe("СР-45");
    // «(демо)» — не код: строчная кириллица
    expect(surveyCode("Якість сну (демо)")).toBe("Якість сну (демо)");
  });

  test("день строки: «08.10», чужой год — с годом", () => {
    const now = new Date(2026, 9, 18);
    expect(shortDate(new Date(2026, 9, 8, 12).toISOString(), now)).toBe("08.10");
    expect(shortDate(new Date(2025, 2, 12, 12).toISOString(), now)).toBe("12.03.2025");
    expect(shortDate("не дата", now)).toBe("—");
  });

  const g = (over: Partial<Parameters<typeof sortGroups>[0][number] & { ownerId: string; surveyCount: number; doneCount: number }>) => ({
    favourite: false,
    changedAt: "2026-10-01T00:00:00.000Z",
    title: "Б",
    memberCount: 5,
    riskCount: 0,
    ownerId: "me",
    surveyCount: 1,
    doneCount: 0,
    ...over,
  });

  test("по умолчанию — обрані первыми, затем свежая зміна; равные — по названию", () => {
    const rows = [
      g({ title: "Стара", changedAt: "2026-09-01T00:00:00.000Z" }),
      g({ title: "Обрана стара", favourite: true, changedAt: "2026-08-01T00:00:00.000Z" }),
      g({ title: "Свіжа", changedAt: "2026-10-10T00:00:00.000Z" }),
      g({ title: "Альфа", changedAt: "2026-10-10T00:00:00.000Z" }),
    ];
    expect(sortGroups(rows, "fav").map((r) => r.title)).toEqual(["Обрана стара", "Альфа", "Свіжа", "Стара"]);
    expect(sortGroups(rows, "title").map((r) => r.title)[0]).toBe("Альфа");
    // исходный массив не трогается: это состояние экрана
    expect(rows[0]!.title).toBe("Стара");
  });

  test("ризик спершу — по числу людей с ризиком", () => {
    const rows = [g({ title: "А", riskCount: 0 }), g({ title: "Б", riskCount: 3 }), g({ title: "В", riskCount: 1 })];
    expect(sortGroups(rows, "risk").map((r) => r.title)).toEqual(["Б", "В", "А"]);
  });

  test("виды: обрані, веду я, без тестів", () => {
    expect(inGroupView(g({ favourite: true }), "fav", "me")).toBe(true);
    expect(inGroupView(g({}), "fav", "me")).toBe(false);
    expect(inGroupView(g({ ownerId: "other" }), "mine", "me")).toBe(false);
    expect(inGroupView(g({ surveyCount: 0 }), "notests", "me")).toBe(true);
    expect(inGroupView(g({ surveyCount: 2 }), "all", null)).toBe(true);
  });

  test("сводка: ризик по группам, «не пройшли» — только в группах с методиками", () => {
    const s = groupsSummary([
      g({ memberCount: 8, riskCount: 2, surveyCount: 2, doneCount: 5 }),
      g({ memberCount: 4, riskCount: 0, surveyCount: 0, doneCount: 0 }),
      g({ memberCount: 6, riskCount: 1, surveyCount: 1, doneCount: 6 }),
    ]);
    expect(s).toEqual({ groups: 3, members: 18, risk: 3, riskGroups: 2, assigned: 14, waiting: 3 });
  });

  test("прежние отметки браузера переезжают только туда, где их ещё нет", () => {
    const local = new Set(["a", "b", "gone"]);
    expect(favouritesToMove(local, [{ id: "a", favourite: true }, { id: "b", favourite: false }, { id: "c", favourite: false }])).toEqual(["b"]);
  });

  test("подстановка и формы слова", () => {
    expect(fill("{n} з {total}", { n: 3, total: 8 })).toBe("3 з 8");
    expect(fill("{n} і {missing}", { n: 1 })).toBe("1 і {missing}");
    expect([1, 3, 5, 21, 22, 25].map((n) => pluralOf(n, "uk"))).toEqual(["one", "few", "many", "one", "few", "many"]);
    expect(pluralOf(2, "en")).toBe("many");
  });
});
