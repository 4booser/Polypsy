import { describe, expect, test } from "bun:test";
import { UI } from "@quizzy/shared";
import {
  ANY_TEST,
  type SavedModel,
  draftFromRule,
  draftToPayload,
  dropPicked,
  emptyDraft,
  filterModels,
  modelHref,
  newAction,
  newParam,
  pageSlice,
  surveysToLoad,
  validateDraft,
} from "../src/pages/analytics/model";

/**
 * Чистая часть раздела «Аналітика»: поиск и страницы перечня, черновик ↔
 * правило, проверка перед сохранением.
 *
 * Главное здесь — тождество «правило → черновик → правило». Модель на сервере
 * — правило поддержки решений, которое считается на каждой сдаче; открыть
 * его в форме и сохранить, ничего не меняя, обязано дать ту же строку. Если
 * форма теряет хоть одно поле, правило молча меняет поведение, а
 * срабатывания по старой версии становятся необъяснимыми.
 */

const rule = (over: Partial<SavedModel> = {}): SavedModel => ({
  id: "r1",
  title: "Тяжкий ризик",
  version: 3,
  enabled: true,
  note: "пояснення",
  conditions: [
    { kind: "scale", surveyId: "sv1", scaleCode: "D", metric: "normed", op: ">", value: 65.5 },
    { kind: "scale", surveyId: null, scaleCode: "L", metric: "raw", op: "<=", value: 3 },
    { kind: "risk", severity: "severe" },
    { kind: "history", completedAtLeast: 2 },
  ],
  actions: [
    { kind: "advise", text: "Повторити через тиждень" },
    { kind: "notify_duty" },
    { kind: "suggest_survey", surveyId: "sv2" },
    { kind: "suggest_pathway", pathwayId: "pw1" },
  ],
  ...over,
});

describe("перечень", () => {
  const rows = [
    { id: "a", title: "Ризик суїциду", note: null },
    { id: "b", title: "Депресія", note: "за шкалою Бека" },
    { id: "c", title: "Тривога", note: "з урахуванням ризику" },
  ];

  test("поиск — по названию и описанию, без учёта регистра", () => {
    expect(filterModels(rows, "РИЗИК").map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterModels(rows, "бека").map((r) => r.id)).toEqual(["b"]);
  });

  test("пустой запрос — весь список, и это копия, а не тот же массив", () => {
    const all = filterModels(rows, "  ");
    expect(all).toEqual(rows);
    expect(all).not.toBe(rows);
  });

  test("страница за концом списка — пустая, а не ошибка", () => {
    expect(pageSlice(rows, 1, 2).map((r) => r.id)).toEqual(["a", "b"]);
    expect(pageSlice(rows, 2, 2).map((r) => r.id)).toEqual(["c"]);
    expect(pageSlice(rows, 5, 2)).toEqual([]);
  });

  test("адрес модели", () => {
    expect(modelHref("new")).toBe("/analytics/new");
    expect(modelHref("r1")).toBe("/analytics/r1");
  });
});

