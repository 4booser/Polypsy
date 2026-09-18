import { describe, expect, test } from "bun:test";
import { ALWAYS_VISIBLE_RAIL } from "@quizzy/shared";
import { railGroups } from "../src/shell/Rail";

/**
 * Разделы рельсы.
 *
 * Проверяется не внешний вид, а состав: какие группы собираются для какой
 * роли и не склеиваются ли две в одну. Склейка была настоящей — «Права»
 * заводились отдельной группой с ключом группы пациентов, и в рельсе
 * получалось два раздела «Люди». Видно это только глазами на живом экране;
 * ни один тест такого не ловил.
 */

const COUNTS = { today: 0, worklist: 0, alerts: 0, referrals: 0 };
const keys = (isSuper: boolean, canAssign: boolean) =>
  railGroups(COUNTS, isSuper, canAssign).map((g) => g.key);

describe("разделы рельсы", () => {
  test("ключи разделов не повторяются ни у одной роли", () => {
    for (const isSuper of [false, true]) {
      for (const canAssign of [false, true]) {
        const list = keys(isSuper, canAssign);
        const unique = new Set(list);
        expect(
          unique.size,
          `роль isSuper=${isSuper} canAssign=${canAssign}: ${list.join(", ")}`,
        ).toBe(list.length);
      }
    }
  });

  test("специалисту раздела администрирования нет вовсе", () => {
    /*
     * Пустой раздел хуже отсутствующего: он обещает содержимое и открывается
     * в пустоту. Специалисту назначать некого и учётными записями он не
     * ведает — значит раздела быть не должно, а не быть пустым.
     */
    expect(keys(false, false)).not.toContain("nav.admin");
  });

  test("назначающий видит администрирование, и в нём есть права", () => {
    const groups = railGroups(COUNTS, false, true);
    const admin = groups.find((g) => g.key === "nav.admin");
    expect(admin, "у заведующего нет раздела администрирования").toBeDefined();
    expect(admin!.items.map((i) => i.to)).toContain("/permissions");
  });

  test("суперадмину доступны и права, и учётные записи", () => {
    const admin = railGroups(COUNTS, true, false).find((g) => g.key === "nav.admin");
    const paths = admin!.items.map((i) => i.to);
    expect(paths).toContain("/permissions");
    expect(paths).toContain("/users");
    expect(paths).toContain("/audit");
  });

  test("ни один раздел не пуст", () => {
    for (const isSuper of [false, true]) {
      for (const canAssign of [false, true]) {
        for (const g of railGroups(COUNTS, isSuper, canAssign)) {
          expect(g.items.length, `раздел «${g.key}» пуст`).toBeGreaterThan(0);
        }
      }
    }
  });
});

/*
 * Скрытие разделов: убирается лишнее, сигнальное остаётся.
 *
 * Прятать пункты нужно — рельса выросла до тринадцати разделов, и половиной
 * из них конкретный специалист не пользуется. Но три из них носят не раздел,
 * а сигнал: рядом стоит число неразобранных случаев риска, задач в очереди,
 * людей на сегодня. Спрятанный сигнал — это не убранное меню, а незамеченная
 * работа, и в психологическом отделении это самое дорогое, что тут можно
 * сломать.
 */
describe("скрытие разделов рельсы", () => {
  const counts = { today: 3, worklist: 5, alerts: 2, referrals: 1 };
  const keysOf = (hidden: string[]) =>
    railGroups(counts, true, true, hidden).flatMap((g) => g.items.map((i) => i.key));

  test("убранный раздел исчезает из меню", () => {
    expect(keysOf([]), "«Методики» нет в рельсе и без всякого скрытия").toContain("nav.surveys");
    expect(
      keysOf(["nav.surveys"]),
      "раздел не убрался: настройка не действует",
    ).not.toContain("nav.surveys");
  });

  test("сигнальный раздел убрать нельзя", () => {
    for (const key of ALWAYS_VISIBLE_RAIL) {
      expect(
        keysOf([...ALWAYS_VISIBLE_RAIL]),
        `«${key}» убрался с глаз: рядом с ним стоит число неразобранного, и человек его больше не увидит`,
      ).toContain(key);
    }
  });

  test("опустевшая группа исчезает целиком", () => {
    /*
     * Заголовок раздела, под которым ничего нет, — не порядок, а обломок.
     * Методики и наборы — единственная группа из двух пунктов, на ней и
     * проверяется.
     */
    const groups = railGroups(counts, true, true, ["nav.surveys", "nav.batteries"]);
    expect(
      groups.map((g) => g.key),
      "пустая группа осталась в рельсе заголовком без содержимого",
    ).not.toContain("nav.group.methods");
  });

  test("скрытие не отнимает доступа: маршрут остаётся объявленным", () => {
    /*
     * Скрытый раздел открывается по ссылке и из палитры команд. Если бы
     * скрытие вычёркивало маршрут, настройка внешнего вида превратилась бы в
     * настройку прав — а права живут на сервере и меняются не отсюда.
     */
    const hiddenKey = "nav.surveys";
    const item = railGroups(counts, true, true).flatMap((g) => g.items).find((i) => i.key === hiddenKey);
    expect(item, "раздел пропал из полного набора — проверка была бы пустой").toBeTruthy();
    expect(typeof item!.to, "у раздела нет адреса, значит открыть его иначе нельзя").toBe("string");
  });
});
