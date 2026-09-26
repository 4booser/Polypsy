import { describe, expect, test } from "bun:test";
import type { SurveyFull } from "@quizzy/shared";
import { planToRows, rowsToPlan } from "../src/components/SafetyPlanEditor";
import {
  applyAnswers,
  defaultAnswers,
  optionKey,
  toDraft,
  toPayload,
  withUids,
  type Draft,
} from "../src/pages/constructor/model";
import { sortRows, type Column } from "../src/ui";
import { occurrenceKeys, rowKeyOf, withKeys } from "../src/ui/rowKeys";

/**
 * Ключи строк (волна 12, разбор кода: «DataTable использовал индекс как
 * ключ строки», «удаление вопроса оставляло курсор в поле другого вопроса»).
 *
 * Браузера в проверке нет, поэтому проверяется то, на чём держится
 * поведение: состояние строки в интерфейсе привязано к её ключу, и после
 * сортировки или удаления соседа по тому же ключу должна находиться та же
 * строка. Ключ по номеру этого не выдерживает — на нём и ловились оба
 * дефекта.
 */

describe("таблица: ключ идёт за строкой, а не за местом", () => {
  interface Row {
    id: number;
    name: string;
    n: number;
  }
  const columns: Column<Row>[] = [
    { key: "name", header: "ФИО", sort: (r) => r.name, render: (r) => r.name },
    { key: "n", header: "Замеров", num: true, sort: (r) => r.n, render: (r) => r.n },
  ];
  const rows: Row[] = [
    { id: 7, name: "Ялинка", n: 2 },
    { id: 12, name: "Яблуко", n: 10 },
    { id: 3, name: "Абрикос", n: 1 },
  ];
  const keyed = (list: Row[]) => new Map(list.map((r, i) => [rowKeyOf(r, i), r.name]));

  test("сортировка не переносит раскрытость на другую строку", () => {
    /*
     * Раскрыта «Ялинка» — интерфейс помнит её ключ. После сортировки по имени
     * «Ялинка» уезжает в конец, а на её прежнем месте — «Абрикос». Пока id
     * числом не считался идентификатором, ключом был номер, и раскрытым
     * оказывался «Абрикос».
     */
    const open = rowKeyOf(rows[0]!, 0);
    const after = keyed(sortRows(rows, columns, { key: "name" }));
    expect(after.get(open)).toBe("Ялинка");
  });

  test("ключи одни и те же при любом порядке", () => {
    const before = [...keyed(rows).keys()].sort();
    for (const sort of [{ key: "name" }, { key: "n" }, { key: "n", desc: true }]) {
      expect([...keyed(sortRows(rows, columns, sort)).keys()].sort()).toEqual(before);
    }
  });

  test("строковый id и rowKey берутся как есть", () => {
    expect(rowKeyOf({ id: "u-1" }, 5)).toBe("u-1");
    expect(rowKeyOf({ code: "PHQ" }, 5, (r) => r.code)).toBe("PHQ");
  });

  test("номер — только когда опознать строку нечем, и он не совпадает с id", () => {
    // «@0» против «#0»: строка без id на первом месте и строка с id 0 — разные строки
    expect(rowKeyOf({ total: 3 }, 0)).toBe("@0");
    expect(rowKeyOf({ id: 0 }, 1)).toBe("#0");
    expect(rowKeyOf({ id: "" }, 2)).toBe("@2");
  });
});

describe("ключ по значению для строк без идентификатора", () => {
  test("повторы различаются номером вхождения", () => {
    expect(occurrenceKeys(["s1", "s2", "s1"], (x) => x)).toEqual(["s1", "s2", "s1#2"]);
  });

  test("удаление соседа не переименовывает остальных", () => {
    const before = occurrenceKeys(["hs", "k", "d"], (x) => x);
    const after = occurrenceKeys(["hs", "d"], (x) => x);
    expect(after).toEqual([before[0], before[2]]);
  });
});

