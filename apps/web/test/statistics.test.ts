import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StatCell, StatModel, StatModelColumn } from "@quizzy/shared";
import {
  HIDDEN_MARK,
  addSample,
  cellText,
  cleanFilters,
  columnsChanged,
  columnsFromDraft,
  criteriaOf,
  criterionValue,
  describeSample,
  diffText,
  emptyStructure,
  filterErrors,
  newBandRow,
  sameFilters,
  structureFromModel,
  validateStructure,
  withSpare,
  withoutCriteria,
} from "../src/pages/statistics/model";
import { TOP } from "../src/shell/Topbar";

/**
 * Раздел «Статистика»: что экран печатает и куда ведёт.
 *
 * Главное здесь — граница печати. Сервер прячет ячейку, когда вместе с
 * соседними числами она называет людей (lib/privacy.ts), и присылает её
 * без числа. Экран обязан довезти это до человека прочерком — и не
 * «досчитать» скрытое сам: разность двух колонок, в которой одна ячейка
 * скрыта, — это скрытое, выписанное через показанное. Обе ошибки тихие:
 * экран выглядит нормально, а утечка — ровно та, против которой написан
 * решатель на сервере.
 *
 * Каждая проверка снималась мутацией; мутации записаны у проверок.
 */

const shown = (percent: number, count = 10): StatCell => ({ suppressed: false, count, percent });
const hidden: StatCell = { suppressed: true };

describe("печать ячеек отчёта", () => {
  /*
   * Мутация: `if (cell.suppressed) return HIDDEN_MARK` убрать — скрытая
   * ячейка с числом рядом (сервер однажды пришлёт) печатается числом, и
   * проверка называет его.
   */
  test("скрытая ячейка — прочерк, даже если рядом с пометкой оказалось число", () => {
    expect(cellText(hidden)).toBe(HIDDEN_MARK);
    const leaky = { suppressed: true, count: 3, percent: 12 } as unknown as StatCell;
    expect(cellText(leaky), "скрытое число доехало до экрана").toBe(HIDDEN_MARK);
    expect(cellText(shown(42))).toBe("42%");
    expect(cellText(null), "до расчёта поле пустое, а не «0%»").toBe("");
  });

  /*
   * Мутация: считать разность и при скрытой ячейке (брать percent ?? 0) —
   * «+30» против скрытой называет скрытое, и проверка падает на нём.
   */
  test("разность колонок печатается только между двумя показанными", () => {
    expect(diffText(shown(30), shown(42))).toBe("+12");
    expect(diffText(shown(42), shown(30))).toBe("−12");
    expect(diffText(shown(30), shown(30))).toBe("0");
    expect(diffText(shown(30), hidden), "разность с правой скрытой").toBe("");
    expect(diffText(hidden, shown(30)), "разность с левой скрытой").toBe("");
    const leaky = { suppressed: true, count: 3, percent: 12 } as unknown as StatCell;
    expect(diffText(shown(30), leaky), "разность через число скрытой ячейки").toBe("");
    expect(diffText(undefined, shown(1))).toBe("");
  });
});

describe("навигация раздела", () => {
  /* Мутация: вернуть пункту «/cohorts» — падает с именем пункта */
  test("пункт «Статистика» верхней полосы ведёт в раздел, а не на подбор людей", () => {
    expect(TOP.find((it) => it.key === "top.statistics")?.to).toBe("/statistics");
  });

  test("все экраны раздела объявлены маршрутами", () => {
    const app = readFileSync(resolve(import.meta.dir, "../src/App.tsx"), "utf8");
    const declared = new Set([...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));
    for (const path of [
      "/statistics",
      "/statistics/new",
      "/statistics/chart",
      "/statistics/filters",
      "/statistics/filters/:id",
      "/statistics/:id",
      "/statistics/:id/edit",
    ]) {
      expect(declared.has(path), `нет маршрута ${path}`).toBe(true);
    }
  });
});

