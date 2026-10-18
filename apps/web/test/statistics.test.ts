import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StatCell, StatModel, StatModelColumn, StatRunColumn, SurveyFull } from "@quizzy/shared";
import {
  HIDDEN_MARK,
  MAX_SAMPLES,
  addKeyed,
  addSample,
  applyPreset,
  cellAt,
  cellShare,
  cellText,
  cleanFilters,
  columnsChanged,
  columnsFromDraft,
  criteriaOf,
  criterionValue,
  diffText,
  duplicateKeyed,
  duplicateSample,
  editSampleDraft,
  emptyStructure,
  figureCount,
  filterErrors,
  keepDrafts,
  keyedSamples,
  newBandRow,
  newQuestionBlock,
  removeKeyed,
  removeSample,
  reportRows,
  sameFilters,
  sampleDraft,
  sampleDraftChanged,
  setScaleBands,
  structureFromModel,
  toggleBand,
  toggleOption,
  validateStructure,
  withSampleDraft,
  withoutCriteria,
} from "../src/pages/statistics/model";
import { navAccess, railEntries, subNavFor } from "../src/shell/nav";

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

  /*
   * Мутация: в cellShare брать percent без проверки suppressed — полоса
   * графика у скрытой ячейки встаёт длиной скрытого числа.
   */
  test("полоса графика у скрытой ячейки — пустота, а не длина скрытого числа", () => {
    expect(cellShare(shown(42))).toBe(42);
    const leaky = { suppressed: true, count: 3, percent: 12 } as unknown as StatCell;
    expect(cellShare(leaky), "длина полосы выдала скрытое").toBeNull();
    expect(cellShare(null)).toBeNull();
  });
});

