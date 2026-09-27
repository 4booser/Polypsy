import { describe, expect, test } from "bun:test";
import { type StatModelColumn, statModelListQuery } from "@quizzy/shared";
import {
  ageFromInput,
  patchFilters,
  pickedModel,
  presetProblem,
  statListQuery,
  withColumnFilters,
} from "../src/pages/statistics/model";

/**
 * «Статистика»: поведение отбора — адрес перечня и экрана диаграммы,
 * правка фильтров выборки и формы пресета (w13:uitests).
 *
 * Соседний statistics.test.ts закрепляет строки-критерии и печать ячеек.
 * Здесь — то, что происходит между нажатием и запросом: какая модель
 * откроется по ссылке, что уйдёт на сервер со страницы из закладки, во что
 * превращается выборка с пресетом, когда её правят.
 */

describe("адрес перечня моделей (f08)", () => {
  test("страница и поиск превращаются в смещение и текст запроса", () => {
    expect(statListQuery(" тривога ", 3, 20)).toEqual({ q: "тривога", limit: 20, offset: 40 });
  });

  test("страница из закладки за пределом сервера — не отказ на весь перечень", () => {
    /*
     * До правки смещение считалось как есть: «?page=999999» при 10 на
     * странице — 9 999 980, сервер (offset ≤ 1 000 000) отвечал 400, и
     * экран не узнавал числа моделей, чтобы вернуть на последнюю страницу.
     */
    for (const [page, per] of [
      [999_999, 10],
      [1_000_000_000, 100],
    ] as const) {
      const q = statListQuery("", page, per);
      const verdict = statModelListQuery.safeParse({ q: q.q, limit: String(q.limit), offset: String(q.offset) });
      expect(verdict.success, `page=${page}`).toBe(true);
    }
  });

  test("поиск длиннее предела обрезается", () => {
    expect(statListQuery("а".repeat(300), 1, 10).q.length).toBe(200);
  });
});

describe("модель на экране «Статистика» (f24)", () => {
  const list = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];

  test("модель из адреса открывается, если человеку она видна", () => {
    expect(pickedModel("m2", list)).toBe("m2");
  });

  test("чужая, удалённая или пустая модель в адресе — первая модель, а не пустой экран", () => {
    /*
     * До правки такой адрес просил модель у сервера, получал отказ и молчал
     * о нём: ни строк выборок, ни подсветки, погашенное «Оновити».
     */
    expect(pickedModel("deleted", list)).toBe("m1");
    expect(pickedModel("", list)).toBe("m1");
    expect(pickedModel("   ", list)).toBe("m1");
    expect(pickedModel(null, list)).toBe("m1");
  });

  test("моделей нет — выбирать нечего", () => {
    expect(pickedModel("m1", [])).toBeNull();
  });

  test("пока перечень едет, модель из адреса грузится сразу", () => {
    expect(pickedModel("m2", null)).toBe("m2");
    expect(pickedModel(null, null)).toBeNull();
  });
});

describe("правка фильтров выборки (f09/f29)", () => {
  const column = (over: Partial<StatModelColumn> = {}): StatModelColumn =>
    ({
      title: null,
      presetId: null,
      filters: {},
      surveyId: "s1",
      versionId: "v1",
      bands: [],
      questions: [],
      ...over,
    }) as StatModelColumn;
  const presets: Record<string, { sex: "male"; ageMin: number; locality: string }> = {
    p1: { sex: "male", ageMin: 25, locality: "Київ" },
  };
  const criteria = (id: string) => presets[id];

  test("выборка с пресетом становится своей — начиная с критериев пресета, а не с пустого места", () => {
    const [next] = withColumnFilters([column({ presetId: "p1", filters: null })], 0, { ageMax: 45 }, criteria);
    expect(next!.presetId).toBeNull();
    expect(next!.filters).toEqual({ sex: "male", ageMin: 25, ageMax: 45, locality: "Київ" });
  });

  test("пустое значение снимает критерий, прочие выборки не трогаются", () => {
    const cols = [column({ filters: { sex: "female", locality: "Львів" } }), column({ filters: { sex: "male" } })];
    const next = withColumnFilters(cols, 0, { locality: "" }, criteria);
    expect(next[0]!.filters).toEqual({ sex: "female" });
    expect(next[1]).toBe(cols[1]!);
  });

  test("пресет, которого уже нет, — пустое начало, а не падение", () => {
    const [next] = withColumnFilters([column({ presetId: "gone", filters: null })], 0, { sex: "female" }, criteria);
    expect(next!.filters).toEqual({ sex: "female" });
  });

  test("возраст из поля: пусто и мусор — «границы нет», прочее — целые годы 0…120", () => {
    expect(ageFromInput("")).toBeNull();
    expect(ageFromInput("  ")).toBeNull();
    expect(ageFromInput("abc")).toBeNull();
    expect(ageFromInput("-3")).toBe(0);
    expect(ageFromInput("150")).toBe(120);
    expect(ageFromInput("25.7")).toBe(25);
    // числовое поле пропускает экспоненту; parseInt читал «1e2» как 1 год
    expect(ageFromInput("1e2")).toBe(100);
  });
});

describe("форма пресета (f23)", () => {
  test("без названия не сохраняется; пробелы — не название", () => {
    expect(presetProblem("", {})).toBe("st.errFilterName");
    expect(presetProblem("   ", { sex: "male" })).toBe("st.errFilterName");
  });

  test("перевёрнутый диапазон называется до запроса", () => {
    expect(presetProblem("Молодь", { ageMin: 45, ageMax: 25 })).toBe("coh.errAge");
    expect(presetProblem("Вересень", { from: "2026-09-30", to: "2026-09-01" })).toBe("coh.errPeriod");
  });

  test("всё верно — сохранять можно", () => {
    expect(presetProblem("Молодь", { ageMin: 18, ageMax: 25 })).toBeNull();
  });

  test("очистка поля снимает критерий из пресета, а не шлёт пустую строку", () => {
    expect(patchFilters({ sex: "male", locality: "Київ" }, { locality: "" })).toEqual({ sex: "male" });
    expect(patchFilters({ ageMin: 25 }, { ageMin: null })).toEqual({});
  });
});
