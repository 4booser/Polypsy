import { describe, expect, test } from "bun:test";
import { TOO_FAST_MS, type ResponseDetailScore } from "@quizzy/shared";
import {
  buildAnswering,
  buildContributions,
  buildTrends,
  resultRows,
  shiftOf,
  type TrendPointView,
} from "../src/pages/response/model";
import { ANSWERS, LABELS, Q, answer, band, detail, dynamics, noNaN, score, series, surveyFull } from "./responseFixtures";

/**
 * Графики одного прохождения: счёт под линейкой, динамикой, вкладом пунктов
 * и временем ответов.
 *
 * Ошибки здесь тихие. Лестница T-баллов под сырым баллом рисуется так же
 * аккуратно, как под настоящим; сдвиг между версиями методики выглядит
 * «достоверным улучшением»; вклад, посчитанный не движком, расходится с
 * баллом на пункте с обратным ключом — и ничего не падает. Каждый сценарий
 * ниже — один такой случай, собранный объектом, а не правкой базы.
 */

describe("результат: линейка и подпись значения", () => {
  test("сырой балл — «N з max», лестница по возрастанию, попавшая полоса с описанием и рекомендацией", () => {
    const [r] = resultRows(detail(), LABELS);
    expect(r!.valueText).toBe("12 з 27");
    expect(r!.rungs.map((x) => x.min)).toEqual([0, 5, 10, 15]);
    expect(r!.band).toEqual({
      label: "Помірна",
      severity: "moderate",
      description: "Помірна: опис",
      recommendation: "Повторний замір за місяць",
    });
    expect(r!.meterMax).toBeNull();
    expect(r!.noBands).toBe(false);
    expect(r!.outside).toBe(false);
  });

  /**
   * Мутация: оставить лестницу ненормированному значению — сырой 14 ложится
   * на лестницу T-баллов «в норму», проверка называет ступени.
   */
  test("не нормировано: лестницы нет, метр в сырых баллах, полосы нет", () => {
    const [r] = resultRows(
      detail({
        scores: [
          score({
            normalization: "tscore",
            normalized: false,
            value: 14,
            maxScore: 20,
            band: null,
            bands: [band("t1", 0, 44.9, "Низький", "none"), band("t2", 45, 120, "Високий", "severe")],
          }),
        ],
      }),
      LABELS,
    );
    expect(r!.normalized).toBe(false);
    expect(r!.rungs, "сырой балл нарисован на лестнице T-баллов").toEqual([]);
    expect(r!.meterMax).toBe(20);
    expect(r!.valueText).toBe("14 з 20");
    expect(r!.band).toBeNull();
  });

  test("шкала без полос — метр от нуля до максимума и пометка; без максимума — без метра и без «з 0»", () => {
    const [r] = resultRows(detail({ scores: [score({ band: null, bands: [] })] }), LABELS);
    expect(r!.noBands).toBe(true);
    expect(r!.meterMax).toBe(27);

    const [zero] = resultRows(detail({ scores: [score({ band: null, bands: [], maxScore: 0, value: 0 })] }), LABELS);
    expect(zero!.meterMax).toBeNull();
    expect(zero!.valueText).toBe("0");
  });

  test("нормированные единицы подписаны своим словом; у T-балла без полос метра нет", () => {
    const [t] = resultRows(detail({ scores: [score({ normalization: "tscore", value: 64.5, band: null, bands: [] })] }), LABELS);
    expect(t!.valueText).toBe("T-бал 64.5");
    expect(t!.meterMax, "у T-балла нет верха — метр 0…64 врал бы о максимуме").toBeNull();

    const [s] = resultRows(detail({ scores: [score({ normalization: "sten", value: 7, band: null, bands: [] })] }), LABELS);
    expect(s!.valueText).toBe("стен 7");
    expect(s!.meterMax).toBe(10);
  });

  test("значение за лестницей — «поза межами», а не молчание", () => {
    const [r] = resultRows(
      detail({ scores: [score({ value: 30, band: null, bands: score().bands.map((b) => ({ ...b, hit: false })) })] }),
      LABELS,
    );
    expect(r!.outside).toBe(true);
    expect(r!.band).toBeNull();
  });

  test("старый ответ сервера без normalized читается как нормированный", () => {
    const legacy = score();
    delete (legacy as Partial<ResponseDetailScore>).normalized;
    const [r] = resultRows(detail({ scores: [legacy] }), LABELS);
    expect(r!.normalized).toBe(true);
    expect(r!.rungs.length).toBe(4);
  });
});

/* ─────────── динамика ─────────── */

