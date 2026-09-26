import { describe, expect, test } from "bun:test";
import {
  RESET_PATCH,
  alphaLevel,
  cellTone,
  chartsHref,
  dayText,
  defaultSurvey,
  fill,
  findSurveys,
  isFiltered,
  isOrdered,
  lossRows,
  medianPoints,
  mondayOf,
  numText,
  numericBars,
  optionParts,
  patchParams,
  protocolHref,
  readState,
  sortQuestions,
  surveyPatch,
  testsHref,
  timeBuckets,
  toneStep,
  tooFastRows,
  weekPoints,
} from "../src/pages/analytics/tests/model";

/**
 * Чистая часть вкладки «Тести» раздела «Аналітика».
 *
 * Проверяется то, где ошибка не видна глазом: адрес, который после
 * пересылки открывается не на том срезе; пустые дни, выпавшие из ряда;
 * ступени фиолетового у вариантов, у которых порядка нет; «где теряют
 * людей», выстроенное по величине вместо порядка пунктов; скрытая неделя,
 * нарисованная нулём.
 */

describe("состояние в адресе", () => {
  test("мусор в адресе читается как «не задано», а не роняет экран", () => {
    const s = readState(new URLSearchParams("survey=s1&scope=who&view=pie&sort=x&from=2026-13&to=2026-09-30"));
    expect(s.survey).toBe("s1");
    expect(s.scope).toBe("all");
    expect(s.view).toBe("overview");
    expect(s.sort).toBe("number");
    expect(s.from).toBeNull();
    expect(s.to).toBe("2026-09-30");
  });

  test("умолчания в адрес не пишутся: две ссылки на один экран совпадают строкой", () => {
    const next = patchParams(new URLSearchParams("survey=s1&view=scales"), { view: "overview", scope: "all", from: "" });
    expect(next.toString()).toBe("survey=s1");
  });

  test("смена методики сбрасывает версию прежней", () => {
    const next = patchParams(new URLSearchParams("survey=s1&version=v7&from=2026-09-01"), surveyPatch("s2"));
    expect(next.get("survey")).toBe("s2");
    expect(next.get("version")).toBeNull();
    // период — срез, а не свойство методики: он остаётся
    expect(next.get("from")).toBe("2026-09-01");
  });

  test("«Скинути» снимает срез, но не методику и не вид", () => {
    const prev = new URLSearchParams("survey=s1&view=time&scope=patient&patient=u1&from=2026-09-01&group=g1&version=v2");
    expect(isFiltered(readState(prev))).toBe(true);
    const next = patchParams(prev, RESET_PATCH);
    expect(next.toString()).toBe("survey=s1&view=time");
    expect(isFiltered(readState(next))).toBe(false);
  });

  test("адреса: прежний /surveys/:id ведёт сюда, прохождение — по форме маршрута", () => {
    expect(testsHref("s1")).toBe("/analytics/tests?survey=s1");
    expect(testsHref("s1", { view: "scales" })).toBe("/analytics/tests?survey=s1&view=scales");
    expect(protocolHref("s1", "r1")).toBe("/surveys/s1/responses/r1");
    expect(chartsHref("s1", "r1")).toBe("/surveys/s1/responses/r1/charts");
  });
});

