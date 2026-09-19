import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type StaffRow,
  birthYear,
  fromAssignable,
  isAdministrator,
  isDoctor,
  matchesQuery,
  metaSegments,
  ownGroups,
  pageSlice,
  sortByName,
} from "../src/pages/people/model";

/**
 * Разделы «Лікарі» и «Адміністратори»: кто в каком списке и что в строке.
 *
 * Здесь нет React и сервера — только решения, которые на живом экране
 * проверяются лишь случайно. Главное из них — правило «кто администратор»:
 * это правило доступа к чужим карточкам, и оно обязано совпадать с лестницей
 * должностей из packages/shared/src/permissions.ts. Разойдись они — в
 * реестре администраторов появился бы рядовой специалист, а глазами такое
 * не ловится: оба выглядят строкой с именем.
 */

const row = (over: Partial<StaffRow> = {}): StaffRow => ({
  id: "u1",
  fullName: "Дригнинога Федір Іванович",
  firstName: "Федір",
  lastName: "Дригнинога",
  middleName: "Іванович",
  email: "noga@gmail.com",
  role: "admin",
  sex: "male",
  birthDate: "1986-04-12",
  specialty: null,
  unit: null,
  ...over,
});

const T = { male: "чол.", female: "жін.", year: "р." };

describe("кто администратор", () => {
  test("технический суперадмин — всегда, ролей ему не нужно", () => {
    expect(isAdministrator(row({ role: "superadmin" }))).toBe(true);
    expect(isAdministrator(row({ role: "superadmin", ladder: [] }))).toBe(true);
  });

  test("заведующий и главный врач — по ступени лестницы", () => {
    expect(isAdministrator(row({ ladder: ["psychologist", "head"] }))).toBe(true);
    expect(isAdministrator(row({ ladder: ["chief"] }))).toBe(true);
  });

  test("специалист и роли вне лестницы — нет", () => {
    expect(isAdministrator(row({ ladder: ["specialist"] }))).toBe(false);
    expect(isAdministrator(row({ ladder: ["psychologist", "custom"] }))).toBe(false);
  });

  test("пока роли не загружены, человек администратором не считается", () => {
    /*
     * Ошибка в сторону «не показать» дешевле: реестр администраторов — это
     * список тех, кто раздаёт доступ, и лишняя строка в нём вводит в
     * заблуждение сильнее, чем недостающая.
     */
    expect(isAdministrator(row())).toBe(false);
  });
});

describe("кто лікар", () => {
  test("сотрудник класса admin, включая заведующего", () => {
    expect(isDoctor(row())).toBe(true);
    expect(isDoctor(row({ ladder: ["head"] }))).toBe(true);
  });

  test("технический суперадмин — нет: он никого не лечит", () => {
    expect(isDoctor(row({ role: "superadmin" }))).toBe(false);
  });
});

describe("строка списка", () => {
  test("мета-строка: почта, пол, год — как на кадре, без прочерков за пустое", () => {
    expect(metaSegments(row(), T)).toEqual(["noga@gmail.com", "чол.", "1986р."]);
    expect(metaSegments(row({ sex: null, birthDate: null }), T)).toEqual(["noga@gmail.com"]);
    expect(metaSegments(row({ sex: "female" }), T)).toEqual(["noga@gmail.com", "жін.", "1986р."]);
  });

  test("год берётся и из готового birthYear — строка пациента несёт его числом", () => {
    expect(metaSegments({ email: "a@b.c", sex: null, birthYear: 1990 }, T)).toEqual(["a@b.c", "1990г.".replace("г.", "р.")]);
  });

  test("кривая дата — не год", () => {
    expect(birthYear("1986-04-12")).toBe(1986);
    expect(birthYear(null)).toBeNull();
    expect(birthYear("дата")).toBeNull();
  });

  test("усечённый ответ «кого я вправе назначать» даёт строку без анкеты", () => {
    const r = fromAssignable({ id: "u2", email: "x@y.z", role: "admin", fullName: "Іванов Іван" });
    expect(r.sex).toBeNull();
    expect(metaSegments(r, T)).toEqual(["x@y.z"]);
  });
});

describe("отбор и порядок", () => {
  test("поиск — по имени и почте, без учёта регистра; пустой запрос — все", () => {
    expect(matchesQuery(row(), "")).toBe(true);
    expect(matchesQuery(row(), "ДРИГ")).toBe(true);
    expect(matchesQuery(row(), "noga@")).toBe(true);
    expect(matchesQuery(row(), "Петренко")).toBe(false);
  });

  test("по алфавиту, а не как отдал сервер", () => {
    const names = sortByName([row({ fullName: "Яценко" }), row({ fullName: "Іванов" }), row({ fullName: "Ґудзь" })]).map(
      (r) => r.fullName,
    );
    expect(names).toEqual(["Ґудзь", "Іванов", "Яценко"]);
  });

  test("группы — только этого владельца, поиск по названию и описанию", () => {
    const groups = [
      { ownerId: "u1", title: "Вечірня група", description: "тривога" },
      { ownerId: "u1", title: "Ранкова", description: null },
      { ownerId: "u9", title: "Чужа", description: "тривога" },
    ];
    expect(ownGroups(groups, "u1", "").map((g) => g.title)).toEqual(["Вечірня група", "Ранкова"]);
    expect(ownGroups(groups, "u1", "тривог").map((g) => g.title)).toEqual(["Вечірня група"]);
    expect(ownGroups(groups, "u9", "чужа").map((g) => g.title)).toEqual(["Чужа"]);
  });

  test("страница за концом списка пуста, а не падает", () => {
    const items = [1, 2, 3, 4, 5];
    expect(pageSlice(items, 1, 2)).toEqual([1, 2]);
    expect(pageSlice(items, 3, 2)).toEqual([5]);
    expect(pageSlice(items, 4, 2)).toEqual([]);
  });
});

/**
 * Разделы людей объявлены в приложении и в меню одними и теми же адресами.
 *
 * Бургер (Rail.tsx) и полоса (Topbar.tsx) держат свои списки ссылок; если
 * маршрут переименуют в App.tsx, обе ссылки уведут на сводку молча — общий
 * перехват не падает. Проверка та же, что у палитры команд, только на этих
 * трёх адресах: они появились вместе и обязаны исчезнуть вместе.
 */
describe("адреса разделов людей", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dir, "../src", f), "utf8");
  const app = src("App.tsx");
  const declared = new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));

  test("списки и карточка объявлены, заведение отдельным адресом", () => {
    for (const p of ["/staff", "/admins", "/staff/new", "/admins/new", "/staff/:id"]) {
      expect(declared.has(p), `нет маршрута ${p}`).toBe(true);
    }
  });

  test("меню ведёт на объявленные адреса", () => {
    const menu = `${src("shell/Rail.tsx")}\n${src("shell/Topbar.tsx")}`;
    const links = [...menu.matchAll(/\bto[:=]\s*"(\/(?:staff|admins)[^"]*)"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(1);
    expect(links.filter((to) => !declared.has(to))).toEqual([]);
  });
});
