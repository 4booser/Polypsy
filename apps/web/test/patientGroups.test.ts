import { describe, expect, test } from "bun:test";
import {
  FAVORITES_KEY,
  keepPresent,
  matchesQuery,
  parseFavorites,
  personMeta,
  serializeFavorites,
  toggleIn,
} from "../src/pages/patientGroups/model";
import { pagesOf, slicePage } from "../src/ui/paging";
import { railGroups } from "../src/shell/Rail";
import { TOP } from "../src/shell/Topbar";

/**
 * Группы пациентов: чистая часть экранов и навигация раздела.
 *
 * Здесь нет React и сервера — только решения, которые на живом экране
 * проверяются лишь случайно: пустые поля в мета-строке, запрос из пробелов,
 * испорченная запись в хранилище, число страниц у списка, который приезжает
 * курсором, — и одна проверка навигации, где ошибка тихая: «Групи» в полосе
 * ведут на группы ПАЦИЕНТОВ, а не методик.
 */

const WORDS = { male: "чол.", female: "жін.", year: "р." };

describe("мета-строка карточки", () => {
  test("собирается в порядке макета: e-mail, подразделение, пол, год", () => {
    expect(
      personMeta(
        { userId: "u", fullName: "Х", email: "noga@gmail.com", unit: "м.Київ", sex: "male", birthYear: 1986 },
        WORDS,
      ),
    ).toEqual(["noga@gmail.com", "м.Київ", "чол.", "1986р."]);
  });

  test("пустые поля пропускаются, а не печатаются прочерком", () => {
    /* строка состава группы приходит без пола и года — их просто нет */
    expect(personMeta({ userId: "u", fullName: "Х", email: "a@b", unit: null }, WORDS)).toEqual(["a@b"]);
    expect(personMeta({ userId: "u", fullName: "Х", email: "", sex: "female", birthYear: null }, WORDS)).toEqual(["жін."]);
  });
});

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

describe("выбор галочками", () => {
  test("переключение даёт новое множество, старое не трогает", () => {
    const a = new Set(["1"]);
    const b = toggleIn(a, "2");
    expect([...b].sort()).toEqual(["1", "2"]);
    expect([...a]).toEqual(["1"]);
    expect([...toggleIn(b, "1")]).toEqual(["2"]);
  });

  test("из выбора уходят те, кого в списке больше нет", () => {
    /* иначе «3 вибрано» при двух видимых галочках — и действие над невидимым */
    const kept = keepPresent(new Set(["1", "2", "3"]), [{ userId: "2" }, { userId: "3" }]);
    expect([...kept].sort()).toEqual(["2", "3"]);
  });
});

describe("пометка «обрана»", () => {
  test("испорченная запись в хранилище — пустая пометка, а не падение", () => {
    expect(parseFavorites(null).size).toBe(0);
    expect(parseFavorites("не json").size).toBe(0);
    expect(parseFavorites('{"a":1}').size).toBe(0);
    expect([...parseFavorites('["g1", 7, null, "g2"]')]).toEqual(["g1", "g2"]);
  });

  test("запись и чтение — обратны друг другу", () => {
    const set = new Set(["g1", "g2"]);
    expect([...parseFavorites(serializeFavorites(set))]).toEqual(["g1", "g2"]);
    /* ключ с именем раздела: хранилище общее на всю консоль, чужой список сюда не прочитается */
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
  test("«Групи» в верхней полосе ведут на группы пациентов, не методик", () => {
    /*
     * Тихая ошибка: оба адреса называются «Групи», оба открываются, и
     * глазами их не отличить — только по содержимому экрана.
     */
    const groups = TOP.find((it) => it.key === "top.groups");
    expect(groups?.to).toBe("/patient-groups");
  });

  test("группы методик остались в бургере под своим именем", () => {
    const items = railGroups({ today: 0, worklist: 0, alerts: 0, referrals: 0 }, false, false).flatMap((g) => g.items);
    const surveyGroups = items.find((i) => i.to === "/groups");
    expect(surveyGroups, "у групп методик не осталось двери").toBeDefined();
    expect(surveyGroups!.key).toBe("adm.groupsTitle");
    /* и группы пациентов в бургере — под тем же словом, что в полосе */
    expect(items.find((i) => i.to === "/patient-groups")?.key).toBe("nav.groups");
  });
});