describe("выбор методики", () => {
  const list = [
    { id: "a", title: "PHQ-9", responseCount: 12 },
    { id: "b", title: "GAD-7", responseCount: 40 },
    { id: "c", title: "Міні-мульт", responseCount: 40 },
  ];

  test("по умолчанию — самая заполненная, при равенстве — по названию", () => {
    expect(defaultSurvey(list)).toBe("b");
    expect(defaultSurvey([])).toBeNull();
  });

  test("поиск без регистра, найденные — по числу прохождений", () => {
    expect(findSurveys(list, "").map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(findSurveys(list, "мУЛЬТ").map((s) => s.id)).toEqual(["c"]);
    expect(findSurveys(list, "zzz")).toEqual([]);
  });
});

describe("подписи", () => {
  test("подстановка в строку словаря не трогает незнакомые места", () => {
    expect(fill("{n} з {of}", { n: 3, of: 8 })).toBe("3 з 8");
    expect(fill("{n} і {x}", { n: 1 })).toBe("1 і {x}");
  });

  test("число — без хвоста и с запятой; невычислимое — прочерк, а не ноль", () => {
    expect(numText(12)).toBe("12");
    expect(numText(0.30000000000000004)).toBe("0,3");
    expect(numText(null)).toBe("—");
    expect(numText(Number.NaN)).toBe("—");
    expect(dayText("2026-09-01")).toBe("01.09.2026");
  });
});

describe("ряд прохождений", () => {
  test("пустые дни достраиваются нулями, а не выпадают", () => {
    const { mode, buckets } = timeBuckets([
      { date: "2026-09-03", count: 2 },
      { date: "2026-09-01", count: 1 },
    ]);
    expect(mode).toBe("day");
    expect(buckets.map((b) => [b.date, b.value])).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 0],
      ["2026-09-03", 2],
    ]);
  });

  test("дольше двух месяцев — неделями с понедельника", () => {
    const { mode, buckets } = timeBuckets([
      { date: "2026-06-03", count: 1 }, // среда → неделя с 1 июня
      { date: "2026-06-07", count: 2 }, // воскресенье той же недели
      { date: "2026-09-26", count: 4 }, // суббота → неделя с 21 сентября
    ]);
    expect(mode).toBe("week");
    expect(buckets[0]).toEqual({ key: "2026-06-01", date: "2026-06-01", value: 3 });
    expect(buckets.at(-1)).toEqual({ key: "2026-09-21", date: "2026-09-21", value: 4 });
    expect(buckets.every((b, i) => i === 0 || Date.parse(b.date) - Date.parse(buckets[i - 1]!.date) === 7 * 86_400_000)).toBe(true);
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
  });

  test("пустой ряд — пустые корзины, а не одна нулевая", () => {
    expect(timeBuckets([]).buckets).toEqual([]);
  });
});

describe("где теряют людей", () => {
  const step = (position: number, lost: number) => ({
    questionId: `q${position}`,
    title: `Пункт ${position}`,
    position,
    reached: 100,
    lost,
    endedHere: 0,
    endedHerePercent: 0,
    avgDurationMs: 1000,
  });

  test("только пункты с потерями", () => {
    const { rows, cut } = lossRows([step(0, 0), step(1, 3), step(2, 0), step(3, 1)]);
    expect(rows.map((r) => r.position)).toEqual([1, 3]);
    expect(cut).toBe(false);
  });

  test("сверх предела — самые большие потери, но в порядке пунктов методики", () => {
    const { rows, cut } = lossRows([step(0, 1), step(1, 9), step(2, 2), step(3, 8), step(4, 1)], 2);
    expect(cut).toBe(true);
    expect(rows.map((r) => r.position)).toEqual([1, 3]);
  });
});

describe("варианты ответа", () => {
  const opt = (id: string, score: number | null | undefined, count = 1) => ({
    optionId: id,
    text: id,
    count,
    percent: 0,
    score,
  });

  test("упорядочены — только различные веса, монотонно в любую сторону", () => {
    expect(isOrdered([opt("a", 0), opt("b", 1), opt("c", 2), opt("d", 3)])).toBe(true);
    expect(isOrdered([opt("a", 3), opt("b", 2), opt("c", 1), opt("d", 0)])).toBe(true);
    // ключевая методика: вес значит «совпало с ключом», порядка нет
    expect(isOrdered([opt("a", 1), opt("b", 0), opt("c", 1)])).toBe(false);
    expect(isOrdered([opt("a", 0), opt("b", 2), opt("c", 1)])).toBe(false);
    expect(isOrdered([opt("a", null), opt("b", 1)])).toBe(false);
    expect(isOrdered([opt("a", 1)])).toBe(false);
  });

  test("ступень — по весу: у обратного ряда самый тёмный — первый вариант", () => {
    const parts = optionParts({ options: [opt("often", 3, 5), opt("some", 1, 2), opt("never", 0, 9)] });
    expect(parts.map((p) => p.step)).toEqual([1, 1 / 3, 0]);
    expect(parts.map((p) => p.value)).toEqual([5, 2, 9]);
  });

  test("неупорядоченным вариантам ступени не выдумываются", () => {
    const parts = optionParts({ options: [opt("a", 0), opt("b", 0)] });
    expect(parts.every((p) => p.step === undefined)).toBe(true);
    expect(optionParts({})).toEqual([]);
  });
});