describe("конструктор: варианты и полосы со своими ключами", () => {
  const survey = {
    id: "sv",
    title: { uk: "Тест", ru: "Тест" },
    questions: [
      {
        id: "q-1",
        type: "single",
        title: { uk: "Питання" },
        help: null,
        required: true,
        options: [
          { id: "o-1", text: { uk: "Раз" }, score: 0, keyCode: null, riskFlag: false, riskLabel: null, riskSeverity: null },
          { id: "o-2", text: { uk: "Два" }, score: 1, keyCode: null, riskFlag: false, riskLabel: null, riskSeverity: null },
          { id: "o-3", text: { uk: "Три" }, score: 2, keyCode: null, riskFlag: false, riskLabel: null, riskSeverity: null },
        ],
      },
    ],
    scales: [
      {
        id: "sc-1",
        code: "total",
        title: { uk: "Разом" },
        description: null,
        kind: "clinical",
        normalization: "raw",
        aggregation: "sum",
        ratioDenominator: null,
        validityThreshold: null,
        validityDirection: null,
        validityMessage: null,
        items: [{ questionId: "q-1", matchKey: null, weight: 1 }],
        corrections: [],
        norms: [],
        stenTable: [],
        bands: [
          { id: "b-1", minScore: 0, maxScore: 1, label: { uk: "Норма" }, severity: "none", grade: null, recommendation: null, cascadeBatteryId: null, cascadeDueDays: null, followUpDays: null },
          { id: "b-2", minScore: 2, maxScore: 3, label: { uk: "Вище" }, severity: "mild", grade: null, recommendation: null, cascadeBatteryId: null, cascadeDueDays: null, followUpDays: null },
        ],
      },
    ],
    administration: "self",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: false,
    showProgress: true,
    allowBack: true,
    anonymous: false,
    randomizeQuestions: false,
  } as unknown as SurveyFull;

  test("сохранённая методика: ключи вариантов и полос — их идентификаторы", () => {
    const d = toDraft(survey, []);
    expect(d.questions[0]!.options.map((o) => o.uid)).toEqual(["o-1", "o-2", "o-3"]);
    expect(d.scales[0]!.bands.map((b) => b.uid)).toEqual(["b-1", "b-2"]);
  });

  test("удаление среднего варианта не отдаёт его ключ соседу", () => {
    /*
     * Ровно дефект разбора: поле «текст ответа 2» после удаления второго
     * варианта было тем же узлом и получало текст третьего вместе с курсором.
     * С ключом по uid поле третьего остаётся полем третьего.
     */
    const options = toDraft(survey, [])
      .questions[0]!.options.filter((o) => o.uid !== "o-2")
      .map((o, k) => [optionKey(o, k), o.text.uk]);
    expect(options).toEqual([
      ["o-1", "Раз"],
      ["o-3", "Три"],
    ]);
  });

  test("ключи редактора на сервер не уходят — ни у вариантов, ни у полос", () => {
    const payload = toPayload(toDraft(survey, []));
    expect(payload.questions[0]!.options.some((o) => "uid" in o)).toBe(false);
    expect(payload.scales[0]!.bands.some((b) => "uid" in b)).toBe(false);
    expect(payload.questions[0]!.options).toHaveLength(3);
  });

  test("черновик без ключей (JSON, старый автосейв) получает их, выданные — не трогаются", () => {
    const d = toDraft(survey, []);
    const raw: Draft = {
      ...d,
      answers: d.answers?.map(({ uid: _u, ...a }) => a),
      questions: d.questions.map((q) => ({ ...q, options: q.options.map(({ uid: _u, ...o }, k) => (k === 0 ? { ...o, uid: "keep" } : o)) })),
      scales: d.scales.map((s) => ({ ...s, bands: s.bands.map(({ uid: _u, ...b }) => b) })),
    };
    const fixed = withUids(raw);
    const optionUids = fixed.questions[0]!.options.map((o) => o.uid);
    expect(optionUids[0]).toBe("keep");
    expect(new Set(optionUids).size).toBe(3);
    expect(fixed.scales[0]!.bands.every((b) => !!b.uid)).toBe(true);
    expect(fixed.answers?.every((a) => !!a.uid)).toBe(true);
  });

  test("новые ответы по умолчанию различимы, а общий набор в вопросах держит их ключи", () => {
    const answers = defaultAnswers();
    expect(new Set(answers.map((a) => a.uid)).size).toBe(2);
    const d = applyAnswers({ ...toDraft(survey, []), mode: "specific" }, answers);
    expect(d.questions[0]!.options.map((o) => o.uid)).toEqual(answers.map((a) => a.uid));
  });
});

describe("план безопасности: строки со своими ключами", () => {
  const plan = {
    warningSigns: ["Не сплю", "Не їм", "Уникаю людей"],
    copingStrategies: [],
    distractions: ["Прогулянка"],
    people: [
      { name: "Мама", contact: "+380" },
      { name: "Брат", contact: "+381" },
    ],
    professionals: [],
    meansRestriction: "  ліки у сестри ",
    reasonsToLive: [],
  };

  test("удаление средней строки не переименовывает соседей", () => {
    const rows = planToRows(plan);
    const [first, middle, last] = rows.warningSigns;
    const after = rows.warningSigns.filter((r) => r.key !== middle!.key);
    expect(after.map((r) => [r.key, r.value])).toEqual([
      [first!.key, "Не сплю"],
      [last!.key, "Уникаю людей"],
    ]);
  });

  test("ключи уникальны по всему плану и на сервер не уходят", () => {
    const rows = planToRows(plan);
    const keys = [...rows.warningSigns, ...rows.distractions, ...rows.people].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const back = rowsToPlan(rows);
    expect(back.people).toEqual(plan.people);
    expect(back.warningSigns).toEqual(plan.warningSigns);
    expect(back.meansRestriction).toBe("ліки у сестри");
  });

  test("пустые строки при сохранении отбрасываются, как и прежде", () => {
    const rows = planToRows(plan);
    rows.distractions.push(...withKeys(["  "]));
    rows.people.push(...withKeys([{ name: "", contact: "+382" }]));
    const back = rowsToPlan(rows);
    expect(back.distractions).toEqual(["Прогулянка"]);
    expect(back.people).toHaveLength(2);
  });
});
