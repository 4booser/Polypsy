import { describe, expect, test } from "bun:test";
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