describe("навигация раздела", () => {
  /* Мутация: вернуть пункту «/cohorts» — падает с именем пункта */
  test("«Статистичні моделі» в подразделах аналитики ведут в раздел, а не на подбор людей", () => {
    const all = navAccess({ role: "superadmin" }, () => true);
    const items = subNavFor("analytics", "/statistics", all)!.groups.flatMap((g) => g.items);
    expect(items.find((it) => it.label === "sn.statModels")?.to).toBe("/statistics");
    /* у того, кому открыта только статистика, «Аналітика» на рельсе ведёт прямо в неё */
    const statsOnly = navAccess({ role: "admin", ladderRank: 3 }, (p) => p === "statistics.read");
    expect(railEntries(statsOnly).find((e) => e.key === "analytics")?.to).toBe("/statistics");
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

describe("структура модели (редактор)", () => {
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
    const moved = columnsFromDraft({ ...draft, surveyId: "s2", versionId: null, bands: [], questions: [] }, cols);
    expect(moved[0]!.versionId).toBeNull();
    /* выбранная в редакторе версия ложится на каждую колонку */
    const pinned = columnsFromDraft({ ...draft, versionId: "v2" }, cols);
    expect(pinned.map((c) => c.versionId)).toEqual(["v2", "v2"]);
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

  /*
   * Мутация: в toggleBand не сортировать по порядку методики — «рядок звіту
   * N» в редакторе расходится с местом строки в отчёте.
   */
  test("смуги отмечаются галочками в порядке шкалы, «Усі / Жодної» не трогают соседнюю шкалу", () => {
    const order = ["s1:a", "s1:b", "s1:c", "s2:x"];
    let bands = toggleBand([], "s1:c", order);
    bands = toggleBand(bands, "s1:a", order);
    expect(bands.map((b) => b.value)).toEqual(["s1:a", "s1:c"]);
    expect(toggleBand(bands, "s1:a", order).map((b) => b.value)).toEqual(["s1:c"]);

    const risky = [newBandRow("s1:b", true), newBandRow("s2:x")];
    const all = setScaleBands(risky, ["s1:a", "s1:b", "s1:c"], true, order);
    expect(all.map((b) => b.value)).toEqual(["s1:a", "s1:b", "s1:c", "s2:x"]);
    expect(all.find((b) => b.value === "s1:b")!.highRisk, "«Усі» стёрли пометку «ВШР» отмеченной смуги").toBe(true);
    expect(setScaleBands(all, ["s1:a", "s1:b", "s1:c"], false, order).map((b) => b.value)).toEqual(["s2:x"]);
  });

  test("варианты ответа — галочками в порядке вопроса", () => {
    const order = ["o1", "o2", "o3"];
    const a = toggleOption(toggleOption(newQuestionBlock("q1"), "o3", order), "o1", order);
    expect(a.options.map((o) => o.optionId)).toEqual(["o1", "o3"]);
    expect(toggleOption(a, "o3", order).options.map((o) => o.optionId)).toEqual(["o1"]);
  });

  /*
   * Тот же счёт, что у сервера (MAX_FIGURES_PER_COLUMN): основание, по шкале
   * — смуги и «Решта», по вопросу — варианты и «Решта», «ВШР».
   */
  test("чисел в колонке: основание, смуги с «Рештою», варианты с «Рештою», «ВШР»", () => {
    const col = column();
    // 1 основание + 1 смуга + 1 «Решта» шкалы + 2 варианта + 1 «Решта» вопроса + «ВШР»
    expect(figureCount(col.bands, col.questions)).toBe(7);
    expect(figureCount([], [{ options: [{ highRisk: false }] }])).toBe(3);
  });
});

describe("выборки рядом (экран модели и график)", () => {
  test("«Додати вибірку» — те же показатели и пустые фильтры, не больше восьми", () => {
    const next = addSample([column({ presetId: "p1", filters: null })]);
    expect(next).toHaveLength(2);
    expect(next[1]!.filters).toEqual({});
    expect(next[1]!.presetId).toBeNull();
    expect(next[1]!.questions).toEqual(next[0]!.questions);
    expect(columnsChanged([column()], next)).toBe(true);
    expect(columnsChanged([column()], [column({ filters: { locality: "Київ", ageMin: null } })])).toBe(false);
    const full = Array.from({ length: MAX_SAMPLES }, () => column());
    expect(addSample(full), "девятая выборка — отказ сервера, а не колонка").toHaveLength(MAX_SAMPLES);
  });

  test("дубль встаёт рядом без подписи, последнюю выборку не убрать", () => {
    const cols = [column({ title: "Київ" }), column({ title: "Львів", filters: { locality: "Львів" } })];
    const twice = duplicateSample(cols, 0);
    expect(twice.map((c) => c.title)).toEqual(["Київ", null, "Львів"]);
    expect(twice[1]!.filters).toEqual(cols[0]!.filters);
    expect(removeSample(cols, 0).map((c) => c.title)).toEqual(["Львів"]);
    expect(removeSample([cols[0]!], 0), "модель осталась без выборки").toHaveLength(1);
  });

  /*
   * Черновик ящика держится за выборку, а не за её номер.
   *
   * Прежде черновики лежали по номеру, и любая перестановка сбрасывала их
   * все: Esc сохранял набранное у выборки 1, «Додати вибірку» стирал его
   * молча, а «Повернутися» после «Прибрати вибірку» открывал ящик выборки,
   * вставшей на прежний номер. Мутация: ключи по номеру (keys = индексы) —
   * после «Прибрати» черновик «Львова» достаётся «Харкову».
   */
  test("ключи выборок переживают добавление, дубль и удаление; черновик уходит только с выборкой", () => {
    const start = keyedSamples([column({ title: "Київ" }), column({ title: "Львів" }), column({ title: "Харків" })]);
    const [kyiv, lviv, kharkiv] = start.keys as [string, string, string];
    expect(new Set(start.keys).size, "ключи выборок совпали").toBe(3);
    const drafts = { [kyiv]: "чернетка Києва", [lviv]: "чернетка Львова" };

    const added = addKeyed(start, "fresh");
    expect(added.keys).toEqual([kyiv, lviv, kharkiv, "fresh"]);
    expect(keepDrafts(drafts, added.keys), "«Додати вибірку» стёр сохранённый черновик").toEqual(drafts);

    const twice = duplicateKeyed(start, 0, "copy");
    expect(twice.columns.map((c) => c.title)).toEqual(["Київ", null, "Львів", "Харків"]);
    expect(twice.keys).toEqual([kyiv, "copy", lviv, kharkiv]);
    expect(keepDrafts(drafts, twice.keys)).toEqual(drafts);

    const fewer = removeKeyed(start, 0);
    expect(fewer.columns.map((c) => c.title)).toEqual(["Львів", "Харків"]);
    expect(fewer.keys).toEqual([lviv, kharkiv]);
    // черновик убранной выборки уходит с ней, «Львова» — остаётся у Львова
    expect(keepDrafts(drafts, fewer.keys)).toEqual({ [lviv]: "чернетка Львова" });
    expect(fewer.keys.includes(kyiv), "«Повернутися» к убранной выборке открыло бы чужой ящик").toBe(false);
  });

  /*
   * Экран модели пользуется ключами, а не номерами: черновик, «Застосувати»
   * и «Повернутися» — по ключу выборки, а «Повернутися» к убранной выборке
   * ничего не открывает. Мутация: вернуть черновики по номеру (`[i]: next`)
   * или открыть ящик без проверки текущих ключей — падает своя строка.
   */
  test("экран модели держит черновики, «Застосувати» и «Повернутися» за ключом выборки", () => {
    const view = readFileSync(resolve(import.meta.dir, "../src/pages/statistics/ModelView.tsx"), "utf8");
    expect(view).toContain("setDrafts((all) => ({ ...all, [key]: next }))");
    expect(view).not.toContain("[i]: next");
    expect(view).toContain("onClick={() => applyDraft(key)}");
    expect(view).toContain("if (key && keysNow.current.includes(key)) setDrawer({ open: true, key });");
    expect(view).toContain("setDrafts((d) => keepDrafts(d, next.keys));");
  });

  test("нет места или последняя выборка — те же выборки тем же объектом, без лишнего ключа", () => {
    const full = keyedSamples(Array.from({ length: MAX_SAMPLES }, () => column()));
    expect(addKeyed(full, "x")).toBe(full);
    expect(duplicateKeyed(full, 0, "x")).toBe(full);
    const one = keyedSamples([column()]);
    expect(removeKeyed(one, 0)).toBe(one);
  });

  test("пресет к выбранным выборкам заменяет их фильтры; новая выборка — с тем же пресетом", () => {
    const cols = [column(), column({ filters: { sex: "male" } })];
    const next = applyPreset(cols, "p9", [1], true);
    expect(next[0]).toBe(cols[0]!);
    expect(next[1]).toMatchObject({ presetId: "p9", filters: null });
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ presetId: "p9", filters: null, title: null });
  });

  /*
   * Ящик выборки: правка поля при выбранном пресете переводит выборку на
   * свои фильтры — начиная с критериев пресета. Мутация: начинать с
   * пустого — проверка ждёт пол из пресета рядом с новым возрастом.
   */
  test("черновик ящика: пресет, правка поля, подпись", () => {
    const criteria = (id: string) => (id === "p1" ? { sex: "male" as const, locality: "Київ" } : undefined);
    const col = column({ presetId: "p1", filters: null, title: "" });
    const d = sampleDraft(col, criteria);
    expect(d.filters).toEqual({ sex: "male", locality: "Київ" });
    expect(sampleDraftChanged(col, d)).toBe(false);

    const edited = editSampleDraft(d, { ageMin: 30 });
    expect(edited.presetId).toBeNull();
    expect(withSampleDraft(col, edited)).toMatchObject({
      presetId: null,
      filters: { sex: "male", locality: "Київ", ageMin: 30 },
    });
    expect(sampleDraftChanged(col, edited)).toBe(true);
    /* пустая подпись — null, а не пустая строка на сервере */
    expect(withSampleDraft(col, { ...d, title: "  " }).title).toBeNull();
  });
});

describe("строки отчёта", () => {
  const survey = {
    scales: [
      {
        id: "sc",
        code: "TOT",
        title: "Загальний бал",
        bands: [
          { id: "b0", label: "мінімальна", minScore: 0, maxScore: 4, severity: "none" },
          { id: "b1", label: "помірна", minScore: 5, maxScore: 9, severity: "moderate" },
        ],
      },
    ],
    questions: [
      { id: "q0", type: "text", title: "Коментар", options: [] },
      {
        id: "q1",
        type: "single",
        title: "Сон",
        options: [
          { id: "o1", text: "Добре", kind: "option" },
          { id: "o2", text: "Погано", kind: "option" },
          { id: "o3", text: "Зовсім ні", kind: "option" },
        ],
      },
    ],
  } as unknown as SurveyFull;
  const col = column({
    bands: [{ scaleId: "sc", bandId: "b1", highRisk: false }],
    questions: [{ questionId: "q1", options: [{ optionId: "o2", highRisk: true }] }],
  });

  test("порядок: шкала, смуги, «Решта», вопрос, варианты, «Решта», «ВШР»; подписи — из версии", () => {
    const rows = reportRows([col], () => survey);
    expect(rows.map((r) => r.kind)).toEqual(["scale", "band", "rest", "question", "option", "rest", "risk"]);
    expect(rows[1]).toMatchObject({ label: "помірна", severity: "moderate", range: "5–9" });
    expect(rows[2], "в «Решті» названы непоказанные смуги").toMatchObject({ others: "мінімальна" });
    expect(rows[3], "номер пункта — по версии методики").toMatchObject({ number: 2 });
    expect(rows[5]).toMatchObject({ others: "Добре, Зовсім ні" });
  });

  /*
   * Мутация: искать ячейку по месту в списке, а не по идентификатору —
   * колонка с другим набором показателей кладёт число в чужую строку.
   */
  test("ячейка берётся по идентификатору показателя, а не по месту", () => {
    const res = {
      scales: [{ scaleId: "sc", bands: [{ bandId: "b1", cell: shown(40, 4) }], rest: shown(60, 6) }],
      questions: [{ questionId: "q1", options: [{ optionId: "o2", cell: hidden }], rest: shown(70, 7) }],
      highRisk: shown(30, 3),
    } as unknown as StatRunColumn;
    const rows = reportRows([col], () => survey, [res]);
    const byKind = (k: string) => rows.filter((r) => r.kind === k);
    expect(cellAt(byKind("band")[0]!, res)).toEqual(shown(40, 4));
    expect(cellAt(byKind("option")[0]!, res)).toEqual(hidden);
    expect(byKind("rest").map((r) => cellAt(r, res))).toEqual([shown(60, 6), shown(70, 7)]);
    expect(cellAt(byKind("risk")[0]!, res)).toEqual(shown(30, 3));
    expect(cellAt(byKind("scale")[0]!, res), "у заголовка группы числа нет").toBeNull();
    expect(cellAt(byKind("band")[0]!, undefined), "до расчёта ячейки нет").toBeNull();
  });

  test("колонки с разной структурой — объединением, без повторов", () => {
    const other = column({ bands: [{ scaleId: "sc", bandId: "b0", highRisk: false }], questions: [] });
    const rows = reportRows([col, other], () => survey);
    expect(rows.flatMap((r) => (r.kind === "band" ? [r.bandId] : []))).toEqual(["b1", "b0"]);
    expect(rows.filter((r) => r.kind === "scale")).toHaveLength(1);
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