describe("черновик ↔ правило", () => {
  test("правило → черновик → тело запроса ничего не теряет", () => {
    const r = rule();
    const back = draftToPayload(draftFromRule(r));
    expect(back.title).toBe(r.title);
    expect(back.note).toBe(r.note);
    expect(back.enabled).toBe(r.enabled);
    expect(back.conditions).toEqual(r.conditions);
    expect(back.actions).toEqual(r.actions);
  });

  test("«любой тест» — null на сервере и своё значение в селекте", () => {
    const d = draftFromRule(rule());
    expect(d.params[1]!.surveyId).toBe(ANY_TEST);
    expect(draftToPayload(d).conditions[1]).toMatchObject({ kind: "scale", surveyId: null });
  });

  test("пустое описание уходит как null, а не пустая строка", () => {
    const d = draftFromRule(rule({ note: null }));
    expect(d.note).toBe("");
    expect(draftToPayload(d).note).toBeNull();
  });

  test("пробелы вокруг названия, кода шкалы и текста совета не сохраняются", () => {
    const d = emptyDraft();
    d.title = "  Модель ";
    d.params = [newParam({ surveyId: "sv1", scaleCode: " D ", value: "10" })];
    d.actions = [newAction({ text: " порада " })];
    const p = draftToPayload(d);
    expect(p.title).toBe("Модель");
    expect(p.conditions[0]).toMatchObject({ scaleCode: "D", value: 10 });
    expect(p.actions[0]).toEqual({ kind: "advise", text: "порада" });
  });

  test("новая модель начинается с параметра и действия: пустую сервер не примет", () => {
    const d = emptyDraft();
    expect(d.params).toHaveLength(1);
    expect(d.actions).toHaveLength(1);
    expect(d.enabled).toBe(true);
  });

  test("ключи строк уникальны — по ним удаляют отмеченное", () => {
    const d = draftFromRule(rule());
    const keys = [...d.params, ...d.actions].map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("проверка перед сохранением", () => {
  test("заполненный черновик проходит без замечаний", () => {
    expect(validateDraft(draftFromRule(rule()))).toEqual([]);
  });

  test("каждая причина названа ключом словаря, и ключ в словаре есть", () => {
    const d = emptyDraft();
    d.title = " ";
    d.params = [newParam({ surveyId: "", scaleCode: "", value: "abc" }), newParam({ kind: "history", completedAtLeast: "101" })];
    d.actions = [newAction({ kind: "advise", text: "" }), newAction({ kind: "suggest_survey", surveyId: "" })];
    const errs = validateDraft(d);
    expect(errs).toEqual(["am.errTitle", "am.errTest", "am.errScale", "am.errThreshold", "am.errCount", "am.errAdvise", "am.errSuggest"]);
    for (const k of errs) expect(UI[k]).toBeDefined();
  });

  test("без параметров и без действий — две отдельные причины", () => {
    const d = emptyDraft();
    d.title = "Модель";
    d.params = [];
    d.actions = [];
    expect(validateDraft(d)).toEqual(["am.errNoParams", "am.errNoActions"]);
  });

  test("одна причина не повторяется по числу строк", () => {
    const d = emptyDraft();
    d.title = "Модель";
    d.params = [newParam(), newParam(), newParam()];
    expect(validateDraft(d).filter((k) => k === "am.errTest")).toHaveLength(1);
  });

  test("порог — число: «-», буквы и пустое поле не сохраняются", () => {
    const d = emptyDraft();
    d.title = "Модель";
    d.actions = [newAction({ text: "порада" })];
    for (const value of ["", "-", "x", "1,5"]) {
      d.params = [newParam({ surveyId: "sv1", scaleCode: "D", value })];
      expect(validateDraft(d), `порог «${value}»`).toContain("am.errThreshold");
    }
    d.params = [newParam({ surveyId: "sv1", scaleCode: "D", value: "-2.5" })];
    expect(validateDraft(d)).toEqual([]);
  });
});

describe("отметка и удаление", () => {
  test("удаляются только отмеченные строки, и параметры, и действия", () => {
    const d = draftFromRule(rule());
    d.params[0]!.picked = true;
    d.actions[3]!.picked = true;
    const next = dropPicked(d);
    expect(next.params.map((p) => p.kind)).toEqual(["scale", "risk", "history"]);
    expect(next.actions.map((a) => a.kind)).toEqual(["advise", "notify_duty", "suggest_survey"]);
  });

  test("ничего не отмечено — черновик тот же объект: экрану есть что показать словами", () => {
    const d = draftFromRule(rule());
    expect(dropPicked(d)).toBe(d);
  });
});

describe("какие методики нужны редактору", () => {
  test("только выбранные и настоящие, без повторов, без «любой» и пустых", () => {
    const d = emptyDraft();
    d.params = [
      newParam({ surveyId: "sv1", scaleCode: "D" }),
      newParam({ surveyId: "sv1", scaleCode: "L" }),
      newParam({ surveyId: ANY_TEST, scaleCode: "X" }),
      newParam({ surveyId: "" }),
      newParam({ kind: "risk", surveyId: "sv9" }),
      newParam({ surveyId: "sv2", scaleCode: "A" }),
    ];
    expect(surveysToLoad(d, new Set())).toEqual(["sv1", "sv2"]);
  });

  test("методики из действий — только те, которых нет в списке: остальные уже названы списком", () => {
    const d = emptyDraft();
    d.params = [newParam({ surveyId: "sv1", scaleCode: "D" })];
    d.actions = [
      newAction({ kind: "suggest_survey", surveyId: "sv1" }),
      newAction({ kind: "suggest_survey", surveyId: "sv7" }),
      newAction({ kind: "suggest_survey", surveyId: "sv8" }),
      newAction({ kind: "suggest_survey", surveyId: "" }),
      newAction({ kind: "advise", surveyId: "sv9" }),
    ];
    /* sv1 нужна ради шкал и без того; sv8 есть в списке; sv7 — сирота, её дочитывают ради названия */
    expect(surveysToLoad(d, new Set(["sv1", "sv8"]))).toEqual(["sv1", "sv7"]);
  });
});