describe("строки-критерии выборки", () => {
  test("пустые значения — не критерии", () => {
    expect(cleanFilters({ sex: "male", locality: "  ", ageMin: null, from: "" })).toEqual({ sex: "male" });
    expect(sameFilters({ sex: "male", locality: "" }, { sex: "male" })).toBe(true);
    expect(sameFilters({ sex: "male" }, { sex: "female" })).toBe(false);
  });

  test("строка «Вік» — одна на обе границы, «Дата» — на оба конца, порядок — кадра", () => {
    expect(criteriaOf({ locality: "Київ", ageMax: 45, sex: "male", to: "2026-09-30" })).toEqual([
      "date",
      "age",
      "sex",
      "locality",
    ]);
    expect(withoutCriteria({ ageMin: 25, ageMax: 45, sex: "male" }, ["age"])).toEqual({ sex: "male" });
    expect(withoutCriteria({ from: "2026-01-01", to: "2026-02-01" }, ["date"])).toEqual({});
  });

  /*
   * Решение заказчика 2026-09-26: адекватные фильтры. Мутация: сравнивать
   * границы строками («100» < «25») — «від 100 до 25» проходит молча.
   */
  test("перевёрнутый диапазон называется до запроса", () => {
    expect(filterErrors({ ageMin: 100, ageMax: 25 })).toEqual(["coh.errAge"]);
    expect(filterErrors({ from: "2026-09-30", to: "2026-09-01" })).toEqual(["coh.errPeriod"]);
    expect(filterErrors({ ageMin: 25, ageMax: 25, from: "2026-09-01", to: "2026-09-01" })).toEqual([]);
  });

  test("чип несёт значение, а группа и человек — только имя критерия", () => {
    const t = (k: string) =>
      ({ "nm.menCap": "Чоловіки", "coh.fromWord": "від", "coh.ageTo": "до" })[k] ?? k;
    const f = { sex: "male" as const, ageMin: 25, from: "2026-09-01", to: "2026-09-30", patientGroupId: "g1", patientId: "p1" };
    expect(criterionValue("sex", f, t as never)).toBe("Чоловіки");
    expect(criterionValue("age", f, t as never)).toBe("від 25");
    expect(criterionValue("date", f, t as never)).toBe("01.09.2026 – 30.09.2026");
    expect(criterionValue("group", f, t as never), "имя группы в чипе читают через плечо").toBe("");
    expect(criterionValue("patient", f, t as never)).toBe("");
  });

  test("выборка словами — для легенды диаграммы", () => {
    const t = (k: string) => ({ "nm.menCap": "Чоловіки", "st.ageWord": "вік", "st.everyone": "Усі" })[k] ?? k;
    expect(describeSample({ sex: "male", ageMin: 25, ageMax: 30 }, t as never)).toBe("Чоловіки, вік 25–30");
    expect(describeSample({}, t as never)).toBe("Усі");
  });
});

const column = (over: Partial<StatModelColumn> = {}): StatModelColumn => ({
  title: "Київ",
  presetId: null,
  filters: { locality: "Київ" },
  surveyId: "s1",
  versionId: "v1",
  bands: [{ scaleId: "sc", bandId: "b1", highRisk: true }],
  questions: [{ questionId: "q1", options: [{ optionId: "o1", highRisk: false }, { optionId: "o2", highRisk: true }] }],
  ...over,
});

