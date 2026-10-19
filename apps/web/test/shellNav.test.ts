import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clinicalLinks,
  isCurrent,
  navAccess,
  railEntries,
  railKeyOf,
  screenTools,
  sectionOf,
  subNavFor,
} from "../src/shell/nav";
import {
  THEME_KEY,
  getThemeChoice,
  isThemeChoice,
  resetThemeForTest,
  resolveTheme,
  restoreStoredTheme,
  setThemeChoice,
} from "../src/shell/theme";

/**
 * Навигация оболочки Polypsy 2.0 (shell/nav.ts) и выбор темы
 * (shell/theme.ts) — без браузера.
 *
 * Тихие ошибки, ради которых это написано: адрес, отнесённый не к тому
 * разделу, подсвечивает на рельсе чужой раздел и открывает чужую колонку
 * подразделов; «Каталог» текущий и на черновиках — два пункта отмечены
 * сразу; дверь к открытому человеку пропала — до клинической карты не
 * добраться иначе, чем набрав адрес. Глазами всё это видно только тому, кто
 * откроет нужный адрес нужной учётной записью.
 */

const ALL = navAccess({ role: "superadmin" }, () => true);

describe("раздел по адресу", () => {
  test("рельса: каждый адрес — в свой раздел, по корню, а не по вхождению строки", () => {
    const cases: [string, ReturnType<typeof railKeyOf>][] = [
      ["/", "today"],
      ["/today", "today"],
      ["/invites", "today"],
      ["/visit/a1", "today"],
      ["/worklist", "worklist"],
      ["/alerts", "cases"],
      ["/patients/u1/case/dynamics", "patients"],
      ["/patient-groups/g1", "patients"],
      ["/mailings/new", "patients"],
      ["/my-schedule", "schedule"],
      ["/messages/t1", "messages"],
      ["/surveys/drafts", "methods"],
      ["/responses/r1/conclusion", "methods"],
      ["/statistics/chart", "analytics"],
      ["/ops/logs", "admin"],
      ["/account", "admin"],
      ["/status", null],
      ["/ui", null],
      ["/todayx", null],
    ];
    for (const [path, key] of cases) expect(railKeyOf(path), path).toBe(key);
  });

  test("колонка подразделов: у конструктора её нет, у техпанели — своя", () => {
    expect(sectionOf("/constructor/s1")).toBeNull();
    expect(sectionOf("/ops")).toBe("ops");
    expect(sectionOf("/ops/trace/x")).toBe("ops");
    expect(sectionOf("/staff/u1")).toBe("admin");
    expect(sectionOf("/today")).toBeNull();
  });
});

describe("текущий пункт подразделов — ровно один", () => {
  const current = (section: Parameters<typeof subNavFor>[0], path: string) =>
    subNavFor(section, path, ALL)!
      .groups.flatMap((g) => g.items)
      .filter((it) => isCurrent(it, path))
      .map((it) => it.to);

  test("каталог методик не текущий на черновиках и в архиве", () => {
    expect(current("methods", "/surveys")).toEqual(["/surveys"]);
    expect(current("methods", "/surveys/drafts")).toEqual(["/surveys/drafts"]);
    expect(current("methods", "/surveys/retired")).toEqual(["/surveys/retired"]);
    /* заключение — экран прохождения методики: каталог */
    expect(current("methods", "/responses/r1/conclusion")).toEqual(["/surveys"]);
  });

  test("модели аналитики не текущие на «Аналітиці тестів»", () => {
    expect(current("analytics", "/analytics/tests")).toEqual(["/analytics/tests"]);
    expect(current("analytics", "/analytics/r1")).toEqual(["/analytics"]);
    expect(current("analytics", "/statistics/filters/f1")).toEqual(["/statistics/filters"]);
    expect(current("analytics", "/statistics/m1")).toEqual(["/statistics"]);
  });

  test("обзор техпанели текущий только сам на себе", () => {
    expect(current("ops", "/ops")).toEqual(["/ops"]);
    expect(current("ops", "/ops/errors")).toEqual(["/ops/errors"]);
  });
});

