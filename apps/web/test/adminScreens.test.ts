import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StaffAccount } from "@quizzy/shared";
import { paragraphChanges, wordDiff } from "../src/pages/Admin";
import { byTag, routeMatches } from "../src/pages/ApiDocs";
import { strengthOf } from "../src/pages/Account";
import { completions, readRecent, recentKey, saveRecent } from "../src/pages/Console";
import { draftDiff, roleOrder } from "../src/pages/Permissions";
import {
  type StaffRow,
  accountState,
  inView,
  isAdministrator,
  isStale,
  ladderCounts,
  mainRole,
  orderRegistry,
  viewCounts,
} from "../src/pages/people/model";
import { plural, shortName, whenShort } from "../src/pages/people/parts";

/**
 * Раздел «Адміністрування» 2.0 (участок v2-admin): чистая логика экранов —
 * состояние учётной записи и виды реестра, порядок, роль строкой, ступени,
 * сравнение текста согласия, отбор маршрутов API, дополнение консоли, сила
 * пароля и формы числа. Всё это тихо врёт на экране, если сломается, и
 * глазами ловится только случайно.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);

function account(over: Partial<StaffAccount> = {}): StaffAccount {
  return {
    lastSeenAt: new Date(NOW - DAY).toISOString(),
    mfa: true,
    disabledAt: null,
    mustChangePassword: false,
    ladderRank: 1,
    roles: [{ code: "specialist", title: "Спеціаліст" }],
    exceptions: 0,
    patients: 0,
    ...over,
  };
}

function row(id: string, over: Partial<StaffRow> = {}): StaffRow {
  return {
    id,
    fullName: id,
    firstName: id,
    lastName: id,
    middleName: null,
    email: `${id}@x.y`,
    role: "admin",
    sex: null,
    birthDate: null,
    specialty: null,
    unit: null,
    department: null,
    position: null,
    phone: null,
    ...over,
  };
}

describe("состояние учётной записи", () => {
  test("выключена, ни разу не входила с временным паролем, сменить пароль, не входила, работает", () => {
    expect(accountState(account({ disabledAt: "2026-10-01T00:00:00Z" }))).toBe("disabled");
    expect(accountState(account({ mustChangePassword: true, lastSeenAt: null }))).toBe("invited");
    expect(accountState(account({ mustChangePassword: true }))).toBe("temp");
    expect(accountState(account({ lastSeenAt: null }))).toBe("never");
    expect(accountState(account())).toBe("active");
    expect(accountState(undefined)).toBeNull();
  });

  test("«давно не входил» — от 30 дней, и только у действующей записи, которая входила", () => {
    expect(isStale(account({ lastSeenAt: new Date(NOW - 30 * DAY).toISOString() }), NOW)).toBe(true);
    expect(isStale(account({ lastSeenAt: new Date(NOW - 29 * DAY).toISOString() }), NOW)).toBe(false);
    expect(isStale(account({ lastSeenAt: null }), NOW)).toBe(false);
    expect(isStale(account({ lastSeenAt: new Date(NOW - 90 * DAY).toISOString(), disabledAt: "2026-01-01T00:00:00Z" }), NOW)).toBe(false);
  });

  test("виды реестра считают то же, что показывают", () => {
    const rows = [
      row("a", { account: account() }),
      row("b", { account: account({ mfa: false }) }),
      row("c", { account: account({ lastSeenAt: new Date(NOW - 40 * DAY).toISOString() }) }),
      row("d", { account: account({ mustChangePassword: true, lastSeenAt: null }) }),
      row("e", { account: account({ disabledAt: "2026-10-01T00:00:00Z", mfa: false }) }),
    ];
    const counts = viewCounts(rows, NOW);
    expect(counts).toEqual({ all: 5, nomfa: 1, stale: 1, invited: 1, disabled: 1 });
    expect(rows.filter((r) => inView(r, "nomfa", NOW)).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("порядок и роль строкой", () => {
  test("по пациентам — больше сверху, без учётной записи — в конце; по входу — свежие сверху", () => {
    const rows = [
      row("Б", { account: account({ patients: 3, lastSeenAt: new Date(NOW - 5 * DAY).toISOString() }) }),
      row("А", { account: account({ patients: 9, lastSeenAt: new Date(NOW - 9 * DAY).toISOString() }) }),
      row("В"),
    ];
    expect(orderRegistry(rows, "patients").map((r) => r.id)).toEqual(["А", "Б", "В"]);
    expect(orderRegistry(rows, "seen").map((r) => r.id)).toEqual(["Б", "А", "В"]);
    expect(orderRegistry(rows, "name").map((r) => r.id)).toEqual(["А", "Б", "В"]);
  });

  test("старшая ступень впереди встроенной; без ступени — своя роль учреждения", () => {
    const head = row("h", { account: account({ roles: [{ code: "psychologist", title: "Психолог" }, { code: "head", title: "Завідувач" }] }) });
    expect(mainRole(head)?.code).toBe("head");
    const intern = row("i", { account: account({ roles: [{ code: "psychologist", title: "Психолог" }, { code: "intern", title: "Стажист" }] }) });
    expect(mainRole(intern)?.code).toBe("intern");
    const plain = row("p", { account: account({ roles: [{ code: "psychologist", title: "Психолог" }] }) });
    expect(mainRole(plain)?.code).toBe("psychologist");
  });

  test("ступени из учётной записи делают человека администратором без поштучных запросов", () => {
    expect(isAdministrator({ role: "admin", ladder: ["psychologist", "head"] })).toBe(true);
    expect(isAdministrator({ role: "admin", ladder: ["specialist"] })).toBe(false);
    const counts = ladderCounts([row("s", { role: "superadmin" }), row("a", { account: account({ ladderRank: 2 }) }), row("b", { account: account({ ladderRank: 2 }) })]);
    expect(counts.get(-1)).toBe(1);
    expect(counts.get(2)).toBe(2);
  });
});

describe("текст согласия", () => {
  test("сравнение по словам: вставка и удаление, абзацы не слипаются", () => {
    const pieces = wordDiff("строк 5 років\nдалі", "строк 10 років\nдалі");
    expect(pieces.filter((p) => p.kind === "del").map((p) => p.text.trim())).toEqual(["5"]);
    expect(pieces.filter((p) => p.kind === "ins").map((p) => p.text.trim())).toEqual(["10"]);
    expect(pieces.map((p) => p.text).join("")).toContain("\n");
  });

  test("«що зміниться» — новые и ушедшие абзацы", () => {
    expect(paragraphChanges("А\n\nБ", "А\n\nВ")).toEqual([
      { kind: "add", text: "В" },
      { kind: "remove", text: "Б" },
    ]);
    expect(paragraphChanges("А", "А")).toEqual([]);
  });
});

describe("описание API", () => {
  const op = (access: string, permission: string | null, summary = "") => ({
    summary,
    description: "",
    tags: ["users"],
    security: [],
    "x-access": access as never,
    "x-permission": permission,
  });
  const spec = {
    paths: {
      "/api/users": { get: op("superadmin", "users.manage", "Учётные записи"), post: op("superadmin", "users.manage") },
      "/api/users/{id}/role": { patch: op("superadmin", "users.manage") },
      "/health": { get: { ...op("public", null), tags: ["health"] } },
    },
  };

  test("разделы по первому тегу, внутри — путь и порядок методов", () => {
    const tags = byTag(spec, "root");
    expect([...tags.keys()].sort()).toEqual(["health", "users"]);
    expect(tags.get("users")!.map((r) => r.method)).toEqual(["get", "post", "patch"]);
  });

  test("PUT и PATCH — одной пилюлей; доступ и текст отбирают", () => {
    const routes = byTag(spec, "root").get("users")!;
    expect(routes.filter((r) => routeMatches(r, { method: "put", access: "all", q: "" })).map((r) => r.method)).toEqual(["patch"]);
    expect(routes.filter((r) => routeMatches(r, { method: "all", access: "public", q: "" }))).toHaveLength(0);
    expect(routes.filter((r) => routeMatches(r, { method: "all", access: "all", q: "учётные" }))).toHaveLength(1);
    expect(routes.filter((r) => routeMatches(r, { method: "all", access: "all", q: "users.manage" }))).toHaveLength(3);
  });
});

describe("консоль", () => {
  const commands = [
    { name: "catalog", usage: "catalog list|install" },
    { name: "cases", usage: "cases" },
    { name: "help", usage: "help" },
  ];
  test("дополнение по имени и началу вызова; пустая строка — ничего", () => {
    expect(completions(commands, "ca").map((c) => c.name)).toEqual(["catalog", "cases"]);
    expect(completions(commands, "cat").map((c) => c.name)).toEqual(["catalog"]);
    expect(completions(commands, "catalog in").map((c) => c.name)).toEqual(["catalog"]);
    expect(completions(commands, "")).toEqual([]);
  });

  /*
   * Строка команды несёт аргументы — `user find ivan@…` ищет и пациентов.
   * Недавние живут во вкладке и под ключом учётной записи: следующий за общим
   * ноутбуком их не получает ни после выхода, ни после закрытия вкладки.
   */
  test("недавние — под ключом учётной записи: другой человек в той же вкладке их не видит", () => {
    const box = new Map<string, string>();
    const store = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) };
    saveRecent(store, "u1", ["user find ivan.petrenko@mail.test", "help"]);
    expect(readRecent(store, "u1")).toEqual(["user find ivan.petrenko@mail.test", "help"]);
    expect(readRecent(store, "u2")).toEqual([]);
    expect([...box.keys()]).toEqual([recentKey("u1")]);
    /* без учётной записи и без хранилища — ни записи, ни чтения */
    saveRecent(store, "", ["stats"]);
    expect(box.size).toBe(1);
    expect(readRecent(null, "u1")).toEqual([]);
  });

  test("недавние команды — в хранилище вкладки, не в localStorage", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Console.tsx"), "utf8");
    expect(src).toContain("sessionStorage");
    expect(src).not.toMatch(/localStorage\.(getItem|setItem)/);
  });
});