describe("динамика: ряд этой методики и сдвиг от прошлого раза", () => {
  test("одно прохождение — сравнивать не с чем", () => {
    expect(buildTrends(detail(), dynamics([series([{ responseId: "r3", rawScore: 12 }])], 1)).kind).toBe("single");
    // методики у человека в ответе нет вовсе — то же, а не падение
    expect(buildTrends(detail(), { ...dynamics([]), surveys: [] }).kind).toBe("single");
  });

  /**
   * Мутация: считать сдвиг от первого замера, как сервер (reliableChange),
   * — дельта выходит 10 вместо 6, проверка называет число.
   */
  test("сдвиг — от предыдущего, с переходом полос; |RCI| > 1,96 — больше ошибки измерения", () => {
    const view = buildTrends(
      detail(),
      dynamics([
        series([
          { responseId: "r1", rawScore: 2, bandLabel: "Мінімальна", severity: "none" },
          { responseId: "r2", rawScore: 6, bandLabel: "Легка", severity: "mild" },
          { responseId: "r3", rawScore: 12, bandLabel: "Помірна", severity: "moderate" },
        ]),
      ]),
    );
    if (view.kind !== "series") throw new Error("ожидался ряд");
    const [s] = view.scales;
    expect(view.focusInSeries).toBe(true);
    expect(s!.points.map((p) => p.focus)).toEqual([false, false, true]);
    expect(s!.shift!.delta, "сдвиг посчитан не от предыдущего замера").toBe(6);
    expect(s!.shift!.from).toEqual({ label: "Легка", severity: "mild" });
    expect(s!.shift!.to).toEqual({ label: "Помірна", severity: "moderate" });
    // 6 / (√2 · 2) = 2,12
    expect(s!.shift!.rci).toBe(2.12);
    expect(s!.shift!.verdict).toBe("reliable");
    expect(s!.rungs.map((r) => r.label)).toEqual(["Мінімальна", "Легка", "Помірна", "Тяжка"]);
  });

  test("вердикты: в пределах ошибки, без SEM, разные версии", () => {
    const p = (value: number, versionNo: number | null = 2, at = "2026-08-01T00:00:00Z"): TrendPointView => ({
      responseId: String(value),
      at,
      value,
      band: null,
      focus: false,
      versionNo,
    });
    expect(shiftOf(p(10), p(12), 2).verdict).toBe("within");
    expect(shiftOf(p(10), p(10), 2)).toMatchObject({ delta: 0, verdict: "within", rci: 0 });

    const noSem = shiftOf(p(10), p(20), null);
    expect(noSem.verdict, "без ошибки измерения вердикт выдуман").toBe("noSem");
    expect(noSem.rci).toBeNull();
    expect(shiftOf(p(10), p(20), 0).verdict).toBe("noSem");

    /*
     * Мутация: сравнивать версии не глядя — сдвиг 10 при SEM 2 даёт
     * «більше за похибку», хотя изменился ключ методики, а не человек.
     */
    const versions = shiftOf(p(10, 1), p(20, 2), 2);
    expect(versions.verdict, "замеры разных версий сравнены напрямую").toBe("versions");
    expect(versions.rci).toBeNull();
    // неизвестная версия у обоих — одна и та же
    expect(shiftOf(p(10, null), p(11, null), 2).verdict).toBe("within");
  });

  test("это прохождение первое в ряду — сдвига нет, есть пометка", () => {
    const view = buildTrends(
      detail({ id: "r1" }),
      dynamics([series([{ responseId: "r1", rawScore: 5 }, { responseId: "r2", rawScore: 9 }])]),
    );
    if (view.kind !== "series") throw new Error("ожидался ряд");
    expect(view.scales[0]!.first).toBe(true);
    expect(view.scales[0]!.shift).toBeNull();
  });

  test("незавершённое прохождение: ряд из сданных, без отметки и без сдвига", () => {
    const view = buildTrends(
      detail({ id: "draft", status: "in_progress" }),
      dynamics([series([{ responseId: "r1", rawScore: 5 }, { responseId: "r2", rawScore: 9 }])]),
    );
    if (view.kind !== "series") throw new Error("ожидался ряд");
    expect(view.focusInSeries).toBe(false);
    expect(view.scales[0]!.shift).toBeNull();
    expect(view.scales[0]!.first).toBe(false);
  });

  test("смена версии в ряду помечена; SEM ноль или NaN — неизвестен, а не ноль", () => {
    const view = buildTrends(
      detail(),
      dynamics([
        series(
          [
            { responseId: "r1", rawScore: 5, versionNo: 1 },
            { responseId: "r3", rawScore: 9, versionNo: 2 },
          ],
          { sem: Number.NaN },
        ),
      ]),
    );
    if (view.kind !== "series") throw new Error("ожидался ряд");
    expect(view.scales[0]!.mixedVersions).toBe(true);
    expect(view.scales[0]!.sem).toBeNull();
    expect(view.scales[0]!.shift!.verdict).toBe("versions");
    noNaN(view);
  });

  test("шкалы сопоставляются по коду, а не по id: id меняется с версией", () => {
    const view = buildTrends(
      detail({ scores: [score({ scaleId: "new-id", scaleCode: "D" })] }),
      dynamics([series([{ responseId: "r1", rawScore: 5 }, { responseId: "r3", rawScore: 9 }], { scaleId: "old-id" })]),
    );
    expect(view.kind).toBe("series");
  });
});