describe("двери открытого человека и экрана", () => {
  test("клиническая карта — группой подразделов, пока открыт человек", () => {
    expect(clinicalLinks("/patients")).toBeNull();
    expect(clinicalLinks("/patients/u1")?.map((i) => i.to)).toEqual([
      "/patients/u1/case",
      "/patients/u1/case/dynamics",
      "/patients/u1/case/timeline",
    ]);
    const groups = subNavFor("patients", "/patients/u1", ALL)!.groups;
    expect(groups.some((g) => g.label === "pcard.clinical")).toBe(true);
  });

  test("правка группы и черновик заключения — на своих экранах и нигде больше", () => {
    expect(screenTools("/patient-groups/g1")?.[0]?.to).toBe("/patient-groups/g1/edit");
    expect(screenTools("/patient-groups/g1/edit")).toBeNull();
    expect(screenTools("/responses/r1/conclusion")?.[0]?.to).toBe("/responses/r1/conclusion/draft");
    expect(subNavFor("methods", "/responses/r1/conclusion", ALL)!.groups.some((g) => g.label === "tools.screen")).toBe(
      true,
    );
  });

  test("«Норми» — только при открытой методике: без неё адресу не на что вести", () => {
    const norms = (path: string) =>
      subNavFor("methods", path, ALL)!.groups.flatMap((g) => g.items).find((i) => i.label === "sn.norms")?.to;
    expect(norms("/surveys")).toBeUndefined();
    expect(norms("/surveys/0b8a3c2e-1111-4222-8333-944455556666/norms")).toBe(
      "/surveys/0b8a3c2e-1111-4222-8333-944455556666/norms",
    );
  });
});

describe("«убрать с глаз» на рельсе", () => {
  test("раздел уходит, когда убраны все его пункты; сигнальные не уходят никогда", () => {
    const keys = (hidden: string[]) => railEntries(ALL, {}, hidden).map((e) => e.key);
    expect(keys(["nav.surveys"])).toContain("methods");
    expect(keys(["nav.surveys", "nav.batteries", "adm.groupsTitle"])).not.toContain("methods");
    expect(keys(["nav.worklist", "nav.cases", "nav.dashboard"])).toEqual(
      expect.arrayContaining(["today", "worklist", "cases"]),
    );
  });
});

describe("тема: светлая, тёмная, как у системы", () => {
  const g = globalThis as { localStorage?: Storage };
  const saved = g.localStorage;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    g.localStorage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
    };
    resetThemeForTest("light");
  });

  afterEach(() => {
    g.localStorage = saved;
    resetThemeForTest("light");
  });

  test("«як у системі» рисует тему системы, явный выбор — себя", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  test("выбор человека пишется в браузер; выбор с сервера — нет", () => {
    setThemeChoice("system");
    expect(getThemeChoice()).toBe("system");
    expect(store.get(THEME_KEY)).toBe("system");
    /* профиль с сервера на общем компьютере принадлежит вошедшему: умолчание машины он не переписывает */
    setThemeChoice("dark", { remember: false });
    expect(getThemeChoice()).toBe("dark");
    expect(store.get(THEME_KEY)).toBe("system");
  });

  test("вошедший ушёл — тема возвращается к выбору браузера, а не остаётся из его профиля", () => {
    setThemeChoice("system");
    setThemeChoice("dark", { remember: false });
    restoreStoredTheme();
    expect(getThemeChoice()).toBe("system");
    expect(store.get(THEME_KEY)).toBe("system");
  });

  test("в хранилище — только три известных значения; мусор не принимается", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("auto")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });

  test("сервер принимает «system» — тот же перечень, что у консоли", () => {
    const schema = readFileSync(resolve(import.meta.dir, "../../../packages/shared/src/schemas.ts"), "utf8");
    expect(schema).toContain('theme: z.enum(["dark", "light", "system"])');
  });
});
