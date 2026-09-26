import { describe, expect, test } from "bun:test";
import type { CohortPreview, UiKey } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import {
  activeFilters,
  barRows,
  breakdownCells,
  breakdownCsv,
  breakdownLabel,
  cleanSpec,
  describeSpec,
  orderCells,
  paramsFromSpec,
  sameSpec,
  specErrors,
  specFromParams,
  toSampleFilters,
} from "../src/pages/cohorts/model";

/**
 * «Добір людей»: правило отбора в адресе, метки условий, полоски долей,
 * выгрузка и перенос в статистику.
 *
 * Главное здесь — две тихие поломки. Первая: скрытая порогом ячейка
 * доезжает до экрана или до файла числом — полосой «примерно такой длины»
 * или нулём в CSV. Вторая: условие, которое пресет статистики не знает,
 * молча теряется при переносе, и «та же выборка» в статистике — другая.
 * Каждая проверка снималась мутацией; мутации записаны у проверок.
 */

const t = (key: UiKey) => UI[key].uk;

describe("правило ⇄ адрес", () => {
  test("полное правило переживает поездку через адрес", () => {
    const spec = {
      sex: "female" as const,
      ageMin: 25,
      ageMax: 45,
      units: ["Рота А", "Рота 'Б'"],
      localities: ["Київ"],
      surveyId: "s1",
      from: "2026-09-01",
      to: "2026-09-30",
      scales: [{ code: "D", op: ">=" as const, value: 10 }],
      minSeverity: "moderate" as const,
      repeatedOnly: true,
      riskOnly: true,
    };
    expect(specFromParams(paramsFromSpec(spec))).toEqual(spec);
  });

  test("чужие параметры адреса сохраняются, мусорные условия — нет", () => {
    const base = new URLSearchParams("saved=abc&sex=robot&age_from=-3&from=вчора&severity=none&scale=D~>=~10");
    const spec = specFromParams(base);
    /* шкала без методики — ничья: её код ничего не значит */
    expect(spec).toEqual({});
    expect(paramsFromSpec({ sex: "male" }, base).get("saved")).toBe("abc");
  });

  test("пустые условия — не условия", () => {
    expect(cleanSpec({ units: [], sex: null, repeatedOnly: false, scales: [] })).toEqual({});
    expect(sameSpec({ units: [] }, {})).toBe(true);
    expect(sameSpec({ sex: "male" }, { sex: "female" })).toBe(false);
  });

  test("перевёрнутый диапазон — ошибка набора, а не пустая выборка", () => {
    expect(specErrors({ ageMin: 45, ageMax: 25 })).toEqual({ age: "coh.errAge" });
    expect(specErrors({ from: "2026-09-30", to: "2026-09-01" })).toEqual({ period: "coh.errPeriod" });
    expect(specErrors({ ageMin: 30, ageMax: 30, from: "2026-09-01", to: "2026-09-01" })).toEqual({});
  });
});

describe("метки активных условий", () => {
  test("каждое значение — своя метка, снятие убирает только его", () => {
    const spec = { units: ["Рота А", "Рота Б"], sex: "male" as const };
    const tags = activeFilters(spec, t);
    expect(tags.map((x) => x.label)).toEqual(["Стать: Чоловіки", "Підрозділ: Рота А", "Підрозділ: Рота Б"]);
    expect(tags[1]!.without(spec)).toEqual({ units: ["Рота Б"], sex: "male" });
  });

  /* мутация: снимать метку методики, не трогая шкал, — в правиле остаётся «D ≥ 10» без методики */
  test("снятие методики снимает и условия по её шкалам", () => {
    const spec = { surveyId: "s1", scales: [{ code: "D", op: ">=" as const, value: 10 }] };
    const tags = activeFilters(spec, t, { survey: () => "PHQ-9", scale: () => "Депресія" });
    expect(tags.map((x) => x.label)).toEqual(["Методика: PHQ-9", "Депресія ≥ 10"]);
    expect(tags[0]!.without(spec)).toEqual({});
  });

  test("вираженість і вік — словами, без «і вище» у найтяжчої ступені", () => {
    expect(activeFilters({ minSeverity: "moderate" }, t)[0]!.label).toBe("Вираженість: помірна і вище");
    expect(activeFilters({ minSeverity: "severe" }, t)[0]!.label).toBe("Вираженість: виражена");
    expect(activeFilters({ ageMin: 25 }, t)[0]!.label).toBe("Вік: від 25");
    expect(describeSpec({}, t)).toBe(t("coh.everyone"));
  });
});

