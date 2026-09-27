import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI, type UiKey } from "@quizzy/shared";
import type { SavedView } from "../src/api";
import { PATIENT_VIEW_KEYS, viewMenu } from "../src/pages/patientGroups/views";
import { refilter, toPage, toPer } from "../src/ui/paging";
import { activeView, openView, patchParams, sameParams, viewParams, viewSearch } from "../src/ui/viewParams";

/**
 * Сохранённые виды списка пациентов (волна 12, разбор кода: «редизайн удалил
 * сохранённые виды списка пациентов»).
 *
 * Виды были спрятаны за шестерёнкой строкой старого образца, которая
 * закрывалась при первом же выборе вида на другую группу, а вид хранил
 * номер страницы и переставал узнаваться после листания. Проверяется то,
 * на чём держится работа с видами: что сохраняется, что открывается, какой
 * вид считается открытым и что предлагает меню.
 */

const KEEP = PATIENT_VIEW_KEYS;
const ut = (k: UiKey) => UI[k].uk;

const view = (over: Partial<SavedView>): SavedView => ({
  id: "v1",
  scope: "patients",
  name: "Вечірня група",
  params: "group=g-eve",
  shared: false,
  mine: true,
  ownerName: "Я",
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

describe("вид — это отбор, а не место в списке", () => {
  test("сохраняются группа и поиск, а не страница и не число строк", () => {
    expect(viewParams("?page=3&group=g-eve&per=50&q=%D0%9F%D0%B5%D1%82", KEEP)).toBe("group=g-eve&q=%D0%9F%D0%B5%D1%82");
    expect(viewParams("?page=3&per=50", KEEP)).toBe("");
  });

  test("порядок параметров в адресе не делает вид другим", () => {
    expect(viewParams("q=a&group=b", KEEP)).toBe(viewParams("group=b&q=a", KEEP));
  });

  test("после листания открытый вид узнаётся как открытый", () => {
    const views = [view({})];
    expect(activeView(views, "?group=g-eve", KEEP)?.id).toBe("v1");
    expect(activeView(views, "?group=g-eve&page=4&per=50", KEEP)?.id).toBe("v1");
    expect(activeView(views, "?group=g-eve&q=Іван", KEEP)).toBeUndefined();
  });

  test("вид, сохранённый старой строкой вместе со страницей, тоже узнаётся", () => {
    expect(activeView([view({ params: "group=g-eve&page=3&per=50" })], "?group=g-eve", KEEP)?.id).toBe("v1");
  });
});

describe("открытие вида", () => {
  test("отбор из вида, страница — с первой, размер страницы — за человеком", () => {
    const next = new URLSearchParams(viewSearch("?group=g-day&q=Пет&page=5&per=50", "group=g-eve", KEEP));
    expect(next.get("group")).toBe("g-eve");
    expect(next.get("q")).toBeNull();
    expect(next.get("page")).toBeNull();
    expect(next.get("per")).toBe("50");
  });

  test("старый вид со страницей в параметрах открывается с первой страницы", () => {
    const next = new URLSearchParams(viewSearch("", "group=g-eve&page=3", KEEP));
    expect(next.get("page")).toBeNull();
    expect(next.get("group")).toBe("g-eve");
  });
});

describe("пункты шестерёнки", () => {
  const act = { open: () => {}, save: () => {}, share: () => {}, remove: () => {} };
  const labels = (search: string, views: SavedView[]) =>
    viewMenu(views, search, ut, act).map((e) => `${e.label}${e.disabled ? " [—]" : ""}${e.danger ? " [!]" : ""}`);

  test("без отбора сохранять нечего; виды — пунктами, открытый погашен", () => {
    expect(labels("", [view({})])).toEqual(["Вечірня група", `${ut("views.saveCurrent")} [—]`]);
  });

  test("открытый свой вид можно открыть коллегам и удалить", () => {
    expect(labels("?group=g-eve&page=2", [view({})])).toEqual([
      "Вечірня група [—]",
      ut("views.saveCurrent"),
      ut("views.makeShared"),
      `${ut("views.remove")}: Вечірня група [!]`,
    ]);
  });

  test("чужой общий вид подписан хозяином, и удалить его нельзя", () => {
    const theirs = view({ id: "v2", mine: false, shared: true, ownerName: "Коваль", params: "q=Пет" });
    expect(labels("?q=Пет", [theirs])).toEqual([`Вечірня група · Коваль [—]`, ut("views.saveCurrent")]);
  });

  test("два вида с одним именем различимы для React", () => {
    const entries = viewMenu([view({}), view({ id: "v2", mine: false, ownerName: "Я" })], "", ut, act);
    const keys = entries.map((e) => e.key ?? e.label);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("список пациентов берёт виды в шестерёнку, а не строкой старого образца", () => {
    const screen = readFileSync(resolve(import.meta.dir, "../src/pages/Patients.tsx"), "utf8");
    expect(screen).toContain("...views.entries");
    expect(screen).not.toContain("<SavedViews");
  });
});

describe("виды не загрузились — это не «видов нет»", () => {
  /*
   * Меню брало `views ?? []`: отказ загрузки видов выглядел ровно как
   * «сохранённых видов нет» — человек, у которого их десяток, видел пустое
   * меню и решал, что они пропали, или заводил заново.
   */
  const act = { open: () => {}, save: () => {}, share: () => {}, remove: () => {} };

  test("отказ — пунктом «не завантажилися — повторити», и он повторяет загрузку", () => {
    let retried = 0;
    const entries = viewMenu([], "?group=g-eve", ut, act, { failed: true, retry: () => retried++ });
    const failed = entries.find((e) => e.label === ut("uit.views.loadFailed"));
    expect(failed).toBeDefined();
    failed!.onSelect!();
    expect(retried).toBe(1);
    // сохранить текущий отбор можно и без списка видов
    expect(entries.some((e) => e.label === ut("views.saveCurrent") && !e.disabled)).toBe(true);
  });

  test("загрузилось пустым — пункта об отказе нет", () => {
    const entries = viewMenu([], "", ut, act, { failed: false, retry: () => {} });
    expect(entries.map((e) => e.label)).toEqual([ut("views.saveCurrent")]);
  });

  test("список пациентов и строка видов очереди/направлений различают отказ", () => {
    const menu = readFileSync(resolve(import.meta.dir, "../src/pages/patientGroups/views.tsx"), "utf8");
    expect(menu).toMatch(/failed: loadView\(res\) === "failed"/);
    const strip = readFileSync(resolve(import.meta.dir, "../src/ui/SavedViews.tsx"), "utf8");
    expect(strip).toMatch(/loadView\(res\) === "failed"/);
    expect(strip).toContain('ut("uit.views.loadFailed")');
  });
});

describe("вид и отбор: путь человека по списку пациентов", () => {
  test("открыл вид → искал → вид больше не открыт; очистил поиск → снова открыт", () => {
    const views = [view({})];
    let search = `?${viewSearch("?per=50", "group=g-eve", KEEP)}`;
    expect(activeView(views, search, KEEP)?.id).toBe("v1");
    search = `?${patchParams(search, refilter({ q: "Пет" }))}`;
    expect(activeView(views, search, KEEP)).toBeUndefined();
    search = `?${patchParams(search, refilter({ q: "" }))}`;
    expect(activeView(views, search, KEEP)?.id).toBe("v1");
    // размер страницы, выбранный до вида, пережил и вид, и поиск
    expect(new URLSearchParams(search).get("per")).toBe("50");
  });

  test("«Зберегти відбір» после листания и смены размера сохраняет только отбор", () => {
    const search = `?${patchParams(patchParams("group=g-eve&q=Пет", toPer(20)), toPage(3))}`;
    expect(viewParams(search, KEEP)).toBe("group=g-eve&q=%D0%9F%D0%B5%D1%82");
  });
});

describe("виды очереди случаев и направлений (ui/SavedViews): вид хранит адрес целиком", () => {
  const alerts = (params: string) => view({ scope: "alerts", params });

  test("вид узнаётся открытым при другом порядке параметров", () => {
    /*
     * Порядок параметров — порядок, в котором трогали фильтры. Вид
     * «важкі, на мені», сохранённый одним путём, после сборки другим не
     * узнавался — а удалить вид или открыть его коллегам можно только у
     * открытого.
     */
    const saved = [alerts("severity=severe&assigned=me")];
    expect(openView(saved, "?assigned=me&severity=severe")?.id).toBe("v1");
    expect(sameParams("a=1&b=2", "b=2&a=1")).toBe(true);
  });

  test("пустое значение — всё равно что его нет", () => {
    expect(openView([alerts("severity=severe")], "severity=severe&q=")?.id).toBe("v1");
  });

  test("другой отбор — другой вид: значение, лишний параметр, повтор параметра", () => {
    const saved = [alerts("severity=severe")];
    expect(openView(saved, "severity=moderate")).toBeUndefined();
    expect(openView(saved, "severity=severe&assigned=me")).toBeUndefined();
    expect(sameParams("unit=A&unit=B", "unit=A")).toBe(false);
  });

  test("сортировка таблицы направлений — часть их вида: другая сортировка — другой вид", () => {
    const saved = [view({ scope: "referrals", params: "all=1&referrals.sort=urgency%3Adesc" })];
    expect(openView(saved, "referrals.sort=urgency%3Adesc&all=1")?.id).toBe("v1");
    expect(openView(saved, "all=1&referrals.sort=urgency")).toBeUndefined();
  });

  test("компонент узнаёт открытый вид через openView, а не посимвольным сравнением", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/ui/SavedViews.tsx"), "utf8");
    expect(src).toContain("openView(views, current)");
    expect(src).not.toMatch(/v\.params === current/);
  });
});