describe("права", () => {
  test("колонки: встроенная, лестница снизу вверх, потом роли учреждения", () => {
    const role = (code: string, isBuiltin = false) => ({ id: code, code, title: { uk: code, ru: code }, isBuiltin, permissions: [], people: 0, assignable: true });
    expect(roleOrder([role("chief"), role("intern"), role("psychologist", true), role("specialist"), role("head")]).map((r) => r.code)).toEqual([
      "psychologist",
      "specialist",
      "head",
      "chief",
      "intern",
    ]);
  });

  test("черновик набора: что добавлено и что убрано", () => {
    expect(draftDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });
});

describe("подписи", () => {
  test("формы числа по-украински и по-английски", () => {
    const t = "{n} лікар|{n} лікарі|{n} лікарів|{n} лікаря";
    expect(plural(t, 1, "uk")).toBe("1 лікар");
    expect(plural(t, 3, "uk")).toBe("3 лікарі");
    expect(plural(t, 18, "uk")).toBe("18 лікарів");
    expect(plural("{n} clinician|{n} clinicians", 2, "en")).toBe("2 clinicians");
  });

  test("короткое имя и момент «сьогодні, 09:12»", () => {
    expect(shortName("Коваль Марта Ярославівна")).toBe("Коваль М. Я.");
    const ut = (k: string) => (k === "adm2.today" ? "сьогодні" : "учора");
    const now = new Date(2026, 9, 18, 17, 0);
    expect(whenShort(new Date(2026, 9, 18, 9, 12).toISOString(), ut as never, now)).toBe("сьогодні, 09:12");
    expect(whenShort(new Date(2026, 9, 17, 18, 40).toISOString(), ut as never, now)).toBe("учора, 18:40");
    expect(whenShort(new Date(2026, 9, 6, 16, 5).toISOString(), ut as never, now)).toBe("06.10, 16:05");
  });

  test("сила пароля растёт с длиной и разнообразием, правило — 10 знаков у сервера", () => {
    expect(strengthOf("")).toBe(0);
    expect(strengthOf("abc")).toBe(0);
    expect(strengthOf("abcdefghij")).toBe(2);
    expect(strengthOf("Abcdefgh1!")).toBe(3);
    expect(strengthOf("Abcdefgh1!xyzw")).toBe(4);
  });
});