describe("пункты", () => {
  const q = (position: number, skipRate: number, changedShare: number, medianDurationMs: number) => ({
    questionId: `q${position}`,
    title: `Пункт ${position}`,
    position,
    skipRate,
    changedShare,
    medianDurationMs,
  });
  const qs = [q(0, 5, 1, 3000), q(1, 20, 0, 1000), q(2, 5, 9, 8000)];

  test("порядок: по убыванию, при равенстве — по номеру", () => {
    expect(sortQuestions(qs, "number").map((x) => x.position)).toEqual([0, 1, 2]);
    expect(sortQuestions(qs, "skips").map((x) => x.position)).toEqual([1, 0, 2]);
    expect(sortQuestions(qs, "changes").map((x) => x.position)).toEqual([2, 0, 1]);
    expect(sortQuestions(qs, "time").map((x) => x.position)).toEqual([2, 0, 1]);
  });

  test("числовой пункт: шкала — как есть, много значений — корзинами", () => {
    expect(numericBars([{ value: 2, count: 1 }, { value: 0, count: 3 }]).map((b) => b.label)).toEqual(["0", "2"]);
    const wide = numericBars(Array.from({ length: 40 }, (_, i) => ({ value: i, count: 1 })), 4);
    expect(wide).toHaveLength(4);
    expect(wide.reduce((s, b) => s + b.value, 0)).toBe(40);
  });

  test("медиана времени: пункты без ответов выпадают, а не рисуются нулём", () => {
    const points = medianPoints(
      [
        { position: 1, answered: 3, medianDurationMs: 4200, p25DurationMs: 3000, p75DurationMs: 6100 },
        { position: 0, answered: 0, medianDurationMs: 0, p25DurationMs: 0, p75DurationMs: 0 },
      ],
      "П",
    );
    expect(points).toEqual([{ x: "П2", y: 4.2, lo: 3, hi: 6.1 }]);
  });

  test("«надто швидко»: нулевые не показываются, остальные — по убыванию", () => {
    const rows = tooFastRows([
      { questionId: "a", position: 0, title: "a", tooFastShare: 0 },
      { questionId: "b", position: 1, title: "b", tooFastShare: 4 },
      { questionId: "c", position: 2, title: "c", tooFastShare: 30 },
    ]);
    expect(rows.map((r) => r.questionId)).toEqual(["c", "b"]);
  });
});

describe("шкалы", () => {
  test("альфа словами по порогам 0,8 и 0,7", () => {
    expect(alphaLevel(0.86)).toBe("high");
    expect(alphaLevel(0.8)).toBe("high");
    expect(alphaLevel(0.72)).toBe("ok");
    expect(alphaLevel(0.4)).toBe("low");
  });

  test("скрытая неделя выпадает из линии, одна точка — не ход", () => {
    const one = weekPoints([
      { week: "2026-09-07", n: 3, mean: null },
      { week: "2026-09-14", n: 6, mean: 11.5 },
    ]);
    expect(one.points.map((p) => p.value)).toEqual([11.5]);
    expect(one.enough).toBe(false);
    const two = weekPoints([
      { week: "2026-09-14", n: 6, mean: 11.5 },
      { week: "2026-09-21", n: 7, mean: 9 },
    ]);
    expect(two.enough).toBe(true);
    expect(two.points[1]!.t - two.points[0]!.t).toBe(7 * 86_400_000);
  });
});

describe("матрица ответов", () => {
  test("тон — доля балла от максимума; без балла или весов — тона нет", () => {
    expect(cellTone(3, 3)).toBe(1);
    expect(cellTone(0, 3)).toBe(0);
    expect(cellTone(null, 3)).toBeNull();
    expect(cellTone(2, null)).toBeNull();
    expect(cellTone(2, 0)).toBeNull();
    expect(cellTone(5, 3)).toBe(1);
  });

  test("ступени тона: ноль — нулевая ступень, максимум — верхняя", () => {
    expect(toneStep(0)).toBe(0);
    expect(toneStep(1)).toBe(4);
    expect(toneStep(0.5)).toBe(2);
  });
});