describe("полоски долей", () => {
  /*
   * Мутация: считать длину скрытой ячейки как ноль или долю от размера —
   * полоса у скрытой появляется, и проверка называет её.
   */
  test("у скрытой ячейки нет ни доли, ни полосы", () => {
    const rows = barRows(
      [
        { key: "Рота А", count: 40 },
        { key: "Рота Б", count: 10 },
        { key: "Рота В", count: null },
      ],
      60,
    );
    expect(rows[0]).toEqual({ key: "Рота А", count: 40, share: 67, width: 1 });
    expect(rows[1]).toEqual({ key: "Рота Б", count: 10, share: 17, width: 0.25 });
    expect(rows[2]).toEqual({ key: "Рота В", count: null, share: null, width: null });
  });

  test("ступени и возраст — в смысловом порядке, незнакомое в конце", () => {
    const cells = [
      { key: "—", count: 5 },
      { key: "severe", count: 5 },
      { key: "mild", count: 9 },
    ];
    expect(orderCells(cells, ["none", "mild", "moderate", "severe"]).map((c) => c.key)).toEqual(["mild", "severe", "—"]);
    expect(breakdownLabel("severity", "—", t)).toBe(t("coh.noBands"));
    expect(breakdownLabel("age", "25-34", t)).toBe("25–34");
    expect(breakdownLabel("unit", "—", t)).toBe(t("coh.unknown"));
  });
});

describe("выгрузка разбивок", () => {
  const preview: CohortPreview = {
    size: 12,
    breakdownAllowed: true,
    smallCellFloor: 5,
    bySex: [
      { key: "female", count: null },
      { key: "male", count: null },
    ],
    byUnit: [{ key: "Рота; «А»", count: 12 }],
    byLocality: [],
    byAge: [],
    bySeverity: [{ key: "mild", count: 12 }],
  };

  /*
   * Мутация: писать скрытую ячейку нулём — таблица посчитала бы ноль в
   * сумму, а в файле нет подписи «приховано» рядом.
   */
  test("скрытое — пустым и словом «так» в колонке «Приховано»", () => {
    const csv = breakdownCsv(preview, t, (kind, k) => breakdownLabel(kind, k, t));
    const lines = csv.replace("﻿", "").split("\r\n");
    expect(lines[0]).toBe("Розбивка;Значення;Осіб;Частка, %;Приховано");
    expect(lines).toContain("За статтю;Жінки;;;так");
    expect(lines).toContain("За вираженістю;Легка;12;100;");
    /* точка с запятой в названии не рвёт строку на колонки */
    expect(lines).toContain('За підрозділами;"Рота; «А»";12;100;');
  });

  test("разбивки идут в порядке экрана", () => {
    expect(breakdownCells(preview, "sex").map((c) => c.key)).toEqual(["male", "female"]);
  });
});

describe("перенос в статистику", () => {
  /*
   * Мутация: брать первый населённый пункт из двух — выборка тихо
   * сужается, а список «не перейдуть» молчит.
   */
  test("непереносимое названо, а не потеряно молча", () => {
    const { filters, dropped } = toSampleFilters({
      sex: "male",
      ageMin: 25,
      localities: ["Київ", "Львів"],
      units: ["Рота А"],
      surveyId: "s1",
      riskOnly: true,
      from: "2026-09-01",
    });
    expect(filters).toEqual({ sex: "male", ageMin: 25, from: "2026-09-01" });
    expect(dropped).toEqual(["st.locality", "person.unit", "coh.survey", "coh.risk"]);
  });

  test("один населённый пункт переносится", () => {
    expect(toSampleFilters({ localities: ["Київ"] })).toEqual({ filters: { locality: "Київ" }, dropped: [] });
  });
});
