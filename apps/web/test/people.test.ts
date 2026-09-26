import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Permission, User } from "@quizzy/shared";
import { type DirectorySource, loadDirectory, loadMember } from "../src/pages/people/data";
import { TOP, barItems, barKind, barSection, isCurrentTop } from "../src/shell/Topbar";
import {
  type StaffRow,
  birthYear,
  cardTitleRole,
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

/**
 * Откуда берётся справочник — и когда за ним не ходят вовсе.
 *
 * Два решения, которые глазами не проверяются: оба маршрута отвечают
 * одинаковым списком. Первое — маршрут выбирается по праву ДО запроса:
 * проба реестра с откатом по отказу писала бы access.denied в журнал
 * доступа на каждом заходе заведующего, и экран «Журнал» считал бы его
 * работу в красный счётчик «Відмов». Второе — карточка коллеги берётся из
 * ответа списка, а не качает реестр заново: реестр — это вся таблица users
 * с расшифрованными ФИО пациентов и запись user.list в журнале.
 */
describe("справочник сотрудников", () => {
  const person = (id: string, role: User["role"], fullName: string): User =>
    ({ id, role, fullName, firstName: "", lastName: "", middleName: null, email: `${id}@x.y`, sex: null, birthDate: null, specialty: null, unit: null }) as User;

  const fake = () => {
    const calls = { users: 0, staff: 0, me: 0 };
    const src: DirectorySource & { me: () => Promise<User> } = {
      users: async () => {
        calls.users++;
        return [person("u1", "admin", "Іванов"), person("u2", "admin", "Петренко"), person("p1", "user", "Пацієнт")];
      },
      assignableStaff: async () => {
        calls.staff++;
        return [{ id: "u2", email: "u2@x.y", role: "admin", fullName: "Петренко" }];
      },
      me: async () => {
        calls.me++;
        return person("u1", "admin", "Іванов");
      },
    };
    return { calls, src };
  };

  test("без права на реестр — только «кого я вправе назначать», реестр не пробуется", async () => {
    const { calls, src } = fake();
    const dir = await loadDirectory({ id: "head-1", canManageUsers: false }, src);
    expect(calls).toEqual({ users: 0, staff: 1, me: 0 });
    expect(dir.partial).toBe(true);
  });

  test("с правом — реестр, без пациентов, и второй маршрут не трогается", async () => {
    const { calls, src } = fake();
    const dir = await loadDirectory({ id: "super-1", canManageUsers: true }, src);
    expect(calls).toEqual({ users: 1, staff: 0, me: 0 });
    expect(dir.partial).toBe(false);
    expect(dir.rows.map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  test("карточка коллеги после списка — из его ответа, реестр не качается второй раз", async () => {
    const { calls, src } = fake();
    const viewer = { id: "super-2", canManageUsers: true };
    await loadDirectory(viewer, src);
    const { row } = await loadMember("u2", viewer, src);
    expect(row?.fullName).toBe("Петренко");
    expect(calls.users).toBe(1);
  });

  test("кого в списке не было — справочник читается ещё раз, но один", async () => {
    const { calls, src } = fake();
    const viewer = { id: "super-3", canManageUsers: true };
    await loadDirectory(viewer, src);
    expect((await loadMember("nobody", viewer, src)).row).toBeNull();
    expect(calls.users).toBe(2);
  });

  test("чужой кеш не достаётся другому смотрящему: вошёл заведующий — свой ответ", async () => {
    const { calls, src } = fake();
    await loadDirectory({ id: "super-4", canManageUsers: true }, src);
    const { row } = await loadMember("u2", { id: "head-4", canManageUsers: false }, src);
    expect(row?.fullName).toBe("Петренко");
    expect(calls).toEqual({ users: 1, staff: 1, me: 0 });
  });

  test("своя карточка — из профиля, справочник не нужен", async () => {
    const { calls, src } = fake();
    const { row } = await loadMember("u1", { id: "u1", canManageUsers: false }, src);
    expect(row?.fullName).toBe("Іванов");
    expect(calls).toEqual({ users: 0, staff: 0, me: 1 });
  });
});

/**
 * Рабочее место: четыре вида, и выбирает их раздел экрана вместе с тем,
 * лечит ли вошедший. От него зависит карточка человека (что под ней, чем
 * подписана); на состав полосы с 2026-09-26 оно не влияет — см. ниже.
 *
 * Проверяется здесь, потому что оба прежних правила были догадками, которые
 * на экране видны только тому, кто открыл нужный раздел нужной учётной
 * записью: «ступень 3 и выше — чистый администратор» уносила у главного
 * лікаря шесть клинических разделов, а «суперадмін — всегда
 * «Адміністратори»» подписывала его так же и в разделе организаций, где
 * кадры f44/f45/f51/f52 рисуют «Лікарі».
 */
describe("рабочее место", () => {
  const superadmin = { role: "superadmin" };
  const head = { role: "admin", ladderRank: 2 };
  const chief = { role: "admin", ladderRank: 3 };
  const specialist = { role: "admin", ladderRank: 1 };

  test("суперадмін: раздел людей — «Адміністратори», организации — «Лікарі» (f47–f50 против f44/f45/f51/f52)", () => {
    expect(barKind(superadmin, true, "/admins")).toBe("peopleAdmins");
    expect(barKind(superadmin, true, "/staff/u1")).toBe("peopleAdmins");
    expect(barKind(superadmin, true, "/organisations")).toBe("peopleStaff");
    expect(barKind(superadmin, true, "/organisations/o1")).toBe("peopleStaff");
  });

  test("суперадмін вне этих разделов кадра не имеет — полоса не урезается", () => {
    expect(barKind(superadmin, true, "/patients")).toBe("admin");
  });

  test("ступень лестницы сама по себе полосу не режет: главный лікар лечит (f30–f35)", () => {
    expect(barKind(chief, true, "/staff/u1")).toBe("admin");
    expect(barKind(head, true, "/staff")).toBe("admin");
  });

  test("узкая полоса — у того, кто ведёт людей и не лечит, и только в разделе людей (f40–f43)", () => {
    expect(barKind(chief, false, "/staff")).toBe("peopleStaff");
    expect(barKind(chief, false, "/patients")).toBe("admin");
  });

  test("рядовой лікар — шесть пунктов везде (f04)", () => {
    expect(barKind(specialist, true, "/staff/u1")).toBe("specialist");
    expect(barKind(specialist, true, "/patients")).toBe("specialist");
  });

  test("раздел считается по корню адреса, а не по вхождению строки", () => {
    expect(barSection("/staff")).toBe("people");
    expect(barSection("/staff/u1/groups")).toBe("people");
    expect(barSection("/admins/new")).toBe("people");
    expect(barSection("/patients/staff")).toBe("other");
  });
});

/**
 * Состав полосы — решение заказчика 2026-09-26: «на вкладке админов
 * пропадают другие кнопки, доделай бар получше».
 *
 * Кадры f40–f50 рисуют в разделе людей полосу из одного пункта, и она такой
 * и была: суперадмін, зайдя к администраторам, терял шесть разделов. Теперь
 * полоса — свойство человека, а не раздела, и проверяется это по обоим
 * адресам раздела людей сразу, а не по одному: пункт, пропавший только на
 * /admins, прежде и был той самой поломкой.
 */
describe("состав полосы", () => {
  const superadmin = { role: "superadmin" };
  const chief = { role: "admin", ladderRank: 3 };
  const keysOf = (kind: Parameters<typeof barItems>[0], can?: (p: Permission) => boolean): string[] =>
    barItems(kind, can).map((it) => it.key);
  const FULL = ["top.patients", "ppl.staff", "top.groups", "top.tests", "top.analytics", "top.statistics", "top.messages"];

  test("суперадміну — одна полная полоса на всех адресах, и в разделе людей тоже", () => {
    for (const path of ["/patients", "/staff", "/staff/u1", "/admins", "/admins/new", "/organisations"]) {
      expect(keysOf(barKind(superadmin, true, path), () => true), path).toEqual(FULL);
    }
  });

  test("«Лікарі» — текущий пункт и на /staff, и на /admins: раздел людей один", () => {
    const staff = barItems("admin").find((it) => it.key === "ppl.staff")!;
    for (const path of ["/staff", "/staff/u1", "/admins", "/admins/new"]) {
      expect(isCurrentTop(staff, path), path).toBe(true);
    }
    expect(isCurrentTop(staff, "/patients/staff")).toBe(false);
    expect(isCurrentTop(staff, "/adminsx")).toBe(false);
    /* и отдельного пункта «Адміністратори» в полосе нет ни у кого */
    for (const kind of ["specialist", "admin", "peopleStaff", "peopleAdmins"] as const) {
      expect(keysOf(kind)).not.toContain("adm.admins");
    }
  });

  test("заведующему, который лечит, — те же семь, что суперадміну, в любом разделе (f30–f35)", () => {
    const can = (p: Permission) => p === "patients.read";
    for (const path of ["/patients", "/staff", "/admins"]) {
      expect(keysOf(barKind(chief, true, path), can), path).toEqual(FULL);
    }
  });

  test("тот, кто не лечит, — не «один пункт по центру», а все доступные ему разделы, одинаково везде", () => {
    /* право на статистику есть, на аналитику и рассылки — нет */
    const can = (p: Permission) => p === "statistics.read" || p === "users.manage";
    const inside = keysOf(barKind(chief, false, "/staff"), can);
    const outside = keysOf(barKind(chief, false, "/patients"), can);
    expect(inside).toEqual(["ppl.staff", "top.tests", "top.statistics"]);
    /* полоса не прыгает при переходе в раздел людей и обратно */
    expect(outside).toEqual(inside);
    /* клинических пунктов у него нет: они вели бы в отказ сервера */
    expect(inside).not.toContain("top.patients");
    expect(inside).not.toContain("top.groups");
  });

  test("рядовому лікарю — шесть пунктов без «Лікарі» (f04), права полосу не режут", () => {
    const specialist = { role: "admin", ladderRank: 1 };
    expect(keysOf(barKind(specialist, true, "/patients"), () => false)).toEqual(TOP.map((it) => it.key));
  });
});

/**
 * Чем подписана карточка. Восемь кадров одной карточки, и подмена имени
 * ролью (или наоборот) глазами ловится только случайно — отсюда проверка.
 */
describe("заголовок карточки", () => {
  test("общая консоль: своя — «Лікар», чужая — имя (f04, f30 против f31, f34, f35)", () => {
    expect(cardTitleRole("specialist", true)).toBe("ppl.roleDoctor");
    expect(cardTitleRole("admin", true)).toBe("ppl.roleDoctor");
    expect(cardTitleRole("admin", false)).toBeNull();
  });

  test("раздел людей: слово роли и в своей, и в чужой (f40, f43, f47, f50)", () => {
    expect(cardTitleRole("peopleStaff", true)).toBe("ppl.roleAdmin");
    expect(cardTitleRole("peopleStaff", false)).toBe("ppl.roleDoctor");
    expect(cardTitleRole("peopleAdmins", true)).toBe("ppl.roleSuperTitle");
    expect(cardTitleRole("peopleAdmins", false)).toBe("ppl.roleAdmin");
  });
});

/**
 * То, что живёт в разметке и проверяется по исходнику: числа замеров и
 * ссылки, которые легко потерять при следующей правке, а на экране заметить
 * можно только открыв нужный кадр нужной учётной записью.
 */
describe("разметка раздела по кадрам", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dir, "../src", f), "utf8");

  test("дверь в разделы своей карточки не потеряна: заголовок секции ведёт в раздел (f04)", () => {
    expect(src("pages/people/StaffCard.tsx")).toContain("`/staff/${row.id}/patients`");
  });

  test("линии списка на f50 — внутренней тенью: рамка сбивала шаг строк 58 на 60", () => {
    const card = src("pages/people/StaffCard.tsx");
    expect(card).toContain("shadow-[inset_0_-2px_0_var(--hairline)]");
    expect(card).not.toContain("border-b-2");
  });

  test("текущий пункт полосы не подсвечен ничем, кроме aria-current (восемь кадров из десяти)", () => {
    const bar = src("shell/Topbar.tsx");
    /* только сама полоса: в списке бургера подсветка текущего пункта своя и со своих кадров */
    const nav = bar.slice(bar.indexOf('aria-label={ut("shell.sections")}'), bar.indexOf("</nav>"));
    expect(nav.length).toBeGreaterThan(200);
    expect(nav).not.toContain("isActive");
    /* сам бледный тон кадра назван в пояснении — ищем его как класс, а не как слово */
    expect(nav).not.toContain("text-[#ab8fcc]");
  });

  test("верхний просвет: общий 50 (f05/f06), 40 просит раздел людей (f42/f49)", () => {
    expect(src("ui/layout.tsx")).toContain("topGap = 50");
    for (const f of ["pages/people/StaffList.tsx", "pages/people/StaffCard.tsx", "pages/people/StaffNew.tsx"]) {
      expect(src(f), `нет topGap={40} в ${f}`).toContain("topGap={40}");
    }
  });
});
