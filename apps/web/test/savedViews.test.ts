import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI, type UiKey } from "@quizzy/shared";
import type { SavedView } from "../src/api";
import { PATIENT_VIEW_KEYS, viewMenu } from "../src/pages/patientGroups/views";
import { activeView, viewParams, viewSearch } from "../src/ui/viewParams";

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