/* ─────────── вклад пунктов ─────────── */

describe("вклад пунктов: движком, по ключу той версии", () => {
  /**
   * Мутация: считать вклад весом выбранного варианта вместо itemContribution
   * — пункт с обратным ключом даёт 3 вместо 0, «совпал с ключом» — 1 вместо
   * веса 2, проверка называет перечень.
   */
  test("вклад каждого вида пункта — тот же, что у движка; нули и нечисловые не попадают", () => {
    const view = buildContributions(detail({ answers: ANSWERS }), surveyFull());
    expect(view.stale).toBe(false);
    const [s] = view.scales;
    expect(
      s!.items.map((i) => [i.number, i.value]),
      "вклад посчитан не движком",
    ).toEqual([
      [1, 3],
      [4, 3],
      [3, 2],
    ]);
    // верх — наибольшее, что мог дать пункт: матрица из двух строк по 2
    expect(s!.top).toBe(4);
    expect(s!.items.find((i) => i.number === 4)!.max).toBe(4);
    expect(s!.items.find((i) => i.number === 3)!.max).toBe(2);
  });

  test("критический выбранный вариант помечен; пропущенный пункт — в счётчике", () => {
    const [s] = buildContributions(detail({ answers: ANSWERS }), surveyFull()).scales;
    expect(s!.items.find((i) => i.number === 1)!.critical).toBe(true);
    expect(s!.items.filter((i) => i.critical).length).toBe(1);
    expect(s!.unanswered).toBe(1);
    expect(s!.size).toBe(7);
  });

  test("методика не той версии — вклад не считается вовсе", () => {
    expect(buildContributions(detail({ answers: ANSWERS }), surveyFull({ versionNumber: 3 }))).toEqual({
      stale: true,
      scales: [],
    });
    // номер тот же, а пункта нет — тоже чужая версия
    const missing = surveyFull({ questions: Q.slice(1) });
    expect(buildContributions(detail({ answers: ANSWERS }), missing).stale).toBe(true);
  });

  test("ни одного ответа с баллом — пустой перечень, а не NaN в верхе", () => {
    const view = buildContributions(
      detail({ answers: ANSWERS.map((a) => ({ ...a, answered: false })) }),
      surveyFull(),
    );
    expect(view.scales[0]!.items).toEqual([]);
    expect(view.scales[0]!.unanswered).toBe(7);
    noNaN(view);
  });
});

/* ─────────── как отвечал ─────────── */

describe("как отвечал: время, быстрые, смены, пропуски", () => {
  const timed = [
    answer({ questionId: "a", position: 1, durationMs: 800 }),
    answer({ questionId: "b", position: 2, durationMs: 4000, changeCount: 2 }),
    answer({ questionId: "c", position: 3, durationMs: 6000 }),
    // пропущенный быстрый — не «быстрый ответ»: ответа нет
    answer({ questionId: "d", position: 4, durationMs: 300, answered: false }),
    // время не замерено — не «быстрый»
    answer({ questionId: "e", position: 5, durationMs: 0 }),
  ];

  test("порог методики; быстрый — только отвеченный и замеренный; медиана по отвеченным", () => {
    const a = buildAnswering(detail({ answers: timed }), 1000);
    expect(a.thresholdMs).toBe(1000);
    expect(a.fast).toEqual([1]);
    expect(a.medianMs).toBe(4000);
    expect(a.changed).toEqual([{ number: 2, times: 2 }]);
    expect(a.unanswered).toBe(1);
    expect(a.totalMs).toBe(300_000);
    expect(a.timed).toBe(true);
  });

  test("без порога методики — общий TOO_FAST_MS, тот же, что у аналитики на сервере", () => {
    expect(buildAnswering(detail({ answers: timed }), null).thresholdMs).toBe(TOO_FAST_MS);
    expect(buildAnswering(detail({ answers: timed }), 0).thresholdMs).toBe(TOO_FAST_MS);
  });

  test("ничего не замерено — null, а не ноль: «0 с» на плитке было бы выдумкой", () => {
    const a = buildAnswering(
      detail({ durationMs: 0, answers: [answer({ questionId: "x", position: 1 }), answer({ questionId: "y", position: 2 })] }),
      null,
    );
    expect(a.totalMs).toBeNull();
    expect(a.medianMs).toBeNull();
    expect(a.timed).toBe(false);
    expect(a.fast).toEqual([]);
    noNaN(a);
  });
});