describe("структура модели (форма f17)", () => {
  test("правка кладёт структуру на каждую колонку и не трогает выборки", () => {
    const cols = [column(), column({ title: null, presetId: "p1", filters: null })];
    const model: StatModel = {
      id: "m",
      title: "Сон",
      description: null,
      ownerId: "u",
      columns: cols,
      createdAt: "",
      updatedAt: "",
    };
    const draft = structureFromModel(model);
    const out = columnsFromDraft(draft, cols);
    expect(out).toHaveLength(2);
    expect(out[0]!.filters).toEqual({ locality: "Київ" });
    expect(out[1]!.presetId).toBe("p1");
    expect(out[1]!.filters).toBeNull();
    /* тот же тест — версия колонки остаётся: полосы принадлежат ей */
    expect(out[0]!.versionId).toBe("v1");
    /* пометка «ВШР» полосы на форме не рисуется, но не теряется */
    expect(out[0]!.bands).toEqual(cols[0]!.bands);
    expect(out[0]!.questions).toEqual(cols[0]!.questions);

    /* другой тест — версию берёт сервер, старая сюда не годится */
    const moved = columnsFromDraft({ ...draft, surveyId: "s2", bands: [], questions: [] }, cols);
    expect(moved[0]!.versionId).toBeNull();
  });

  test("новая модель — одна выборка без фильтров, пустые строки не едут", () => {
    const draft = { ...emptyStructure(), title: "Нова", surveyId: "s1", bands: [newBandRow("sc:b1"), newBandRow()] };
    const out = columnsFromDraft(draft, null);
    expect(out).toEqual([
      {
        title: null,
        presetId: null,
        filters: {},
        surveyId: "s1",
        bands: [{ scaleId: "sc", bandId: "b1", highRisk: false }],
        questions: [],
      },
    ]);
  });

  test("без названия, теста или показателей форма не сохраняется", () => {
    expect(validateStructure(emptyStructure())).toEqual(["st.errTitle", "st.errSurvey"]);
    expect(validateStructure({ ...emptyStructure(), title: "Т", surveyId: "s1" })).toEqual(["st.errIndicators"]);
  });

  test("строк в группе — выбранные и одна пустая, не меньше двух", () => {
    const empty = (r: { v: string }) => !r.v;
    const make = () => ({ v: "" });
    expect(withSpare([{ v: "" }], empty, make)).toHaveLength(2);
    expect(withSpare([{ v: "a" }, { v: "b" }], empty, make).map((r) => r.v)).toEqual(["a", "b", ""]);
    expect(withSpare([{ v: "" }, { v: "a" }, { v: "" }], empty, make).map((r) => r.v)).toEqual(["a", ""]);
  });
});

describe("выборки рядом (f29)", () => {
  test("«+» добавляет выборку с теми же показателями и пустыми фильтрами", () => {
    const next = addSample([column({ presetId: "p1", filters: null })]);
    expect(next).toHaveLength(2);
    expect(next[1]!.filters).toEqual({});
    expect(next[1]!.presetId).toBeNull();
    expect(next[1]!.questions).toEqual(next[0]!.questions);
    expect(columnsChanged([column()], next)).toBe(true);
    expect(columnsChanged([column()], [column({ filters: { locality: "Київ", ageMin: null } })])).toBe(false);
  });
});

/**
 * Номера кадров в докблоках раздела — только свои (и двойник f10 из
 * «Аналітики», чья сетка перечня повторена один в один).
 *
 * Та же мысль, что у frameRefs.test.ts, но своим списком: общий сторож
 * правят параллельно другие разделы, а перепутанный номер здесь увёл бы
 * следующую сверку по чужому кадру.
 *
 * Мутация: вписать в комментарий List.tsx «f05» — падает с именем файла.
 */
describe("номера кадров в докблоках раздела", () => {
  const OWN = new Set(["f08", "f09", "f17", "f18", "f23", "f24", "f29", "f10"]);
  const dir = resolve(import.meta.dir, "../src/pages/statistics");
  for (const file of readdirSync(dir)) {
    test(`${file}: только кадры статистики`, () => {
      const text = readFileSync(join(dir, file), "utf8");
      const wrong = [...text.matchAll(/\bf(\d\d)(?:_\d)?\b/g)].map((m) => `f${m[1]}`).filter((f) => !OWN.has(f));
      expect([...new Set(wrong)], `чужие кадры в ${file}`).toEqual([]);
    });
  }
});
